// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import type { ReadyParserOptions } from '../../public-api';
import { DelimiterMatcher } from './bytes';

class ReadyParser extends Transform {
  #matcher: DelimiterMatcher;
  declare delimiter: Buffer;
  ready = false;

  constructor({ delimiter, ...options }: Partial<ReadyParserOptions> = {}) {
    super(options);
    this.#matcher = new DelimiterMatcher(delimiter);
    this.delimiter = this.#matcher.delimiter;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    const offset = this.ready ? 0 : this.#matcher.find(chunk);
    if (offset !== -1) {
      if (!this.ready) {
        this.ready = true;
        this.emit('ready');
      }
      if (offset < chunk.length) this.push(chunk.subarray(offset));
    }
    callback();
  }
}

export { ReadyParser };
