// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import type { SlipEncoderOptions, SlipDecoderOptions } from '../../public-api';
import { ByteQueue, integer, frameTooLarge } from './bytes';

type SlipSettings = SlipEncoderOptions & Required<Pick<SlipEncoderOptions, 'ESC' | 'END' | 'ESC_END' | 'ESC_ESC'>>;

function settings(options: SlipEncoderOptions): SlipSettings {
  const result = { ...options };
  for (const [name, value] of Object.entries({ ESC: 0xdb, END: 0xc0, ESC_END: 0xdc, ESC_ESC: 0xdd }) as [
    'ESC' | 'END' | 'ESC_END' | 'ESC_ESC',
    number,
  ][]) {
    if (result[name] === undefined) result[name] = value;
  }
  for (const name of ['START', 'ESC', 'END', 'ESC_START', 'ESC_END', 'ESC_ESC'] as const) {
    if (result[name] !== undefined) integer(result[name], name, 0, 255);
  }
  return result as SlipSettings;
}

class SlipEncoder extends Transform {
  #codes = new Int16Array(256).fill(-1);
  #options: SlipSettings;

  constructor(options: SlipEncoderOptions = {}) {
    super(options);
    this.#options = settings(options);
    const { START, END, ESC, ESC_START, ESC_END, ESC_ESC } = this.#options;
    this.#codes[ESC] = ESC_ESC;
    this.#codes[END] = ESC_END;
    if (START !== undefined && ESC_START !== undefined) this.#codes[START] = ESC_START;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const size = chunk.length;
    const { START, END, ESC, ESC_START, bluetoothQuirk } = this.#options;
    if (bluetoothQuirk && !size) return callback();
    const codes = this.#codes;
    const plain =
      size >= 256 &&
      codes[chunk[0]] === -1 &&
      chunk.indexOf(ESC) === -1 &&
      chunk.indexOf(END) === -1 &&
      (START === undefined || ESC_START === undefined || chunk.indexOf(START) === -1);
    let length = size + 1 + Number(START !== undefined) + Number(Boolean(bluetoothQuirk));
    if (!plain) for (let i = 0; i < size; i++) length += Number(codes[chunk[i]] !== -1);
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    if (bluetoothQuirk) output[offset++] = END;
    if (START !== undefined) output[offset++] = START;
    if (plain) offset += chunk.copy(output, offset);
    else {
      for (let i = 0; i < size; i++) {
        const code = codes[chunk[i]];
        if (code === -1) output[offset++] = chunk[i];
        else {
          output[offset++] = ESC;
          output[offset++] = code;
        }
      }
    }
    output[offset] = END;
    callback(null, output);
  }
}

class SlipDecoder extends Transform {
  #bytes = new ByteQueue();
  #codes = new Int16Array(256).fill(-1);
  #options: SlipSettings;
  #started = false;
  #escaped = false;
  #maxFrameLength?: number;

  constructor({ maxFrameLength, ...options }: SlipDecoderOptions = {}) {
    super(options);
    this.#options = settings(options);
    this.#maxFrameLength = maxFrameLength === undefined ? undefined : integer(maxFrameLength, 'maxFrameLength', 0);
    const { START, END, ESC, ESC_START, ESC_END, ESC_ESC } = this.#options;
    this.#codes[ESC_END] = END;
    this.#codes[ESC_ESC] = ESC;
    if (START !== undefined && ESC_START !== undefined) this.#codes[ESC_START] = START;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const { START, END, ESC } = this.#options;
    // Native searches pay off on larger chunks. Keep small fragments on the
    // byte loop, and retain larger unescaped payloads without copying them.
    if (chunk.length >= 256 && START === undefined && !this.#escaped && chunk.indexOf(ESC) === -1) {
      let offset = 0;
      for (let end = chunk.indexOf(END); end !== -1; end = chunk.indexOf(END, offset)) {
        if (!this.#append(chunk.subarray(offset, end))) return callback(this.#overflow());
        this.push(this.#bytes.take());
        offset = end + 1;
      }
      if (!this.#append(offset ? chunk.subarray(offset) : chunk)) return callback(this.#overflow());
      callback();
      return;
    }
    const decoded = Buffer.allocUnsafe(chunk.length);
    let size = 0;
    let frameStart = 0;
    const emit = () => {
      if (!this.#append(decoded.subarray(frameStart, size))) return false;
      this.push(this.#bytes.take());
      frameStart = size;
      return true;
    };
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (START === undefined) this.#started = true;
      if (this.#escaped) {
        this.#escaped = false;
        const code = this.#codes[byte];
        if (code === -1 && !emit()) return callback(this.#overflow());
        if (this.#started) decoded[size++] = code === -1 ? byte : code;
      } else if (byte === START) this.#started = true;
      else if (byte === ESC) this.#escaped = true;
      else if (byte === END) {
        if (!emit()) return callback(this.#overflow());
        this.#started = false;
      } else if (this.#started) decoded[size++] = byte;
    }
    if (!this.#append(decoded.subarray(frameStart, size))) return callback(this.#overflow());
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#bytes.take());
    callback();
  }

  #append(buffer: Buffer) {
    if (this.#maxFrameLength !== undefined && this.#bytes.length + buffer.length > this.#maxFrameLength) return false;
    this.#bytes.append(buffer);
    return true;
  }

  #overflow() {
    this.#bytes.clear();
    return frameTooLarge();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.#bytes.clear();
    this.#started = false;
    this.#escaped = false;
    callback(error);
  }
}

export { SlipEncoder, SlipDecoder };
