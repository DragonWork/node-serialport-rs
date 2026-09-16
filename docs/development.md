<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Development and verification

Source builds require Rust/Cargo and a native linker or platform SDK. The crate declares Rust 1.88 as its minimum; the release workflow pins Rust 1.98.1. Release builds use fat LTO and stripped symbols, with an atomic replacement of `native/serialport-rs.node`. Cargo's `CARGO_PROFILE_RELEASE_LTO=thin` override remains available when comparing toolchains or diagnosing target-specific link failures.

Build the addon and the Unix pseudo-terminal test helper from the source checkout, then run the checks:

```sh
npm ci --ignore-scripts
npm run build:debug
cargo build --locked --example pty
npm test
npm run check
cargo test --locked --lib
```

Use `npm run build` for an optimized release build. Pull requests use dev builds through `test.yml`; publication runs the same tests against the release artifacts.

Runtime source lives in `ts/`. `npm run build:js` compiles it in strict mode to `index.js` and `lib/`, and copies `ts/public-api.d.ts` to `index.d.ts`. Edit the TypeScript sources; generated files are ignored by Git. `npm test` and `npm pack` compile the runtime first.

Dev builds cache Cargo dependencies and share compiled addons and test helpers across Node versions. Release builds do not restore these caches.

Native builds use `target/.serialport-build.lock`. Successful releases remove their project-local compiler caches while retaining the addon and PTY/echo helpers. Failed builds retain their cache and the previous addon. Debug and external `CARGO_TARGET_DIR` caches are preserved. Check the recorded PID before removing a lock left by a force-killed build.

The JavaScript tests use Node's built-in test runner. Native integration tests require Unix pseudo-terminals; mock and parser tests do not require serial hardware. Tests cover byte integrity, buffer ownership, backpressure, concurrent ports, cancellation, reopening, and worker cleanup. Optional consumer tests accept `SERIALPORT_CONSUMER` and `SERIALPORT_REFERENCE_STREAM` module paths.

Linux CI compares parser output and stream contracts against SerialPort 13.0.0, including the upstream stream using the Rust binding. Run these checks locally with:

```sh
npm install --no-save --ignore-scripts --package-lock=false serialport@13.0.0
node scripts/compare-parsers.js node_modules/serialport
SERIALPORT_REFERENCE_STREAM="$PWD/node_modules/@serialport/stream" node --expose-gc --test test/compatibility.test.js test/consumer.test.js
```

Run `npm run check:types` to check the runtime and the public consumer fixture in `test/types.ts` against the pinned compiler and Node 20 declarations.

The `bench/` directory contains separate latency, throughput, and parser measurement tools. PTY results measure the host software path, not physical UART speed. Throughput records count echoed payload once, exclude echo-helper CPU, and include sampled memory usage.

## Releases

Set matching versions in the npm and Cargo manifests and lockfiles. Run the **Publish** workflow at the release commit with `publish` enabled. It builds every target, runs the tests and validates the package before creating a draft release. With `publish` disabled, the workflow produces build artifacts only.

The archive, `serialport-rs-<version>.tar.gz`, contains compiled JavaScript, declarations, prebuilt addons, documentation and licenses. It is attached to a GitHub draft before npm publication. The GitHub release is published after npm succeeds.

Retry failed publication jobs with their original `npm-package` artifact. An existing npm version is accepted only if its archive integrity matches; an existing tag must resolve to the tested commit. A completed immutable release is verified instead of rewritten. A failure before publication leaves its draft available for a retry. A different package under an already published version requires a new version.
