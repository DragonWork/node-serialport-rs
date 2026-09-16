// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {spawnSync} = require('node:child_process');
const {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmdirSync, unlinkSync} = require('node:fs');
const {join, resolve} = require('node:path');
const {withBuildLock, cleanRelease} = require('./build-state');

const root = join(__dirname, '..');
if (process.argv.slice(2).some(option => !['--debug', '--bench'].includes(option))) throw new Error('Unknown build option');
const debug = process.argv.includes('--debug');
const bench = process.argv.includes('--bench');
if (debug && bench) throw new Error('Benchmarks require a release build');
const buildProfile = debug ? 'debug' : 'release';
const args = debug ? ['build', '--locked'] : ['build', '--release', '--locked'];
if (bench) args.push('--lib', '--example', 'echo');
const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
const target = process.env.CARGO_BUILD_TARGET || '';
if (target && !/^[a-z0-9_]+(?:-[a-z0-9_]+)+$/.test(target)) throw new Error('Pass a Rust target triple in CARGO_BUILD_TARGET');
withBuildLock(root, () => {
  const result = spawnSync('cargo', args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; return; }
  const library = process.platform === 'win32' ? 'node_serialport_rs.dll'
    : process.platform === 'darwin' ? 'libnode_serialport_rs.dylib' : 'libnode_serialport_rs.so';
  const output = join(root, 'native');
  mkdirSync(output, {recursive: true});
  const temporary = mkdtempSync(join(output, '.build-'));
  const staged = join(temporary, 'serialport-rs.node');
  try {
    copyFileSync(join(targetDirectory, target, buildProfile, library), staged);
    chmodSync(staged, 0o644);
    const checked = spawnSync(process.execPath, ['-e', 'if (typeof require(process.argv[1]).NativePort !== "function") process.exit(1)', staged],
      {cwd: root, stdio: 'inherit'});
    if (checked.error) throw checked.error;
    if (checked.status !== 0) throw new Error('Native addon load check failed');
    // Preserve mappings held by running processes until the new library is complete.
    renameSync(staged, join(output, 'serialport-rs.node'));
  } finally {
    if (existsSync(staged)) unlinkSync(staged);
    rmdirSync(temporary);
  }
  if (!debug) cleanRelease(root, targetDirectory, target);
});
