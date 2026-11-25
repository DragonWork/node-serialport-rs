// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { releaseFiles } = require('./prepare-release');
const targets = require('../lib/targets.json');
const platformPackage = require('../lib/platform-package.cjs');
const notices = ['LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md'];

function packInfo(json) {
  const data = JSON.parse(json);
  const entries = Array.isArray(data) ? data : Object.values(data);
  assert.equal(entries.length, 1, 'Expected exactly one npm package');
  return entries[0];
}

function checkFiles(files) {
  const paths = files.map(file => file.path);
  for (const name of [
    'index.js',
    'index.d.ts',
    'lib/targets.json',
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_LICENSES.md',
  ]) {
    assert(paths.includes(name), `Missing package asset: ${name}`);
  }
  for (const path of paths) {
    assert(!/^(ts|src|test|scripts|node_modules)\//.test(path), `Development source in package: ${path}`);
    assert(
      !/\.(rs|map)$/.test(path) && (!path.endsWith('.ts') || path.endsWith('.d.ts')),
      `Uncompiled source in package: ${path}`,
    );
  }
}

function pack(cwd, directory, version) {
  const cli = process.env.npm_execpath;
  assert(cli, 'Run this script with npm run pack:release');
  const info = packInfo(
    execFileSync(process.execPath, [cli, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
      cwd,
      encoding: 'utf8',
    }),
  );
  assert.equal(info.version, version);
  assert.equal(basename(info.filename), info.filename);
  assert(info.filename.endsWith('.tgz'));
  const bytes = readFileSync(join(directory, info.filename));
  assert.equal(info.integrity, 'sha512-' + createHash('sha512').update(bytes).digest('base64'));
  return info;
}

function packRegistry(root, directory, files, pkg) {
  const stage = mkdtempSync(join(tmpdir(), 'serialport-rs-pack-'));
  const packages = [];
  const optionalDependencies = {};
  function packManifest(dir, manifest, expected) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const { name, filename, integrity, files } = pack(dir, directory, pkg.version);
    assert.equal(name, manifest.name);
    assert.deepEqual(files.map(f => f.path).sort(), [...expected, 'package.json'].sort());
    packages.push({ name, filename, integrity });
  }
  function copy(dir, source, destination) {
    const file = join(dir, destination);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(root, source), file);
  }
  try {
    for (const [name, group] of Map.groupBy(targets, platformPackage)) {
      const { platform, arch, libc } = group[0];
      const dir = join(stage, name.split('/')[1]);
      const expected = [...notices];
      for (const file of notices) copy(dir, file, file);
      for (const { target } of group) {
        const file = `${target}/serialport-rs.node`;
        copy(dir, 'native/' + file, file);
        expected.push(file);
      }
      packManifest(
        dir,
        {
          name,
          version: pkg.version,
          description: `Native addon for serialport-rs on ${name.split('/')[1]}`,
          license: pkg.license,
          repository: pkg.repository,
          publishConfig: { access: 'public' },
          os: [platform],
          cpu: [arch],
          ...(libc && { libc: [libc === 'gnu' ? 'glibc' : libc] }),
        },
        expected,
      );
      optionalDependencies[name] = pkg.version;
    }
    const parent = join(stage, pkg.name);
    const expected = files.map(f => f.path).filter(file => file !== 'package.json' && !file.startsWith('native/'));
    for (const file of expected) copy(parent, file, file);
    packManifest(parent, { ...pkg, files: pkg.files.filter(f => f !== 'native'), optionalDependencies }, expected);
    return packages;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function packageRelease(output = 'artifacts') {
  const root = join(__dirname, '..');
  const directory = resolve(root, output);
  const prepared = JSON.parse(readFileSync(join(directory, 'prepared-release.json'), 'utf8'));
  assert.deepEqual(Object.keys(prepared.files).sort(), [...releaseFiles].sort(), 'Unexpected prepared release files');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(commit, prepared.commit, 'Checkout changed after release preparation');
  for (const [name, content] of Object.entries(prepared.files)) {
    assert.equal(readFileSync(join(root, name), 'utf8'), content, `Release file changed after preparation: ${name}`);
  }
  execFileSync(process.execPath, [join(__dirname, 'build-js.js')], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [join(__dirname, 'check-package.js'), '--prebuilds'], { cwd: root, stdio: 'inherit' });
  mkdirSync(directory, { recursive: true });
  // Build and validate first; keep stdout as pack metadata during archiving.
  const info = pack(root, directory, prepared.version);
  checkFiles(info.files);
  assert.deepEqual(
    info.files
      .map(f => f.path)
      .filter(f => f.startsWith('native/'))
      .sort(),
    targets.map(t => `native/${t.target}/serialport-rs.node`).sort(),
  );
  const bytes = readFileSync(join(directory, info.filename));
  assert(bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8 && bytes[8] === 2, 'Expected gzip level 9');
  const filename = info.filename.slice(0, -4) + '.tar.gz';
  renameSync(join(directory, info.filename), join(directory, filename));
  chmodSync(join(directory, filename), 0o644);
  const packages = packRegistry(root, directory, info.files, JSON.parse(prepared.files['package.json']));
  const expected = process.env.RELEASE_COMMIT || process.env.GITHUB_SHA;
  if (expected) assert.equal(commit, expected, 'Checkout changed during release');
  const metadata = {
    name: info.name,
    version: info.version,
    tag: `v${info.version}`,
    distTag: info.version.includes('-') ? 'next' : 'latest',
    commit,
    filename,
    packages,
    notes: prepared.notes,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assert.equal(metadata.integrity, info.integrity, 'Packed archive changed');
  writeFileSync(join(directory, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}

if (require.main === module) console.log(JSON.stringify(packageRelease(process.argv[2]), null, 2));
module.exports = { packInfo, checkFiles, packageRelease };
