// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { jsonResponse } = require('./publish-release');

const releaseFiles = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'CHANGELOG.md'];
const header = '# Changelog\n\n';
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function prependRelease(changelog, notes, tag) {
  assert(!changelog || changelog.startsWith(header), 'Unexpected CHANGELOG.md header');
  assert(notes.startsWith(`## What's Changed in ${tag} (`), 'Release notes have the wrong version');
  const sections = changelog
    .slice(header.length)
    .trim()
    .split(/\n(?=## What's Changed in )/);
  const previous = sections.filter(section => section && !section.startsWith(`## What's Changed in ${tag} (`));
  return header + [notes.trim(), ...previous.map(section => section.trim())].join('\n\n') + '\n';
}

function prepareRelease(root, request = 'auto', cliff = process.env.GIT_CLIFF || 'git-cliff') {
  const flags = ['--config', join(root, 'cliff.toml'), '--unreleased', '--use-branch-tags', '--no-exec'];
  const run = args =>
    execFileSync(cliff, [...flags, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  let version = request.replace(/^v/, '');
  if (['auto', 'patch', 'minor', 'major'].includes(request))
    version = run(['--bumped-version', '--bump', request]).replace(/^v/, '');
  assert(semver.test(version), 'Choose auto, patch, minor, major, or an exact SemVer version');
  const tag = `v${version}`;
  assert(!git(root, ['tag', '--list', tag]), `Tag ${tag} already exists; retry the original publication job instead`);
  const notes = run(['--tag', tag, '--strip', 'all']) + '\n';
  assert(/^\* /m.test(notes), 'No changelog entries; chore-only changes do not need a release');
  const files = Object.fromEntries(
    releaseFiles
      .filter(name => existsSync(join(root, name)))
      .map(name => [name, readFileSync(join(root, name), 'utf8')]),
  );
  const pkg = JSON.parse(files['package.json']);
  const lock = JSON.parse(files['package-lock.json']);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  files['package.json'] = files['package.json'].replace(
    /^(  "version": ")[^"]+("[,]?)$/m,
    (_, before, after) => before + version + after,
  );
  lock.version = version;
  lock.packages[''].version = version;
  files['package-lock.json'] = JSON.stringify(lock, null, 2) + '\n';
  for (const [name, pattern] of [
    ['Cargo.toml', /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/],
    ['Cargo.lock', /(\[\[package\]\]\r?\nname = "node-serialport-rs"\r?\nversion = ")([^"]+)(")/],
  ]) {
    assert.equal(files[name].match(pattern)?.[2], pkg.version, `Version mismatch in ${name}`);
    files[name] = files[name].replace(pattern, (_, before, old, after) => before + version + after);
  }
  files['CHANGELOG.md'] = prependRelease(files['CHANGELOG.md'] || '', notes, tag);
  return { version, tag, notes, sourceCommit: git(root, ['rev-parse', 'HEAD']), files };
}

function applyPrepared(root, meta) {
  assert(semver.test(meta.version));
  assert.equal(meta.tag, `v${meta.version}`);
  assert.deepEqual(Object.keys(meta.files).sort(), [...releaseFiles].sort());
  assert.equal(JSON.parse(meta.files['package.json']).version, meta.version);
  const commit = git(root, ['rev-parse', 'HEAD']);
  assert(commit === meta.sourceCommit || commit === meta.commit, 'Prepared files belong to a different checkout');
  for (const name of releaseFiles) {
    assert.equal(typeof meta.files[name], 'string');
    writeFileSync(join(root, name), meta.files[name]);
  }
}

async function recordPrepared(root, meta, repository, branch, token) {
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository');
  assert(branch && token, 'A branch and GH_TOKEN are required');
  const additions = releaseFiles
    .filter(path => !existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== meta.files[path])
    .map(path => ({ path, contents: Buffer.from(meta.files[path]).toString('base64') }));
  if (!additions.length) return meta.sourceCommit;
  // GitHub signs this commit and rejects a branch that changed after checkout.
  const response = await jsonResponse('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query:
        'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid signature { isValid } } } }',
      variables: {
        input: {
          branch: { repositoryNameWithOwner: repository, branchName: branch },
          expectedHeadOid: meta.sourceCommit,
          message: { headline: `chore(release): prepare ${meta.tag}` },
          fileChanges: { additions },
        },
      },
    }),
  });
  assert(!response.errors?.length, 'Could not record release preparation; the branch may have advanced');
  const commit = response.data?.createCommitOnBranch?.commit;
  assert(commit?.signature?.isValid, 'Release preparation commit must have a valid GitHub signature');
  assert(/^[a-f0-9]{40}$/.test(commit.oid), 'Invalid preparation commit');
  return commit.oid;
}

async function main() {
  const root = join(__dirname, '..');
  if (process.argv[2] === '--apply') {
    applyPrepared(root, JSON.parse(readFileSync(process.argv[3], 'utf8')));
    return;
  }
  const meta = prepareRelease(root, process.argv[2] || 'auto');
  if (process.env.GITHUB_SHA) assert.equal(meta.sourceCommit, process.env.GITHUB_SHA);
  meta.commit =
    process.env.RELEASE_PUBLISH === 'true'
      ? await recordPrepared(
          root,
          meta,
          process.env.GITHUB_REPOSITORY,
          process.env.GITHUB_REF_NAME,
          process.env.GH_TOKEN,
        )
      : meta.sourceCommit;
  applyPrepared(root, meta);
  const output = resolve(root, process.argv[3] || 'artifacts');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'prepared-release.json'), JSON.stringify(meta, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `commit=${meta.commit}\nversion=${meta.version}\n`, { flag: 'a' });
  console.log(`Prepared ${meta.tag}`);
}

if (require.main === module)
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { prepareRelease, prependRelease, applyPrepared, recordPrepared, releaseFiles };
