// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {Transform, type TransformCallback} from 'node:stream';
import type {DelimiterOptions} from '../../public-api';
import {ByteQueue, DelimiterMatcher} from './bytes';

class DelimiterParser extends Transform {
  #bytes = new ByteQueue();
  #matcher: DelimiterMatcher;
  declare delimiter: Buffer;
  declare includeDelimiter: boolean;

  constructor({delimiter, includeDelimiter = false, ...options}: Partial<DelimiterOptions> = {}) {
    super(options);
    this.#matcher = new DelimiterMatcher(delimiter);
    this.delimiter = this.#matcher.delimiter;
    this.includeDelimiter = includeDelimiter;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    let offset = 0;
    let end;
    while ((end = this.#matcher.find(chunk, offset)) !== -1) {
      const excluded = this.includeDelimiter ? 0 : this.delimiter.length;
      if (this.#bytes.length) {
        this.#bytes.append(chunk.subarray(offset, end));
        this.push(this.#bytes.take(this.#bytes.length - excluded));
        this.#bytes.clear();
      } else this.push(chunk.subarray(offset, end - excluded));
      offset = end;
    }
    this.#bytes.append(chunk.subarray(offset));
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#bytes.take());
    callback();
  }
}

export {DelimiterParser};
