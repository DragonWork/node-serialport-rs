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

The loader selects a binary for the host architecture, libc and byte order. FreeBSD, Android and RISC-V availability also depends on the Node.js distribution.

Runtime tests cover Linux x64 and ARM64, macOS ARM64 and Windows x64. Baud rates, modem control lines and disconnect behavior depend on the device and its driver.
