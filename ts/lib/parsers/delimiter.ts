// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {Transform, type TransformCallback} from 'node:stream';
import type {DelimiterOptions} from '../../public-api';
import {ByteQueue, DelimiterMatcher, integer} from './bytes';

class DelimiterParser extends Transform {
  #bytes = new ByteQueue();
  #matcher: DelimiterMatcher;
  #maxFrameLength?: number;
  declare delimiter: Buffer;
  declare includeDelimiter: boolean;

  constructor({delimiter, includeDelimiter = false, maxFrameLength, ...options}: Partial<DelimiterOptions> = {}) {
    super(options);
    this.#matcher = new DelimiterMatcher(delimiter);
    this.delimiter = this.#matcher.delimiter;
    this.includeDelimiter = includeDelimiter;
    this.#maxFrameLength = maxFrameLength === undefined ? undefined : integer(maxFrameLength, 'maxFrameLength', 0);
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    let offset = 0;
    let end;
    while ((end = this.#matcher.find(chunk, offset)) !== -1) {
      if (this.#maxFrameLength !== undefined && this.#bytes.length + end - offset - this.delimiter.length > this.#maxFrameLength) return callback(this.#overflow());
      const excluded = this.includeDelimiter ? 0 : this.delimiter.length;
      if (this.#bytes.length) {
        this.#bytes.append(chunk.subarray(offset, end));
        this.push(this.#bytes.take(this.#bytes.length - excluded));
        this.#bytes.clear();
      } else this.push(chunk.subarray(offset, end - excluded));
      offset = end;
    }
    // A suffix that could still be a delimiter is not payload until resolved.
    if (this.#maxFrameLength !== undefined && this.#bytes.length + chunk.length - offset - this.#matcher.pendingBytes > this.#maxFrameLength) return callback(this.#overflow());
    this.#bytes.append(chunk.subarray(offset));
    callback();
  }

  _flush(callback: TransformCallback) {
    if (this.#maxFrameLength !== undefined && this.#bytes.length > this.#maxFrameLength) return callback(this.#overflow());
    this.push(this.#bytes.take());
    callback();
  }

  #overflow() {
    this.#bytes.clear();
    return Object.assign(new RangeError('Frame exceeds maxFrameLength'), {code: 'ERR_SERIALPORT_FRAME_TOO_LARGE'});
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.#bytes.clear();
    callback(error);
  }
}

export {DelimiterParser};
