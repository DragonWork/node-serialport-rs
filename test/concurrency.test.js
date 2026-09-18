// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const { Worker } = require('node:worker_threads');
const {
  promisify,
  types: { isSharedArrayBuffer },
} = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { SerialPort, RustBinding } = require('..');
const { pty, call } = require('./helpers');

test(
  'I/O workers start lazily, remain bounded and retire after close',
  { timeout: 10000, skip: process.platform !== 'linux' },
  async (t) => {
    const terminals = await Promise.all(Array.from({ length: 8 }, () => pty(t)));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
    const {readdirSync, readFileSync} = require('node:fs');
    const {availableParallelism} = require('node:os');
    const {setTimeout: delay} = require('node:timers/promises');
    const {RustBinding} = require(process.argv[1]);
    function count() {
      return readdirSync('/proc/self/task').filter(id => {
        try { return readFileSync('/proc/self/task/' + id + '/comm', 'utf8').trim() === 'serialport-rt'; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }).length;
    }
    (async () => {
      const ports = [];
      const counts = [count()];
      try {
        for (const path of JSON.parse(process.argv[2])) {
          ports.push(await RustBinding.open({path, baudRate: 115200}));
          if (ports.length === 1 || ports.length === 2 || ports.length === 8) counts.push(count());
        }
        await ports[0].drain();
      } finally { await Promise.all(ports.map(port => port.close())); }
      for (let i = 0; count() && i < 100; i++) await delay(10);
      counts.push(count());
      console.log(JSON.stringify({counts, limit: Math.min(availableParallelism(), 4)}));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
        require.resolve('..'),
        JSON.stringify(terminals.map((terminal) => terminal.path)),
      ],
      { timeout: 8000 },
    );
    const { counts, limit } = JSON.parse(stdout);
    assert.deepEqual(counts, [0, 1, Math.min(2, limit), limit, 0]);
  },
);

test('eight concurrent ports make independent progress while one writer stalls', { timeout: 10000 }, async (t) => {
  const terminals = await Promise.all(Array.from({ length: 8 }, () => pty(t)));
  const ports = terminals.map(({ path }) => new SerialPort({ path, baudRate: 115200, autoOpen: false }));
  for (const port of ports) {
    port.on('error', () => {});
    t.after(() => port.destroy());
  }
  await Promise.all(ports.map((port) => call(port, 'open')));
  const stalled = assert.rejects(call(ports[0], 'write', Buffer.alloc(1024 * 1024)), { canceled: true });
  await Promise.all(
    ports.slice(1).map(async (port, index) => {
      const expected = Buffer.from(`port-${index}`);
      const data = once(port, 'data');
      await terminals[index + 1].command(`write ${expected.toString('hex')}`);
      assert.deepEqual((await data)[0], expected);
      await call(port, 'write', expected);
      assert.equal(await terminals[index + 1].command(`read ${expected.length}`), expected.toString('hex'));
    }),
  );
  await Promise.all(ports.map((port) => call(port, 'close')));
  await stalled;
});

test('corked writes preserve order across batched native transfers', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  const expected = Buffer.from(Array.from({ length: 2048 }, (_, i) => i & 0xff));
  port.cork();
  const writes = Array.from(expected, (byte) => call(port, 'write', Buffer.from([byte])));
  port.uncork();
  // A macOS PTY may not drain until its peer consumes the output.
  const [received] = await Promise.all([terminal.command(`read ${expected.length}`), ...writes, call(port, 'drain')]);
  assert.equal(received, expected.toString('hex'));
  await call(port, 'close');
});

test('native writes snapshot borrowed memory before returning to JavaScript', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => {
    if (port.isOpen) return port.close();
  });
  const buffer = Buffer.alloc(1024, 0x5a);
  const expected = buffer.toString('hex');
  const written = port.write(buffer);
  buffer.fill(0);
  assert.equal(await terminal.command(`read ${buffer.length}`), expected);
  await written;
  await port.close();
});

test('vectored writes snapshot repeated and overlapping buffers', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const buffer = Buffer.from('overlapping');
  const parts = Object.freeze([buffer, buffer.subarray(3), buffer, buffer.subarray(0, 4)]);
  const expected = Buffer.concat(parts);
  const written = port.writev(parts);
  buffer.fill(0);
  assert.equal(await terminal.command(`read ${expected.length}`), expected.toString('hex'));
  await written;
});

test('vectored writes preserve immutable inputs across the native byte limit', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const parts = Object.freeze([Buffer.alloc(0), Buffer.alloc(48 * 1024, 0xa1), Buffer.alloc(32 * 1024, 0xb2)]);
  const expected = Buffer.concat(parts);
  const [received] = await Promise.all([terminal.command(`read ${expected.length}`), port.writev(parts)]);
  assert.equal(received, expected.toString('hex'));
  assert.equal(parts[1].length, 48 * 1024);
  assert.equal(parts[2].length, 32 * 1024);
});

test('vectored writes retain slicing semantics for a shadowed Buffer length', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => port.isOpen && port.close());
  const buffer = Buffer.from('prefix unused');
  Object.defineProperty(buffer, 'length', { value: 6 });
  await port.writev([buffer, Buffer.from('!')]);
  assert.equal(await terminal.command('read 7'), Buffer.from('prefix!').toString('hex'));
});

test('small writes complete asynchronously and stay behind queued controls', { timeout: 10000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => {
    if (port.isOpen) return port.close();
  });
  const byte = Buffer.from([0x5a]);
  for (let i = 0; i < 100; i++) {
    let returned = false;
    const order = [];
    const updated = port.update({ baudRate: i % 2 ? 115200 : 57600 }).then(() => order.push('update'));
    const written = port.write(byte).then(() => {
      assert.equal(returned, true);
      order.push('write');
    });
    returned = true;
    await Promise.all([updated, written]);
    assert.deepEqual(order, ['update', 'write']);
  }
  assert.equal(await terminal.command('read 100'), '5a'.repeat(100));
  await port.close();
});

test('shared memory is snapshotted before native writes borrow it', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
  t.after(() => {
    if (port.isOpen) return port.close();
  });
  const nativeWrite = port._native.write;
  const nativeWritev = port._native.writev;
  const check = (buffer) =>
    assert.equal(isSharedArrayBuffer(buffer.buffer), false, 'Shared memory must not be borrowed by Rust');
  port._native.write = function (id, buffer, inline) {
    check(buffer);
    return nativeWrite.call(this, id, buffer, inline);
  };
  port._native.writev = function (id, buffers) {
    buffers.forEach(check);
    return nativeWritev.call(this, id, buffers);
  };
  const shared = Buffer.from(new SharedArrayBuffer(256)).fill(0x5a);
  await port.write(shared);
  assert.equal(await terminal.command('read 256'), '5a'.repeat(256));
  shared.fill(0xa5);
  await port.writev([shared.subarray(0, 128), shared.subarray(128)]);
  assert.equal(await terminal.command('read 256'), 'a5'.repeat(256));
  const getStore = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
  port._native.write = function (id, buffer, inline) {
    assert.equal(isSharedArrayBuffer(getStore.call(buffer)), false);
    return nativeWrite.call(this, id, buffer, inline);
  };
  Object.defineProperty(shared, 'buffer', { value: new ArrayBuffer(256) });
  await port.write(shared);
  assert.equal(await terminal.command('read 256'), 'a5'.repeat(256));
  await port.close();
});

test('stream read-ahead is bounded while paused and resumes without losing bytes', { timeout: 10000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false, highWaterMark: 4096 });
  t.after(() => port.destroy());
  await call(port, 'open');
  const readable = once(port, 'readable');
  port.read(0);
  const expected = Buffer.alloc(256 * 1024);
  for (let i = 0; i < expected.length; i++) expected[i] = i & 255;
  const written = terminal.command(`write ${expected.toString('hex')}`);
  // Cleanup can terminate the helper if an earlier assertion fails.
  written.catch(() => {});
  await readable;
  await delay(100);
  assert(port.readableLength > 0 && port.readableLength <= 8192, `Buffered ${port.readableLength} bytes`);
  const received = new Promise((resolve) => {
    const chunks = [];
    let length = 0;
    port.on('data', (data) => {
      chunks.push(data);
      length += data.length;
      if (length >= expected.length) resolve(Buffer.concat(chunks));
    });
  });
  port.resume();
  assert.deepEqual(await received, expected);
  await written;
  await call(port, 'close');
});

test('terminated Node worker releases its pending read and port lock', { timeout: 10000 }, async (t) => {
  const terminal = await pty(t);
  const worker = new Worker(
    `
    const {parentPort, workerData} = require('node:worker_threads');
    const {RustBinding} = require(workerData.root);
    RustBinding.open({path: workerData.path, baudRate: 115200}).then(port => {
      port.read(Buffer.alloc(32), 0, 32).catch(() => {});
      parentPort.postMessage('ready');
    });
  `,
    { eval: true, workerData: { root: require.resolve('..'), path: terminal.path } },
  );
  t.after(() => worker.terminate());
  assert.equal((await once(worker, 'message'))[0], 'ready');
  await worker.terminate();
  let binding;
  for (let i = 0; i < 100; i++) {
    try {
      binding = await RustBinding.open({ path: terminal.path, baudRate: 115200 });
      break;
    } catch (error) {
      if (i === 99) throw error;
      await delay(10);
    }
  }
  await binding.close();
});

test('after receiving data, a waiting read does not busy-spin', { timeout: 5000 }, async (t) => {
  const terminal = await pty(t);
  const port = new SerialPort({ path: terminal.path, baudRate: 115200, autoOpen: false });
  t.after(() => port.destroy());
  await call(port, 'open');
  const received = once(port, 'data');
  await terminal.command('write 01');
  await received;
  port.resume();
  await delay(30);
  const baseline = process.cpuUsage();
  await delay(300);
  const usage = process.cpuUsage(baseline);
  assert.ok(usage.user + usage.system < 150000, `Idle CPU: ${(usage.user + usage.system) / 1000} ms over 300 ms`);
  await call(port, 'close');
});

for (const mode of ['binding', 'stream']) {
  test(`${mode} callbacks advance promises on an otherwise idle event loop`, { timeout: 10000 }, async (t) => {
    const terminal = await pty(t);
    // Only the parent owns a watchdog and idle delays. A timer in the child could
    // hide a missing Node callback scope by flushing otherwise stranded promises.
    const child = promisify(execFile)(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict');
      const {once} = require('node:events');
      const {RustBinding, SerialPort} = require(process.argv[1]);
      const mode = process.argv[3];
      const call = (port, method, ...args) => new Promise((resolve, reject) => {
        port[method](...args, error => error ? reject(error) : resolve());
      });
      (async () => {
        const options = {path: process.argv[2], baudRate: 115200, autoOpen: false};
        const port = mode === 'binding' ? await RustBinding.open(options) : new SerialPort(options);
        if (mode === 'stream') await call(port, 'open');
        process.stdout.write('ready');
        for (let i = 1; i <= 8; i++) {
          assert(!process.getActiveResourcesInfo().includes('Timeout'));
          const updated = mode === 'binding' ? port.update({baudRate: 115200}) : call(port, 'update', {baudRate: 115200});
          const read = mode === 'binding' ? port.readChunk(1) : once(port, 'data').then(([data]) => data);
          const written = mode === 'binding' ? port.write(Buffer.from([i])) : call(port, 'write', Buffer.from([i]));
          await Promise.all([updated, written]);
          assert.deepEqual(await read, Buffer.from([i]));
          await new Promise(resolve => process.nextTick(resolve));
          await Promise.resolve();
        }
        if (mode === 'binding') { await port.drain(); await port.close(); }
        else { await call(port, 'drain'); await call(port, 'close'); }
        process.stdout.write('complete');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
        require.resolve('..'),
        terminal.path,
        mode,
      ],
      { timeout: 8000 },
    );
    t.after(() => child.child.kill());
    const exchange = (async () => {
      const [ready] = await once(child.child.stdout, 'data');
      assert.equal(ready.toString(), 'ready');
      for (let i = 1; i <= 8; i++) {
        const expected = i.toString(16).padStart(2, '0');
        assert.equal(await terminal.command('read 1'), expected);
        await delay(25);
        await terminal.command(`write ${expected}`);
      }
    })();
    const [{ stdout }] = await Promise.all([child, exchange]);
    assert.equal(stdout, 'readycomplete');
  });
}
