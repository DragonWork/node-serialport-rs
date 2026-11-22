// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { RustBinding } from '..';
import { pty } from './helpers';

if (process.argv.includes('--drain-gate')) {
  test('reads, ordered commands and close during a physical drain', { timeout: 10000 }, async t => {
    const peer = await pty(t);
    const second = await pty(t);
    const options = { path: peer.path, baudRate: 115200 };
    const port = await RustBinding.open(options);
    const other = await RustBinding.open({ ...options, path: second.path });
    const release = () => writeFileSync('release', '');
    t.after(async () => {
      release();
      if (port.isOpen) await port.close();
      await other.close();
    });
    process.env.SERIALPORT_GATE_DRAIN = '1';
    async function entered() {
      while (!existsSync('entered')) await delay(1);
    }

    const drained = port.drain();
    await entered();
    const order: string[] = [];
    const written = port.write(Buffer.from('A')).then(() => order.push('write'));
    const queried = port.getBaudRate().then(() => order.push('get'));
    const received = port.readChunk(1);
    await peer.command('write 5a');
    await other.write(Buffer.from('B'));
    assert.equal(await second.command('read 1'), '42');
    assert.deepEqual(
      await Promise.race([received, delay(5000, 'read waited for the drain', { ref: false })]),
      Buffer.from('Z'),
    );
    assert.deepEqual(order, []);
    release();
    await Promise.all([drained, written, queried]);
    assert.deepEqual(order, ['write', 'get']);
    assert.equal(await peer.command('read 1'), '41');

    rmSync('release');
    rmSync('entered');
    const canceled = assert.rejects(port.drain(), { canceled: true });
    await entered();
    let closed = false;
    const closing = port.close().then(() => {
      closed = true;
    });
    await other.getBaudRate();
    assert.equal(closed, false);
    await assert.rejects(RustBinding.open(options));
    release();
    await Promise.all([closing, canceled]);
    const reopened = await RustBinding.open(options);
    await reopened.close();
  });
} else {
  test('a slow driver drain preserves duplex I/O and exclusive close', { skip: process.platform !== 'linux' }, t => {
    const directory = mkdtempSync(join(tmpdir(), 'serialport-drain-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const library = join(directory, 'drain-gate.so');
    const build = spawnSync('cc', ['-shared', '-fPIC', join(__dirname, 'drain-gate.c'), '-o', library, '-ldl'], {
      encoding: 'utf8',
    });
    if ((build.error as NodeJS.ErrnoException)?.code === 'ENOENT') return t.skip('C compiler unavailable');
    assert.equal(build.status, 0, build.stderr);
    const env: NodeJS.ProcessEnv = { ...process.env, LD_PRELOAD: library };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [__filename, '--drain-gate'], {
      cwd: directory,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
