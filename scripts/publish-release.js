// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

async function publishRelease(meta, api) {
  const tagCommit = await api.tagCommit();
  assert(!tagCommit || tagCommit === meta.commit, 'Release tag points to a different commit');
  const published = await api.npmPackage();
  assert(
    !published || published.dist?.integrity === meta.integrity,
    'Version already exists with different contents; retry with the original package artifact',
  );
  let release = await api.release();
  if (release && !release.draft) {
    assert(
      release.assets.some((asset) => asset.name === meta.filename && asset.digest === `sha256:${meta.sha256}`),
      'Published release has no matching immutable archive',
    );
  } else {
    if (release) {
      assert.equal(release.target_commitish, meta.commit, 'Draft belongs to a different commit');
      if (release.body !== meta.notes) await api.updateDraftNotes(release);
    } else release = await api.createDraft();
    await api.upload(release);
  }
  if (!published) await api.publishNpm();
  // Publishing the GitHub release is last: assets are complete and npm has succeeded.
  if (release.draft) await api.publishDraft(release);
}

async function jsonResponse(url, options = {}, missing = false) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: HTTP ${response.status}`);
  return response.json();
}

function liveApi(meta, archive, repository, token) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid GitHub repository');
  assert(token, 'GH_TOKEN is required');
  const github = (path, options = {}, missing = false) =>
    jsonResponse(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
      },
      missing,
    );
  const tag = encodeURIComponent(meta.tag);
  return {
    async tagCommit() {
      const ref = await github(`git/ref/tags/${tag}`, {}, true);
      if (!ref) return null;
      let object = ref.object;
      while (object.type === 'tag') object = (await github(`git/tags/${object.sha}`)).object;
      assert.equal(object.type, 'commit', 'Tag must resolve to a commit');
      return object.sha;
    },
    npmPackage() {
      return jsonResponse(
        `https://registry.npmjs.org/${encodeURIComponent(meta.name)}/${encodeURIComponent(meta.version)}`,
        {},
        true,
      );
    },
    async release() {
      const published = await github(`releases/tags/${tag}`, {}, true);
      if (published) return published;
      // The tag endpoint only returns published releases; include authenticated drafts on retries.
      for (let page = 1; ; page++) {
        const releases = await github(`releases?per_page=100&page=${page}`);
        const draft = releases.find((release) => release.tag_name === meta.tag);
        if (draft) return draft;
        if (releases.length < 100) return null;
      }
    },
    createDraft() {
      return github('releases', {
        method: 'POST',
        body: JSON.stringify({
          tag_name: meta.tag,
          target_commitish: meta.commit,
          name: meta.tag,
          draft: true,
          prerelease: meta.distTag === 'next',
          body: meta.notes,
        }),
      });
    },
    updateDraftNotes(release) {
      return github(`releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ body: meta.notes }) });
    },
    upload() {
      execFileSync('gh', ['release', 'upload', meta.tag, archive, '--clobber', '--repo', repository], {
        stdio: 'inherit',
      });
    },
    publishNpm() {
      execFileSync(
        'npm',
        [
          'publish',
          archive,
          '--ignore-scripts',
          '--registry=https://registry.npmjs.org',
          '--access=public',
          '--provenance',
          '--tag',
          meta.distTag,
        ],
        { stdio: 'inherit' },
      );
    },
    publishDraft(release) {
      return github(`releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ draft: false, make_latest: meta.distTag === 'next' ? 'false' : 'legacy' }),
      });
    },
  };
}

async function main(file) {
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  const pkg = require('../package.json');
  assert.equal(meta.name, pkg.name);
  assert.equal(meta.version, pkg.version);
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(meta.version));
  assert.equal(meta.tag, `v${meta.version}`);
  assert.equal(meta.distTag, meta.version.includes('-') ? 'next' : 'latest');
  assert.equal(
    meta.commit,
    process.env.RELEASE_COMMIT || process.env.GITHUB_SHA,
    'Artifact belongs to a different checkout',
  );
  assert.equal(typeof meta.notes, 'string');
  assert(meta.notes.startsWith(`## What's Changed in ${meta.tag} (`), 'Release notes belong to a different version');
  assert.equal(basename(meta.filename), meta.filename);
  assert(meta.filename.endsWith('.tar.gz'));
  const archive = resolve(dirname(file), meta.filename);
  const bytes = readFileSync(archive);
  assert.equal(meta.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.equal(meta.sha256, createHash('sha256').update(bytes).digest('hex'));
  await publishRelease(meta, liveApi(meta, archive, process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN));
}

if (require.main === module)
  main(process.argv[2] || join('artifacts', 'release.json')).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { publishRelease, jsonResponse, liveApi };
