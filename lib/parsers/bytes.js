// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const EMPTY = Buffer.alloc(0);

// Keep incoming chunks intact; copy only a frame that spans chunk boundaries.
class ByteQueue {
  #chunks = [];
  #head = 0;
  length = 0;

  append(buffer) {
    if (buffer.length) {
      this.#chunks.push(buffer);
      this.length += buffer.length;
    }
  }

  peek(length) {
    if (!length) return EMPTY;
    if (length > this.length) throw new RangeError('Not enough buffered bytes');
    const first = this.#chunks[this.#head];
    if (first.length >= length) return first.subarray(0, length);
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    for (let i = this.#head; offset < length; i++) {
      offset += this.#chunks[i].copy(result, offset, 0, length - offset);
    }
    return result;
  }

  take(length = this.length) {
    const result = this.peek(length);
    this.discard(length);
    return result;
  }

  discard(length) {
    if (length > this.length || length < 0) throw new RangeError('Invalid byte count');
    this.length -= length;
    while (length) {
      const first = this.#chunks[this.#head];
      if (length < first.length) {
        this.#chunks[this.#head] = first.subarray(length);
        break;
      }
      length -= first.length;
      this.#chunks[this.#head++] = undefined;
    }
    if (!this.length) this.clear();
    else if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  clear() {
    this.#chunks = [];
    this.#head = 0;
    this.length = 0;
  }
}

class DelimiterMatcher {
  #prefix;
  #matched = 0;

  constructor(delimiter) {
    if (delimiter === undefined) throw new TypeError('delimiter is required');
    this.delimiter = Buffer.from(delimiter);
    if (!this.delimiter.length) throw new TypeError('delimiter must not be empty');
    this.#prefix = new Uint32Array(this.delimiter.length);
    for (let i = 1, matched = 0; i < this.delimiter.length; i++) {
      while (matched && this.delimiter[i] !== this.delimiter[matched]) matched = this.#prefix[matched - 1];
      if (this.delimiter[i] === this.delimiter[matched]) matched++;
      this.#prefix[i] = matched;
    }
  }

  #advance(byte) {
    while (this.#matched && byte !== this.delimiter[this.#matched]) this.#matched = this.#prefix[this.#matched - 1];
    if (byte === this.delimiter[this.#matched]) this.#matched++;
    if (this.#matched !== this.delimiter.length) return false;
    this.#matched = 0;
    return true;
  }

  // Return the end of the next delimiter, retaining only a partial prefix.
  find(chunk, offset = 0) {
    while (offset < chunk.length && this.#matched) {
      if (this.#advance(chunk[offset++])) return offset;
    }
    if (offset === chunk.length) return -1;
    const found = chunk.indexOf(this.delimiter, offset);
    if (found !== -1) return found + this.delimiter.length;
    // Buffer.indexOf handled complete matches; only the suffix can span chunks.
    for (let i = Math.max(offset, chunk.length - this.delimiter.length + 1); i < chunk.length; i++) {
      this.#advance(chunk[i]);
    }
    return -1;
  }
}

function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  return value;
}

module.exports = {ByteQueue, DelimiterMatcher, integer};
