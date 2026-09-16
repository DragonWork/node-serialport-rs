// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} = require('node:fs');
const {basename, join, resolve} = require('node:path');

function packInfo(json) {
  const data = JSON.parse(json);
  const entries = Array.isArray(data) ? data : Object.values(data);
  assert.equal(entries.length, 1, 'Expected exactly one npm package');
  return entries[0];
}

function checkFiles(files) {
  const paths = files.map(file => file.path);
  for (const name of ['index.js', 'index.d.ts', 'lib/targets.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md']) {
    assert(paths.includes(name), `Missing package asset: ${name}`);
  }
  for (const path of paths) {
    assert(!/^(ts|src|test|scripts|node_modules)\//.test(path), `Development source in package: ${path}`);
    assert(!/\.(rs|map)$/.test(path) && (!path.endsWith('.ts') || path.endsWith('.d.ts')), `Uncompiled source in package: ${path}`);
  }
}

function packageRelease(output = 'artifacts') {
  const root = join(__dirname, '..');
  const directory = resolve(root, output);
  const npmCli = process.env.npm_execpath;
  assert(npmCli, 'Run this script with npm run pack:release');
  execFileSync(process.execPath, [join(__dirname, 'build-js.js')], {cwd: root, stdio: 'inherit'});
  execFileSync(process.execPath, [join(__dirname, 'check-package.js'), '--prebuilds'], {cwd: root, stdio: 'inherit'});
  mkdirSync(directory, {recursive: true});
  // Build and validate first; keep stdout as pack metadata during archiving.
  const info = packInfo(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], {cwd: root, encoding: 'utf8'}));
  checkFiles(info.files);
  assert.equal(basename(info.filename), info.filename);
  assert(info.filename.endsWith('.tgz'));
  const bytes = readFileSync(join(directory, info.filename));
  assert(bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8 && bytes[8] === 2, 'Expected gzip level 9');
  const filename = info.filename.slice(0, -4) + '.tar.gz';
  renameSync(join(directory, info.filename), join(directory, filename));
  chmodSync(join(directory, filename), 0o644);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA, 'Checkout changed during release');
  const metadata = {name: info.name, version: info.version, tag: `v${info.version}`,
    distTag: info.version.includes('-') ? 'next' : 'latest', commit, filename,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex')};
  assert.equal(metadata.integrity, info.integrity, 'Packed archive changed');
  writeFileSync(join(directory, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (require.main === module) console.log(JSON.stringify(packageRelease(process.argv[2]), null, 2));
module.exports = {packInfo, checkFiles, packageRelease};
