// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {Transform, type TransformCallback} from 'node:stream';
import type {SlipEncoderOptions} from '../../public-api';
import {ByteQueue, integer} from './bytes';

type SlipSettings = SlipEncoderOptions & Required<Pick<SlipEncoderOptions, 'ESC' | 'END' | 'ESC_END' | 'ESC_ESC'>>;

function settings(options: SlipEncoderOptions): SlipSettings {
  const result = {...options};
  for (const [name, value] of Object.entries({ESC: 0xdb, END: 0xc0, ESC_END: 0xdc, ESC_ESC: 0xdd}) as ['ESC' | 'END' | 'ESC_END' | 'ESC_ESC', number][]) {
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
    const {START, END, ESC, ESC_START, ESC_END, ESC_ESC} = this.#options;
    this.#codes[ESC] = ESC_ESC;
    this.#codes[END] = ESC_END;
    if (START !== undefined && ESC_START !== undefined) this.#codes[START] = ESC_START;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const {START, END, ESC, bluetoothQuirk} = this.#options;
    if (bluetoothQuirk && !chunk.length) return callback();
    let length = chunk.length + 1 + Number(START !== undefined) + Number(Boolean(bluetoothQuirk));
    for (let i = 0; i < chunk.length; i++) length += Number(this.#codes[chunk[i]] !== -1);
    const output = Buffer.allocUnsafe(length);
    let offset = 0;
    if (bluetoothQuirk) output[offset++] = END;
    if (START !== undefined) output[offset++] = START;
    for (let i = 0; i < chunk.length; i++) {
      const code = this.#codes[chunk[i]];
      if (code === -1) output[offset++] = chunk[i];
      else { output[offset++] = ESC; output[offset++] = code; }
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

  constructor(options: SlipEncoderOptions = {}) {
    super(options);
    this.#options = settings(options);
    const {START, END, ESC, ESC_START, ESC_END, ESC_ESC} = this.#options;
    this.#codes[ESC_END] = END;
    this.#codes[ESC_ESC] = ESC;
    if (START !== undefined && ESC_START !== undefined) this.#codes[ESC_START] = START;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const {START, END, ESC} = this.#options;
    const decoded = Buffer.allocUnsafe(chunk.length);
    let size = 0;
    let frameStart = 0;
    const emit = () => {
      this.#bytes.append(decoded.subarray(frameStart, size));
      this.push(this.#bytes.take());
      frameStart = size;
    };
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (START === undefined) this.#started = true;
      if (this.#escaped) {
        this.#escaped = false;
        const code = this.#codes[byte];
        if (code === -1) emit();
        if (this.#started) decoded[size++] = code === -1 ? byte : code;
      } else if (byte === START) this.#started = true;
      else if (byte === ESC) this.#escaped = true;
      else if (byte === END) { emit(); this.#started = false; }
      else if (this.#started) decoded[size++] = byte;
    }
    this.#bytes.append(decoded.subarray(frameStart, size));
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#bytes.take());
    callback();
  }
}

export {SlipEncoder, SlipDecoder};
