// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { loadNative, selectTarget } = require('../lib/native');
const targets = require('../lib/targets.json');

function isolatedLoader({ platform = 'linux', arch = 'arm64', glibc = true, exists = () => true } = {}) {
  const module = { exports: {} };
  let loaded;
  runInNewContext(readFileSync(require.resolve('../lib/native'), 'utf8'), {
    module,
    exports: module.exports,
    __dirname: join(__dirname, '../lib'),
    process: {
      platform,
      arch,
      config: { variables: {} },
      report: { getReport: () => ({ header: { glibcVersionRuntime: glibc && '2.31' } }) },
    },
    require(name) {
      if (name === 'node:fs') return { existsSync: exists };
      if (name === './targets.json') return targets;
      if (name.endsWith('.node')) {
        loaded = name;
        return { NativePort: class {} };
      }
      return require(name);
    },
  });
  module.exports.loadNative();
  return loaded;
}

test('every release target maps back to its platform-specific binary', () => {
  assert.equal(new Set(targets.map((entry) => entry.target)).size, targets.length);
  for (const entry of targets) assert.equal(selectTarget(entry), entry.target);
});

test('ARM selection respects the minimum instruction set and libc', () => {
  assert.equal(selectTarget({ platform: 'linux', arch: 'arm', arm: 6, libc: 'gnu' }), 'arm-unknown-linux-gnueabihf');
  assert.equal(selectTarget({ platform: 'linux', arch: 'arm', arm: 8, libc: 'gnu' }), 'armv7-unknown-linux-gnueabihf');
  assert.equal(selectTarget({ platform: 'linux', arch: 'arm', arm: 6, libc: 'musl' }), 'arm-unknown-linux-musleabihf');
  assert.equal(selectTarget({ platform: 'linux', arch: 'x64', libc: 'musl' }), 'x86_64-unknown-linux-musl');
  assert.equal(selectTarget({ platform: 'unknown', arch: 'x64' }), undefined);
  assert.equal(selectTarget({ platform: 'linux', arch: 'ppc64', libc: 'gnu', endian: 'BE' }), undefined);
  assert.equal(
    selectTarget({ platform: 'linux', arch: 's390x', libc: 'gnu', endian: 'BE' }),
    's390x-unknown-linux-gnu',
  );
});

test('the native loader resolves serialport-rs.node', () => {
  assert.equal(typeof loadNative().NativePort, 'function');
  assert(
    Object.keys(require.cache).some(
      (file) => file.endsWith('/serialport-rs.node') || file.endsWith('\\serialport-rs.node'),
    ),
  );
});

test('packaged loading distinguishes glibc and musl and prefers a local build', () => {
  const local = join(__dirname, '../native/serialport-rs.node');
  assert.equal(isolatedLoader(), local);
  for (const glibc of [true, false]) {
    const target = `aarch64-unknown-linux-${glibc ? 'gnu' : 'musl'}`;
    const file = join(__dirname, '../native', target, 'serialport-rs.node');
    assert.equal(isolatedLoader({ glibc, exists: (candidate) => candidate === file }), file);
  }
  assert.throws(() => isolatedLoader({ exists: () => false }), /No serialport-rs native build/);
});

test('release validation accepts this binary and rejects a mismatched architecture', () => {
  const { checkNative } = require('../scripts/check-native');
  const file = Object.keys(require.cache).find((file) => file.endsWith('serialport-rs.node'));
  assert(file);
  checkNative(file, { platform: process.platform, arch: process.arch });
  assert.throws(
    () => checkNative(file, { platform: process.platform, arch: process.arch === 'arm64' ? 'x64' : 'arm64' }),
    /Wrong (CPU|ELF class)/,
  );
});

test('ELF validation checks new CPU IDs, word sizes and s390x byte order', (t) => {
  const { checkNative } = require('../scripts/check-native');
  const directory = mkdtempSync(join(tmpdir(), 'serialport-elf-'));
  t.after(() => rmSync(directory, { recursive: true }));
  for (const [arch, bits, endian, machine] of [
    ['ia32', 1, 1, 3],
    ['ppc64', 2, 1, 21],
    ['s390x', 2, 2, 22],
    ['riscv64', 2, 1, 243],
  ]) {
    const header = Buffer.alloc(64);
    header.write('7f454c46', 0, 'hex');
    header[4] = bits;
    header[5] = endian;
    if (endian === 1) header.writeUInt16LE(machine, 18);
    else header.writeUInt16BE(machine, 18);
    const file = join(directory, arch);
    writeFileSync(file, header);
    checkNative(file, { platform: 'linux', arch });
    header[5] = endian === 1 ? 2 : 1;
    writeFileSync(file, header);
    assert.throws(() => checkNative(file, { platform: 'linux', arch }), /Wrong ELF byte order/);
  }
});
