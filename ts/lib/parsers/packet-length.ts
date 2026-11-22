// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import type { PacketLengthOptions } from '../../public-api';
import { ByteQueue, integer } from './bytes';

class PacketLengthParser extends Transform {
  #bytes = new ByteQueue();
  #delimiters: Set<number>;
  #marker?: Buffer;
  #started = false;
  #length = 0;
  declare delimiterBytes: number;
  declare lengthBytes: number;
  declare lengthOffset: number;
  declare packetOverhead: number;
  declare maxLen: number;

  constructor({
    delimiter = 0xaa,
    delimiterBytes = 1,
    packetOverhead = 2,
    lengthBytes = 1,
    lengthOffset = 1,
    maxLen = 255,
    ...options
  }: PacketLengthOptions = {}) {
    super(options);
    this.delimiterBytes = integer(delimiterBytes, 'delimiterBytes', 1, 6);
    this.lengthBytes = integer(lengthBytes, 'lengthBytes', 1, 6);
    this.lengthOffset = integer(lengthOffset, 'lengthOffset', 0);
    this.packetOverhead = integer(packetOverhead, 'packetOverhead', 0);
    this.maxLen = integer(maxLen, 'maxLen', 0, Number.MAX_SAFE_INTEGER - packetOverhead);
    this.#delimiters = new Set(Array.isArray(delimiter) ? delimiter : [delimiter]);
    if (!this.#delimiters.size) throw new TypeError('delimiter must not be empty');
    for (const value of this.#delimiters) {
      integer(value, 'delimiter', 0, 2 ** (delimiterBytes * 8) - 1);
      if (this.#delimiters.size === 1) {
        this.#marker = Buffer.alloc(this.delimiterBytes);
        this.#marker.writeUIntBE(value, 0, this.delimiterBytes);
      }
    }
  }

  #findDelimiter(span: Buffer, start: number, width: number): number {
    if (this.#delimiters.has(span.readUIntBE(start, width))) return start;
    if (this.#marker?.length === width) {
      const index = span.indexOf(width === 1 ? this.#marker[0] : this.#marker, start + 1);
      return index > span.length - width ? -1 : index;
    }
    for (let i = start + 1; i <= span.length - width; i++) {
      if (this.#delimiters.has(span.readUIntBE(i, width))) return i;
    }
    return -1;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.#bytes.append(chunk);
    for (;;) {
      let header: Buffer | undefined;
      let headerOffset = 0;
      if (!this.#started) {
        while (this.#bytes.length >= this.delimiterBytes) {
          const width = this.delimiterBytes;
          let span = this.#bytes.headChunk;
          let offset = this.#bytes.headOffset;
          if (span.length - offset < width) {
            span = this.#bytes.peek(width);
            offset = 0;
          }
          const index = this.#findDelimiter(span, offset, width);
          if (index !== -1) {
            header = span;
            headerOffset = index;
            if (index !== offset) this.#bytes.discard(index - offset);
            this.#started = true;
            break;
          }
          // Keep the suffix which may begin a marker in the next chunk.
          this.#bytes.discard(span.length - offset - width + 1);
        }
        if (!this.#started) break;
      }
      if (!this.#length) {
        const headerLength = Math.max(this.delimiterBytes + 1, this.lengthOffset + this.lengthBytes);
        if (this.#bytes.length < headerLength) break;
        const payload =
          header && headerOffset + headerLength <= header.length
            ? header.readUIntLE(headerOffset + this.lengthOffset, this.lengthBytes)
            : this.#bytes.peek(headerLength).readUIntLE(this.lengthOffset, this.lengthBytes);
        // Preserve early emission of invalid lengths without buffering an impossible frame.
        this.#length = payload > this.maxLen ? headerLength : Math.max(headerLength, payload + this.packetOverhead);
      }
      if (this.#bytes.length < this.#length) break;
      this.push(this.#bytes.take(this.#length));
      this.#length = 0;
      this.#started = false;
    }
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#bytes.take());
    callback();
  }
}

export { PacketLengthParser };
