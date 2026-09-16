<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Development and verification

Source builds require Rust/Cargo and a native linker or platform SDK. The crate declares Rust 1.88 as its minimum; the release workflow pins Rust 1.98.1. Release builds use fat LTO and stripped symbols, with an atomic replacement of `native/serialport-rs.node`. Cargo's `CARGO_PROFILE_RELEASE_LTO=thin` override remains available when comparing toolchains or diagnosing target-specific link failures.

Build the addon and the Unix pseudo-terminal test helper from the source checkout, then run the checks:

```sh
npm run build:debug
cargo build --locked --example pty
npm test
npm run check
cargo test --locked --lib
```

Use `npm run build` for an optimized release build. Pull requests use dev builds through `test.yml`; publication runs the same tests against the release artifacts.

Dev builds cache Cargo dependencies and share compiled addons and test helpers across Node versions. Release builds do not restore these caches.

The JavaScript tests use Node's built-in test runner. Native integration tests require Unix pseudo-terminals; mock and parser tests do not require serial hardware. Tests cover byte integrity, buffer ownership, backpressure, concurrent ports, cancellation, reopening, and worker cleanup. Optional consumer tests accept `SERIALPORT_CONSUMER` and `SERIALPORT_REFERENCE_STREAM` module paths.

Linux CI compares parser output and stream contracts against SerialPort 13.0.0, including the upstream stream using the Rust binding. Run these checks locally with:

```sh
npm install --no-save --ignore-scripts --package-lock=false serialport@13.0.0
node scripts/compare-parsers.js node_modules/serialport
SERIALPORT_REFERENCE_STREAM="$PWD/node_modules/@serialport/stream" node --expose-gc --test test/compatibility.test.js test/consumer.test.js
```

TypeScript declarations and a consumer fixture live in `index.d.ts` and `test/types.ts`. They can be checked with a compatible TypeScript compiler and Node type definitions using strict NodeNext resolution.

The `bench/` directory contains separate latency, throughput, and parser measurement tools. PTY results measure the host software path, not physical UART speed. Throughput records count echoed payload once, exclude echo-helper CPU, and include sampled memory usage.
