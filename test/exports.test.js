// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
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
  ].sort();
  assert.deepEqual(Object.keys(library).sort(), names);
  const esm = await import(pathToFileURL(require.resolve('..')).href);
  for (const name of names) assert.equal(esm[name], library[name], name);
});
