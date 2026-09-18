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
  // A successful release supersedes compiler state in this same target lane.
  // Other target directories may belong to active development work.
  const profiles = [directory, resolve(directory, '..', 'debug')].filter(existsSync);
  if (!profiles.length) return;
  const owner = lstatSync(base);
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
  for (const profile of profiles) {
    assert.equal(realpathSync(profile), profile, 'Build cache must not contain symlink parents');
    inspect(profile);
  }
  const helpers = new Set(profiles.flatMap(profile => ['echo', 'echo.exe', 'pty', 'pty.exe'].map(name => join(profile, 'examples', name))));
  for (const [path, isDirectory] of paths) {
    if (helpers.has(path)) continue;
    if (!isDirectory || readdirSync(path).length === 0) rmSync(path, {recursive: isDirectory});
  }
}

module.exports = {withBuildLock, cleanRelease};
