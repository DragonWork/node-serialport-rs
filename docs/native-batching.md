<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native receive batching

The Rust-backed stream can group already-ready reads into callbacks containing
at most 16 chunks. Small partial reads keep their direct delivery path.
This is automatic; there is no batch-size option or fill timer.

Applications still receive ordinary Buffer chunks in byte order. The binding
creates batch storage only when a second chunk is already ready. Explicit
binding `read()` and `readChunk()` calls keep their single-request behavior.
Using the original `@serialport/stream` with only the Rust binding does not use
this streaming read-ahead path.

The 64 KiB byte-credit and 32-chunk read-ahead limits still apply. Credits return
per delivered chunk; close and queued control/write operations interrupt further
batch collection. Batching reduces native callbacks, not wire latency or the
number of OS reads. Consumers should not depend on native callback boundaries.

A fatal JavaScript allocation failure rejects the affected native callback and
closes the port. Buffers delivered by earlier callbacks remain valid.
