// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {Transform, type TransformCallback} from 'node:stream';
import type {InterByteTimeoutOptions} from '../../public-api';
import {ByteQueue, integer} from './bytes';

class InterByteTimeoutParser extends Transform {
  #bytes = new ByteQueue();
  #timer?: NodeJS.Timeout;
  declare interval: number;
  declare maxBufferSize: number;

  constructor({interval, maxBufferSize = 65536, ...options}: Partial<InterByteTimeoutOptions> = {}) {
    super(options);
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 1) throw new TypeError('Invalid interval');
    this.interval = interval;
    this.maxBufferSize = integer(maxBufferSize, 'maxBufferSize');
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(this.maxBufferSize - this.#bytes.length, chunk.length - offset);
      this.#bytes.append(chunk.subarray(offset, offset + count));
      offset += count;
      if (this.#bytes.length === this.maxBufferSize) this.emitPacket();
    }
    if (this.#bytes.length) {
      if (this.#timer) this.#timer.refresh();
      else this.#timer = setTimeout(() => this.emitPacket(), this.interval);
    }
    callback();
  }

  emitPacket() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#bytes.length) this.push(this.#bytes.take());
  }

  _flush(callback: TransformCallback) {
    this.emitPacket();
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#bytes.clear();
    callback(error);
  }
}

export {InterByteTimeoutParser};
