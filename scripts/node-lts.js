// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const { jsonResponse } = require('./publish-release');

function nodePolicy(majors) {
  assert(
    Array.isArray(majors) &&
      majors.length &&
      majors.every((major, i) => Number.isSafeInteger(major) && major > (i ? majors[i - 1] : 0)),
    'Expected a nonempty, ascending list of supported Node.js LTS majors',
  );
  const min = majors[0];
  const latest = majors.at(-1);
  return { majors, min, latest, engines: `>=${min} <${latest + 1}` };
}

function supportedLts(releases, schedule, today) {
  const released = new Set();
  for (const { version, date, lts } of releases) {
    const match = /^(v\d+)\.\d+\.\d+$/.exec(version);
    if (match && lts && date <= today) released.add(match[1]);
  }
  const majors = Object.entries(schedule)
    .filter(([line, { lts, end }]) => released.has(line) && lts <= today && today < end)
    .map(([line]) => Number(line.slice(1)))
    .sort((a, b) => a - b);
  return nodePolicy(majors);
}

async function getNodeLts(snapshot) {
  if (snapshot) return nodePolicy(JSON.parse(snapshot));
  const [releases, schedule] = await Promise.all([
    jsonResponse('https://nodejs.org/dist/index.json'),
    jsonResponse('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'),
  ]);
  return supportedLts(releases, schedule, new Date().toISOString().slice(0, 10));
}

async function main() {
  const { majors, min, latest } = await getNodeLts(process.env.RELEASE_NODE_LTS);
  const versions = JSON.stringify(majors);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `majors=${versions}\nmin=${min}\nlatest=${latest}\n`);
  console.log(versions);
}

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { getNodeLts, supportedLts };
