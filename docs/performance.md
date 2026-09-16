<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Performance

Recorded 32-byte PTY round trips on Linux ARM64, Node 26.8.2, with 20,000 samples after 5,000 warmup exchanges:

| Implementation | Median | p95 | p99 |
| --- | --- | --- | --- |
| Patched SerialPort C++ binding, median of five runs | 77.50 µs | 235.50 µs | 557.57 µs |
| Optimized Rust build, run 1 | 77.48 µs | 108.28 µs | 314.85 µs |
| Optimized Rust build, run 2 | 78.91 µs | 106.17 µs | 207.89 µs |

Both Rust runs kept the median in the same range while reducing the slower p95 and p99 responses. [Recorded measurements and binary fingerprints](../bench/results/latency-linux-arm64-node26.8.2.json).

## Release LTO comparison

On Linux x64 with Node 26.8.2 and Rust 1.98.1, five alternating thin/fat LTO trials used identical 32-byte payloads and the same PTY echo helper. Both optimized addons passed the JavaScript suite, including native PTY tests and Promise progress with no timer in the tested process.

| Workload | LTO | Median | p95 | p99 |
| --- | --- | --- | --- | --- |
| Continuous round trips | Thin | 53.42 µs | 97.57 µs | 167.65 µs |
| Continuous round trips | Fat | 47.20 µs | 73.49 µs | 116.22 µs |
| 1 ms between round trips | Thin | 134.69 µs | 209.36 µs | 337.21 µs |
| 1 ms between round trips | Fat | 133.19 µs | 205.23 µs | 292.75 µs |

Values are medians of each trial's percentiles. Continuous trials recorded 10,000 samples after 2,000 warmups; spaced trials recorded 1,000 after 100 warmups and excluded the gap from latency. Scheduling on the shared host varied, particularly in the spaced trials. These results support using fat LTO by default on this host, but do not establish a speedup on every architecture or physical serial device. Binary sizes were effectively identical (913,200 and 913,216 bytes). [Trial results and fingerprints](../bench/results/lto-linux-x64-node26.8.2.json).
