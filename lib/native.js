// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {existsSync} = require('node:fs');
const {join} = require('node:path');
const {endianness} = require('node:os');
const targets = require('./targets.json');

function selectTarget({platform, arch, libc, arm = 7, endian = endianness()}) {
  return targets.filter(target => target.platform === platform && target.arch === arch
    && (!target.libc || target.libc === libc) && (!target.arm || target.arm <= arm)
    && (!target.endian || target.endian === endian))
    .sort((a, b) => (b.arm || 0) - (a.arm || 0))[0]?.target;
}

function loadNative() {
  const local = join(__dirname, '../native/serialport-rs.node');
  if (existsSync(local)) return require(local);
  const {platform, arch} = process;
  const libc = platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl') : undefined;
  const arm = Number(process.config.variables.arm_version || 7);
  const target = selectTarget({platform, arch, libc, arm});
  const binary = target && join(__dirname, '..', 'native', target, 'serialport-rs.node');
  if (!binary || !existsSync(binary)) {
    throw new Error(`No serialport-rs native build for ${target || `${platform}/${arch}`}. Build this package with npm run build.`);
  }
  return require(binary);
}

module.exports = {loadNative, selectTarget};
