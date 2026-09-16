// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {prepareRelease, prependRelease, applyPrepared, recordPrepared} = require('../scripts/prepare-release');

const cliff = process.env.GIT_CLIFF;
const oldNotes = "## What's Changed in v1.12.1 (2026-08-01)\n\n* fix: earlier release\n";

function offline(t) {
  const previous = process.env.GIT_CLIFF_OFFLINE;
  process.env.GIT_CLIFF_OFFLINE = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CLIFF_OFFLINE;
    else process.env.GIT_CLIFF_OFFLINE = previous;
  });
}

function fixture(t, messages = []) {
  const root = mkdtempSync(join(tmpdir(), 'serialport-release-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git(['init', '--quiet']);
  git(['config', 'user.name', 'DragonWork']);
  git(['config', 'user.email', '97512+DragonWork@users.noreply.github.com']);
  const version = '1.12.1';
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'serialport-rs', version}, null, 2) + '\n');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({name: 'serialport-rs', version, lockfileVersion: 3, packages: {'': {name: 'serialport-rs', version}}}, null, 2) + '\n');
  writeFileSync(join(root, 'Cargo.toml'), `[package]\nname = "node-serialport-rs"\nversion = "${version}"\n`);
  writeFileSync(join(root, 'Cargo.lock'), `[[package]]\nname = "node-serialport-rs"\nversion = "${version}"\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n' + oldNotes);
  copyFileSync(join(__dirname, '../cliff.toml'), join(root, 'cliff.toml'));
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'chore: initial release']);
  git(['tag', 'v1.12.1']);
  for (const message of messages) git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', message]);
  return {root, git};
}

test('prepending notes replaces that version once and preserves earlier releases', () => {
  const notes = "## What's Changed in v1.12.2 (2026-08-14)\n\n* fix(socketmap): relax limits by @DragonWork\n";
  const first = prependRelease('# Changelog\n\n' + oldNotes, notes, 'v1.12.2');
  assert.equal(prependRelease(first, notes, 'v1.12.2'), first);
  assert(first.endsWith(oldNotes));
  assert.throws(() => prependRelease('Unrelated document', notes, 'v1.12.2'));
  assert.throws(() => prependRelease('', notes, 'v2.0.0'));
});

test('invalid overrides are rejected before invoking git-cliff', () => {
  for (const version of ['--help', '1.2.03', '1.2.3-01', '1.2.3\nextra']) {
    assert.throws(() => prepareRelease('/unused', version, '/missing-git-cliff'), /Choose auto/);
  }
});

test('Conventional Commits select patch, minor and major releases and exclude chores', {skip: !cliff}, async t => {
  offline(t);
  for (const [message, version] of [['fix(io): retry interrupted reads', '1.12.2'], ['feat(api): add an option', '1.13.0'], ['feat(api)!: change a contract', '2.0.0']]) {
    await t.test(version, t => {
      const {root} = fixture(t, [message, 'chore(release): update internal metadata']);
      const meta = prepareRelease(root, 'auto', cliff);
      assert.equal(meta.version, version);
      assert(meta.notes.includes(`* ${message} by @DragonWork`));
      assert(!meta.notes.includes('chore'));
      assert(meta.notes.includes(`/compare/v1.12.1...v${version}`));
      applyPrepared(root, {...meta, commit: meta.sourceCommit});
      assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, version);
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
      assert.equal(lock.version, version);
      assert.equal(lock.packages[''].version, version);
      for (const name of ['Cargo.toml', 'Cargo.lock']) assert(readFileSync(join(root, name), 'utf8').includes(`version = "${version}"`));
      assert(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').endsWith(oldNotes));
    });
  }
});

test('manual bump modes and exact prerelease versions override automatic selection', {skip: !cliff}, t => {
  offline(t);
  const {root} = fixture(t, ['feat: add an option']);
  for (const [request, expected] of [['patch', '1.12.2'], ['minor', '1.13.0'], ['major', '2.0.0'], ['v4.5.6-rc.1', '4.5.6-rc.1']]) {
    assert.equal(prepareRelease(root, request, cliff).version, expected);
  }
  assert.throws(() => prepareRelease(root, '1.12.1', cliff), /already exists/);
});

test('git-cliff renders the requested author, PR and compare-link format', {skip: !cliff}, t => {
  const {root} = fixture(t, ['build(deps): update dependencies', 'fix(socketmap): relax limits\n\nDetails']);
  const timestamp = Date.UTC(2026, 7, 14) / 1000;
  const context = JSON.parse(execFileSync(cliff, ['--config', join(root, 'cliff.toml'), '--offline', '--unreleased', '--tag', 'v1.12.2', '--context'], {cwd: root, encoding: 'utf8'}));
  context[0].timestamp = timestamp;
  context[0].commits[0].remote = {username: 'dependabot[bot]', pr_number: 181, pr_labels: [], is_first_time: false};
  const path = join(root, 'context.json');
  writeFileSync(path, JSON.stringify(context));
  const notes = execFileSync(cliff, ['--config', join(root, 'cliff.toml'), '--offline', '--from-context', path, '--strip', 'all'], {cwd: root, encoding: 'utf8'}).trim();
  assert.equal(notes, "## What's Changed in v1.12.2 (2026-08-14)\n\n" +
    '* build(deps): update dependencies by @dependabot[bot] in [#181](https://github.com/DragonWork/node-serialport-rs/pull/181)\n' +
    '* fix(socketmap): relax limits by @DragonWork\n\n' +
    '**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v1.12.1...v1.12.2');
});

test('preparation records only release files and rejects concurrent branch updates', {skip: !cliff}, async t => {
  offline(t);
  const {root} = fixture(t, ['fix: keep progress']);
  const meta = prepareRelease(root, 'auto', cliff);
  let input;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    input = JSON.parse(options.body).variables.input;
    return {ok: true, json: async () => ({data: {createCommitOnBranch: {commit: {oid: 'c'.repeat(40), signature: {isValid: true}}}}})};
  });
  assert.equal(await recordPrepared(root, meta, 'DragonWork/node-serialport-rs', 'main', 'test-token'), 'c'.repeat(40));
  assert.equal(input.expectedHeadOid, meta.sourceCommit);
  assert.equal(input.message.headline, 'chore(release): prepare v1.12.2');
  assert.deepEqual(input.fileChanges.additions.map(file => file.path).sort(), Object.keys(meta.files).sort());
  for (const file of input.fileChanges.additions) assert.equal(Buffer.from(file.contents, 'base64').toString(), meta.files[file.path]);
  t.mock.method(global, 'fetch', async () => ({ok: true, json: async () => ({data: {createCommitOnBranch: {commit: {oid: 'c'.repeat(40), signature: {isValid: false}}}}})}));
  await assert.rejects(recordPrepared(root, meta, 'DragonWork/node-serialport-rs', 'main', 'test-token'), /valid GitHub signature/);
  t.mock.method(global, 'fetch', async () => ({ok: true, json: async () => ({errors: [{message: 'expectedHeadOid does not match'}]})}));
  await assert.rejects(recordPrepared(root, meta, 'DragonWork/node-serialport-rs', 'main', 'test-token'), /branch may have advanced/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '1.12.1');
});
