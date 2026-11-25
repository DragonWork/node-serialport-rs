<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native builds

The addon uses Node-API 8. Prebuilt binaries are available for these targets.

| Platform | Architectures |
| --- | --- |
| Linux glibc | x64, x86, ARM64, ARMv6, ARMv7, PowerPC64 LE, s390x, RISC-V64 |
| Linux musl | x64, x86, ARM64, ARMv6, ARMv7 |
| macOS | x64, ARM64 |
| Windows | x64, x86, ARM64 |
| Android | x64, x86, ARM64, ARMv7 |
| FreeBSD | x64 |
| illumos / SmartOS | x64 |

npm selects a native package using the operating system, CPU architecture and Linux libc. For example, Linux x64 with glibc uses `@serialport-rs/linux-x64-gnu`. Each Linux 32-bit ARM package contains both ARMv6 and ARMv7 binaries. The loader checks the ARM version and byte order before loading the addon. FreeBSD, Android and RISC-V availability also depends on the Node.js distribution.

Install with `npm install --include=optional` if native dependencies were omitted. Mock ports and parsers can run on their own. Generate consumer lockfiles with npm 11.11.0 or newer to record Linux libc selection for `npm ci`. The GitHub release archive includes every binary and supports `npm install --offline ./serialport-rs-VERSION.tar.gz`.

Runtime tests cover Linux x64 and ARM64, macOS ARM64 and Windows x64. Baud rates, modem control lines and disconnect behavior depend on the device and its driver.
