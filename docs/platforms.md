<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native builds

Requires Node.js 20 or newer. The addon targets Node-API 8.


The release workflow builds 14 targets in parallel:

| Platform | Architectures |
| --- | --- |
| Linux glibc | x64, ARM64, ARMv6, ARMv7 |
| Linux musl | x64, ARM64, ARMv7 |
| macOS | x64, ARM64 |
| Windows | x64, x86, ARM64 |
| Android | ARM64, ARMv7 |

Platform binaries use `native/<rust-target>/serialport-rs.node`. The loader selects the architecture and libc variant. Native binaries use the host's system libraries; a build for one platform is not interchangeable with another.
