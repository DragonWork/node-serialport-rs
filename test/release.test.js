// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publishRelease, jsonResponse, liveApi } = require('../scripts/publish-release');
const { packInfo, checkFiles } = require('../scripts/package-release');

const meta = {
  name: 'serialport-rs',
  version: '1.2.3',
  tag: 'v1.2.3',
  commit: 'a'.repeat(40),
  filename: 'serialport-rs-1.2.3.tar.gz',
  integrity: 'sha512-package',
  sha256: 'b'.repeat(64),
  distTag: 'latest',
  notes: "## What's Changed in v1.2.3 (2026-09-16)\n\n* fix(io): preserve progress by @DragonWork\n",
};

function provider(overrides = {}) {
  const calls = [];
  const draft = { id: 1, draft: true, target_commitish: meta.commit, assets: [], body: meta.notes };
  return {
    calls,
    api: {
      async tagCommit() {
        return null;
      },
      async npmPackage() {
        return null;
      },
      async release() {
        return null;
      },
      async createDraft() {
        calls.push('draft');
        return draft;
      },
      async updateDraftNotes() {
        calls.push('notes');
      },
      async upload() {
        calls.push('upload');
      },
      async publishNpm() {
        calls.push('npm');
      },
      async publishDraft() {
        calls.push('publish');
      },
      ...overrides,
    },
  };
}

test('release publication follows archive upload and npm success', async () => {
  const { api, calls } = provider();
  await publishRelease(meta, api);
  assert.deepEqual(calls, ['draft', 'upload', 'npm', 'publish']);
});

test('npm failure leaves the release unpublished and a retry reuses its draft', async () => {
  const failure = new Error('registry unavailable');
  const first = provider({
    async publishNpm() {
      throw failure;
    },
  });
  await assert.rejects(publishRelease(meta, first.api), error => error === failure);
  assert.deepEqual(first.calls, ['draft', 'upload']);
  const retry = provider({
    async release() {
      return { id: 1, draft: true, target_commitish: meta.commit };
    },
    async npmPackage() {
      return { dist: { integrity: meta.integrity } };
    },
  });
  await publishRelease(meta, retry.api);
  assert.deepEqual(retry.calls, ['notes', 'upload', 'publish']);
});

test('tag and npm version collisions fail before any release mutation', async () => {
  for (const overrides of [
    {
      async tagCommit() {
        return 'c'.repeat(40);
      },
    },
    {
      async npmPackage() {
        return { dist: { integrity: 'sha512-different' } };
      },
    },
    {
      async release() {
        return { draft: true, target_commitish: 'c'.repeat(40) };
      },
    },
  ]) {
    const { api, calls } = provider(overrides);
    await assert.rejects(publishRelease(meta, api));
    assert.deepEqual(calls, []);
  }
});

test('completed immutable releases are verified without rewriting assets or tags', async () => {
  const { api, calls } = provider({
    async tagCommit() {
      return meta.commit;
    },
    async npmPackage() {
      return { dist: { integrity: meta.integrity } };
    },
    async release() {
      return { draft: false, assets: [{ name: meta.filename, digest: `sha256:${meta.sha256}` }] };
    },
  });
  await publishRelease(meta, api);
  assert.deepEqual(calls, []);
});

test('authentication and server errors cannot be mistaken for absent releases', async t => {
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 403 }));
  await assert.rejects(jsonResponse('https://example.invalid/release', {}, true), /HTTP 403/);
});

test('draft lookup and annotated tag resolution support publication retries', async t => {
  const responses = new Map([
    ['git/ref/tags/v1.2.3', { object: { type: 'tag', sha: 'tag-object' } }],
    ['git/tags/tag-object', { object: { type: 'commit', sha: meta.commit } }],
    ['releases?per_page=100&page=1', [{ id: 1, tag_name: meta.tag, draft: true }]],
  ]);
  t.mock.method(global, 'fetch', async url => {
    const path = url.replace('https://api.github.com/repos/DragonWork/node-serialport-rs/', '');
    if (path === 'releases/tags/v1.2.3') return { ok: false, status: 404 };
    assert(responses.has(path), `Unexpected request: ${path}`);
    return { ok: true, json: async () => responses.get(path) };
  });
  const api = liveApi(meta, '/unused', 'DragonWork/node-serialport-rs', 'test-token');
  assert.equal(await api.tagCommit(), meta.commit);
  assert.equal((await api.release()).draft, true);
});

test('pack metadata accepts npm array and keyed formats while rejecting development files', () => {
  const info = {
    name: 'serialport-rs',
    files: [
      'index.js',
      'index.d.ts',
      'lib/targets.json',
      'CHANGELOG.md',
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_LICENSES.md',
    ].map(path => ({ path })),
  };
  assert.deepEqual(packInfo(JSON.stringify([info])), info);
  assert.deepEqual(packInfo(JSON.stringify({ 'serialport-rs': info })), info);
  checkFiles(info.files);
  for (const path of ['ts/index.ts', 'src/lib.rs', 'index.js.map', 'test/serial.test.js']) {
    assert.throws(() => checkFiles([...info.files, { path }]));
  }
});

test('draft creation and retries use archived notes without publishing early', async t => {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ id: 7, draft: true }) };
  });
  const api = liveApi(meta, '/unused', 'DragonWork/node-serialport-rs', 'test-token');
  await api.createDraft();
  await api.updateDraftNotes({ id: 7 });
  assert.equal(requests[0].body.body, meta.notes);
  assert.equal(requests[0].body.draft, true);
  assert(!('generate_release_notes' in requests[0].body));
  assert.deepEqual(requests[1].body, { body: meta.notes });
  assert.equal(requests[1].method, 'PATCH');
});
