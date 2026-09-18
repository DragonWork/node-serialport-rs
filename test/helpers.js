// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { once } = require('node:events');
const { join } = require('node:path');

async function pty(t) {
  const child = spawn(join(__dirname, '../target/debug/examples/pty'), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw new Error(`PTY helper failed: ${stderr}`);
  t.after(() => {
    child.kill();
  });
  return {
    path: first.value,
    async command(command) {
      child.stdin.write(`${command}\n`);
      const line = await lines.next();
      if (line.done) throw new Error(`PTY helper exited: ${stderr}`);
      return line.value;
    },
    async hangup() {
      const exited = once(child, 'exit');
      child.stdin.write('hangup\n');
      await exited;
    },
  };
}

function call(port, method, ...args) {
  return new Promise((resolve, reject) =>
    port[method](...args, function (error, value) {
      if (method !== 'write' && this !== port) return reject(new Error('Incorrect callback receiver'));
      if (error) reject(error);
      else resolve(value);
    }),
  );
}

module.exports = { pty, call };
