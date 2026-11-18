<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Development and verification

Source builds use Rust edition 2024 and require a native linker or platform SDK. The checkout selects the `stable` Rust channel. Run `rustup update stable` to update your installed compiler. Release builds use fat LTO and stripped symbols, with an atomic replacement of `native/serialport-rs.node`. Cargo's `CARGO_PROFILE_RELEASE_LTO=thin` override remains available when comparing toolchains or diagnosing target-specific link failures.

Build the addon and the Unix pseudo-terminal test helper from the source checkout, then run the checks:

```sh
npm ci --ignore-scripts
npm run build:debug
cargo build --locked --example pty
npm test
npm run check
cargo test --locked --lib
```

Use `npm run build` for an optimized release build with the stable compiler. Debug builds use the active toolchain. Pull requests test dev builds, and publication tests the release artifacts.

CI runs the Rust tests on stable and beta across Linux x64/ARM64, macOS ARM64 and Windows x64. Stable also covers the Node version matrix. The beta job builds the addon from source and runs the Node 26 tests, including during release verification. Only stable builds supply release artifacts. Beta failures are advisory.

The MSRV check reads `package.rust-version` from [Cargo.toml](../Cargo.toml) and checks the library, tests and examples on each native platform. Stable and MSRV failures block release verification.

Runtime source lives in `ts/`. `npm run build:js` compiles it in strict mode to `index.js` and `lib/`, and copies `ts/public-api.d.ts` to `index.d.ts`. Edit the TypeScript sources; generated files are ignored by Git. `npm test` and `npm pack` compile the runtime first.

Test sources and helpers live in `test/*.ts`. `npm run build:tests` first checks the complete test project in strict mode, including references to runtime types, then emits only the test files to ignored `test/*.js` and source maps. The separate emission pass avoids generating a second copy of imported runtime sources. `npm test` builds both the runtime and tests and enables source maps. To run selected tests, build once and pass the generated `.test.js` paths to Node's test runner.

JavaScript, TypeScript and JSON use the pinned [Prettier](https://prettier.io/docs/install) version in `devDependencies`. Run `npm run format` to format maintained files, or `npm run format:check` to check them without writing. The shared `.prettierrc.json` uses spaces inside braces (`{ value }`), two-space indentation, single quotes in JS/TS, LF endings and a 120-column target. Prettier-enabled editors read the same configuration. Generated JavaScript/declarations, dependencies and build artifacts are excluded by `.prettierignore`. Formatting is checked by both `npm run check` and CI; Rust continues to use `cargo fmt`.

Dev builds cache Cargo dependencies and share compiled addons and test helpers across Node versions. Release builds do not restore these caches.

Native builds use `target/.serialport-build.lock`. Successful releases remove release and debug compiler caches in their matching project-local target directory while retaining the addon and PTY/echo helpers. Failed builds retain their cache and the previous addon. Debug builds retain their caches; separate development lanes and external `CARGO_TARGET_DIR` caches are preserved. Use a separate target directory for concurrent development work. Check the recorded PID before removing a lock left by a force-killed build.

The JavaScript tests use Node's built-in test runner. Native integration tests require Unix pseudo-terminals; mock and parser tests do not require serial hardware. Tests cover byte integrity, buffer ownership, backpressure, concurrent ports, cancellation, reopening, and worker cleanup. Optional consumer tests accept `SERIALPORT_CONSUMER` and `SERIALPORT_REFERENCE_STREAM` module paths.

Windows read-policy regressions run on every OS with `cargo test --locked --lib platform::windows_read`. They inject empty completions, pending reads, buffered data and device errors, including a driver that repeatedly completes empty reads.

For Windows driver validation, connect two isolated COM ports (a com0com pair or two cross-wired UARTs), build the addon and tests, and run in PowerShell:

```powershell
$env:SERIALPORT_TEST_PORT = 'COM3'
$env:SERIALPORT_TEST_PEER = 'COM4'
node --enable-source-maps --test test/windows-serial.test.js
```

This opt-in test sends binary data, waits through two 65-second idle periods, checks pending-read cancellation and byte integrity, and reports round-trip latency and throughput. It skips without both port variables. Run it on each supported driver; simulated read completions and Windows compilation do not establish hardware behavior.

Linux CI compares parser output and stream contracts against SerialPort 13.0.0, including the upstream stream using the Rust binding. Run these checks locally with:

```sh
npm install --no-save --ignore-scripts --package-lock=false serialport@13.0.0
npm run build:js
npm run build:tests
node test/compare-parsers.js node_modules/serialport
SERIALPORT_REFERENCE_STREAM="$PWD/node_modules/@serialport/stream" node --enable-source-maps --expose-gc --test test/compatibility.test.js test/consumer.test.js
```

Run `npm run check:types` to check the runtime, every test, and the public consumer fixture in `test/types.ts` against the pinned compiler and Node declarations. The consumer fixture is checked without execution. CI also checks these against Node 20 declarations in its Node 20 test job to preserve compatibility with the minimum supported runtime. Tests that exercise newer runtime features must retain their feature guards; the test compiler's library types do not polyfill those features.

The [`bench/` directory](../bench/README.md) contains separate latency, throughput, and parser measurement tools. PTY results measure the host software path, not physical UART speed. Throughput records count echoed payload once, exclude echo-helper CPU, and include sampled memory usage.

## Releases

Releases start only through the manual **Publish** workflow. Choose a branch and set `version` to `auto`, `patch`, `minor`, `major`, or an exact version such as `0.2.0` or `0.3.0-rc.1`. Automatic selection uses Conventional Commits since the latest reachable release tag: breaking changes select major, features select minor, and other changes select patch. Release notes exclude chores except for `chore(deps):` updates.

The workflow starts the project-owned checksum installer, then invokes its git-cliff action at an exact commit. The action manifest pins the downloaded binary checksum and version; Dependabot tracks both GitHub Actions references. git-cliff uses `cliff.toml` to generate release notes and prepend them to `CHANGELOG.md`. The workflow updates both npm and Cargo manifests and lockfiles together. With `publish` enabled, GitHub records these files in a signed preparation commit on the selected branch before the builds start. A concurrent branch update aborts preparation. With `publish` disabled, the prepared files are used only in the build artifacts.

Every native build, test job and package step uses the same prepared version. A GitHub draft is created only after all builds, tests and package checks pass. The draft body comes from the notes saved with that archive, so a publication retry uses the same changelog.

To prepare and review these files locally with git-cliff installed:

```sh
npm run release:prepare -- auto
```

This updates the working tree and writes `artifacts/prepared-release.json`; it creates no local tag or commit. Commit the reviewed changes before starting the manual workflow. Regenerating the same version replaces its changelog section without duplicating it.

The archive, `serialport-rs-<version>.tar.gz`, contains compiled JavaScript, declarations, prebuilt addons, the changelog, documentation and licenses. It is attached to the draft before npm publication. The GitHub release is published after npm succeeds.

Retry failed publication jobs with their original `npm-package` artifact. An existing npm version is accepted only if its archive integrity matches; an existing tag must resolve to the tested commit. A completed immutable release is verified instead of rewritten. A failure before publication leaves its draft available for a retry. A different package under an already published version requires a new version.
