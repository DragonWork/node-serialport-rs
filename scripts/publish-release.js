// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const targets = require('../lib/targets.json');
const platformPackage = require('../lib/platform-package.cjs');

async function registered(pkg, api) {
  const entry = await api.npmPackage(pkg);
  assert(
    !entry || entry.dist?.integrity === pkg.integrity,
    `${pkg.name} already exists with different contents; retry with the original package artifact`,
  );
  return entry;
}

async function publishVerified(pkg, entry, api, wait) {
  let accepted = false;
  let attempts = 0;
  let failure;
  for (let poll = 0; !entry; poll++) {
    if (poll === 12) throw new Error(`Could not verify publication of ${pkg.name}`, { cause: failure });
    if (!accepted && attempts < 3) {
      attempts++;
      try {
        await api.publishNpm(pkg);
        accepted = true;
      } catch (error) {
        failure = error;
      }
    }
    await wait(Math.min(1000 * 2 ** poll, 30000));
    entry = await registered(pkg, api);
    if (!entry && !accepted && attempts === 3) throw failure;
  }
  await api.verifyNpm(pkg, entry);
}

async function publishRelease(meta, api, wait = sleep) {
  const tagCommit = await api.tagCommit();
  assert(!tagCommit || tagCommit === meta.commit, 'Release tag points to a different commit');
  const entries = new Map();
  for (const pkg of meta.packages) entries.set(pkg.name, await registered(pkg, api));
  let release = await api.release();
  if (release && !release.draft) {
    assert(
      release.assets.some(asset => asset.name === meta.filename && asset.digest === `sha256:${meta.sha256}`),
      'Published release has no matching immutable archive',
    );
  } else {
    if (release) {
      assert.equal(release.target_commitish, meta.commit, 'Draft belongs to a different commit');
      if (release.body !== meta.notes) await api.updateDraftNotes(release);
    } else release = await api.createDraft();
    const uploaded = release.assets?.some(
      asset => asset.name === meta.filename && asset.digest === `sha256:${meta.sha256}`,
    );
    if (!uploaded) await api.upload(release);
  }
  const publish = pkg => publishVerified(pkg, entries.get(pkg.name), api, wait);
  const natives = meta.packages.slice(0, -1);
  // Let npm process several tarballs while polling their public versions.
  for (let i = 0; i < natives.length; i += 5) {
    const results = await Promise.allSettled(natives.slice(i, i + 5).map(publish));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  await publish(meta.packages.at(-1));
  // Publishing the GitHub release is last: assets are complete and npm has succeeded.
  if (release.draft) await api.publishDraft(release);
}

async function request(url, options = {}, missing = false) {
  const method = options.method || 'GET';
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      if (method !== 'GET' || attempt === 3) throw error;
    }
    if (response) {
      if (response.ok) return response;
      if (missing && response.status === 404) return null;
      if (method !== 'GET' || attempt === 3 || (response.status < 500 && ![404, 429].includes(response.status)))
        throw new Error(`${method} ${url}: HTTP ${response.status}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

async function jsonResponse(url, options = {}, missing = false) {
  const response = await request(url, options, missing);
  return response ? response.json() : null;
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
    npmPackage(pkg) {
      return jsonResponse(
        `https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}/${encodeURIComponent(meta.version)}?verify=${Date.now()}`,
        { cache: 'no-store' },
        true,
      );
    },
    async verifyNpm(pkg, entry) {
      assert.equal(entry.name, pkg.name);
      assert.equal(entry.version, meta.version);
      const url = new URL(entry.dist.tarball);
      assert.equal(url.origin, 'https://registry.npmjs.org');
      const bytes = await (await request(url)).arrayBuffer();
      assert.equal(
        'sha512-' + createHash('sha512').update(Buffer.from(bytes)).digest('base64'),
        pkg.integrity,
        `Registry tarball differs for ${pkg.name}`,
      );
      console.log(`Verified ${pkg.name}@${meta.version}`);
    },
    async release() {
      const published = await github(`releases/tags/${tag}`, {}, true);
      if (published) return published;
      // The tag endpoint only returns published releases; include authenticated drafts on retries.
      for (let page = 1; ; page++) {
        const releases = await github(`releases?per_page=100&page=${page}`);
        const draft = releases.find(release => release.tag_name === meta.tag);
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
    publishNpm(pkg) {
      execFileSync(
        'npm',
        [
          'publish',
          join(dirname(archive), pkg.filename),
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
  const names = [...new Set(targets.map(platformPackage)), meta.name];
  assert.deepEqual(
    meta.packages.map(pkg => pkg.name),
    names,
    'Expected every native package followed by the parent',
  );
  for (const pkg of meta.packages) {
    assert.equal(pkg.filename, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${meta.version}.tgz`);
    const data = readFileSync(join(dirname(file), pkg.filename));
    assert.equal(pkg.integrity, 'sha512-' + createHash('sha512').update(data).digest('base64'), pkg.name);
  }
  await publishRelease(meta, liveApi(meta, archive, process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN));
}

if (require.main === module)
  main(process.argv[2] || join('artifacts', 'release.json')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { publishRelease, jsonResponse, liveApi };
