// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync} = require('node:fs');
const {isAbsolute, join, relative, resolve, sep} = require('node:path');

function withBuildLock(root, operation) {
  root = realpathSync(root);
  const target = join(root, 'target');
  mkdirSync(target, {recursive: true});
  assert.equal(realpathSync(target), target, 'Build target must not be a symlink');
  const lock = join(target, '.serialport-build.lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Build lock exists: ${lock}. Check its pid file before removing an interrupted build's lock.`);
    throw error;
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return operation();
  } finally { rmSync(lock, {recursive: true}); }
}

function cleanRelease(root, targetDirectory, target = '') {
  const withinRoot = relative(resolve(root), resolve(targetDirectory));
  if (isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith(`..${sep}`)) return;
  root = realpathSync(root);
  const base = resolve(root, 'target');
  const directory = resolve(root, withinRoot, target, 'release');
  const path = relative(base, directory);
  // Caller-provided caches outside this checkout may contain unrelated active lanes.
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) return;
  assert(path && directory.endsWith(`${sep}release`), 'Refusing an unscoped cache cleanup');
  if (!existsSync(directory)) return;
  const owner = lstatSync(base);
  assert.equal(realpathSync(directory), directory, 'Release cache must not contain symlink parents');
  const paths = [];
  function inspect(path) {
    const info = lstatSync(path);
    assert(!info.isSymbolicLink() && info.dev === owner.dev && info.uid === owner.uid,
      `Unexpected ownership, mount or symlink in release cache: ${path}`);
    assert(info.isDirectory() || info.isFile(), `Unexpected special file in release cache: ${path}`);
    assert(!/\.(profraw|profdata)$/.test(path), 'Preserve PGO profiles and finish their workflow before cleanup');
    if (info.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
    paths.push([path, info.isDirectory()]);
  }
  inspect(directory);
  const helpers = new Set(['echo', 'echo.exe', 'pty', 'pty.exe'].map(name => join(directory, 'examples', name)));
  for (const [path, isDirectory] of paths) {
    if (helpers.has(path)) continue;
    if (!isDirectory || readdirSync(path).length === 0) rmSync(path, {recursive: isDirectory});
  }
}

module.exports = {withBuildLock, cleanRelease};
