// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { once } = require('node:events');
const { resolve } = require('node:path');
const parsers = require(process.argv[2] ? resolve(process.argv[2]) : '..');

const lines = Buffer.from(`${'x'.repeat(127)}\n`.repeat(32768));
const packet = Buffer.alloc(1027, 0x31);
packet[0] = 0xaa;
packet.writeUInt16LE(1024, 1);
const slip = Buffer.alloc(4097, 0x31);
slip[4096] = 0xc0;
const escapedSlip = Buffer.concat([Buffer.alloc(4096, Buffer.from([0xdb, 0xdd])), Buffer.from([0xc0])]);
const cases = [
  ['fixed 64-byte frames', 'ByteLengthParser', { length: 64 }, Buffer.alloc(4 * 1024 * 1024, 0x31), 4096],
  ['128-byte lines', 'DelimiterParser', { delimiter: '\n' }, lines, 4096],
  ['256 KiB fragmented line', 'DelimiterParser', { delimiter: '\n' }, Buffer.alloc(256 * 1024, 0x31), 64],
  [
    '1 KiB length-prefixed packets',
    'PacketLengthParser',
    { lengthBytes: 2, packetOverhead: 3, maxLen: 65535 },
    Buffer.concat(Array(256).fill(packet)),
    64,
  ],
  ['SLIP 4 KiB decode', 'SlipDecoder', {}, Buffer.concat(Array(64).fill(slip)), 64],
  ['SLIP aligned 4 KiB decode', 'SlipDecoder', {}, Buffer.concat(Array(64).fill(slip)), slip.length],
  ['SLIP escaped decode', 'SlipDecoder', {}, Buffer.concat(Array(64).fill(escapedSlip)), 64],
  ['SLIP 4 KiB encode', 'SlipEncoder', {}, Buffer.alloc(4 * 1024 * 1024, 0x31), 4096],
];

async function run([name, Parser, options, input, chunkSize]) {
  const times = [];
  const cpus = [];
  let outputBytes = 0;
  for (let trial = 0; trial < 6; trial++) {
    global.gc?.();
    const parser = new parsers[Parser](options);
    outputBytes = 0;
    parser.on('data', (chunk) => {
      outputBytes += chunk.length;
    });
    const end = once(parser, 'end');
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    for (let offset = 0; offset < input.length; offset += chunkSize)
      parser.write(input.subarray(offset, offset + chunkSize));
    parser.end();
    await end;
    const ms = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    if (trial) {
      times.push(ms);
      cpus.push((cpu.user + cpu.system) / 1000);
    }
  }
  times.sort((a, b) => a - b);
  cpus.sort((a, b) => a - b);
  return {
    name,
    medianMs: +times[2].toFixed(2),
    medianCpuMs: +cpus[2].toFixed(2),
    MiBps: +(input.length / 1048576 / (times[2] / 1000)).toFixed(1),
    outputBytes,
  };
}

(async () => {
  console.log(`${process.version} ${process.platform}/${process.arch}; five trials after warmup`);
  for (const entry of cases) console.log(JSON.stringify(await run(entry)));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
