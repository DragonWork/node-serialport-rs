<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native builds

Requires Node.js 20 or newer. The addon targets Node-API 8.


The release matrix defines 24 targets. Publication requires every build and the test jobs to succeed:

| Platform | Architectures |
| --- | --- |
| Linux glibc | x64, x86, ARM64, ARMv6, ARMv7, PowerPC64 LE, s390x, RISC-V64 |
| Linux musl | x64, x86, ARM64, ARMv6, ARMv7 |
| macOS | x64, ARM64 |
| Windows | x64, x86, ARM64 |
| Android | x64, x86, ARM64, ARMv7 |
| FreeBSD | x64 |
| illumos / SmartOS | x64 |

Platform binaries use `native/<rust-target>/serialport-rs.node`. The loader selects architecture, libc and, where needed, byte order. Native binaries use the host's system libraries; a build for one platform is not interchangeable with another.

Runtime CI covers Linux x64/ARM64, macOS ARM64 and Windows x64. Other matrix entries use cross-compilers or platform SDKs and require hardware validation before relying on driver-specific behavior. FreeBSD, Android and RISC-V support also depend on the Node version and distribution. The target set follows the [Node 20](https://github.com/nodejs/node/blob/v20.x/BUILDING.md#platform-list) and [Node 26](https://github.com/nodejs/node/blob/v26.8.2/BUILDING.md#platform-list) platform lists, [Rust target support](https://doc.rust-lang.org/rustc/platform-support.html), and available build toolchains.

The intersection is constrained by dependencies as well as CPU support. LoongArch64 and OpenHarmony currently fail in the transitive `nix 0.26.4` dependency; AIX additionally lacks a distributed Rust standard library and needs dependency ports. These platforms are not advertised as working prebuilds. Other Unix platforms may be buildable from source with a compatible Node, Rust toolchain and serial driver, but are not part of the configured release matrix.
