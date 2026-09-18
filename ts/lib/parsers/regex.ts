// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { RegexParserOptions } from '../../public-api';

class RegexParser extends Transform {
  #decoder: StringDecoder;
  #tail = '';
  declare regex: RegExp;

  constructor({ regex, encoding = 'utf8', ...options }: Partial<RegexParserOptions> = {}) {
    super({ ...options, encoding });
    if (regex === undefined) throw new TypeError('regex is required');
    this.regex = regex instanceof RegExp ? regex : new RegExp(String(regex));
    this.#decoder = new StringDecoder(encoding);
  }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
    const text = this.#tail + (typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
    const pieces = text.split(this.regex);
    this.#tail = pieces.pop() ?? '';
    for (const piece of pieces) this.push(piece);
    callback();
  }

  _flush(callback: TransformCallback) {
    this.push(this.#tail + this.#decoder.end());
    this.#tail = '';
    callback();
  }
}

export { RegexParser };
