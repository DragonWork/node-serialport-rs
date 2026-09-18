// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');

const { values } = parseArgs({
  options: {
    binding: { type: 'string' },
    stream: { type: 'string' },
    label: { type: 'string', default: 'rust' },
    samples: { type: 'string', default: '10000' },
    warmup: { type: 'string', default: '2000' },
    bytes: { type: 'string', default: '32' },
    segments: { type: 'string', default: '1' },
    'idle-ms': { type: 'string', default: '3000' },
    'gap-ms': { type: 'string', default: '0' },
  },
});
const samples = integer('samples', 1, 1000000);
const warmup = integer('warmup', 0, 1000000);
const bytes = integer('bytes', 4, 65536);
const segments = integer('segments', 1, 1024);
assert(bytes % segments === 0, 'Bytes must divide into whole segments');
const idleMs = integer('idle-ms', 0, 60000);
const gapMs = integer('gap-ms', 0, 1000);
const bindingPath = resolve(values.binding || join(__dirname, '..'));
const streamPath = resolve(values.stream || join(__dirname, '..'));
const binding = require(bindingPath).autoDetect();
const { SerialPortStream } = require(streamPath);

function integer(name, min, max) {
  const value = Number(values[name]);
  assert(Number.isInteger(value) && value >= min && value <= max, `Invalid --${name}`);
  return value;
}

function distribution(values) {
  values.sort((a, b) => a - b);
  const percentile = (p) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
  return Object.fromEntries(
    Object.entries({
      median: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: values[values.length - 1],
    }).map(([key, value]) => [key, +value.toFixed(2)]),
  );
}

function call(port, method) {
  return new Promise((resolve, reject) => port[method]((error) => (error ? reject(error) : resolve())));
}

async function main() {
  const child = spawn(join(__dirname, '../target/release/examples/echo'), { stdio: ['pipe', 'pipe', 'pipe'] });
  let helperError = '';
  child.stderr.on('data', (data) => {
    helperError += data;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let port;
  try {
    const first = await lines.next();
    assert(!first.done, `Echo helper failed: ${helperError}`);
    port = new SerialPortStream({
      path: first.value,
      baudRate: 115200,
      autoOpen: false,
      binding,
    });
    let pending;
    let failure;
    port.on('error', (error) => {
      failure = error;
      pending?.reject(error);
    });
    const payload = Buffer.allocUnsafe(bytes);
    for (let i = 0; i < bytes; i++) payload[i] = i & 255;
    const parts = Array.from({ length: segments }, (_, i) =>
      payload.subarray((i * bytes) / segments, ((i + 1) * bytes) / segments),
    );
    port.on('data', (data) => {
      const receivedAt = process.hrtime.bigint();
      assert(pending, 'Unexpected serial data');
      const end = pending.offset + data.length;
      assert(end <= bytes && data.equals(payload.subarray(pending.offset, end)), 'Corrupted or duplicated echo');
      pending.offset = end;
      if (end === bytes) {
        const { resolve } = pending;
        pending = undefined;
        resolve(receivedAt);
      }
    });
    await call(port, 'open');
    child.stdin.write('start\n');
    assert.equal((await lines.next()).value, 'ready');

    const eventUs = [];
    const promiseUs = [];
    const writeUs = [];
    let cpuStart;
    let started;
    for (let i = 0; i < warmup + samples; i++) {
      if (failure) throw failure;
      if (i === warmup) {
        cpuStart = process.cpuUsage();
        started = process.hrtime.bigint();
      }
      // Optional gaps are outside the measured round trip; no heartbeat timer runs during I/O.
      if (gapMs && i >= warmup) await delay(gapMs);
      payload.writeUInt32LE(i, 0);
      const response = new Promise((resolve, reject) => {
        pending = { offset: 0, resolve, reject };
      });
      let onWrite;
      const written = new Promise((resolve, reject) => {
        onWrite = (error) => (error ? reject(error) : resolve(process.hrtime.bigint()));
      });
      const sentAt = process.hrtime.bigint();
      if (segments === 1) port.write(payload, onWrite);
      else {
        port.cork();
        for (let part = 0; part < parts.length; part++) {
          port.write(parts[part], part === parts.length - 1 ? onWrite : undefined);
        }
        port.uncork();
      }
      const receivedAt = await response;
      const continuedAt = process.hrtime.bigint();
      const writtenAt = await written;
      if (i >= warmup) {
        eventUs.push(Number(receivedAt - sentAt) / 1000);
        promiseUs.push(Number(continuedAt - sentAt) / 1000);
        writeUs.push(Number(writtenAt - sentAt) / 1000);
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const activeCpu = process.cpuUsage(cpuStart);
    const activeCpuUs = activeCpu.user + activeCpu.system;
    await call(port, 'drain');
    // Include a pending read after traffic, where stale readiness can cause a busy loop.
    const idleStart = process.hrtime.bigint();
    const idleCpuStart = process.cpuUsage();
    if (idleMs) await delay(idleMs);
    const idleElapsedMs = Number(process.hrtime.bigint() - idleStart) / 1e6;
    const idleCpu = process.cpuUsage(idleCpuStart);
    const idleCpuMs = (idleCpu.user + idleCpu.system) / 1000;
    const memory = process.memoryUsage();
    const native = process.report
      .getReport()
      .sharedObjects.filter((path) => path.endsWith('.node'))
      .map((path) => ({
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      }));
    const packageVersion = (path) => {
      const { name, version } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      return { name, version };
    };
    console.log(
      JSON.stringify({
        label: values.label,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        binding: packageVersion(bindingPath),
        stream: packageVersion(streamPath),
        native,
        samples,
        warmup,
        bytes,
        segments,
        gapMs,
        eventUs: distribution(eventUs),
        promiseUs: distribution(promiseUs),
        writeUs: distribution(writeUs),
        elapsedMs: +elapsedMs.toFixed(2),
        cpuUsPerRoundTrip: +(activeCpuUs / samples).toFixed(2),
        cpuPercent: +(activeCpuUs / elapsedMs / 10).toFixed(3),
        idleCpuMs: +idleCpuMs.toFixed(2),
        idleCpuPercent: +((idleCpuMs / idleElapsedMs) * 100).toFixed(3),
        rssMiB: +(memory.rss / 1048576).toFixed(2),
        externalMiB: +(memory.external / 1048576).toFixed(2),
      }),
    );
  } finally {
    try {
      if (port?.isOpen) await call(port, 'close');
    } finally {
      child.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
