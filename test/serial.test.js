// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { SerialPort, RustBinding } = require('..');
const { pty, call } = require('./helpers');

test('discovery returns the complete metadata shape without opening ports', async () => {
  const ports = await RustBinding.list();
  assert.ok(Array.isArray(ports));
  for (const port of ports) {
    assert.equal(typeof port.path, 'string');
    assert.deepEqual(Object.keys(port).sort(), [
      'locationId',
      'manufacturer',
      'path',
      'pnpId',
      'productId',
      'serialNumber',
      'vendorId',
    ]);
  }
});

test('validates settings before opening', () => {
  assert.throws(() => new SerialPort({ path: '', baudRate: 9600 }), /path/);
  assert.throws(() => new SerialPort({ path: '/invalid', baudRate: NaN }), /baudRate/);
  assert.throws(() => new SerialPort({ path: '/invalid', baudRate: 9600, dataBits: 9 }), /dataBits/);
});

test('failed open settles asynchronously', async () => {
  const port = new SerialPort({ path: '/no-such-serial-device', baudRate: 115200, autoOpen: false });
  await assert.rejects(call(port, 'open'));
  assert.equal(port.opening, false);
  assert.equal(port.isOpen, false);
});

test('binary duplex transfers and Promise continuations', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  const expected = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const received = once(port, 'data');
  await terminal.command(`write ${expected.toString('hex')}`);
  assert.deepEqual((await received)[0], expected);
  await call(port, 'write', expected);
  assert.equal(await terminal.command('read 256'), expected.toString('hex'));
  await call(port, 'drain');
  await call(port, 'close');
  assert.equal(port.isOpen, false);
});

test('native operation callbacks retain their caller AsyncLocalStorage context', { timeout: 5000 }, async (t) => {
  const context = new AsyncLocalStorage();
  t.after(() => context.disable());
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  for (const [method, args] of [
    ['open', []],
    ['write', [Buffer.from([42])]],
    ['update', [{ baudRate: 9600 }]],
    ['drain', []],
    ['close', []],
  ]) {
    const store = { method };
    const result = await context.run(
      store,
      () =>
        new Promise((resolve) => {
          port[method](...args, function (error) {
            resolve({ error, store: context.getStore(), receiver: this });
          });
        }),
    );
    assert.equal(result.error, null);
    assert.equal(result.store, store, `${method} callback lost its caller context`);
    if (method !== 'write') assert.equal(result.receiver, port);
    if (method === 'write') assert.equal(await terminal.command('read 1'), '2a');
  }
});

test(
  'received buffers remain valid after close and garbage collection',
  { timeout: 5000, skip: typeof global.gc !== 'function' },
  async (t) => {
    const terminal = await pty(t);
    const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
    t.after(() => port.destroy());
    await call(port, 'open');
    const expected = Buffer.from(Array.from({ length: 32 * 1024 + 32 }, (_, i) => (i * 17) & 255));
    const chunks = [];
    let length = 0;
    const received = new Promise((resolve) => {
      port.on('data', (data) => {
        assert(Buffer.isBuffer(data));
        chunks.push(data);
        length += data.length;
        if (length >= expected.length) resolve();
      });
    });
    const first = once(port, 'data');
    await terminal.command(`write ${expected.subarray(0, 32).toString('hex')}`);
    await first;
    await terminal.command(`write ${expected.subarray(32).toString('hex')}`);
    await received;
    await call(port, 'close');
    global.gc();
    for (let i = 0; i < 256; i++) Buffer.allocUnsafe(1024).fill(0xa5);
    global.gc();
    assert.deepEqual(Buffer.concat(chunks), expected);
  },
);

test('pending native read cancels on close and bindings can reopen', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  for (let i = 0; i < 10; i++) {
    const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    const buffer = Buffer.alloc(128);
    const read = assert.rejects(binding.read(buffer, 0, buffer.length), { canceled: true });
    await binding.close();
    await read;
  }
});

test('close during opening cancels without a stray open', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  let opens = 0;
  port.on('open', () => opens++);
  const opened = assert.rejects(call(port, 'open'), { canceled: true });
  await call(port, 'close');
  await opened;
  assert.equal(opens, 0);
  assert.equal(port.isOpen, false);
});

test('disconnect emits one close and releases resources', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  port.resume();
  const closed = once(port, 'close');
  await terminal.hangup();
  assert.equal((await closed)[0].disconnected, true);
  assert.equal(port.isOpen, false);
});

test(
  'a disconnected binding remains closable until its consumer acknowledges the failure',
  { timeout: 5000 },
  async (t) => {
    const terminal = await pty(t);
    const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    t.after(() => binding.isOpen && binding.close());
    const read = assert.rejects(binding.read(Buffer.alloc(1), 0, 1), { disconnected: true });
    await terminal.hangup();
    await read;
    assert.equal(binding.isOpen, true);
    await assert.rejects(binding.getBaudRate(), /closed/);
    await binding.close();
    assert.equal(binding.isOpen, false);
    await assert.rejects(binding.close(), /not open/);
    await assert.rejects(binding.read(Buffer.alloc(1), 0, 1), { canceled: true });
  },
);

test(
  'a native callback allocation failure closes once and releases the exclusive port lock',
  { timeout: 5000 },
  async (t) => {
    const terminal = await pty(t);
    const allocator = Buffer.allocUnsafe;
    let port;
    try {
      // Capture a failing allocator for this connection only, before any asynchronous work runs.
      Buffer.allocUnsafe = () => Buffer.alloc(0);
      port = new SerialPort({ path: terminal.path, baudRate: 115200 });
    } finally {
      Buffer.allocUnsafe = allocator;
    }
    t.after(() => port.destroy());
    await once(port, 'open');
    const binding = port.port;
    let closes = 0;
    port.on('close', () => closes++);
    const closed = once(port, 'close');
    port.resume();
    await terminal.command('write 0102');
    const [error] = await closed;
    assert.equal(error.disconnected, true);
    assert.match(error.message, /Invalid read buffer allocation/);
    assert.equal(binding.isOpen, false);
    const replacement = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    await replacement.close();
    assert.equal(closes, 1);
  },
);

test('queued write before open and sequential reopen', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 9600, autoOpen: false });
  t.after(() => port.destroy());
  const written = call(port, 'write', [0, 10, 13, 255]);
  await call(port, 'open');
  await written;
  assert.equal(await terminal.command('read 4'), '000a0dff');
  await call(port, 'close');
  await call(port, 'open');
  const received = once(port, 'data');
  await terminal.command('write abcd');
  assert.equal((await received)[0].toString('hex'), 'abcd');
  await call(port, 'close');
});

test('binding read copies only the requested range', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => binding.isOpen && binding.close());
  const buffer = Buffer.alloc(8, 0xaa);
  const received = binding.read(buffer, 2, 3);
  await terminal.command('write 010203');
  const result = await received;
  assert.equal(result.buffer, buffer);
  assert.equal(result.bytesRead, 3);
  assert.equal(buffer.toString('hex'), 'aaaa010203aaaaaa');
  await assert.rejects(binding.read(buffer, 9, 1), RangeError);
  await binding.close();
});

test('pseudo-terminal baud rates can be queried and updated', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => binding.isOpen && binding.close());
  assert.deepEqual(await binding.getBaudRate(), { baudRate: 115200 });
  await binding.update({ baudRate: 57600 });
  assert.deepEqual(await binding.getBaudRate(), { baudRate: 57600 });
});

test(
  'a detached read destination rejects instead of reporting bytes it did not receive',
  { timeout: 5000 },
  async (t) => {
    const terminal = await pty(t);
    const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    t.after(() => binding.isOpen && binding.close());
    const buffer = Buffer.from(new ArrayBuffer(4));
    const rejected = assert.rejects(binding.read(buffer, 0, 4), RangeError);
    structuredClone(buffer.buffer, { transfer: [buffer.buffer] });
    await terminal.command('write 0102');
    await rejected;
    assert.equal(binding.isOpen, true);
    const next = binding.read(Buffer.alloc(4), 1, 2);
    await terminal.command('write 0304');
    const result = await next;
    assert.equal(result.bytesRead, 2);
    assert.equal(result.buffer.toString('hex'), '00030400');
  },
);

test(
  'shrinking a read destination is rejected before copying into it',
  {
    timeout: 5000,
    skip: typeof ArrayBuffer.prototype.resize !== 'function',
  },
  async (t) => {
    const terminal = await pty(t);
    const binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    t.after(() => binding.isOpen && binding.close());
    const store = new ArrayBuffer(8, { maxByteLength: 16 });
    const buffer = Buffer.from(store).fill(0xaa);
    const rejected = assert.rejects(binding.read(buffer, 2, 4), RangeError);
    store.resize(3);
    await terminal.command('write 01020304');
    await rejected;
    assert.deepEqual([...new Uint8Array(store)], [0xaa, 0xaa, 0xaa]);
  },
);
