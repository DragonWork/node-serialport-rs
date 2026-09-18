// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import type { ByteLengthOptions } from '../../public-api';
import { ByteQueue, integer } from './bytes';

class ByteLengthParser extends Transform {
  #bytes = new ByteQueue();
  declare length: number;

  constructor(options: Partial<ByteLengthOptions> = {}) {
    super(options);
    this.length = integer(options.length, 'length');
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.#bytes.append(chunk);
    while (this.#bytes.length >= this.length) this.push(this.#bytes.take(this.length));
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#bytes.take());
    callback();
  }
}

export { ByteLengthParser };
