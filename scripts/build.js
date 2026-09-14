// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {spawnSync} = require('node:child_process');
const {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync} = require('node:fs');
const {join} = require('node:path');

const root = join(__dirname, '..');
if (process.argv.slice(2).some(option => option !== '--debug')) throw new Error('Unknown build option');
const debug = process.argv.includes('--debug');
const buildProfile = debug ? 'debug' : 'release';
const args = debug ? ['build', '--locked'] : ['build', '--release', '--locked'];
const result = spawnSync('cargo', args, {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const library = process.platform === 'win32' ? 'node_serialport_rs.dll'
  : process.platform === 'darwin' ? 'libnode_serialport_rs.dylib' : 'libnode_serialport_rs.so';
const output = join(root, 'native');
mkdirSync(output, {recursive: true});
const temporary = mkdtempSync(join(output, '.build-'));
const staged = join(temporary, 'serialport-rs.node');
try {
  copyFileSync(join(root, 'target', buildProfile, library), staged);
  chmodSync(staged, 0o644);
  // Preserve mappings held by running processes until the new library is complete.
  renameSync(staged, join(output, 'serialport-rs.node'));
} finally {
  if (existsSync(staged)) unlinkSync(staged);
  rmdirSync(temporary);
}
