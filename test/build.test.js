// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {withBuildLock, cleanRelease} = require('../scripts/build-state');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'serialport-build-'));
  t.after(() => rmSync(root, {recursive: true}));
  function file(path, data = 'fixture') {
    const parts = path.split('/');
    const name = parts.pop();
    mkdirSync(join(root, ...parts), {recursive: true});
    writeFileSync(join(root, ...parts, name), data);
  }
  return {root, file};
}

test('release cleanup removes matching debug caches and retains helpers and other lanes', t => {
  const {root, file} = fixture(t);
  for (const path of ['target/release/deps/cache.rlib', 'target/release/examples/echo',
    'target/release/examples/echo.d', 'target/debug/deps/cache.rlib', 'target/debug/examples/pty',
    'target/other/debug/deps/cache.rlib', 'native/serialport-rs.node']) file(path);
  withBuildLock(root, () => cleanRelease(root, join(root, 'target')));
  assert(!existsSync(join(root, 'target/release/deps')));
  assert(!existsSync(join(root, 'target/release/examples/echo.d')));
  assert(!existsSync(join(root, 'target/debug/deps')));
  for (const path of ['target/release/examples/echo', 'target/debug/examples/pty', 'target/other/debug/deps/cache.rlib', 'native/serialport-rs.node']) {
    assert.equal(readFileSync(join(root, path), 'utf8'), 'fixture');
  }
});

test('release cleanup validates debug state before deleting release caches', {skip: process.platform === 'win32'}, t => {
  const {root, file} = fixture(t);
  file('target/release/cache.rlib');
  file('target/debug/cache.rlib');
  file('outside/keep');
  symlinkSync(join(root, 'outside'), join(root, 'target/debug/link'));
  assert.throws(() => cleanRelease(root, join(root, 'target')), /symlink/);
  assert(existsSync(join(root, 'target/release/cache.rlib')));
  assert(existsSync(join(root, 'target/debug/cache.rlib')));
  assert(existsSync(join(root, 'outside/keep')));
});

test('release cleanup preserves caller-managed external caches', t => {
  const {root, file} = fixture(t);
  file('external/release/cache.rlib');
  cleanRelease(root, join(root, 'external'));
  assert(existsSync(join(root, 'external/release/cache.rlib')));
});

test('build state handles a symlinked checkout without following cache symlinks', {skip: process.platform === 'win32'}, t => {
  const {root, file} = fixture(t);
  file('checkout/target/release/cache.rlib');
  const alias = join(root, 'alias');
  symlinkSync(join(root, 'checkout'), alias);
  withBuildLock(alias, () => cleanRelease(alias, join(alias, 'target')));
  assert(!existsSync(join(root, 'checkout/target/release')));
});

test('release cleanup rejects symlinks before removing any build state', {skip: process.platform === 'win32'}, t => {
  const {root, file} = fixture(t);
  file('target/release/cache.rlib');
  file('outside/keep');
  symlinkSync(join(root, 'outside'), join(root, 'target/release/link'));
  assert.throws(() => cleanRelease(root, join(root, 'target')), /symlink/);
  assert(existsSync(join(root, 'target/release/cache.rlib')));
  assert(existsSync(join(root, 'outside/keep')));
});

test('release cleanup preserves collected PGO profiles and resumable state', t => {
  const {root, file} = fixture(t);
  file('target/release/cache.rlib');
  file('target/release/training.profdata');
  assert.throws(() => cleanRelease(root, join(root, 'target')), /PGO/);
  assert(existsSync(join(root, 'target/release/cache.rlib')));
  assert(existsSync(join(root, 'target/release/training.profdata')));
});

test('build locks prevent overlap and release after failures without removing caches', t => {
  const {root, file} = fixture(t);
  file('target/release/cache.rlib');
  const failure = new Error('compile failed');
  assert.throws(() => withBuildLock(root, () => {
    assert.throws(() => withBuildLock(root, () => {}), /Build lock exists/);
    assert(existsSync(join(root, 'target/.serialport-build.lock/pid')));
    throw failure;
  }), error => error === failure);
  assert(!existsSync(join(root, 'target/.serialport-build.lock')));
  assert(existsSync(join(root, 'target/release/cache.rlib')));
  withBuildLock(root, () => {});
});
