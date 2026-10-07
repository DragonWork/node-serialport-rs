// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { once, getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { SerialPortStream, DisconnectedError, RustBinding, type BindingOpenOptions } from '..';
import { call, device, deferred, binding as testBinding, portSequence, type TestPort } from './helpers';

function stream(...devices: TestPort[]) {
  return new SerialPortStream({
    path: 'test-device',
    baudRate: 115200,
    autoOpen: false,
    binding: portSequence(...devices),
  });
}

test('binding open reports validation failures through its Promise', async () => {
  let opened!: ReturnType<typeof RustBinding.open>;
  assert.doesNotThrow(() => {
    opened = RustBinding.open({ path: '', baudRate: 115200 });
  });
  await assert.rejects(opened, TypeError);
  await assert.rejects(RustBinding.open(Object.assign([], { path: '/invalid', baudRate: 9600 })), TypeError);
});

test('JavaScript parsers can load without a native binary', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '-e',
      `
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
  `,
      require.resolve('..'),
    ],
    { timeout: 5000 },
  );
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
  const binding = device({
    async writev() {
      throw failure;
    },
  });
  const port = stream(binding);
  t.after(() => port.destroy());
  port.on('error', () => {});
  const closes: Array<Error & { disconnected?: boolean }> = [];
  port.on('close', (error: (Error & { disconnected?: boolean }) | null) => {
    assert(error);
    closes.push(error);
  });
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
  assert(lateClose);
  lateClose(new Error('old connection failed'));
  assert.equal(port.port, replacement);
  assert.equal(port.isOpen, true);
  await call(port, 'close');
});

test('an unsettled read from a closed binding cannot block a reopened stream', async t => {
  let reads = 0;
  const replacement = device({
    read() {
      reads++;
      return new Promise(() => {});
    },
  });
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
  const port = stream(
    device({
      update() {
        return update.promise;
      },
    }),
    device(),
  );
  t.after(() => port.destroy());
  await call(port, 'open');
  const updated = call(port, 'update', { baudRate: 9600 });
  await call(port, 'close');
  await call(port, 'open');
  update.resolve();
  await updated;
  assert.equal(port.baudRate, 115200);
});

test('update retains the requested baud rate when the caller mutates its options', async t => {
  const update = deferred();
  let requested;
  const port = stream(
    device({
      update(options) {
        requested = options.baudRate;
        return update.promise;
      },
    }),
  );
  t.after(() => port.destroy());
  await call(port, 'open');
  const options = { baudRate: 9600 };
  const updated = call(port, 'update', options);
  options.baudRate = 57600;
  update.resolve();
  await updated;
  assert.equal(requested, 9600);
  assert.equal(port.baudRate, 9600);
});

test('a failed close while canceling open settles callbacks and allows a retry', async t => {
  const opening = deferred<TestPort>();
  const failure = new Error('driver refused close');
  let attempts = 0;
  let reads = 0;
  const binding = device({
    startReading() {
      reads++;
    },
    async close() {
      if (++attempts === 1) throw failure;
      this.isOpen = false;
      this.onClose?.(null);
    },
  });
  const port = new SerialPortStream({
    path: 'test-device',
    baudRate: 115200,
    autoOpen: false,
    binding: testBinding(() => opening.promise),
  });
  t.after(() => port.destroy());
  const errors: NodeJS.ErrnoException[] = [];
  port.on('error', error => errors.push(error));
  let openError: (Error & { canceled?: boolean }) | null | undefined;
  let closeError;
  let closes = 0;
  let opens = 0;
  const received: Buffer[] = [];
  port.on('data', data => received.push(data));
  port.on('open', () => opens++);
  port.on('close', () => closes++);
  port.open(error => {
    openError = error;
  });
  port.close(error => {
    closeError = error;
  });
  opening.resolve(binding);
  await nextTurn();
  assert.equal(closeError, failure);
  assert(openError);
  assert.equal(openError.canceled, true);
  assert.equal(port.opening, false);
  assert.equal(port.closing, false);
  assert.equal(port.isOpen, true);
  assert.equal(opens, 0);
  assert.equal(closes, 0);
  assert.deepEqual(errors, []);
  assert.equal(reads, 1);
  assert(binding.onData);
  binding.onData(Buffer.from('still connected'));
  assert.deepEqual(received, [Buffer.from('still connected')]);
  await call(port, 'close');
  assert.equal(closes, 1);
  assert.equal(port.isOpen, false);
});

test('a failed close resumes writes and reads submitted while closing', async t => {
  const closing = deferred();
  const failure = new Error('driver refused close');
  const writes: Buffer[] = [];
  let reads = 0;
  const binding = device({
    close() {
      return closing.promise;
    },
    async write(data) {
      writes.push(Buffer.from(data));
    },
    startReading() {
      reads++;
    },
  });
  const port = stream(binding);
  t.after(() => {
    binding.close = device().close;
    port.destroy();
  });
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

test('synchronous control failures reach callbacks asynchronously and leave the port usable', async t => {
  for (const [method, args] of [
    ['update', [{ baudRate: 9600 }]],
    ['set', [{}]],
    ['get', []],
    ['flush', []],
    ['drain', []],
    ['close', []],
  ] as const) {
    await t.test(method, async t => {
      const failure = new Error(`${method} failed`);
      const binding = device({
        [method]() {
          throw failure;
        },
      });
      const port = stream(binding);
      t.after(() => {
        binding.close = device().close;
        port.destroy();
      });
      await call(port, 'open');
      let returned = false;
      const failed = new Promise(resolve => {
        assert.doesNotThrow(() =>
          (port[method] as (...values: unknown[]) => unknown).call(
            port,
            ...args,
            function (this: typeof port, error: Error | null) {
              assert.equal(returned, true);
              assert.equal(this, port);
              resolve(error);
            },
          ),
        );
      });
      returned = true;
      assert.equal(await failed, failure);
      assert.equal(port.isOpen, true);
      assert.equal(port.closing, false);
      assert.equal(port.baudRate, 115200);
    });
  }
});

test('synchronous scalar and vectored write failures settle writes and preserve the disconnect cause', async t => {
  for (const method of ['write', 'writev']) {
    await t.test(method, async t => {
      const failure = new Error('driver write failed');
      const binding = device({
        [method]() {
          throw failure;
        },
      });
      const port = stream(binding);
      t.after(() => port.destroy());
      port.on('error', () => {});
      await call(port, 'open');
      const closed = new Promise(resolve => port.once('close', resolve));
      if (method === 'writev') port.cork();
      const failures: Promise<Error | null | undefined>[] = [];
      assert.doesNotThrow(() => {
        failures.push(new Promise(resolve => port.write('first', resolve)));
        if (method === 'writev') {
          failures.push(new Promise(resolve => port.write('second', resolve)));
          port.uncork();
        }
      });
      assert((await Promise.all(failures)).every(error => error === failure));
      const reason = await closed;
      assert(reason instanceof DisconnectedError);
      assert.equal(reason.cause, failure);
      assert.equal(binding.isOpen, false);
    });
  }
});

test('synchronous reads and non-Error rejections close the affected connection', async t => {
  for (const method of ['read', 'readChunk', 'startReading']) {
    await t.test(method, async t => {
      const port = stream(
        device({
          [method]() {
            throw null;
          },
        }),
      );
      t.after(() => port.destroy());
      await call(port, 'open');
      const closed = once(port, 'close');
      port.resume();
      const [reason] = await closed;
      assert(reason instanceof DisconnectedError);
      assert(reason.cause instanceof Error);
      assert.equal(reason.cause.cause, null);
      assert.equal(port.isOpen, false);
    });
  }
});

test('falsy open rejections are reported as errors with their original cause', async () => {
  for (const cause of [undefined, null, false, 'offline']) {
    const port = new SerialPortStream({
      path: 'test-device',
      baudRate: 9600,
      autoOpen: false,
      binding: testBinding(() => Promise.reject(cause)),
    });
    await assert.rejects(call(port, 'open'), error => error instanceof Error && error.cause === cause);
    assert.equal(port.opening, false);
    port.destroy();
  }
});

test('invalid binding read counts cannot expose uninitialized buffer contents', async () => {
  for (const bytesRead of [-1, 1.5, NaN, Infinity, 65537]) {
    const port = stream(
      device({
        async read(buffer) {
          return { buffer, bytesRead };
        },
      }),
    );
    await call(port, 'open');
    const closed = once(port, 'close');
    const received: Buffer[] = [];
    port.on('data', data => received.push(data));
    const [reason] = await closed;
    assert(reason.cause instanceof RangeError);
    assert.equal(reason.disconnected, true);
    assert.deepEqual(received, []);
  }
});

test('a binding that fails after releasing its connection still completes stream closure', async () => {
  const failure = new Error('close cleanup failed');
  const port = stream(
    device({
      async close() {
        this.isOpen = false;
        throw failure;
      },
    }),
  );
  await call(port, 'open');
  const closed = once(port, 'close');
  await assert.rejects(call(port, 'close'), failure);
  assert.equal((await closed)[0], failure);
  assert.equal(port.port, undefined);
  assert.equal(port.closing, false);
});

test('an already aborted signal prevents opening and reports one AbortError', async () => {
  const cause = new Error('startup canceled');
  let opened = 0;
  let callbackError;
  const port = new SerialPortStream(
    {
      path: 'test-device',
      baudRate: 9600,
      signal: AbortSignal.abort(cause),
      binding: testBinding(async () => {
        opened++;
        return device();
      }),
    },
    error => {
      callbackError = error;
    },
  );
  const errors: NodeJS.ErrnoException[] = [];
  port.on('error', error => errors.push(error));
  await nextTurn();
  assert.equal(opened, 0);
  assert.equal(port.destroyed, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'AbortError');
  assert.equal(errors[0].code, 'ABORT_ERR');
  assert.equal(errors[0].cause, cause);
  assert.equal(callbackError, errors[0]);
});

test('abort during an uncancelable open closes the late connection and settles queued writes', async () => {
  const controller = new AbortController();
  const opening = deferred<TestPort>();
  const binding = device();
  const port = new SerialPortStream({
    path: 'test-device',
    baudRate: 9600,
    autoOpen: false,
    signal: controller.signal,
    binding: testBinding(() => opening.promise),
  });
  const error = once(port, 'error');
  const closed = new Promise(resolve => port.once('close', resolve));
  const opened = assert.rejects(call(port, 'open'), { canceled: true });
  const written = assert.rejects(call(port, 'write', 'waiting'), { code: 'ABORT_ERR' });
  controller.abort('shutdown');
  opening.resolve(binding);
  await Promise.all([opened, written, closed]);
  assert.equal((await error)[0].cause, 'shutdown');
  assert.equal(binding.isOpen, false);
  assert.equal(port.destroyed, true);
  assert.equal(port.opening, false);
  assert.equal(port.closing, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort remains effective across close and reopen without reaching binding options', async () => {
  const controller = new AbortController();
  if (typeof require('node:events').addAbortListener === 'function') {
    controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  }
  const requests: BindingOpenOptions[] = [];
  const port = new SerialPortStream({
    path: 'test-device',
    baudRate: 9600,
    autoOpen: false,
    signal: controller.signal,
    binding: testBinding(async options => {
      requests.push(options);
      return device();
    }),
  });
  await call(port, 'open');
  await call(port, 'close');
  await call(port, 'open');
  const error = once(port, 'error');
  const closed = new Promise(resolve => port.once('close', resolve));
  controller.abort();
  await closed;
  assert.equal((await error)[0].code, 'ABORT_ERR');
  assert(requests.every(options => !Object.hasOwn(options, 'signal')));
  assert.equal(port.isOpen, false);
  await assert.rejects(call(port, 'open'), /destroyed/);
});

test('destroy removes the abort listener from an unopened stream', async () => {
  const controller = new AbortController();
  const port = new SerialPortStream({
    path: 'test-device',
    baudRate: 9600,
    autoOpen: false,
    signal: controller.signal,
    binding: testBinding(async () => device()),
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  port.destroy();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await nextTurn();
  assert.equal(port.errored, null);
});

test('invalid stream flags, signals and bindings fail before opening', () => {
  const options = {
    path: 'test-device',
    baudRate: 9600,
    binding: {
      open() {
        assert.fail('opened');
      },
    },
  };
  for (const invalid of [{ autoOpen: 'false' }, { endOnClose: 1 }, { signal: null }, { signal: {} }, { binding: {} }]) {
    // @ts-expect-error Deliberately malformed constructor input.
    assert.throws(() => new SerialPortStream({ ...options, ...invalid }), TypeError);
  }
});
