// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {setImmediate: nextTurn} = require('node:timers/promises');
const {SerialPortStream, DisconnectedError, RustBinding} = require('..');
const {call} = require('./helpers');

function device(overrides = {}) {
  return {
    isOpen: true,
    async close() { this.isOpen = false; this.onClose?.(null); },
    read() { return new Promise(() => {}); },
    async write() {},
    ...overrides,
  };
}

function stream(...devices) {
  return new SerialPortStream({path: 'test-device', baudRate: 115200, autoOpen: false,
    binding: {async open() { return devices.shift(); }}});
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}

test('binding open reports validation failures through its Promise', async () => {
  let opened;
  assert.doesNotThrow(() => { opened = RustBinding.open({path: '', baudRate: 115200}); });
  await assert.rejects(opened, TypeError);
});

test('JavaScript parsers can load without a native binary', async () => {
  await promisify(execFile)(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, ...args) {
      if (request.endsWith('.node')) throw new Error('Native library loaded unnecessarily');
      return original.call(this, request, ...args);
    };
    const {DelimiterParser} = require(process.argv[1]);
    const output = [];
    const parser = new DelimiterParser({delimiter: '\\n'});
    parser.on('data', data => output.push(data.toString()));
    parser.on('end', () => assert.deepEqual(output, ['frame']));
    parser.end('frame\\n');
  `, require.resolve('..')], {timeout: 5000});
});

test('an internal disconnect reason survives the binding close hook', async () => {
  const port = stream(device());
  await call(port, 'open');
  const reason = new DisconnectedError('write failed');
  const closed = once(port, 'close');
  const completed = new Promise(resolve => port.close(resolve, reason));
  assert.equal((await closed)[0], reason);
  assert.equal(await completed, reason);
});

test('a failed vectored write closes its connection once', async t => {
  const failure = new Error('write failed');
  const binding = device({async writev() { throw failure; }});
  const port = stream(binding);
  t.after(() => port.destroy());
  port.on('error', () => {});
  const closes = [];
  port.on('close', error => closes.push(error));
  await call(port, 'open');
  port.cork();
  const first = assert.rejects(call(port, 'write', Buffer.from([1])), failure);
  const second = assert.rejects(call(port, 'write', Buffer.from([2])), failure);
  port.uncork();
  await Promise.all([first, second]);
  await nextTurn();
  assert.equal(binding.isOpen, false);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].disconnected, true);
  assert.equal(closes[0].message, failure.message);
});

test('late close notifications cannot close a replacement connection', async t => {
  const old = device();
  const replacement = device();
  const port = stream(old, replacement);
  t.after(() => port.destroy());
  await call(port, 'open');
  const lateClose = old.onClose;
  await call(port, 'close');
  await call(port, 'open');
  lateClose(new Error('old connection failed'));
  assert.equal(port.port, replacement);
  assert.equal(port.isOpen, true);
  await call(port, 'close');
});

test('an unsettled read from a closed binding cannot block a reopened stream', async t => {
  let reads = 0;
  const replacement = device({read() { reads++; return new Promise(() => {}); }});
  const port = stream(device(), replacement);
  t.after(() => port.destroy());
  await call(port, 'open');
  port.resume();
  await nextTurn();
  await call(port, 'close');
  await call(port, 'open');
  await nextTurn();
  assert.equal(reads, 1);
  await call(port, 'close');
});

test('late updates do not change a replacement connection settings', async t => {
  const update = deferred();
  const port = stream(device({update() { return update.promise; }}), device());
  t.after(() => port.destroy());
  await call(port, 'open');
  const updated = call(port, 'update', {baudRate: 9600});
  await call(port, 'close');
  await call(port, 'open');
  update.resolve();
  await updated;
  assert.equal(port.baudRate, 115200);
});

test('update retains the requested baud rate when the caller mutates its options', async t => {
  const update = deferred();
  let requested;
  const port = stream(device({update(options) { requested = options.baudRate; return update.promise; }}));
  t.after(() => port.destroy());
  await call(port, 'open');
  const options = {baudRate: 9600};
  const updated = call(port, 'update', options);
  options.baudRate = 57600;
  update.resolve();
  await updated;
  assert.equal(requested, 9600);
  assert.equal(port.baudRate, 9600);
});

test('a failed close while canceling open settles callbacks and allows a retry', async t => {
  const opening = deferred();
  const failure = new Error('driver refused close');
  let attempts = 0;
  let reads = 0;
  const binding = device({startReading() { reads++; }, async close() {
    if (++attempts === 1) throw failure;
    this.isOpen = false;
    this.onClose?.(null);
  }});
  const port = new SerialPortStream({path: 'test-device', baudRate: 115200, autoOpen: false,
    binding: {open() { return opening.promise; }}});
  t.after(() => port.destroy());
  const errors = [];
  port.on('error', error => errors.push(error));
  let openError;
  let closeError;
  let closes = 0;
  let opens = 0;
  const received = [];
  port.on('data', data => received.push(data));
  port.on('open', () => opens++);
  port.on('close', () => closes++);
  port.open(error => { openError = error; });
  port.close(error => { closeError = error; });
  opening.resolve(binding);
  await nextTurn();
  assert.equal(closeError, failure);
  assert.equal(openError.canceled, true);
  assert.equal(port.opening, false);
  assert.equal(port.closing, false);
  assert.equal(port.isOpen, true);
  assert.equal(opens, 0);
  assert.equal(closes, 0);
  assert.deepEqual(errors, []);
  assert.equal(reads, 1);
  binding.onData(Buffer.from('still connected'));
  assert.deepEqual(received, [Buffer.from('still connected')]);
  await call(port, 'close');
  assert.equal(closes, 1);
  assert.equal(port.isOpen, false);
});

test('a failed close resumes writes and reads submitted while closing', async t => {
  const closing = deferred();
  const failure = new Error('driver refused close');
  const writes = [];
  let reads = 0;
  const binding = device({close() { return closing.promise; },
    async write(data) { writes.push(Buffer.from(data)); },
    startReading() { reads++; },
  });
  const port = stream(binding);
  t.after(() => { binding.close = device().close; port.destroy(); });
  await call(port, 'open');
  const closed = assert.rejects(call(port, 'close'), failure);
  const written = call(port, 'write', Buffer.from('pending'));
  written.catch(() => {});
  port.resume();
  await nextTurn();
  assert.equal(reads, 0);
  assert.deepEqual(writes, []);
  closing.reject(failure);
  await closed;
  await nextTurn();
  assert.deepEqual(writes, [Buffer.from('pending')]);
  assert.equal(reads, 1);
  await written;
});
