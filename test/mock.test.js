// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { SerialPortMock } = require('..');
const { call } = require('./helpers');

test.beforeEach(() => SerialPortMock.binding.reset());

test('SerialPortMock supports echo and recording without hardware', { timeout: 5000 }, async t => {
  assert.equal(typeof SerialPortMock, 'function');
  SerialPortMock.binding.reset();
  SerialPortMock.binding.createPort('/mock/echo', { echo: true, record: true });
  const port = new SerialPortMock({ path: '/mock/echo', baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  const data = once(port, 'data');
  const expected = Buffer.from([0, 0xff, 7]);
  await call(port, 'write', expected);
  assert.deepEqual((await data)[0], expected);
  assert.deepEqual(port.port.lastWrite, expected);
  assert.deepEqual(port.port.recording, expected);
  await call(port, 'close');
  assert.equal(port.isOpen, false);
});

test('mock discovery, metadata and serial numbers reset without prototype-key collisions', async () => {
  SerialPortMock.binding.createPort('__proto__', { manufacturer: 'Test', vendorId: '1234', productId: '5678' });
  const [info] = await SerialPortMock.list();
  assert.deepEqual(info, {
    path: '__proto__',
    manufacturer: 'Test',
    vendorId: '1234',
    productId: '5678',
    serialNumber: '1',
    pnpId: undefined,
    locationId: undefined,
  });
  info.path = 'changed';
  assert.equal((await SerialPortMock.list())[0].path, '__proto__');
  SerialPortMock.binding.reset();
  assert.deepEqual(await SerialPortMock.list(), []);
  SerialPortMock.binding.createPort('/mock/new');
  assert.equal((await SerialPortMock.list())[0].serialNumber, '1');
});

test('ready data obeys read limits and destination offsets', async t => {
  SerialPortMock.binding.createPort('/mock/ready', { readyData: Buffer.from([1, 2, 3, 4, 5]), maxReadSize: 2 });
  const port = await SerialPortMock.binding.open({ path: '/mock/ready', baudRate: 9600 });
  t.after(() => port.isOpen && port.close());
  const target = Buffer.alloc(6, 0xaa);
  assert.deepEqual(await port.read(target, 1, 4), { buffer: target, bytesRead: 2 });
  assert.deepEqual(target, Buffer.from([0xaa, 1, 2, 0xaa, 0xaa, 0xaa]));
  assert.equal((await port.read(target, 0, 4)).bytesRead, 2);
  assert.deepEqual(target.subarray(0, 2), Buffer.from([3, 4]));
  assert.equal((await port.read(target, 0, 4)).bytesRead, 1);
  assert.equal(target[0], 5);
});

test('close cancels pending reads and writes and permits reopening', async () => {
  SerialPortMock.binding.createPort('/mock/cancel');
  const options = { path: '/mock/cancel', baudRate: 9600 };
  const port = await SerialPortMock.binding.open(options);
  const read = assert.rejects(port.read(Buffer.alloc(4), 0, 4), { canceled: true });
  const write = assert.rejects(port.write(Buffer.from([1])), { canceled: true });
  await port.close();
  await Promise.all([read, write]);
  assert.equal(port.writeOperation, null);
  assert.throws(() => port.emitData('closed'), /closed/);
  const reopened = await SerialPortMock.binding.open(options);
  await reopened.close();
});

test('shared opens retain exclusive-lock protection until every connection closes', async () => {
  const binding = SerialPortMock.binding;
  binding.createPort('/mock/locks');
  const options = { path: '/mock/locks', baudRate: 9600 };
  const locked = await binding.open(options);
  await assert.rejects(binding.open({ ...options, lock: false }), /locked/);
  await locked.close();
  const a = await binding.open({ ...options, lock: false });
  const b = await binding.open({ ...options, lock: false });
  await assert.rejects(binding.open(options), /locked/);
  await a.close();
  await assert.rejects(binding.open(options), /locked/);
  const read = b.read(Buffer.alloc(1), 0, 1);
  b.emitData(Buffer.from([7]));
  assert.equal((await read).buffer[0], 7);
  await b.close();
  await (await binding.open(options)).close();
});

test('writes snapshot input, drain waits, and recording inspection does not mutate history', async t => {
  SerialPortMock.binding.createPort('/mock/writes', { record: true });
  const port = await SerialPortMock.binding.open({ path: '/mock/writes', baudRate: 9600 });
  t.after(() => port.isOpen && port.close());
  const data = Buffer.from([1, 2, 3]);
  const written = port.write(data);
  data.fill(0);
  await assert.rejects(port.write(data), /pending/);
  await port.drain();
  await written;
  assert.deepEqual(port.lastWrite, Buffer.from([1, 2, 3]));
  port.lastWrite.fill(0);
  port.recording.fill(0);
  assert.deepEqual(port.recording, Buffer.from([1, 2, 3]));
  await port.write(Buffer.from([4]));
  assert.deepEqual(port.recording, Buffer.from([1, 2, 3, 4]));
  port.recording = Buffer.alloc(0);
  assert.equal(port.recording.length, 0);
});

test('mock controls, flushing and read validation are asynchronous and isolated by port', async t => {
  const binding = SerialPortMock.binding;
  binding.createPort('/mock/a');
  binding.createPort('/mock/b');
  const a = await binding.open({ path: '/mock/a', baudRate: 9600 });
  const b = await binding.open({ path: '/mock/b', baudRate: 115200 });
  t.after(() => Promise.all([a, b].filter(port => port.isOpen).map(port => port.close())));
  await a.update({ baudRate: 57600 });
  assert.deepEqual(await a.getBaudRate(), { baudRate: 57600 });
  assert.deepEqual(await b.getBaudRate(), { baudRate: 115200 });
  assert.equal(a.openOptions.baudRate, 9600);
  await a.set({ dtr: true, rts: false });
  assert.deepEqual(await a.get(), { cts: true, dsr: false, dcd: false });
  await assert.rejects(a.read(Buffer.alloc(1), -1, 1), RangeError);
  await assert.rejects(a.update({ baudRate: 0 }), TypeError);
  await assert.rejects(a.set({ rts: 'yes' }), TypeError);
  a.emitData('discard');
  await a.flush();
  const read = a.read(Buffer.alloc(1), 0, 1);
  await assert.rejects(a.read(Buffer.alloc(1), 0, 1), /pending/);
  a.emitData('x');
  assert.equal((await read).buffer.toString(), 'x');
});

test('detaching a pending read destination rejects without consuming queued input', async t => {
  SerialPortMock.binding.createPort('/mock/detach');
  const port = await SerialPortMock.binding.open({ path: '/mock/detach', baudRate: 9600 });
  t.after(() => port.isOpen && port.close());
  const target = Buffer.from(new ArrayBuffer(4));
  const rejected = assert.rejects(port.read(target, 0, 4), RangeError);
  structuredClone(target.buffer, { transfer: [target.buffer] });
  port.emitData(Buffer.from([1, 2]));
  await rejected;
  const read = await port.read(Buffer.alloc(4), 0, 4);
  assert.equal(read.bytesRead, 2);
  assert.deepEqual(read.buffer.subarray(0, 2), Buffer.from([1, 2]));
});

test('corked stream writes retain order and a closed session cannot echo into its replacement', async t => {
  SerialPortMock.binding.createPort('/mock/stream', { record: true, echo: true });
  const port = new SerialPortMock({ path: '/mock/stream', baudRate: 9600, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  port.cork();
  const a = call(port, 'write', [1, 2]);
  const b = call(port, 'write', [3, 4]);
  port.uncork();
  await Promise.all([a, b]);
  assert.deepEqual(port.port.recording, Buffer.from([1, 2, 3, 4]));
  await call(port, 'close');
  await call(port, 'open');
  const output = [];
  port.on('data', data => output.push(data));
  await nextTurn();
  assert.deepEqual(output, []);
});

test('SerialPortMock operates when loading a native addon is prohibited', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const {once} = require('node:events');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, ...args) {
      if (request.endsWith('.node')) throw new Error('Unexpected native addon load');
      return original.call(this, request, ...args);
    };
    (async () => {
      const {SerialPortMock} = require(process.argv[1]);
      SerialPortMock.binding.createPort('/mock/pure-js', {echo: true});
      const port = new SerialPortMock({path: '/mock/pure-js', baudRate: 9600});
      await once(port, 'open');
      const reply = once(port, 'data');
      port.write('ok');
      assert.equal((await reply)[0].toString(), 'ok');
      await new Promise((resolve, reject) => port.close(error => error ? reject(error) : resolve()));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      require.resolve('..'),
    ],
    { timeout: 5000 },
  );
});
