// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import type { BindingOpenOptions, SetOptions } from '../public-api';

const defaults = {
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  lock: true,
  rtscts: false,
  xon: false,
  xoff: false,
  xany: false,
  hupcl: true,
};

function snapshot<T extends object>(options: T): T {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Options must be an object');
  return { ...options };
}

function validateBaudRate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 0xffffffff)
    throw new TypeError('"baudRate" must be a positive 32-bit integer');
  return value;
}

function validateOptions<O extends Partial<BindingOpenOptions>>(options: O): O & Required<BindingOpenOptions> {
  // Read caller-owned properties once, then validate the values that will be used.
  const settings = { ...defaults, ...snapshot(options) };
  if (typeof settings.path !== 'string' || !settings.path || settings.path.includes('\0'))
    throw new TypeError('"path" must be a nonempty device path');
  validateBaudRate(settings.baudRate);
  if (![5, 6, 7, 8].includes(settings.dataBits)) throw new TypeError('Invalid dataBits');
  if (![1, 1.5, 2].includes(settings.stopBits)) throw new TypeError('Invalid stopBits');
  if (!['none', 'odd', 'even', 'mark', 'space'].includes(settings.parity)) throw new TypeError('Invalid parity');
  for (const key of ['lock', 'rtscts', 'xon', 'xoff', 'xany', 'hupcl'] as const) {
    if (typeof settings[key] !== 'boolean') throw new TypeError(`"${key}" must be a boolean`);
  }
  return settings as O & Required<BindingOpenOptions>;
}

function validateSetOptions(options: SetOptions): SetOptions {
  const flags = snapshot(options);
  for (const key of ['dtr', 'rts', 'brk', 'cts', 'dsr'] as const) {
    if (flags[key] !== undefined && typeof flags[key] !== 'boolean') throw new TypeError(`Invalid ${key}`);
  }
  return flags;
}

export { validateOptions, validateBaudRate, validateSetOptions };
