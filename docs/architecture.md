<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture and memory ownership

Rust runs event-driven I/O on lazily created, single-threaded Tokio runtimes. One active port starts one I/O worker. Additional ports use up to `min(available CPUs, 4)` workers per loaded addon; further ports share those workers. Workers retire after their last connection finishes cleanup. Opening a device and physical output drain use bounded blocking-worker pools.

Idle serial I/O has no heartbeat interval. Readiness wakes pending reads and writes. Explicit physical-drain operations may poll the driver's output queue; the timeout parser also uses timers when it has buffered data.

| Data path | Ownership and copies |
| --- | --- |
| Small immediate writes | Rust borrows the buffer only during the synchronous native call and never waits for the port mutex |
| Queued writes | Remaining bytes are copied into Rust-owned memory before the native call returns |
| Incoming data | Rust owns the I/O buffers; small stream reads are copied into pooled Node buffers, while larger buffers can be transferred without copying their contents |
| SharedArrayBuffer writes | Copied before Rust borrows the data; callers must still coordinate concurrent writers |
| Parsers | Buffer slices are reused where possible; frames crossing input chunks may require copying |

This is not an end-to-end zero-copy implementation. Keep submitted buffers unchanged until their operation completes. Received buffers remain valid after the port closes. Read-ahead is bounded by byte and event credits; pending native operations and callback queues are also bounded. Applications must still respect Node stream backpressure.

SLIP decoding reuses larger input chunks that need no escape processing and no explicit start marker. Small fragments keep the byte loop to avoid the cost of repeated native searches. Delimiter and readline parsers can bound incomplete payloads with the optional `maxFrameLength` setting; the default remains unlimited for compatibility.

## Async context

Applications can use `AsyncLocalStorage` for request or device context. Promise continuations preserve their caller's context. Explicit stream close callbacks are bound when registered because a native close notification may arrive in a different context. This adds no context capture to the read/write hot path.

Stream event listeners run in the context that emits the event. Use Node's [`AsyncResource.bind()`](https://nodejs.org/api/async_context.html#static-method-asyncresourcebindfn-type-thisarg) when a particular listener must retain the context in which it was registered. The library does not create its own context store or infer which request owns unsolicited serial data.

## Lifecycle notes

- Install `error` and `close` listeners. Application-level reconnect and protocol recovery are deliberately not automatic.
- A failed write can leave a Node writable stream in an errored state. Create a new stream instance when recovering from such a failure.
- Physical output drain waits for the driver to finish transmission. A blocked drain can also delay close; avoid waiting for drain when intentionally abandoning blocked output.
- If a custom binding refuses to close and remains open, the close callback receives the failure and buffered I/O resumes. A close failure while canceling an open also leaves the connection available for cleanup: the open callback reports cancellation, the close callback reports the driver failure, and close can be retried.
