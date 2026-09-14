// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Transform} = require('node:stream');
const {StringDecoder} = require('node:string_decoder');

class RegexParser extends Transform {
  #decoder;
  #tail = '';

  constructor({regex, encoding = 'utf8', ...options} = {}) {
    super({...options, encoding});
    if (regex === undefined) throw new TypeError('regex is required');
    this.regex = regex instanceof RegExp ? regex : new RegExp(String(regex));
    this.#decoder = new StringDecoder(encoding);
  }

  _transform(chunk, encoding, callback) {
    const text = this.#tail + (typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
    const pieces = text.split(this.regex);
    this.#tail = pieces.pop() ?? '';
    for (const piece of pieces) this.push(piece);
    callback();
  }

  _flush(callback) {
    this.push(this.#tail + this.#decoder.end());
    this.#tail = '';
    callback();
  }
}

module.exports = {RegexParser};
