// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { checkNative } = require('./check-native');
const root = join(__dirname, '..');
for (const file of ['index.js', 'index.d.ts', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md']) {
  assert.ok(statSync(join(root, file)).isFile(), `Missing package file: ${file}`);
}
const library = require(root);
if (process.argv.includes('--prebuilds')) {
  assert(
    !existsSync(join(root, 'native', 'serialport-rs.node')),
    'Release package must not contain a local-only native build',
  );
  for (const entry of require('../lib/targets.json')) {
    const file = join(root, 'native', entry.target, 'serialport-rs.node');
    assert(statSync(file).isFile(), `Missing native build: ${entry.target}`);
    checkNative(file, entry);
  }
}
assert.equal(typeof require('../lib/native').loadNative().NativePort, 'function');
assert.equal(typeof library.SerialPort, 'function');
assert.equal(typeof library.SerialPortMock, 'function');
assert.equal(library.SerialPort.binding, library.autoDetect());
assert.equal(library.SerialPortMock.list, library.SerialPortMock.binding.list);
assert.equal(require('../package.json').license, 'Apache-2.0');
