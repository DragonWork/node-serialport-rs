// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Transform} = require('node:stream');
const {ByteQueue, integer} = require('./bytes');

class PacketLengthParser extends Transform {
  #bytes = new ByteQueue();
  #delimiters;
  #started = false;
  #length = 0;

  constructor({delimiter = 0xaa, delimiterBytes = 1, packetOverhead = 2,
    lengthBytes = 1, lengthOffset = 1, maxLen = 255, ...options} = {}) {
    super(options);
    this.delimiterBytes = integer(delimiterBytes, 'delimiterBytes', 1, 6);
    this.lengthBytes = integer(lengthBytes, 'lengthBytes', 1, 6);
    this.lengthOffset = integer(lengthOffset, 'lengthOffset', 0);
    this.packetOverhead = integer(packetOverhead, 'packetOverhead', 0);
    this.maxLen = integer(maxLen, 'maxLen', 0, Number.MAX_SAFE_INTEGER - packetOverhead);
    this.#delimiters = new Set(Array.isArray(delimiter) ? delimiter : [delimiter]);
    if (!this.#delimiters.size) throw new TypeError('delimiter must not be empty');
    for (const value of this.#delimiters) integer(value, 'delimiter', 0, 2 ** (delimiterBytes * 8) - 1);
  }

  _transform(chunk, encoding, callback) {
    this.#bytes.append(chunk);
    for (;;) {
      if (!this.#started) {
        while (this.#bytes.length >= this.delimiterBytes) {
          if (this.#delimiters.has(this.#bytes.peek(this.delimiterBytes).readUIntBE(0, this.delimiterBytes))) {
            this.#started = true;
            break;
          }
          this.#bytes.discard(1);
        }
        if (!this.#started) break;
      }
      if (!this.#length) {
        const headerLength = Math.max(this.delimiterBytes + 1, this.lengthOffset + this.lengthBytes);
        if (this.#bytes.length < headerLength) break;
        const payload = this.#bytes.peek(headerLength).readUIntLE(this.lengthOffset, this.lengthBytes);
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

  _flush(callback) {
    this.push(this.#bytes.take());
    callback();
  }
}

module.exports = {PacketLengthParser};
