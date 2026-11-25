// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import platformPackage from '../lib/platform-package.cjs';

const artifacts = resolve(process.argv[2] || 'artifacts');
const meta = JSON.parse(readFileSync(join(artifacts, 'release.json')));
const targets = JSON.parse(readFileSync(new URL('../lib/targets.json', import.meta.url)));
const host = targets.find(t => t.target === process.env.EXPECTED_TARGET);
assert(host, 'Set EXPECTED_TARGET to the Rust target being tested');
const native = platformPackage(host);
const packuments = new Map();
const tarballs = new Map();
const downloaded = new Set();
const server = createServer((req, res) => {
  const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  const pkg = tarballs.get(route);
  if (pkg) {
    downloaded.add(pkg.name);
    createReadStream(join(artifacts, pkg.filename)).pipe(res);
  } else if (packuments.has(route)) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(packuments.get(route)));
  } else {
    res.writeHead(404).end();
  }
});
const temporary = mkdtempSync(join(tmpdir(), 'serialport-rs-consumer-'));
const run = promisify(execFile);
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const registry = `http://127.0.0.1:${server.address().port}`;
  for (const pkg of meta.packages) {
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', join(artifacts, pkg.filename), 'package/package.json']));
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, meta.version);
    if (pkg.name !== meta.name) {
      const target = targets.find(t => platformPackage(t) === pkg.name);
      assert.deepEqual(manifest.os, [target.platform]);
      assert.deepEqual(manifest.cpu, [target.arch]);
      assert.deepEqual(manifest.libc, target.libc ? [target.libc === 'gnu' ? 'glibc' : target.libc] : undefined);
    }
    const route = pkg.name + '/-/' + pkg.filename;
    tarballs.set(route, pkg);
    manifest.dist = { integrity: pkg.integrity, tarball: registry + '/' + route };
    packuments.set(pkg.name, {
      name: pkg.name,
      'dist-tags': { latest: meta.version },
      versions: { [meta.version]: manifest },
    });
  }
  assert.deepEqual(
    packuments.get(meta.name).versions[meta.version].optionalDependencies,
    Object.fromEntries([...new Set(targets.map(platformPackage))].map(name => [name, meta.version])),
  );
  for (const layout of ['registry', 'offline']) {
    const cwd = join(temporary, layout);
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), '{"name":"consumer","private":true}\n');
    copyFileSync(new URL('./packed.mjs', import.meta.url), join(cwd, 'packed.mjs'));
    for (const command of ['install', 'ci']) {
      const env = {
        ...process.env,
        NATIVE_PACKAGE: layout === 'registry' ? native : '',
        npm_config_registry: registry,
        npm_config_cache: join(temporary, layout + '-' + command + '-cache'),
        npm_config_update_notifier: 'false',
      };
      const args = [process.env.npm_execpath, command, '--ignore-scripts', '--no-audit', '--no-fund'];
      if (command === 'install')
        args.push(layout === 'registry' ? meta.name + '@' + meta.version : join(artifacts, meta.filename));
      if (layout === 'offline') args.push('--offline');
      downloaded.clear();
      await run(process.execPath, args, { cwd, env });
      assert.deepEqual([...downloaded].sort(), layout === 'registry' ? [native, meta.name].sort() : []);
      const { stdout } = await run(process.execPath, ['packed.mjs'], { cwd, env });
      console.log(`${layout} npm ${command}: ${stdout.trim()}`);
      if (layout === 'registry' && command === 'ci') {
        await run(
          process.execPath,
          [
            process.env.npm_execpath,
            'ci',
            '--offline',
            '--omit=optional',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ],
          { cwd, env },
        );
        await run(
          process.execPath,
          [
            '-e',
            `
          const assert = require('node:assert/strict');
          const { SerialPortMock, SerialPort } = require('serialport-rs');
          SerialPortMock.binding.createPort('/dev/mock');
          (async () => {
            assert.equal((await SerialPortMock.list())[0].path, '/dev/mock');
            await assert.rejects(SerialPort.list(), error => error.message.includes(process.env.NATIVE_PACKAGE));
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
          ],
          { cwd, env },
        );
      }
    }
  }
} finally {
  server.close();
  rmSync(temporary, { recursive: true, force: true });
}
