// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { Writable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { RustBinding, SerialPort } = require('..');
const { pty, call } = require('./helpers');

function waitForBytes(port, length) {
  const chunks = [];
  let received = 0;
  let resolve;
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  port.onData = data => {
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

test('automatic native receive batching preserves streaming bytes and chunk credits', { timeout: 10000 }, async t => {
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

test('explicit binding reads keep their requested byte ranges', { timeout: 10000 }, async t => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const first = port.readChunk(5);
  await terminal.command(`write ${Buffer.from('firstsecond').toString('hex')}`);
  assert.equal((await first).toString(), 'first');
  assert.equal((await port.readChunk(6)).toString(), 'second');
});

test('a stalled pipe bounds read-ahead and resumes every byte in order', { timeout: 10000 }, async t => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false, highWaterMark: 4096 });
  t.after(() => port.destroy());
  const expected = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index & 255));
  let received = 0;
  let resume;
  let completed;
  const done = new Promise(resolve => {
    completed = resolve;
  });
  const sink = new Writable({
    highWaterMark: 1,
    write(data, encoding, callback) {
      assert.deepEqual(data, expected.subarray(received, received + data.length));
      const first = received === 0;
      received += data.length;
      if (first) resume = callback;
      else callback();
      if (received === expected.length) completed();
    },
  });
  t.after(() => sink.destroy());
  await call(port, 'open');
  port.pipe(sink);
  const paused = once(port, 'pause');
  const written = terminal.command(`write ${expected.toString('hex')}`);
  written.catch(() => {});
  await paused;
  const stalledAt = received;
  await delay(50);
  assert.equal(received, stalledAt, 'A returned data listener must not bypass pipe backpressure');
  assert(port.readableLength <= 8192, `Buffered ${port.readableLength} bytes`);
  resume();
  await Promise.all([done, written]);
  await call(port, 'close');
});

test('native batching delivers the first ready chunk before its followers', { timeout: 10000 }, async t => {
  const { NativePort } = require('../lib/native').loadNative();
  const { validateOptions } = require('../lib/binding');
  const terminal = await pty(t);
  let opened, closed, primed, received;
  const open = new Promise(resolve => {
    opened = resolve;
  });
  const close = new Promise(resolve => {
    closed = resolve;
  });
  const prime = new Promise(resolve => {
    primed = resolve;
  });
  const got = new Promise(resolve => {
    received = resolve;
  });
  const callbacks = [];
  let bytes = 0;
  let allocations = 0;
  let firstAllocations;
  let bytesAtContinuation;
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
        if (callbacks.length === 1) {
          firstAllocations = allocations;
          Promise.resolve().then(() => {
            bytesAtContinuation = bytes;
          });
        }
        for (const buffer of Array.isArray(event) ? event : [event]) bytes += buffer.length;
        if (bytes === 513) received();
      }
    },
    length => {
      allocations++;
      return Buffer.allocUnsafe(length);
    },
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
  assert(Buffer.isBuffer(callbacks[0]), 'The first ready chunk must have its own callback');
  assert.equal(firstAllocations, 2, 'Only the priming and first ready buffers should be allocated');
  assert.equal(bytesAtContinuation, 1 + callbacks[0].length, 'The first reply can resume before its followers');
  const batches = callbacks.filter(Array.isArray);
  assert(batches.length > 0);
  assert(batches.every(batch => batch.length >= 2 && batch.length <= 16));
  assert.deepEqual(Buffer.concat(callbacks.flat()), payload);
});

test('the binding preserves the first reply continuation before batched followers', { timeout: 10000 }, async t => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  let primed, completed;
  const prime = new Promise(resolve => {
    primed = resolve;
  });
  const done = new Promise(resolve => {
    completed = resolve;
  });
  const payload = Buffer.alloc(512, 0xa5);
  const chunks = [];
  let firstLength;
  let continuedAt;
  let received = 0;
  port.onData = data => {
    if (!received) {
      assert.deepEqual(data, Buffer.from([0x5a]));
      received++;
      primed();
      return;
    }
    chunks.push(data);
    received += data.length;
    if (chunks.length === 1) {
      firstLength = data.length;
      Promise.resolve().then(() => {
        continuedAt = received;
      });
    }
    if (received === payload.length + 1) completed();
  };
  port.startReading(4096);
  await terminal.command('write 5a');
  await prime;
  await terminal.command(`write ${payload.toString('hex')}`);
  await done;
  assert.equal(continuedAt, firstLength + 1);
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test('native batches reuse their delivery callback for successive payloads', { timeout: 10000 }, async t => {
  const addon = require('../lib/native').loadNative();
  const NativePort = addon.NativePort;
  let inBatch = false;
  let batches = 0;
  let firstBatch;
  const callbacks = new Set();
  const schedule = global.queueMicrotask;
  global.queueMicrotask = callback => {
    if (inBatch) callbacks.add(callback);
    schedule(callback);
  };
  t.after(() => {
    global.queueMicrotask = schedule;
    addon.NativePort = NativePort;
  });
  addon.NativePort = class {
    constructor(options, callback, allocator) {
      return new NativePort(
        options,
        (error, event) => {
          inBatch = Array.isArray(event);
          if (inBatch) {
            batches++;
            firstBatch ??= new WeakRef(event);
          }
          try {
            callback(error, event);
          } finally {
            inBatch = false;
          }
        },
        allocator,
      );
    }
  };
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const primed = waitForBytes(port, 1);
  port.startReading(4096);
  await terminal.command('write 5a');
  await primed;
  for (let index = 0; index < 3; index++) {
    const payload = Buffer.alloc(512, 0xa5 + index);
    const done = waitForBytes(port, payload.length);
    await terminal.command(`write ${payload.toString('hex')}`);
    assert.deepEqual(await done, payload);
  }
  assert(batches >= 3);
  assert.equal(callbacks.size, 1);
  if (global.gc) {
    await new Promise(setImmediate);
    global.gc();
    assert.equal(firstBatch.deref(), undefined, 'The cached callback must not retain an earlier batch');
  }
});

test('queued native deliveries preserve mixed chunk order and stop on close', async t => {
  const addon = require('../lib/native').loadNative();
  const NativePort = addon.NativePort;
  let notify;
  addon.NativePort = class {
    constructor(options, callback) {
      notify = callback;
      queueMicrotask(() => notify(null, { kind: 'open', id: 0 }));
    }
    readCredit() {}
    close() {
      queueMicrotask(() => notify(null, { kind: 'close', id: 0 }));
    }
  };
  t.after(() => {
    addon.NativePort = NativePort;
  });
  const port = await RustBinding.open({ path: '/queued', baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const received = [];
  const contexts = [];
  const context = new AsyncLocalStorage();
  port.onData = data => {
    received.push(data.toString());
    contexts.push(context.getStore());
  };
  port.startReading(4096);
  context.run('first', () => notify(null, [Buffer.from('a'), Buffer.from('b')]));
  context.run('single', () => notify(null, Buffer.from('c')));
  context.run('second', () => notify(null, [Buffer.from('d'), Buffer.from('e')]));
  context.run('third', () => notify(null, [Buffer.from('f'), Buffer.from('g')]));
  await Promise.resolve();
  assert.equal(received.join(''), 'abcdefg');
  assert.deepEqual(contexts, ['first', 'first', 'single', 'second', 'second', 'third', 'third']);
  assert.equal(port._readBytes, 4096 - 7);
  assert.equal(port._readSlots, 32 - 7);
  let closed;
  port.onData = data => {
    received.push(data.toString());
    closed = port.close();
  };
  notify(null, [Buffer.from('h'), Buffer.from('i')]);
  notify(null, [Buffer.from('j'), Buffer.from('k')]);
  await Promise.resolve();
  await closed;
  assert.equal(received.join(''), 'abcdefgh');
});

test('a handled native batch listener exception retains followers and read credits', { timeout: 10000 }, async t => {
  const terminal = await pty(t);
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const {RustBinding} = require(process.argv[1]);
    (async () => {
      let errors = 0, inBatch = false, primed = false, received = 0, finish;
      const chunks = [];
      process.on('uncaughtException', error => {
        assert.equal(error.message, 'listener failed');
        errors++;
      });
      const port = await RustBinding.open({path: process.argv[2], baudRate: 115200});
      try {
        const done = new Promise(resolve => { finish = resolve; });
        const deliver = port._deliverBatch;
        port._deliverBatch = function (...args) {
          inBatch = true;
          try { return deliver.apply(this, args); }
          finally { inBatch = false; }
        };
        port.onData = data => {
          if (!primed) { primed = true; console.log('primed'); return; }
          chunks.push(data);
          received += data.length;
          if (inBatch && errors === 0) throw new Error('listener failed');
          if (received === 512) finish();
        };
        port.startReading(4096);
        console.log('ready');
        await done;
        assert.equal(errors, 1);
        assert.equal(port._readBytes, 4096 - 513);
        assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(512, 0xa5));
      } finally { await port.close(); }
      console.log('complete');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      require.resolve('..'),
      terminal.path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data;
  });
  const exited = once(child, 'close');
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, 'ready', stderr);
  await terminal.command('write 5a');
  assert.equal((await lines.next()).value, 'primed', stderr);
  await terminal.command(`write ${Buffer.alloc(512, 0xa5).toString('hex')}`);
  assert.equal((await lines.next()).value, 'complete', stderr);
  assert.equal((await exited)[0], 0, stderr);
});

test(
  'a later batched buffer allocation error preserves prior data and releases the port',
  { timeout: 10000 },
  async t => {
    const { NativePort } = require('../lib/native').loadNative();
    const { validateOptions } = require('../lib/binding');
    const terminal = await pty(t);
    let opened;
    let primed;
    let firstPayload;
    let failed;
    let closed;
    const openedPromise = new Promise(resolve => {
      opened = resolve;
    });
    const primedPromise = new Promise(resolve => {
      primed = resolve;
    });
    const failedPromise = new Promise(resolve => {
      failed = resolve;
    });
    const closedPromise = new Promise(resolve => {
      closed = resolve;
    });
    let native;
    let prior;
    let errors = 0;
    let closes = 0;
    let allocations = 0;
    const allocator = length => {
      allocations++;
      return allocations === 4 ? Buffer.alloc(Math.max(0, length - 1)) : Buffer.alloc(length);
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
          } else firstPayload = event;
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
    assert(Buffer.isBuffer(firstPayload));
    assert.deepEqual(firstPayload, payload.subarray(0, firstPayload.length));
    assert.match(error.message, /Invalid read buffer allocation/);
    assert.equal(allocations, 4);
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
  port.onData = data => {
    delivered.push(data.toString());
    if (delivered.length === 1) throw new Error('listener failed');
  };
  assert.throws(() => port._deliverBatch([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')]), /listener failed/);
  await new Promise(resolve => queueMicrotask(resolve));
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
