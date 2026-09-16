# Changelog

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
