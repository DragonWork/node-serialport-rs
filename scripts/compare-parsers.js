// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {once} = require('node:events');
const {resolve} = require('node:path');
const current = require('..');
if (!process.argv[2]) throw new Error('Pass the directory of a serialport package to compare');
const reference = require(resolve(process.argv[2]));

async function output(Parser, options, input, chunkSize) {
  const parser = new Parser(options);
  const result = [];
  parser.on('data', chunk => result.push(chunk));
  const end = once(parser, 'end');
  for (let i = 0; i < input.length; i += chunkSize) parser.write(input.subarray(i, i + chunkSize));
  parser.end();
  await end;
  return result;
}

async function compare(name, options, input) {
  for (const size of [1, 2, 3, 7, 64, input.length]) {
    const expected = await output(reference[name], options, input, size);
    const actual = await output(current[name], options, input, size);
    assert.deepEqual(actual, expected, `${name}, chunk size ${size}, ${JSON.stringify(options)}`);
  }
}

(async () => {
  const binary = Buffer.from(Array.from({length: 4096}, (_, i) => (i * 13 + 7) & 255));
  let cases = 0;
  for (const length of [1, 3, 64, 4096]) { await compare('ByteLengthParser', {length}, binary); cases++; }
  for (const delimiter of [Buffer.from([7]), Buffer.from([7, 20, 33]), Buffer.from([0xff, 0xff])]) {
    for (const includeDelimiter of [false, true]) { await compare('DelimiterParser', {delimiter, includeDelimiter}, binary); cases++; }
  }
  await compare('ReadlineParser', {}, Buffer.from('a\nb\r\nc\nd')); cases++;
  await compare('RegexParser', {regex: /[\r\n]+/}, Buffer.from('a\nb\r\nc\nd')); cases++;
  await compare('ReadyParser', {delimiter: 'START'}, Buffer.from('ignoredSTARTpayloadSTARTtail')); cases++;
  for (const options of [{}, {bluetoothQuirk: true}, {START: 0xab, END: 0xbc, ESC: 0xcd, ESC_START: 0xac, ESC_END: 0xbd, ESC_ESC: 0xce}]) {
    await compare('SlipEncoder', options, binary); cases++;
    const encoded = Buffer.concat(await output(reference.SlipEncoder, options, binary, 128));
    await compare('SlipDecoder', options, encoded); cases++;
  }
  for (const maxBufferSize of [3, 64, 65536]) { await compare('InterByteTimeoutParser', {interval: 60000, maxBufferSize}, binary); cases++; }
  const cctalk = Buffer.from([1, 0, 2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 1]);
  await compare('CCTalkParser', 0, cctalk); cases++;
  await compare('PacketLengthParser', {}, Buffer.from([0, 0xaa, 3, 4, 5, 6, 0xaa, 2, 7, 8, 0xaa, 3, 9])); cases++;
  const options = {delimiter: [0xaabc, 0xdef0], delimiterBytes: 2, lengthOffset: 2, lengthBytes: 2, packetOverhead: 4};
  await compare('PacketLengthParser', options, Buffer.from([0xaa, 0xbc, 3, 0, 1, 2, 3, 0xde, 0xf0, 1, 0, 4])); cases++;
  const space = Buffer.from([0x09, 0x23, 0xc0, 0x07, 0, 4, 0x54, 0x41, 0x42, 0x43, 0x44]);
  for (const options of [{}, {timeCodeFieldLength: 1, ancillaryDataFieldLength: 2}]) {
    await compare('SpacePacketParser', options, Buffer.concat([space, space, space.subarray(0, 4)])); cases++;
  }
  console.log(`${cases * 6} parser comparisons passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
