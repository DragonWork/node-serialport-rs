// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import { ByteQueue } from './bytes';

class CCTalkParser extends Transform {
  #bytes = new ByteQueue();
  #last = 0;
  declare maxDelayBetweenBytesMs: number;

  constructor(maxDelayBetweenBytesMs = 50) {
    super();
    this.maxDelayBetweenBytesMs = maxDelayBetweenBytesMs;
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    if (this.maxDelayBetweenBytesMs > 0) {
      const now = performance.now();
      if (now - this.#last > this.maxDelayBetweenBytesMs) this.#bytes.clear();
      this.#last = now;
    }
    this.#bytes.append(chunk);
    while (this.#bytes.length >= 2) {
      const length = this.#bytes.peek(2)[1] + 5;
      if (this.#bytes.length < length) break;
      this.push(this.#bytes.take(length));
    }
    callback();
  }
}

export { CCTalkParser };
