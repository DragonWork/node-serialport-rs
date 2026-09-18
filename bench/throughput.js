// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');

const { values } = parseArgs({
  options: {
    binding: { type: 'string' },
    stream: { type: 'string' },
    label: { type: 'string', default: 'rust' },
    ports: { type: 'string', default: '1' },
    bytes: { type: 'string', default: '65536' },
    mib: { type: 'string', default: '64' },
    'warmup-mib': { type: 'string', default: '4' },
  },
});
function integer(name, min, max) {
  const value = Number(values[name]);
  assert(Number.isInteger(value) && value >= min && value <= max, `Invalid --${name}`);
  return value;
}
const ports = integer('ports', 1, 32);
const bytes = integer('bytes', 8, 65536);
const measured = integer('mib', 1, 4096) * 1048576;
const warmup = integer('warmup-mib', 0, 64) * 1048576;
assert(measured % bytes === 0 && warmup % bytes === 0, 'Transfer sizes must contain whole frames');
const binding = require(resolve(values.binding || join(__dirname, '..'))).autoDetect();
const { SerialPortStream } = require(resolve(values.stream || join(__dirname, '..')));
const call = (port, method, ...args) =>
  new Promise((resolve, reject) => {
    port[method](...args, error => (error ? reject(error) : resolve()));
  });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const mib = value => +(value / 1048576).toFixed(2);
function memory() {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { rss, heapUsed, external, arrayBuffers };
}
const memoryMiB = value => Object.fromEntries(Object.entries(value).map(([key, bytes]) => [key, mib(bytes)]));
function workers() {
  if (process.platform !== 'linux') return null;
  return readdirSync('/proc/self/task').filter(id => {
    try {
      return readFileSync(`/proc/self/task/${id}/comm`, 'utf8').trim() === 'serialport-rt';
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }).length;
}

class Echo {
  constructor(index) {
    this.sent = 0;
    this.received = 0;
    this.target = 0;
    this.payload = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) this.payload[i] = (i * 13 + index * 29) & 255;
    this.expected = Buffer.from(this.payload);
    this.child = spawn(join(__dirname, '../target/release/examples/echo'), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => {
      if (!this.closing) this.fail(new Error('Echo helper exited'));
    });
    this.stderr = '';
    this.child.stderr.on('data', data => {
      this.stderr = (this.stderr + data).slice(-8192);
    });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }

  fail(error) {
    this.failure ||= error;
    this.pending?.reject(error);
  }

  async open() {
    const first = await this.lines.next();
    assert(!first.done, `Echo helper failed: ${this.stderr}`);
    this.port = new SerialPortStream({
      path: first.value,
      baudRate: 115200,
      autoOpen: false,
      binding,
    });
    this.port.on('error', error => this.fail(error));
    this.port.on('close', () => {
      if (!this.closing) this.fail(new Error('Serial port closed unexpectedly'));
    });
    this.port.on('data', data => {
      try {
        assert(this.received + data.length <= this.target, 'Unexpected or duplicate echo bytes');
        for (let offset = 0; offset < data.length;) {
          const position = this.received % bytes;
          const length = Math.min(bytes - position, data.length - offset);
          this.expected.writeUInt32LE(Math.floor(this.received / bytes), 0);
          assert(
            data.subarray(offset, offset + length).equals(this.expected.subarray(position, position + length)),
            'Corrupt or reordered echo',
          );
          this.received += length;
          offset += length;
        }
        if (this.received === this.target) this.pending?.resolve();
      } catch (error) {
        this.fail(error);
      }
    });
    await call(this.port, 'open');
    this.child.stdin.write('start\n');
    assert.equal((await this.lines.next()).value, 'ready');
  }

  async transfer(length) {
    if (!length) return;
    this.target += length;
    const received = new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const sending = (async () => {
      while (this.sent < this.target) {
        if (this.failure) throw this.failure;
        this.payload.writeUInt32LE(Math.floor(this.sent / bytes), 0);
        this.sent += bytes;
        // One outstanding write per port bounds sender memory independently of transfer size.
        await call(this.port, 'write', this.payload);
      }
    })();
    await Promise.all([sending, received]);
    this.pending = undefined;
    if (this.failure) throw this.failure;
    assert.equal(this.received, this.sent);
  }

  async close() {
    this.closing = true;
    try {
      if (this.port?.isOpen) await call(this.port, 'close');
    } finally {
      this.child.kill();
      await this.exited;
    }
  }
}

async function main() {
  const initial = memory();
  const sessions = Array.from({ length: ports }, (_, index) => new Echo(index));
  const timeout = setTimeout(() => {
    for (const session of sessions) {
      session.fail(new Error('Throughput benchmark timed out'));
      session.child.kill();
      session.port?.destroy();
    }
  }, 120000);
  let sampler;
  try {
    await Promise.all(sessions.map(session => session.open()));
    await Promise.all(sessions.map(session => session.transfer(warmup)));
    global.gc?.();
    const before = memory();
    const peak = { ...before };
    const sample = () => {
      for (const [key, value] of Object.entries(memory())) peak[key] = Math.max(peak[key], value);
    };
    sampler = setInterval(sample, 50);
    const activeWorkers = workers();
    const cpuStart = process.cpuUsage();
    const started = process.hrtime.bigint();
    await Promise.all(sessions.map(session => session.transfer(measured)));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const cpu = process.cpuUsage(cpuStart);
    sample();
    clearInterval(sampler);
    const afterTransfer = memory();
    await Promise.all(sessions.map(session => call(session.port, 'drain')));
    await Promise.all(sessions.map(session => session.close()));
    await delay(100);
    global.gc?.();
    const afterClose = memory();
    for (const session of sessions) if (session.failure) throw session.failure;
    console.log(
      JSON.stringify({
        label: values.label,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ports,
        bytes,
        measuredMiBPerPort: measured / 1048576,
        warmupMiBPerPort: warmup / 1048576,
        elapsedMs: +elapsedMs.toFixed(2),
        echoMiBps: +(((measured * ports) / 1048576 / elapsedMs) * 1000).toFixed(2),
        cpuMsPerMiB: +((cpu.user + cpu.system) / 1000 / ((measured * ports) / 1048576)).toFixed(2),
        memoryMiB: {
          initial: memoryMiB(initial),
          before: memoryMiB(before),
          peak: memoryMiB(peak),
          afterTransfer: memoryMiB(afterTransfer),
          afterClose: memoryMiB(afterClose),
        },
        activeWorkers,
        workersAfterClose: workers(),
        forcedGc: typeof global.gc === 'function',
        nativeSha256: Object.keys(require.cache)
          .filter(file => file.endsWith('.node'))
          .map(hash),
        benchmarkSha256: hash(__filename),
      }),
    );
  } finally {
    clearTimeout(timeout);
    clearInterval(sampler);
    await Promise.all(sessions.filter(session => !session.closing).map(session => session.close()));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
