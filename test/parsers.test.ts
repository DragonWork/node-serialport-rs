// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Transform } from 'node:stream';
import type { SpacePacket } from '..';
import {
  DelimiterParser,
  ReadlineParser,
  ByteLengthParser,
  ReadyParser,
  SlipEncoder,
  SlipDecoder,
  CCTalkParser,
  PacketLengthParser,
  SpacePacketParser,
  RegexParser,
  InterByteTimeoutParser,
} from '..';

async function parse<T = Buffer>(parser: Transform, chunks: readonly (Buffer | string)[]): Promise<T[]> {
  const output: T[] = [];
  parser.on('data', chunk => output.push(chunk));
  const ended = once(parser, 'end');
  for (const chunk of chunks) parser.write(chunk);
  parser.end();
  await ended;
  return output;
}

test('delimiter spanning chunks preserves the incomplete tail', async () => {
  const output = await parse(new DelimiterParser({ delimiter: '\r\n' }), ['ab\r', '\ncd\r\ne']);
  assert.deepEqual(
    output.map(chunk => chunk.toString()),
    ['ab', 'cd', 'e'],
  );
});

test('readline returns decoded strings', async () => {
  assert.deepEqual(await parse<string>(new ReadlineParser(), ['hello\nwor', 'ld\n']), ['hello', 'world']);
});

test('byte-length handles chunk boundaries and trailing bytes', async () => {
  const output = await parse(new ByteLengthParser({ length: 3 }), [Buffer.from([0, 1]), Buffer.from([2, 3, 4, 5, 6])]);
  assert.deepEqual(
    output.map(chunk => [...chunk]),
    [[0, 1, 2], [3, 4, 5], [6]],
  );
});

test('ready emits once and strips the handshake', async () => {
  const parser = new ReadyParser({ delimiter: 'READY' });
  let ready = 0;
  parser.on('ready', () => ready++);
  const output = await parse(parser, ['noiseRE', 'ADYpayload', 'more']);
  assert.equal(ready, 1);
  assert.equal(Buffer.concat(output).toString(), 'payloadmore');
});

test('SLIP encoder and decoder preserve every byte value', async () => {
  const expected = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encoder = new SlipEncoder({ readableHighWaterMark: 17, writableHighWaterMark: 19 });
  const decoder = new SlipDecoder({ readableHighWaterMark: 23, writableHighWaterMark: 29 });
  assert.equal(encoder.readableHighWaterMark, 17);
  assert.equal(encoder.writableHighWaterMark, 19);
  assert.equal(decoder.readableHighWaterMark, 23);
  assert.equal(decoder.writableHighWaterMark, 29);
  const encoded = await parse(encoder, [expected]);
  const decoded = await parse(decoder, encoded);
  assert.deepEqual(Buffer.concat(decoded), expected);
});

test('SLIP encoding snapshots unescaped payloads around the bulk-copy boundary', async () => {
  for (const size of [255, 256, 257, 4096]) {
    for (const options of [{}, { bluetoothQuirk: true }, { START: 0, ESC_START: 3 }, { START: 0 }, { START: 0x31 }]) {
      const payload = Buffer.alloc(size, 0x31);
      const prefix = Buffer.from([
        ...(options.bluetoothQuirk ? [0xc0] : []),
        ...(options.START === undefined ? [] : [options.START]),
      ]);
      const expected = Buffer.concat([prefix, payload, Buffer.from([0xc0])]);
      const output = await parse(new SlipEncoder(options), [payload]);
      payload.fill(0xff);
      assert.deepEqual(output, [expected]);
    }
  }
});

test('SLIP encoding escapes markers anywhere in a large payload', async () => {
  const options = { START: 0, END: 2, ESC: 1, ESC_START: 3, ESC_END: 4, ESC_ESC: 5 };
  for (const [byte, escape] of [
    [0, 3],
    [2, 4],
    [1, 5],
  ]) {
    for (const position of [0, 255, 256, 4095]) {
      const payload = Buffer.alloc(4096, 0x31);
      payload[position] = byte;
      const expected = Buffer.concat([
        Buffer.from([0]),
        payload.subarray(0, position),
        Buffer.from([1, escape]),
        payload.subarray(position + 1),
        Buffer.from([2]),
      ]);
      assert.deepEqual(await parse(new SlipEncoder(options), [payload]), [expected]);
    }
  }
});

test('large unescaped SLIP frames reuse input memory and retain split frames', async () => {
  const input = Buffer.alloc(513, 1);
  input[255] = input[511] = 0xc0;
  input[512] = 5;
  const output = await parse(new SlipDecoder(), [input, Buffer.from([6, 0xc0])]);
  assert.deepEqual(output, [Buffer.alloc(255, 1), Buffer.alloc(255, 1), Buffer.from([5, 6])]);
  assert.equal(output[0].buffer, input.buffer);
  assert.equal(output[0].byteOffset, input.byteOffset);
  assert.equal(output[1].byteOffset, input.byteOffset + 256);
});

function fragments(buffer: Buffer, size: number) {
  return Array.from({ length: Math.ceil(buffer.length / size) }, (_, i) => buffer.subarray(i * size, (i + 1) * size));
}

test('delimiter framing is independent of chunk boundaries and overlapping prefixes', async () => {
  const input = Buffer.from('aababaabbabaaababa');
  const delimiter = Buffer.from('aaba');
  for (const includeDelimiter of [false, true]) {
    const expected = [];
    let offset = 0;
    for (let at = input.indexOf(delimiter); at !== -1; at = input.indexOf(delimiter, offset)) {
      if (at > offset || includeDelimiter)
        expected.push(input.subarray(offset, at + (includeDelimiter ? delimiter.length : 0)));
      offset = at + delimiter.length;
    }
    if (offset < input.length) expected.push(input.subarray(offset));
    for (let size = 1; size <= input.length; size++) {
      assert.deepEqual(
        await parse(new DelimiterParser({ delimiter, includeDelimiter }), fragments(input, size)),
        expected,
      );
    }
  }
});

test('delimiter frame limits exclude split delimiters and reset after every frame', async () => {
  const input = Buffer.from('abcababdefababghi');
  for (const includeDelimiter of [false, true]) {
    for (let size = 1; size <= input.length; size++) {
      const output = await parse(
        new DelimiterParser({ delimiter: 'abab', includeDelimiter, maxFrameLength: 3 }),
        fragments(input, size),
      );
      assert.deepEqual(
        output.map(buffer => buffer.toString()),
        includeDelimiter ? ['abcabab', 'defabab', 'ghi'] : ['abc', 'def', 'ghi'],
      );
    }
  }
  assert.deepEqual(await parse(new DelimiterParser({ delimiter: '\r\n', maxFrameLength: 0 }), ['\r', '\n']), []);
});

test('delimiter frame limits reject oversized complete, incomplete and trailing frames', async () => {
  for (const chunks of [['abcd\r\n'], ['ab', 'cd'], ['abc\r', 'x'], ['abc\r']]) {
    const parser = new DelimiterParser({ delimiter: '\r\n', maxFrameLength: 3 });
    await assert.rejects(parse(parser, chunks), { code: 'ERR_SERIALPORT_FRAME_TOO_LARGE' });
    assert.equal(parser.destroyed, true);
  }
  const parser = new DelimiterParser({ delimiter: '\r\n', maxFrameLength: 3 });
  const failed = once(parser, 'error');
  parser.write('abcd');
  assert.equal((await failed)[0].code, 'ERR_SERIALPORT_FRAME_TOO_LARGE');
});

test('readline frame limits count bytes before decoding', async () => {
  assert.deepEqual(await parse<string>(new ReadlineParser({ maxFrameLength: 2 }), ['é\n']), ['é']);
  await assert.rejects(parse<string>(new ReadlineParser({ maxFrameLength: 1 }), ['é\n']), {
    code: 'ERR_SERIALPORT_FRAME_TOO_LARGE',
  });
});

test('delimiter frame limits reject invalid settings and remain optional', async () => {
  for (const maxFrameLength of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => new DelimiterParser({ delimiter: '\n', maxFrameLength }), TypeError);
  }
  const input = Buffer.alloc(128 * 1024, 0x61);
  assert.deepEqual(await parse(new DelimiterParser({ delimiter: '\n' }), [input]), [input]);
});

test('aligned byte frames and delimiters reuse input memory', async () => {
  const input = Buffer.from('abc:def:');
  for (const parser of [new ByteLengthParser({ length: 4 }), new DelimiterParser({ delimiter: ':' })]) {
    const output = await parse(parser, [input]);
    assert.equal(output.length, 2);
    assert.equal(output[0].buffer, input.buffer);
    assert.equal(output[0].byteOffset, input.byteOffset);
    assert.equal(output[1].byteOffset, input.byteOffset + 4);
  }
});

test('ready handles a prefix restarting inside another prefix', async () => {
  assert.deepEqual(await parse(new ReadyParser({ delimiter: 'aab' }), ['aa', 'abpayload']), [Buffer.from('payload')]);
});

test('regex decoding keeps UTF-8 characters intact across every byte boundary', async () => {
  const bytes = Buffer.from('Grüße;🔌;完了');
  for (const regex of [';', /;/, Buffer.from(';')])
    assert.deepEqual(await parse<string>(new RegexParser({ regex }), fragments(bytes, 1)), ['Grüße', '🔌', '完了']);
});

test('readline supports UTF-16 delimiters and fragmented multibyte characters', async () => {
  const bytes = Buffer.from('α\r\nβ\r\nγ', 'utf16le');
  assert.deepEqual(
    await parse<string>(new ReadlineParser({ encoding: 'utf16le', delimiter: '\r\n' }), fragments(bytes, 1)),
    ['α', 'β', 'γ'],
  );
});

test('SLIP custom zero-valued start and escape codes round-trip fragmented data', async () => {
  const options = { START: 0, ESC: 1, END: 2, ESC_START: 3, ESC_END: 4, ESC_ESC: 5, bluetoothQuirk: true };
  const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const encoded = Buffer.concat(await parse(new SlipEncoder(options), [payload]));
  assert.deepEqual(await parse(new SlipDecoder(options), fragments(encoded, 1)), [payload]);
});

test('SLIP defaults also apply to explicitly undefined options', async () => {
  const options = { ESC: undefined, END: undefined, ESC_END: undefined, ESC_ESC: undefined };
  const payload = Buffer.from([0xdb, 0xc0, 7]);
  const encoded = await parse(new SlipEncoder(options), [payload]);
  assert.deepEqual(encoded, [Buffer.from([0xdb, 0xdd, 0xdb, 0xdc, 7, 0xc0])]);
  assert.deepEqual(await parse(new SlipDecoder(options), encoded), [payload]);
});

test('escaped SLIP bytes take priority over a matching start marker', async () => {
  const options = { START: 0xdc, ESC_START: 0xde };
  const payload = Buffer.from([0xc0, 0xdc, 7]);
  const encoded = Buffer.concat(await parse(new SlipEncoder(options), [payload]));
  for (let size = 1; size <= encoded.length; size++) {
    assert.deepEqual(await parse(new SlipDecoder(options), fragments(encoded, size)), [payload]);
  }
});

test('SLIP retains the documented invalid-escape and trailing-frame behavior', async () => {
  assert.deepEqual(await parse(new SlipDecoder(), [Buffer.from([7, 0xdb]), Buffer.from([9, 0xc0, 10])]), [
    Buffer.from([7]),
    Buffer.from([9]),
    Buffer.from([10]),
  ]);
  assert.deepEqual(await parse(new SlipEncoder(), [Buffer.alloc(0)]), [Buffer.from([0xc0])]);
  assert.deepEqual(await parse(new SlipEncoder({ bluetoothQuirk: true }), [Buffer.alloc(0)]), []);
});

test('SLIP frame limits count decoded payload bytes across escape and chunk boundaries', async () => {
  const payload = Buffer.from([0xc0, 0xdb, 7]);
  const encoded = Buffer.concat(await parse(new SlipEncoder(), [payload, payload]));
  for (let size = 1; size <= encoded.length; size++) {
    assert.deepEqual(await parse(new SlipDecoder({ maxFrameLength: 3 }), fragments(encoded, size)), [payload, payload]);
    await assert.rejects(parse(new SlipDecoder({ maxFrameLength: 2 }), fragments(encoded, size)), {
      code: 'ERR_SERIALPORT_FRAME_TOO_LARGE',
    });
  }
  assert.deepEqual(await parse(new SlipDecoder({ maxFrameLength: 0 }), [Buffer.from([0xc0, 0xc0])]), []);
  await assert.rejects(parse(new SlipDecoder({ maxFrameLength: 0 }), [Buffer.from([1])]), {
    code: 'ERR_SERIALPORT_FRAME_TOO_LARGE',
  });
});

test('SLIP frame limits apply to both large slices and the byte decoder', async () => {
  const payload = Buffer.alloc(256, 1);
  const input = Buffer.concat([payload, Buffer.from([0xc0]), payload, Buffer.from([0xc0])]);
  for (const size of [1, 7, 255, 256, input.length]) {
    assert.deepEqual(await parse(new SlipDecoder({ maxFrameLength: 256 }), fragments(input, size)), [payload, payload]);
    for (const terminated of [false, true]) {
      const oversized = Buffer.concat([payload, Buffer.from(terminated ? [1, 0xc0] : [1])]);
      const parser = new SlipDecoder({ maxFrameLength: 256 });
      await assert.rejects(parse(parser, fragments(oversized, size)), { code: 'ERR_SERIALPORT_FRAME_TOO_LARGE' });
      assert.equal(parser.destroyed, true);
    }
  }
  const parser = new SlipDecoder({ maxFrameLength: 256 });
  const failed = once(parser, 'error');
  parser.write(payload);
  parser.write(Buffer.from([1]));
  const [error] = await failed;
  assert(error instanceof RangeError);
  assert('code' in error);
  assert.equal(error.code, 'ERR_SERIALPORT_FRAME_TOO_LARGE');
});

test('SLIP limits preserve custom start markers, invalid escapes and incomplete tails', async () => {
  const settings = { START: 0, END: 2, ESC: 1, ESC_START: 3, ESC_END: 4, ESC_ESC: 5, maxFrameLength: 1 };
  assert.deepEqual(await parse(new SlipDecoder(settings), [Buffer.from([9, 9, 0, 1]), Buffer.from([3, 2])]), [
    Buffer.from([0]),
  ]);
  assert.deepEqual(await parse(new SlipDecoder({ maxFrameLength: 1 }), [Buffer.from([7, 0xdb, 9, 0xc0, 10])]), [
    Buffer.from([7]),
    Buffer.from([9]),
    Buffer.from([10]),
  ]);
  await assert.rejects(parse(new SlipDecoder(settings), [Buffer.from([0, 7, 8])]), {
    code: 'ERR_SERIALPORT_FRAME_TOO_LARGE',
  });
});

test('SLIP limits reject invalid settings and remain optional', async () => {
  for (const maxFrameLength of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10']) {
    // @ts-expect-error Deliberately include a nonnumeric limit.
    assert.throws(() => new SlipDecoder({ maxFrameLength }), TypeError);
  }
  const payload = Buffer.alloc(128 * 1024, 1);
  assert.deepEqual(await parse(new SlipDecoder(), [payload]), [payload]);
});

test('CCTalk frames use the payload length and discard incomplete trailing frames', async () => {
  const frames = [Buffer.from([1, 0, 2, 3, 4]), Buffer.from([2, 3, 4, 5, 6, 7, 8, 9])];
  const input = Buffer.concat([...frames, Buffer.from([1, 20, 3])]);
  for (let size = 1; size <= input.length; size++) {
    assert.deepEqual(await parse(new CCTalkParser(0), fragments(input, size)), frames);
  }
});

test('length-prefixed frames handle multiple multibyte delimiters and split length fields', async () => {
  const options = {
    delimiter: [0xabc123, 0x987654],
    delimiterBytes: 3,
    lengthOffset: 3,
    lengthBytes: 2,
    packetOverhead: 5,
    maxLen: 1024,
  };
  const frames = [Buffer.from([0xab, 0xc1, 0x23, 3, 0, 1, 2, 3]), Buffer.from([0x98, 0x76, 0x54, 1, 0, 4])];
  const input = Buffer.concat(frames);
  for (let size = 1; size <= input.length; size++) {
    assert.deepEqual(await parse(new PacketLengthParser(options), fragments(input, size)), frames);
  }
});

test('length-prefixed frames emit an oversized header early and recover', async () => {
  const input = Buffer.from([0, 0xaa, 6, 1, 2, 0xaa, 2, 3, 4, 0xaa, 4, 5]);
  assert.deepEqual(await parse(new PacketLengthParser({ maxLen: 4 }), fragments(input, 1)), [
    Buffer.from([0xaa, 6]),
    Buffer.from([0xaa, 2, 3, 4]),
    Buffer.from([0xaa, 4, 5]),
  ]);
});

test('space packets expose the header and secondary fields without recursive parsing', async () => {
  const frame = Buffer.from([0x09, 0x23, 0xc0, 0x07, 0, 4, 0x54, 0x41, 0x42, 0x43, 0x44]);
  const expected = {
    header: {
      versionNumber: 1,
      identification: { apid: 0x123, secondaryHeader: 1, type: 0 },
      sequenceControl: { packetName: 7, sequenceFlags: 3 },
      dataLength: 5,
    },
    data: 'CD',
    secondaryHeader: { timeCode: 'T', ancillaryData: 'AB' },
  };
  for (let size = 1; size <= frame.length; size++) {
    assert.deepEqual(
      await parse<SpacePacket | number[]>(
        new SpacePacketParser({ timeCodeFieldLength: 1, ancillaryDataFieldLength: 2 }),
        fragments(frame, size),
      ),
      [expected, []],
    );
  }
  const parser = new SpacePacketParser();
  let count = 0;
  parser.on('data', packet => {
    if (!Array.isArray(packet)) count++;
  });
  parser.end(Buffer.concat(Array.from({ length: 10000 }, () => frame)));
  await once(parser, 'end');
  assert.equal(count, 10000);
});

test('timeout parser emits bounded frames, flushes the tail, and has no timer after destroy', async () => {
  const output = await parse(new InterByteTimeoutParser({ interval: 10, maxBufferSize: 3 }), [
    Buffer.from('ab'),
    Buffer.from('cdefg'),
  ]);
  assert.deepEqual(
    output.map(buffer => buffer.toString()),
    ['abc', 'def', 'g'],
  );
  const parser = new InterByteTimeoutParser({ interval: 10 });
  const received: Buffer[] = [];
  parser.on('data', chunk => received.push(chunk));
  const data = once(parser, 'data');
  parser.write('first');
  await data;
  parser.write('discard');
  parser.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(
    received.map(buffer => buffer.toString()),
    ['first'],
  );
});

test('parser constructors reject invalid frame sizes instead of retaining bytes forever', () => {
  for (const length of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new ByteLengthParser({ length }), TypeError);
  for (const delimiter of [undefined, '', Buffer.alloc(0)])
    // @ts-expect-error Missing delimiters must be rejected at runtime.
    assert.throws(() => new DelimiterParser({ delimiter }), TypeError);
  assert.throws(() => new InterByteTimeoutParser({ interval: 0 }), TypeError);
  assert.throws(() => new PacketLengthParser({ lengthBytes: 7 }), TypeError);
  assert.throws(() => new SpacePacketParser({ timeCodeFieldLength: -1 }), TypeError);
});
