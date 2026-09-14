// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {DelimiterParser} = require('./delimiter');

class ReadlineParser extends DelimiterParser {
  constructor({encoding = 'utf8', delimiter = '\n', ...options} = {}) {
    super({ ...options, encoding, delimiter: typeof delimiter === 'string' ? Buffer.from(delimiter, encoding) : delimiter });
  }
}

module.exports = {ReadlineParser};
