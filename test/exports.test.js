// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { endianness } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const library = require('..');

const exports13 = [
  'SerialPort',
  'SerialPortMock',
  'ByteLengthParser',
  'CCTalkParser',
  'DelimiterParser',
  'InterByteTimeoutParser',
  'PacketLengthParser',
  'ReadlineParser',
  'ReadyParser',
  'RegexParser',
  'SlipEncoder',
  'SlipDecoder',
  'SpacePacketParser',
];

test('SerialPort 13 constructors are available through CommonJS and ESM named imports', async () => {
  const esm = await import(pathToFileURL(require.resolve('..')).href);
  for (const name of exports13) {
    assert.equal(typeof library[name], 'function', name);
    assert.equal(esm[name], library[name], name);
  }
});

test('static discovery functions can be passed around without a receiver', async () => {
  const { SerialPort, SerialPortMock } = library;
  const { list: listReal } = SerialPort;
  const { list: listMock } = SerialPortMock;
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort('/mock/discovery');
  assert.equal((await listMock())[0].path, '/mock/discovery');
  assert(Array.isArray(await listReal()));
});

test('public exports stay within the serial stream, binding and compatible parser API', async () => {
  const names = [
    ...exports13,
    'SerialPortStream',
    'DisconnectedError',
    'RustBinding',
    'BindingsError',
    'autoDetect',
    'MockBinding',
    'MockPortBinding',
    'CanceledError',
    'version',
  ].sort();
  assert.deepEqual(Object.keys(library).sort(), names);
  const esm = await import(pathToFileURL(require.resolve('..')).href);
  for (const name of names) assert.equal(esm[name], library[name], name);
});

test('version identifies the package and runtime through a frozen object', () => {
  const { version } = library;
  const manifest = require('../package.json');
  assert(Object.isFrozen(version));
  assert.equal(version.name, manifest.name);
  assert.equal(version.version, manifest.version);
  assert.equal(version.node, process.versions.node);
  assert.equal(version.napi, 8);
  assert.equal(version.platform, process.platform);
  assert.equal(version.arch, process.arch);
  assert.equal(version.endian, endianness());
  assert.equal(version.target, require('../lib/native').runtimeTarget().target);
  assert.equal(JSON.parse(JSON.stringify(version)).version, manifest.version);
  assert.throws(() => {
    version.arch = 'other';
  }, TypeError);
  assert.throws(() => {
    version.target = 'other';
  }, TypeError);
});

test('version metadata stays lazy and does not require a native binary', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, ...args) {
      if (request.endsWith('.node')) throw new Error('Unexpected native load');
      return original.call(this, request, ...args);
    };
    let reports = 0;
    process.report.getReport = () => {
      reports++;
      return { header: { glibcVersionRuntime: '2.31' } };
    };
    const { version } = require(process.argv[1]);
    assert.equal(reports, 0);
    assert.equal(version.arch, process.arch);
    assert.equal(reports, 0);
    const first = JSON.stringify(version);
    assert.equal(JSON.stringify(version), first);
    assert.equal(reports, process.platform === 'linux' ? 1 : 0);
  `,
      require.resolve('..'),
    ],
    { timeout: 5000 },
  );
});
