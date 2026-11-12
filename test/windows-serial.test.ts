// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RustBinding, SerialPort } from '..';
import { call } from './helpers';

const path = process.env.SERIALPORT_TEST_PORT;
const peerPath = process.env.SERIALPORT_TEST_PEER;

test(
  'Windows paired ports retain pending reads across idle timeouts and preserve duplex bytes',
  { skip: process.platform !== 'win32' || !path || !peerPath, timeout: 180_000 },
  async t => {
    assert(path && peerPath && path.toLowerCase() !== peerPath.toLowerCase(), 'Use two isolated, connected COM ports');
    let binding = await RustBinding.open({ path, baudRate: 115200 });
    t.after(async () => {
      if (binding.isOpen) await binding.close();
    });
    const peer = new SerialPort({ path: peerPath, baudRate: 115200, autoOpen: false });
    let failure: Error | undefined;
    peer.on('error', error => {
      failure = error;
    });
    peer.on('data', data => {
      if (
        !peer.write(data, error => {
          if (error) failure = error;
        })
      )
        peer.pause();
    });
    peer.on('drain', () => peer.resume());
    t.after(() => peer.destroy());
    await call(peer, 'open');

    async function readExact(length: number) {
      const chunks: Buffer[] = [];
      let received = 0;
      while (received < length) {
        const chunk = await binding.readChunk(length - received);
        assert(chunk.length > 0, 'Idle timeout became EOF');
        chunks.push(chunk);
        received += chunk.length;
      }
      return Buffer.concat(chunks);
    }

    const frame = Buffer.from('010300000001840a', 'hex');
    const roundTrips: number[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const received = readExact(frame.length);
      // Each pause exceeds the driver's 60-second first-byte timeout. Race the
      // pending read so a regression fails immediately instead of waiting it out.
      await Promise.race([
        delay(65_000, undefined, { signal: t.signal, ref: false }),
        received.then(() => {
          throw new Error('Unexpected data on an idle fixture');
        }),
      ]);
      assert.ifError(failure);
      assert(binding.isOpen && peer.isOpen, 'Port closed while idle');
      const start = performance.now();
      const [, echoed] = await Promise.all([binding.write(frame), received]);
      roundTrips.push(performance.now() - start);
      assert.deepEqual(echoed, frame);
    }

    for (let i = 0; i < 64; i++) {
      frame.writeUInt32LE(i);
      const start = performance.now();
      const [, echoed] = await Promise.all([binding.write(frame), readExact(frame.length)]);
      roundTrips.push(performance.now() - start);
      assert.deepEqual(echoed, frame);
    }

    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 255;
    const transferStart = performance.now();
    const sending = async () => {
      for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
        await binding.write(payload.subarray(offset, offset + 16 * 1024));
      }
    };
    const [, echoed] = await Promise.all([sending(), readExact(payload.length)]);
    const transferMs = performance.now() - transferStart;
    assert.deepEqual(echoed, payload);
    assert.ifError(failure);

    // Closing must cancel an outstanding read without waiting for the next timeout.
    const canceled = assert.rejects(binding.readChunk(1), { canceled: true });
    const closeStart = performance.now();
    await binding.close();
    await canceled;
    assert(performance.now() - closeStart < 1000, 'Closing waited for the read timeout');
    binding = await RustBinding.open({ path, baudRate: 115200 });
    const [, reopened] = await Promise.all([binding.write(frame), readExact(frame.length)]);
    assert.deepEqual(reopened, frame);
    await binding.close();
    await call(peer, 'close');
    roundTrips.sort((a, b) => a - b);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        path,
        peer: peerPath,
        roundTripMs: { median: roundTrips[Math.floor(roundTrips.length / 2)], p99: roundTrips.at(-1) },
        echoedBytesPerSecond: (payload.length * 1000) / transferMs,
      }),
    );
  },
);
