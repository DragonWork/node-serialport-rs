// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {copyFileSync, chmodSync, mkdirSync} = require('node:fs');
const {join} = require('node:path');
const {checkNative} = require('./check-native');
const target = require('../lib/targets.json').find(entry => entry.target === process.argv[2]);
assert(target, 'Pass a supported Rust target');
const library = target.platform === 'win32' ? 'node_serialport_rs.dll'
  : target.platform === 'darwin' ? 'libnode_serialport_rs.dylib' : 'libnode_serialport_rs.so';
const root = join(__dirname, '..');
const output = join(root, 'native', target.target);
mkdirSync(output, {recursive: true});
const binary = join(output, 'serialport-rs.node');
const input = join(root, 'target', target.target, 'release', library);
checkNative(input, target);
copyFileSync(input, binary);
chmodSync(binary, 0o644);
