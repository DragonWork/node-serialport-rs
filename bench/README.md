<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# serialport-rs 0.2.0 vs patched C++

32-byte PTY round trips measured on September 16, 2026 with Node 26.8.2. Values are medians of five individual trials' Promise-continuation percentiles.

## Linux x64

Four AMD EPYC 9634 vCPUs, Linux 7.1.8+deb13-cloud-amd64, Rust 1.98.1 and GCC 14.2.0.

| Workload | Implementation | Median | p95 | p99 |
| --- | --- | --- | --- | --- |
| Continuous | serialport-rs 0.2.0 | 56.66 µs | 84.74 µs | 138.05 µs |
| Continuous | Patched C++ 13.1.0 | 91.44 µs | 141.86 µs | 235.67 µs |
| 1 ms between exchanges | serialport-rs 0.2.0 | 133.12 µs | 209.44 µs | 321.72 µs |
| 1 ms between exchanges | Patched C++ 13.1.0 | 175.00 µs | 272.75 µs | 354.78 µs |

## Raspberry Pi 4B

Four Cortex-A72 cores at 1.8 GHz, Linux ARM64 7.3.0-rc3-v8-rt+, Rust 1.98.1 and GCC 16.2.0.

| Workload | Implementation | Median | p95 | p99 |
| --- | --- | --- | --- | --- |
| Continuous | serialport-rs 0.2.0 | 80.76 µs | 110.59 µs | 172.52 µs |
| Continuous | Patched C++ 13.1.0 | 83.05 µs | 191.39 µs | 465.55 µs |
| 1 ms between exchanges | serialport-rs 0.2.0 | 133.09 µs | 339.07 µs | 646.03 µs |
| 1 ms between exchanges | Patched C++ 13.1.0 | 230.90 µs | 525.38 µs | 944.54 µs |

The Pi's continuous median was similar between implementations, with lower p95 and p99 for Rust. The x64 results showed lower median and tail latency for Rust.

## Method

Each workload used five alternating trials per implementation. Continuous trials collected 10,000 samples after 2,000 warmups. Spaced trials collected 1,000 samples after 100 warmups; the gap was excluded from measured latency. Both implementations used the same echo helper and verified every returned payload.

[serialport-rs at b6db262](https://github.com/DragonWork/node-serialport-rs/commit/b6db26266c3176a8ecc3a1903510a973b9ecbb3e) used a release build with fat LTO. [DragonWork/bindings-cpp at 23ca033](https://github.com/DragonWork/bindings-cpp/commit/23ca033cf68fbc1bda2837b03bfdaf77bde70ff3) used its release build and `@serialport/stream` 13.0.0, including the Node 26 callback-scope fix.

PTY measurements cover the host software path. Physical UART performance also depends on baud rate, hardware and drivers.

## Run the benchmarks

From a source checkout:

```sh
npm ci --ignore-scripts
cargo build --release --locked --lib --example echo
npm run build
node --expose-gc bench/latency.js
node --expose-gc bench/throughput.js
node --expose-gc bench/parsers.js
```

The latency and throughput scripts accept `--binding` and `--stream` package paths for comparing compatible implementations.
