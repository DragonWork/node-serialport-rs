// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SerialPort, version } from 'serialport-rs';

const require = createRequire(import.meta.url);
const target = process.env.EXPECTED_TARGET;
assert(target);
assert.equal(require('serialport-rs').SerialPort, SerialPort);
assert.equal(version.target, target);
assert(Array.isArray(await SerialPort.list()));
const binary = require.resolve(`serialport-rs/native/${target}/serialport-rs.node`);
assert(require.cache[binary], `Expected the installed addon at ${binary}`);
console.log(`serialport-rs ${version.version} loaded ${target} on Node ${process.version}`);
