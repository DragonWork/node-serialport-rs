// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RustBinding } = require('..');
const { pty } = require('./helpers');

function waitForBytes(port, length) {
  const chunks = [];
  let received = 0;
  let resolve;
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  port.onData = (data) => {
    try {
      assert(Buffer.isBuffer(data));
      chunks.push(data);
      received += data.length;
      if (received >= length) resolve(Buffer.concat(chunks));
      else port.startReading(4096);
    } catch (error) {
      reject(error);
    }
  };
  return done;
}

test('automatic native receive batching preserves streaming bytes and chunk credits', { timeout: 10000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const expected = Buffer.from(Array.from({ length: 16 * 1024 }, (_, index) => index & 255));
  const received = waitForBytes(port, expected.length);
  port.startReading(4096);
  await terminal.command(`write ${expected.toString('hex')}`);
  assert.deepEqual((await received).subarray(0, expected.length), expected);
  await port.close();
});

test('explicit binding reads keep their requested byte ranges', { timeout: 10000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const first = port.readChunk(5);
  await terminal.command(`write ${Buffer.from('firstsecond').toString('hex')}`);
  assert.equal((await first).toString(), 'first');
  assert.equal((await port.readChunk(6)).toString(), 'second');
});

test('native batching promptly delivers isolated reads and groups ready bursts', { timeout: 10000 }, async (t) => {
  const { NativePort } = require('../lib/native').loadNative();
  const { validateOptions } = require('../lib/binding');
  const terminal = await pty(t);
  let opened, closed, primed, received;
  const open = new Promise((resolve) => {
    opened = resolve;
  });
  const close = new Promise((resolve) => {
    closed = resolve;
  });
  const prime = new Promise((resolve) => {
    primed = resolve;
  });
  const got = new Promise((resolve) => {
    received = resolve;
  });
  const callbacks = [];
  let bytes = 0;
  const native = new NativePort(
    validateOptions({ path: terminal.path, baudRate: 115200 }),
    (error, event) => {
      assert.ifError(error);
      if (event.kind === 'open') opened();
      else if (event.kind === 'close') closed();
      else if (!bytes) {
        bytes = 1;
        primed();
      } else {
        callbacks.push(event);
        for (const buffer of Array.isArray(event) ? event : [event]) bytes += buffer.length;
        if (bytes === 513) received();
      }
    },
    Buffer.allocUnsafe,
  );
  t.after(async () => {
    native.close();
    await close;
  });
  await open;
  // One small read primes the adaptive buffer size; its only event credit stops further reads.
  native.readCredit(4096, 1);
  await terminal.command('write 5a');
  await prime;
  // Keep the paused-reader preload below macOS's 1022-byte PTY input limit.
  const payload = Buffer.alloc(512, 0xa5);
  await terminal.command(`write ${payload.toString('hex')}`);
  native.readCredit(1, 32);
  await got;
  const batches = callbacks.filter(Array.isArray);
  assert(batches.length > 0);
  assert(batches.every((batch) => batch.length >= 2 && batch.length <= 16));
  assert.deepEqual(Buffer.concat(callbacks.flat()), payload);
});

test(
  'a later batched buffer allocation error preserves prior data and releases the port',
  { timeout: 10000 },
  async (t) => {
    const { NativePort } = require('../lib/native').loadNative();
    const { validateOptions } = require('../lib/binding');
    const terminal = await pty(t);
    let opened;
    let primed;
    let firstPayload;
    let failed;
    let closed;
    const openedPromise = new Promise((resolve) => {
      opened = resolve;
    });
    const primedPromise = new Promise((resolve) => {
      primed = resolve;
    });
    const failedPromise = new Promise((resolve) => {
      failed = resolve;
    });
    const closedPromise = new Promise((resolve) => {
      closed = resolve;
    });
    let native;
    let prior;
    let errors = 0;
    let closes = 0;
    let allocations = 0;
    const allocator = (length) => {
      allocations++;
      return allocations === 3 ? Buffer.alloc(Math.max(0, length - 1)) : Buffer.alloc(length);
    };
    native = new NativePort(
      validateOptions({ path: terminal.path, baudRate: 115200 }),
      (error, event) => {
        if (error) {
          errors++;
          failed(error);
          native.close();
          return;
        }
        if (event.kind === 'open') {
          opened();
        } else if (event.kind === 'close') {
          closes++;
          closed();
        } else if (Buffer.isBuffer(event)) {
          if (!prior) {
            prior = event;
            primed();
          }
        }
      },
      allocator,
    );
    t.after(async () => {
      native.close();
      await closedPromise;
    });

    await openedPromise;
    // Prime the adaptive buffer with one byte and consume its only event credit.
    native.readCredit(4096, 1);
    await terminal.command('write 5a');
    await primedPromise;

    // Preload the burst so the first payload read is full and follow-ups are immediately ready.
    const payload = Buffer.alloc(512, 0xa5);
    await terminal.command(`write ${payload.toString('hex')}`);
    native.readCredit(1, 32);

    const error = await failedPromise;
    assert(Buffer.isBuffer(prior));
    assert.equal(prior.length, 1);
    assert.equal(prior[0], 0x5a);
    assert.match(error.message, /Invalid read buffer allocation/);
    assert.equal(allocations, 3);
    await closedPromise;
    assert.equal(errors, 1);
    assert.equal(closes, 1);

    const replacement = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
    await replacement.close();
  },
);

test('batch delivery preserves remaining chunks and credits after a throwing listener', async () => {
  const { BindingPort } = require('../lib/binding');
  const port = Object.create(BindingPort.prototype);
  Object.assign(port, { isOpen: true, _readBytes: 6, _readSlots: 3 });
  const delivered = [];
  port.onData = (data) => {
    delivered.push(data.toString());
    if (delivered.length === 1) throw new Error('listener failed');
  };
  assert.throws(() => port._deliverBatch([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')]), /listener failed/);
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(delivered, ['ab', 'cd', 'ef']);
  assert.equal(port._readBytes, 0);
  assert.equal(port._readSlots, 0);
  port._readBytes = 4;
  port._readSlots = 2;
  port.onData = () => {
    port.isOpen = false;
  };
  port._deliverBatch([Buffer.from('ab'), Buffer.from('cd')]);
  assert.equal(port._readBytes, 2);
});
