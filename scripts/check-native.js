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
    const cpu = {
      ia32: {machine: 3, bits: 1, endian: 1},
      x64: {machine: 62, bits: 2, endian: 1},
      arm: {machine: 40, bits: 1, endian: 1},
      arm64: {machine: 183, bits: 2, endian: 1},
      ppc64: {machine: 21, bits: 2, endian: 1},
      s390x: {machine: 22, bits: 2, endian: 2},
      riscv64: {machine: 243, bits: 2, endian: 1},
    }[arch];
    assert(cpu, `Unsupported ELF architecture: ${arch}`);
    assert.equal(data.toString('hex', 0, 4), '7f454c46', `Expected an ELF binary: ${file}`);
    assert.equal(data[5], cpu.endian, `Wrong ELF byte order: ${file}`);
    assert.equal(data[4], cpu.bits, `Wrong ELF class: ${file}`);
    const machine = cpu.endian === 1 ? data.readUInt16LE(18) : data.readUInt16BE(18);
    assert.equal(machine, cpu.machine, `Wrong CPU: ${file}`);
  }
}

module.exports = {checkNative};
