// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

module.exports = function platformPackage({ platform, arch, libc }) {
  return '@serialport-rs/' + [platform, arch, libc].filter(Boolean).join('-');
};
