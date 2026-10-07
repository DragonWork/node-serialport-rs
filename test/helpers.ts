// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { BindingInterface, BindingOpenOptions, SerialPortStream, PortStatus, BaudRateResult } from '..';

export type TestPort = NonNullable<import('../ts/lib/stream').SerialPortStream['port']>;
type CallbackMethod = 'open' | 'close' | 'write' | 'update' | 'set' | 'get' | 'getBaudRate' | 'flush' | 'drain';
type CallbackPort = Pick<SerialPortStream<BindingInterface>, CallbackMethod>;
type CallbackResult<M> = M extends 'get' ? PortStatus : M extends 'getBaudRate' ? BaudRateResult : void;

async function pty(t: TestContext) {
  const child = spawn(join(__dirname, '../target/debug/examples/pty'), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw new Error(`PTY helper failed: ${stderr}`);
  t.after(() => {
    child.kill();
  });
  return {
    path: first.value,
    async command(command: string) {
      child.stdin.write(`${command}\n`);
      const line = await lines.next();
      if (line.done) throw new Error(`PTY helper exited: ${stderr}`);
      return line.value;
    },
    async hangup() {
      const exited = once(child, 'exit');
      child.stdin.write('hangup\n');
      await exited;
    },
  };
}

function call<M extends CallbackMethod>(port: CallbackPort, method: M, ...args: unknown[]): Promise<CallbackResult<M>> {
  const operation = port[method] as (...args: unknown[]) => unknown;
  return new Promise((resolve, reject) =>
    operation.call(port, ...args, function (this: CallbackPort, error?: Error | null, value?: CallbackResult<M>) {
      if (method !== 'write' && this !== port) return reject(new Error('Incorrect callback receiver'));
      if (error) reject(error);
      else resolve(value as CallbackResult<M>);
    }),
  );
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function device(overrides: Partial<TestPort> = {}): TestPort {
  return {
    openOptions: {
      path: 'test-device',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      lock: true,
      rtscts: false,
      xon: false,
      xoff: false,
      xany: false,
      hupcl: true,
    },
    isOpen: true,
    async close() {
      this.isOpen = false;
      this.onClose?.(null);
    },
    read() {
      return new Promise(() => {});
    },
    async write() {},
    async update() {},
    async set() {},
    async get() {
      return { cts: false, dsr: false, dcd: false };
    },
    async getBaudRate() {
      return { baudRate: this.openOptions.baudRate };
    },
    async flush() {},
    async drain() {},
    ...overrides,
  };
}

export function binding(open: (options: BindingOpenOptions) => Promise<TestPort>): BindingInterface<TestPort> {
  return {
    async list() {
      return [];
    },
    open,
  };
}

export function portSequence(...ports: TestPort[]): BindingInterface<TestPort> {
  return binding(async () => {
    const port = ports.shift();
    assert(port, 'No device remains in the fixture');
    return port;
  });
}

export { pty, call };
