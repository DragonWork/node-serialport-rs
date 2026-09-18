// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { spawnSync } = require('node:child_process');
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
// Keep the public declaration surface independent of private implementation fields.
copyFileSync(join(root, 'ts/public-api.d.ts'), join(root, 'index.d.ts'));
