// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');

function checkNative(file, {platform, arch}) {
  const data = readFileSync(file);
  if (platform === 'win32') {
    assert.equal(data.toString('ascii', 0, 2), 'MZ', `Expected a PE binary: ${file}`);
    const header = data.readUInt32LE(60);
    assert.equal(data.readUInt32LE(header), 0x4550, `Invalid PE signature: ${file}`);
    assert.equal(data.readUInt16LE(header + 4), {x64: 0x8664, ia32: 0x14c, arm64: 0xaa64}[arch], `Wrong CPU: ${file}`);
  } else if (platform === 'darwin') {
    assert.equal(data.readUInt32LE(0), 0xfeedfacf, `Expected a Mach-O binary: ${file}`);
    assert.equal(data.readUInt32LE(4), {x64: 0x1000007, arm64: 0x100000c}[arch], `Wrong CPU: ${file}`);
  } else {
    assert.equal(data.toString('hex', 0, 4), '7f454c46', `Expected an ELF binary: ${file}`);
    assert.equal(data[5], 1, `Expected little-endian ELF: ${file}`);
    assert.equal(data[4], arch === 'arm' ? 1 : 2, `Wrong ELF class: ${file}`);
    assert.equal(data.readUInt16LE(18), {x64: 62, arm64: 183, arm: 40}[arch], `Wrong CPU: ${file}`);
  }
}

module.exports = {checkNative};
