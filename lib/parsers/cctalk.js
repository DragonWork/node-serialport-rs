// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Transform} = require('node:stream');
const {ByteQueue} = require('./bytes');

class CCTalkParser extends Transform {
  #bytes = new ByteQueue();
  #last = 0;

  constructor(maxDelayBetweenBytesMs = 50) {
    super();
    this.maxDelayBetweenBytesMs = maxDelayBetweenBytesMs;
  }

  _transform(chunk, encoding, callback) {
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

module.exports = {CCTalkParser};
