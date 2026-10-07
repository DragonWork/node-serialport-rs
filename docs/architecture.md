<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Architecture and memory ownership

Rust runs event-driven I/O on lazily created, single-threaded Tokio runtimes. One active port starts one I/O worker. Additional ports use up to `min(available CPUs, 4)` workers per loaded addon; further ports share those workers. Workers retire after their last connection finishes cleanup. Opening a device and physical output drain use bounded blocking-worker pools.

Device discovery and configuration use `serialport`. Unix I/O uses Tokio's `AsyncFd` with nonblocking descriptor reads and writes. On Windows, Tokio owns the overlapped I/O handle and `serialport::COMPort` owns a duplicate for control operations. Each handle has a single owner.

Platform restrictions that can be validated without a device are checked before opening it. A request for unsupported stop bits, parity or shared Windows access therefore cannot first alter a port's configuration or control lines.

Idle serial I/O has no heartbeat interval. Readiness wakes pending reads and writes. Explicit physical-drain operations may poll the driver's output queue; the timeout parser also uses timers when it has buffered data.

| Data path | Ownership and copies |
| --- | --- |
| Immediate scalar writes | Rust borrows the buffer only during the synchronous native call and never waits for the port mutex |
| Queued writes | Remaining bytes are copied into Rust-owned memory before the native call returns |
| Vectored writes | Each segment is borrowed and copied in turn, supporting overlapping input without persistent N-API references per segment |
| Incoming data | Rust owns the I/O buffers; small stream reads are copied into pooled Node buffers, while larger buffers can be transferred without copying their contents |
| SharedArrayBuffer writes | Copied before Rust borrows the data; callers must still coordinate concurrent writers |
| Parsers | Buffer slices are reused where possible; frames crossing input chunks may require copying |

This is not an end-to-end zero-copy implementation. Keep submitted buffers unchanged until their operation completes. Received buffers remain valid after the port closes. Read-ahead is bounded by byte and event credits; pending native operations and callback queues are also bounded. Applications must still respect Node stream backpressure.

Native admission limits outstanding writes and controls to 64 across both the channel and the reactor queue. The reactor keeps receiving read credits even at that limit, so a blocked writer and a full control backlog cannot stop incoming data. Rejected submissions release their reservation before returning to JavaScript.

Individual stream reads travel inline in the native callback event up to 96 bytes on 64-bit targets and 64 bytes on 32-bit targets. On the current 64-bit layout, the larger inline payload fits within the existing control-event size. Rust retains initialized read storage so subsequent small reads can overwrite it without repeatedly zero-filling it. Only the completed byte range is copied into the event and then into an independent pooled JavaScript buffer. The retained Rust read allocation is bounded by 64 KiB per port. Batched followers and larger reads retain their owned buffers.

Vectored writes reuse complete JavaScript buffer views. Only segments split at the native transfer boundary need an additional view. Rust snapshots each segment before fetching the next, since array accessors can run JavaScript and mutate earlier inputs. An uncontended batch can complete through the same nonblocking write path as a scalar write; a partial write queues only its remaining snapshot. Earlier ordered operations force the queued path, preserving both byte order and Promise completion order.

Inline native submissions reuse a settled Promise and skip pending-operation records. Caller-visible writes still settle asynchronously. Requests waiting for the worker retain their normal pending records, and rejected submissions release their ordering reservation before another operation can run.

Native completion events borrow fixed Rust string labels instead of allocating a `String` for each event. JavaScript still receives the same ordinary string fields; the event object is only marshalled from Rust to JavaScript.

SLIP decoding reuses larger input chunks that need no escape processing and no explicit start marker. Small fragments keep the byte loop to avoid the cost of repeated native searches. Delimiter, readline and SLIP decoders can bound incomplete payloads with the optional `maxFrameLength` setting; the default remains unlimited for compatibility. SLIP counts decoded bytes, while delimiter and readline parsers count bytes before text decoding. Overflow and destruction release the buffered payload.

## Async context

Applications can use `AsyncLocalStorage` for request or device context. Promise continuations preserve their caller's context. Explicit stream close callbacks are bound when registered because a native close notification may arrive in a different context. This adds no context capture to the read/write hot path.

Stream event listeners run in the context that emits the event. Use Node's [`AsyncResource.bind()`](https://nodejs.org/api/async_context.html#static-method-asyncresourcebindfn-type-thisarg) when a particular listener must retain the context in which it was registered. The library does not create its own context store or infer which request owns unsolicited serial data.

## Lifecycle notes

- Install `error` and `close` listeners. Application-level reconnect and protocol recovery are deliberately not automatic.
- A failed write can leave a Node writable stream in an errored state. Create a new stream instance when recovering from such a failure.
- Physical output drain waits for the driver to finish transmission. A blocked drain can also delay close; avoid waiting for drain when intentionally abandoning blocked output.
- If a custom binding refuses to close and remains open, the close callback receives the failure and buffered I/O resumes. A close failure while canceling an open also leaves the connection available for cleanup: the open callback reports cancellation, the close callback reports the driver failure, and close can be retried.
- Synchronous custom-binding failures use the same paths as rejected promises. Closing clears the binding's stream hooks and the completed open promise so a retained stream does not keep an old connection alive.
- A stream's optional abort listener lasts until destruction, including across ordinary close/reopen cycles. Destruction removes the listener and cancels queued writes before closing the connection.
