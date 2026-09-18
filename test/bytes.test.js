// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ByteQueue } = require('../lib/parsers/bytes');

test('byte queue preserves partial chunks through peeks, discards and compaction', () => {
  const input = Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 255));
  const queue = new ByteQueue();
  for (let i = 0; i < input.length; i += 7) queue.append(input.subarray(i, i + 7));
  let offset = 0;
  const retained = [];
  while (offset < input.length) {
    const count = Math.min(1 + (offset % 31), input.length - offset);
    const expected = input.subarray(offset, offset + count);
    assert.deepEqual(queue.peek(count), expected);
    assert.equal(queue.length, input.length - offset);
    if (offset % 2) queue.discard(count);
    else {
      const bytes = queue.take(count);
      assert.deepEqual(bytes, expected);
      retained.push([bytes, Buffer.from(expected)]);
    }
    offset += count;
    assert.equal(queue.length, input.length - offset);
  }
  queue.append(Buffer.from('reused'));
  assert.equal(queue.take().toString(), 'reused');
  for (const [bytes, expected] of retained) assert.deepEqual(bytes, expected);
});

test('byte queue reuses contiguous input and resets a partially consumed head', () => {
  const input = Buffer.from('first second');
  const queue = new ByteQueue();
  queue.append(input);
  queue.discard(6);
  const bytes = queue.peek(6);
  assert.equal(bytes.toString(), 'second');
  assert.equal(bytes.buffer, input.buffer);
  assert.equal(bytes.byteOffset, input.byteOffset + 6);
  queue.clear();
  queue.append(Buffer.from('next'));
  assert.equal(queue.take().toString(), 'next');
  assert.equal(bytes.toString(), 'second');
});
