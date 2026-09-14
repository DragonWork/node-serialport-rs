// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Transform} = require('node:stream');
const {DelimiterMatcher} = require('./bytes');

class ReadyParser extends Transform {
  #matcher;
  ready = false;

  constructor({delimiter, ...options} = {}) {
    super(options);
    this.#matcher = new DelimiterMatcher(delimiter);
    this.delimiter = this.#matcher.delimiter;
  }

  _transform(chunk, encoding, callback) {
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

module.exports = {ReadyParser};
