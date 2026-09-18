// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { call } = require('./helpers');

const implementations = [['serialport-rs', require('..').SerialPortStream]];
if (process.env.SERIALPORT_REFERENCE_STREAM) {
  implementations.push(['SerialPort 13', require(process.env.SERIALPORT_REFERENCE_STREAM).SerialPortStream]);
}

for (const [name, SerialPortStream] of implementations) {
  function stream(t, overrides = {}) {
    const binding = {
      isOpen: true,
      async close() {
        this.isOpen = false;
      },
      async write() {},
      async drain() {},
      ...overrides,
    };
    const port = new SerialPortStream({
      path: 'test-device',
      baudRate: 115200,
      autoOpen: false,
      binding: {
        async open() {
          return binding;
        },
      },
    });
    port.on('error', () => {});
    t.after(() => port.isOpen && call(port, 'close'));
    return port;
  }

  test(`${name}: set supplies default flags without changing caller options`, async t => {
    const requests = [];
    const port = stream(t, {
      async set(options) {
        requests.push(options);
      },
    });
    await call(port, 'open');
    await call(port, 'set', undefined);
    const options = Object.freeze({ dtr: false, dsr: true });
    await call(port, 'set', options);
    assert.deepEqual(requests, [
      { brk: false, cts: false, dtr: true, rts: true },
      { brk: false, cts: false, dtr: false, rts: true, dsr: true },
    ]);
    assert.deepEqual(options, { dtr: false, dsr: true });
  });

  for (const afterFinish of [false, true]) {
    test(
      `${name}: drain ${afterFinish ? 'after finish' : 'during end'} waits for output`,
      { timeout: 3000 },
      async t => {
        let releaseWrite;
        const writing = new Promise(resolve => {
          releaseWrite = resolve;
        });
        const order = [];
        const port = stream(t, {
          async write() {
            await writing;
            order.push('write');
          },
          async drain() {
            await writing;
            order.push('drain');
          },
        });
        await call(port, 'open');
        const finished = once(port, 'finish');
        port.end('last packet');
        if (afterFinish) {
          releaseWrite();
          await finished;
        }
        let settled = false;
        const drained = call(port, 'drain').finally(() => {
          settled = true;
        });
        // Attach rejection handlers before checking the pending write.
        const completed = Promise.all([drained, finished]);
        completed.catch(() => {});
        if (!afterFinish) {
          await nextTurn();
          assert.equal(settled, false);
          releaseWrite();
        }
        await completed;
        assert.deepEqual(order, ['write', 'drain']);
        assert.equal(port.writableFinished, true);
        assert.equal(port.isOpen, true);
      },
    );
  }

  test(`${name}: drain after end reports a driver failure`, async t => {
    const failure = new Error('output drain failed');
    const port = stream(t, {
      async drain() {
        throw failure;
      },
    });
    await call(port, 'open');
    const finished = once(port, 'finish');
    port.end('last packet');
    await finished;
    await assert.rejects(call(port, 'drain'), error => error === failure);
    assert.equal(port.isOpen, true);
  });

  test(`${name}: a zero-byte binding read ends the readable side once`, async t => {
    let reads = 0;
    const port = stream(t, {
      async read(buffer, offset) {
        reads++;
        if (reads === 1) {
          buffer.write('tail', offset);
          return { buffer, bytesRead: 4 };
        }
        if (reads === 2) return { buffer, bytesRead: 0 };
        // Keep a broken implementation from spinning forever on repeated EOF.
        return new Promise(() => {});
      },
    });
    const received = [];
    let ends = 0;
    port.on('end', () => {
      ends++;
    });
    await call(port, 'open');
    port.on('data', data => {
      received.push(data);
    });
    await nextTurn();
    assert.equal(port.readableEnded, true);
    assert.equal(ends, 1);
    assert.equal(reads, 2);
    assert.equal(Buffer.concat(received).toString(), 'tail');
    assert.equal(port.isOpen, true);
  });
}
