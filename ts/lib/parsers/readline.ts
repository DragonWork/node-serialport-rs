// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {DelimiterParser} from './delimiter';
import type {ReadlineOptions} from '../../public-api';

class ReadlineParser extends DelimiterParser {
  constructor({encoding = 'utf8', delimiter = '\n', ...options}: ReadlineOptions = {}) {
    super({ ...options, encoding, delimiter: typeof delimiter === 'string' ? Buffer.from(delimiter, encoding) : delimiter });
  }
}

export {ReadlineParser};
