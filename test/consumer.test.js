// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {pty, call} = require('./helpers');
const {RustBinding} = require('..');

for (const operation of ['read', 'write']) {
  test(`original serialport stream reports a Rust binding ${operation} disconnect`, {
    skip: !process.env.SERIALPORT_REFERENCE_STREAM, timeout: 5000,
  }, async t => {
    const {SerialPortStream} = require(process.env.SERIALPORT_REFERENCE_STREAM);
    const terminal = await pty(t);
    const port = new SerialPortStream({path: terminal.path, baudRate: 115200, binding: RustBinding, autoOpen: false});
    t.after(() => port.isOpen && call(port, 'close'));
    port.on('error', () => {});
    let closes = 0;
    port.on('close', () => closes++);
    await call(port, 'open');
    const closed = new Promise(resolve => port.once('close', resolve));
    if (operation === 'read') {
      const data = once(port, 'data');
      await terminal.command('write 01');
      assert.equal((await data)[0][0], 1);
      port.resume();
    }
    await terminal.hangup();
    if (operation === 'write') await assert.rejects(call(port, 'write', Buffer.alloc(128 * 1024)));
    assert.equal((await closed).disconnected, true);
    assert.equal(closes, 1);
    assert.equal(port.isOpen, false);
    if (operation === 'write') {
      // The original stream destroys itself after any write error, including with its mock binding.
      await new Promise(setImmediate);
      assert.equal(port.destroyed, true);
      return;
    }
    const replacement = await pty(t);
    port.settings.path = replacement.path;
    await call(port, 'open');
    const data = once(port, 'data');
    await replacement.command('write abcd');
    assert.equal((await data)[0].toString('hex'), 'abcd');
    await call(port, 'close');
    assert.equal(closes, 2);
  });
}

test('herdsman serial adapter transfers bytes and reports a disconnect', {
  skip: !process.env.SERIALPORT_CONSUMER, timeout: 5000,
}, async t => {
  const {SerialPort} = require(process.env.SERIALPORT_CONSUMER);
  const implementation = require(process.env.SERIALPORT_IMPLEMENTATION || '..');
  assert.equal(SerialPort.binding, implementation.RustBinding, 'Consumer must resolve the selected binding');
  assert(SerialPort.prototype instanceof implementation.SerialPortStream, 'Consumer must resolve the selected stream');
  const terminal = await pty(t);
  const port = new SerialPort({path: terminal.path, baudRate: 115200, autoOpen: false});
  t.after(() => port.destroy());
  await port.asyncOpen();
  const input = Buffer.from([0, 13, 10, 0xfe, 0x80, 0xff]);
  const received = once(port, 'data');
  await terminal.command(`write ${input.toString('hex')}`);
  assert.deepEqual((await received)[0], input);
  await call(port, 'write', input);
  assert.equal(await terminal.command(`read ${input.length}`), input.toString('hex'));
  await call(port, 'drain');
  await port.asyncFlushAndClose();
  assert.equal(port.isOpen, false);
  await port.asyncOpen();
  port.resume();
  let closes = 0;
  port.on('close', () => closes++);
  const closed = once(port, 'close');
  await terminal.hangup();
  assert.equal((await closed)[0].disconnected, true);
  assert.equal(closes, 1);
  assert.equal(port.isOpen, false);
});
