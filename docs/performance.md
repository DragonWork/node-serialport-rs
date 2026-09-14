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
