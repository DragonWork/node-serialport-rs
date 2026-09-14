// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Transform} = require('node:stream');
const {ByteQueue, integer} = require('./bytes');

class ByteLengthParser extends Transform {
  #bytes = new ByteQueue();

  constructor(options = {}) {
    super(options);
    this.length = integer(options.length, 'length');
  }

  _transform(chunk, encoding, callback) {
    this.#bytes.append(chunk);
    while (this.#bytes.length >= this.length) this.push(this.#bytes.take(this.length));
    callback();
  }

  _flush(callback) {
    this.push(this.#bytes.take());
    callback();
  }
}

module.exports = {ByteLengthParser};
