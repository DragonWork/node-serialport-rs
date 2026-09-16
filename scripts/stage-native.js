// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {checkNative} = require('./check-native');
const {withBuildLock, cleanRelease} = require('./build-state');
const target = require('../lib/targets.json').find(entry => entry.target === process.argv[2]);
assert(target, 'Pass a supported Rust target');
const library = target.platform === 'win32' ? 'node_serialport_rs.dll'
  : target.platform === 'darwin' ? 'libnode_serialport_rs.dylib' : 'libnode_serialport_rs.so';
const root = join(__dirname, '..');
withBuildLock(root, () => {
  const output = join(root, 'native', target.target);
  mkdirSync(output, {recursive: true});
  const binary = join(output, 'serialport-rs.node');
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
  const input = join(targetDirectory, target.target, 'release', library);
  const temporary = mkdtempSync(join(output, '.build-'));
  const staged = join(temporary, 'serialport-rs.node');
  try {
    copyFileSync(input, staged);
    checkNative(staged, target);
    chmodSync(staged, 0o644);
    renameSync(staged, binary);
  } finally {
    if (existsSync(staged)) unlinkSync(staged);
    rmdirSync(temporary);
  }
  cleanRelease(root, targetDirectory, target.target);
  // Cargo's host build scripts and proc macros also use the release profile.
  cleanRelease(root, targetDirectory);
});
