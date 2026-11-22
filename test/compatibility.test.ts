// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { call, device, binding, pty, type TestPort } from './helpers';
import { RustBinding, SerialPortStream as CurrentStream, type SetOptions } from '..';

const implementations: [string, typeof CurrentStream][] = [['serialport-rs', CurrentStream]];
if (process.env.SERIALPORT_REFERENCE_STREAM) {
  implementations.push(['SerialPort 13', require(process.env.SERIALPORT_REFERENCE_STREAM).SerialPortStream]);
}

for (const [name, SerialPortStream] of implementations) {
  function stream(t: TestContext, overrides: Partial<TestPort> = {}) {
    const connection = device({
      async close() {
        this.isOpen = false;
      },
      ...overrides,
    });
    const port = new SerialPortStream({
      path: 'test-device',
      baudRate: 115200,
      autoOpen: false,
      binding: binding(async () => connection),
    });
    port.on('error', () => {});
    t.after(() => port.isOpen && call(port, 'close'));
    return port;
  }

  test(`${name}: set supplies default flags without changing caller options`, async t => {
    const requests: SetOptions[] = [];
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
        let releaseWrite!: () => void;
        const writing = new Promise<void>(resolve => {
          releaseWrite = resolve;
        });
        const order: string[] = [];
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
    const received: Buffer[] = [];
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

for (const operation of ['read', 'write']) {
  test(
    `original serialport stream reports a Rust binding ${operation} disconnect`,
    {
      skip: !process.env.SERIALPORT_REFERENCE_STREAM,
      timeout: 5000,
    },
    async t => {
      const { SerialPortStream } = require(process.env.SERIALPORT_REFERENCE_STREAM!);
      const terminal = await pty(t);
      const port = new SerialPortStream({
        path: terminal.path,
        baudRate: 115200,
        binding: RustBinding,
        autoOpen: false,
      });
      t.after(() => port.isOpen && call(port, 'close'));
      port.on('error', () => {});
      let closes = 0;
      port.on('close', () => closes++);
      await call(port, 'open');
      const closed = new Promise<Error & { disconnected: boolean }>(resolve => port.once('close', resolve));
      if (operation === 'read') {
        const data = once(port, 'data');
        await terminal.command('write 01');
        assert.equal((await data)[0][0], 1);
        port.resume();
      }
      await terminal.hangup();
      if (operation === 'write') await assert.rejects(call(port, 'write', Buffer.alloc(128 * 1024)));
      assert.equal((await closed).disconnected, true);
      assert.equal(closes, 1);
      assert.equal(port.isOpen, false);
      if (operation === 'write') {
        // The original stream destroys itself after any write error, including with its mock binding.
        await new Promise(setImmediate);
        assert.equal(port.destroyed, true);
        return;
      }
      const replacement = await pty(t);
      port.settings.path = replacement.path;
      await call(port, 'open');
      const data = once(port, 'data');
      await replacement.command('write abcd');
      assert.equal((await data)[0].toString('hex'), 'abcd');
      await call(port, 'close');
      assert.equal(closes, 2);
    },
  );
}
