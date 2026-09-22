# Changelog

## What's Changed in v0.3.2 (2026-09-22)

* build(deps): update dependencies and fix dependabot.yml by @DragonWork
* chore(deps): update npm dev dependencies by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.3.1...v0.3.2

## What's Changed in v0.3.1 (2026-09-21)

* perf: reuse batch delivery callback by @DragonWork
* chore(deps): bump dtolnay/rust-toolchain from 6c977a6 to 02cb101 in the actions group (#5) by @dependabot[bot] in [#5](https://github.com/DragonWork/node-serialport-rs/pull/5)
* chore(deps): bump the cargo group with 3 updates (#4) by @dependabot[bot] in [#4](https://github.com/DragonWork/node-serialport-rs/pull/4)

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.3.0...v0.3.1

## What's Changed in v0.3.0 (2026-09-18)

* fix(stream): preserve close context and recover failed cancellation by @DragonWork
* feat(parsers): bound delimiter frames and reduce SLIP copies by @DragonWork
* fix(build): clean superseded debug caches after release by @DragonWork
* perf(native): reduce vectored write buffer overhead by @DragonWork
* style: standardize JavaScript and TypeScript with Prettier by @DragonWork
* perf(native): batch ready serial reads automatically by @DragonWork
* perf(binding): reuse whole buffers in vectored writes by @DragonWork
* perf(native): borrow fixed completion event labels by @DragonWork
* test: avoid macOS PTY deadlock in batching tests by @DragonWork
* perf(native): deliver first read before batching followers by @DragonWork
* style: prefer concise arrows and multiline JSON by @DragonWork
* chore(deps): bump the cargo group with 2 updates (#3) by @dependabot[bot] in [#3](https://github.com/DragonWork/node-serialport-rs/pull/3)

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.2.0...v0.3.0

## What's Changed in v0.2.0 (2026-09-16)

* fix(stream): preserve SerialPort 13 control and drain behavior by @DragonWork
* perf(parsers): avoid buffer views when discarding partial chunks by @DragonWork
* fix(stream): honor EOF from custom bindings by @DragonWork
* fix(io): retry interrupted transfers without starving peers by @DragonWork
* test(ci): check compatibility against SerialPort 13 by @DragonWork
* test(io): guard idle callback and promise progress by @DragonWork
* perf(build): use fat LTO for release builds by @DragonWork
* feat(platforms): expand native release targets by @DragonWork
* refactor(runtime): compile from strict TypeScript by @DragonWork
* fix(build): clean successful release caches safely by @DragonWork
* fix(build): normalize checkout paths before cache cleanup by @DragonWork
* feat(release): publish verified archives after all checks by @DragonWork
* docs(bench): compare 0.2.0 with patched C++ on x64 by @DragonWork
* docs(bench): consolidate 0.2.0 comparisons by @DragonWork
* feat(release): automate manual versioned releases by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.1.1...v0.2.0

## What's Changed in v0.1.1 (2026-09-15)

* chore: rename npm package to serialport-rs by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.1.0...v0.1.1

## What's Changed in v0.1.0 (2026-09-14)

* init: first commit by @DragonWork
