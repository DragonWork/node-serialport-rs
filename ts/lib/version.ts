// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import { endianness } from 'node:os';
import { runtimeTarget } from './native';

const manifest = require('../package.json') as { name: string; version: string };

export const version = Object.freeze({
  name: manifest.name,
  version: manifest.version,
  node: process.versions.node,
  napi: 8 as const,
  platform: process.platform,
  arch: process.arch,
  endian: endianness(),
  get libc() {
    return runtimeTarget().libc;
  },
  get target() {
    return runtimeTarget().target;
  },
});
