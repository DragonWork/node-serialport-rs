# Changelog

## What's Changed in v0.7.0 (2026-10-16)

* fix(api): validate a single snapshot of binding options by @DragonWork
* feat(stream): support cancellation and resilient binding errors by @DragonWork
* feat(parsers): bound decoded SLIP frame lengths by @DragonWork
* feat(api): expose frozen runtime version metadata by @DragonWork
* perf(binding): skip pending records for inline writes by @DragonWork
* perf(parsers): copy unescaped SLIP payloads in bulk by @DragonWork
* feat(api): add async controls and structured transport errors by @DragonWork
* test: migrate all suites and helpers to strict TypeScript by @DragonWork
* chore(deps): bump the actions group across 1 directory with 5 updates (#18) by @dependabot[bot] in [#18](https://github.com/DragonWork/node-serialport-rs/pull/18)
* chore(deps): bump the compatible-npm-updates group with 2 updates (#17) by @dependabot[bot] in [#17](https://github.com/DragonWork/node-serialport-rs/pull/17)
* chore(deps): bump the actions group across 1 directory with 2 updates (#21) by @dependabot[bot] in [#21](https://github.com/DragonWork/node-serialport-rs/pull/21)
* build(deps): bump tokio by @dependabot[bot]
* fix: replace deprecated AsyncFd constructor by @DragonWork
* build(deps): update Rust dependencies by @DragonWork
* fix: update Rust dependencies and AsyncFd registration (#19) by @DragonWork in [#19](https://github.com/DragonWork/node-serialport-rs/pull/19)
* fix: validate intrinsic read buffer lengths by @DragonWork
* fix: preserve regex parser input order by @DragonWork
* fix: prevent destroyed streams from resuming I/O by @DragonWork
* fix(types): constrain supported parity values by @DragonWork
* docs: clarify FTDI serial fallback by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.6.0...v0.7.0

## What's Changed in v0.6.0 (2026-10-06)

* chore(deps): bump the actions group across 1 directory with 2 updates (#12) by @dependabot[bot] in [#12](https://github.com/DragonWork/node-serialport-rs/pull/12)
* build(deps): bump napi-derive from 3.6.9 to 3.6.10 in the compatible-cargo-updates group (#11) by @dependabot[bot] in [#11](https://github.com/DragonWork/node-serialport-rs/pull/11)
* build(deps): update dependencies by @DragonWork
* refactor(rust): modernize APIs and require Rust 1.98 by @DragonWork
* perf(rust): mark exceptional paths as cold by @DragonWork
* refactor(serial): replace tokio-serial with native async adapters by @DragonWork
* perf(read): reuse initialized buffers and inline small payloads by @DragonWork
* perf(workers): reduce worker and session bookkeeping by @DragonWork
* perf(windows): normalize USB identifiers once by @DragonWork
* build(deps): update napi dependencies by @DragonWork
* perf(rust): reserve cold hints for exceptional failures by @DragonWork
* build(deps): update Node.js types to 26.6.4 by @DragonWork
* ci(rust): track stable and test beta by @DragonWork
* fix(serial): harden setup validation and transport lifecycle coverage by @DragonWork
* fix(serial): keep read credits flowing under command backpressure by @DragonWork
* perf(serial): reduce burst locking and error-path overhead by @DragonWork
* fix(stream): preserve queued read order after listener exceptions by @DragonWork
* perf(serial): complete uncontended vectored writes inline by @DragonWork
* perf(rust): remove unhelpful validation and setup hints by @DragonWork
* test(serial): cover flush and live configuration by @DragonWork
* build(deps): update napi bindings by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.5.0...v0.6.0

## What's Changed in v0.5.0 (2026-09-28)

* feat: expand Windows port metadata by @DragonWork
* feat: add macOS port locations by @DragonWork
* chore(deps): update dependencies by @DragonWork

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.4.0...v0.5.0

## What's Changed in v0.4.0 (2026-09-27)

* feat: expand SerialPort compatibility exports by @DragonWork
* ci: run tests on pushes and pull requests by @DragonWork
* chore(deps): bump prettier from 3.9.8 to 3.9.9 in the compatible-npm-updates group across 1 directory (#7) by @dependabot[bot] in [#7](https://github.com/DragonWork/node-serialport-rs/pull/7)
* perf: reuse small read buffers by @DragonWork
* chore(deps): bump taiki-e/install-action from 2.87.18 to 2.87.20 in the actions group across 1 directory (#8) by @dependabot[bot] in [#8](https://github.com/DragonWork/node-serialport-rs/pull/8)
* chore(deps): bump @types/node from 26.6.2 to 26.6.3 in the compatible-npm-updates group (#9) by @dependabot[bot] in [#9](https://github.com/DragonWork/node-serialport-rs/pull/9)

**Full Changelog**: https://github.com/DragonWork/node-serialport-rs/compare/v0.3.2...v0.4.0

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
