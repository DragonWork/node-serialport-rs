<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# API

## Serial streams

ES modules:

```js
import { SerialPort, ReadlineParser } from 'serialport-rs';

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
const lines = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

port.on('error', error => console.error('Serial error:', error.message));
port.on('close', error => {
  if (error?.disconnected) console.error('Device disconnected');
});
lines.on('data', line => console.log(line));

port.on('open', () => {
  port.write('status\r\n', error => {
    if (error) console.error('Write failed:', error.message);
  });
});
```

CommonJS is also supported:

```js
const { SerialPort, ReadlineParser } = require('serialport-rs');
```

Opening is automatic unless `autoOpen: false` is passed. Use `open(callback)` and `close(callback)` for explicit lifecycle control. The stream supports `pipe()`, `pause()`, `resume()`, `cork()`, and normal Node.js backpressure. `write()` accepts buffers, strings, and arrays of bytes; when it returns `false`, wait for the stream's `drain` event before submitting more data.

The stream's `drain` event is different from the serial `drain(callback)` method. The event concerns JavaScript write buffering; the method waits for queued writes and then asks the OS to drain device output. A successful write callback alone does not mean the bytes have physically left the UART.

### Discovery

```js
const ports = await SerialPort.list();
for (const port of ports) console.log(port.path, port.manufacturer, port.serialNumber);
```

Each entry includes `path`, `manufacturer`, `serialNumber`, `vendorId`, `productId`, `pnpId`, and `locationId`. Unavailable metadata is `undefined`. Linux discovery uses `/dev/serial/by-id` when available for `pnpId`; `locationId` is not currently populated.

### Options and controls

| Option | Default | Values |
| --- | --- | --- |
| `path` | Required | Device path, such as `/dev/ttyUSB0` or `COM3` |
| `baudRate` | Required | Positive integer supported by the device/driver |
| `dataBits` | `8` | `5`, `6`, `7`, `8` |
| `stopBits` | `1` | `1`, `1.5`, `2`; `1.5` requires Windows |
| `parity` | `'none'` | `'none'`, `'odd'`, `'even'`, `'mark'`, `'space'`; platform restrictions apply |
| `lock` | `true` | Exclusive access; Windows rejects `false` |
| `rtscts` | `false` | Hardware flow control |
| `xon`, `xoff`, `xany` | `false` | Software flow-control settings; platform support varies |
| `hupcl` | `true` | Unix hang-up-on-close setting; Windows DTR-on-open setting |
| `autoOpen` | `true` | Open during construction |
| `highWaterMark` | `65536` | Node stream buffering threshold, in bytes |
| `endOnClose` | `false` | Emit `end` when the port closes |

Available control methods are `update({ baudRate }, callback)`, `set({ dtr, rts, brk }, callback)`, `get(callback)`, `flush(callback)`, and `drain(callback)`. `get()` returns CTS, DSR, and DCD status. `flush()` discards unread input and output that the OS has not transmitted. Device drivers may reject unsupported control operations or serial settings.

See [index.d.ts](../index.d.ts) for the exported types and method signatures.

## Promise-based binding API

For code that already manages its own stream layer, `RustBinding` implements the serial binding interface:

```js
import { RustBinding } from 'serialport-rs';

const binding = await RustBinding.open({ path: '/dev/ttyUSB0', baudRate: 115200 });
try {
  await binding.write(Buffer.from('status\r\n'));
  const buffer = Buffer.alloc(256);
  const { bytesRead } = await binding.read(buffer, 0, buffer.length);
  console.log(buffer.subarray(0, bytesRead));
} finally {
  await binding.close();
}
```

Binding operations return promises. `read()` returns at least one byte or rejects; only one read and one write may be pending per connection. Extensions include `readChunk(length)`, which returns a buffer directly, and `writev(buffers)`, which batches buffers.

After an unexpected I/O failure, a raw binding stays logically open until its consumer calls `close()`. This allows existing stream wrappers to perform their disconnect handling. Native resource cleanup does not depend on that acknowledgement. Intentional close cancels pending operations with the exported `BindingsError` class carrying `canceled: true`.

## Parsers

All parsers are JavaScript transforms and can be loaded without the native binary:

- `ByteLengthParser`: fixed-size frames.
- `DelimiterParser` and `ReadlineParser`: delimiter-separated frames or text lines.
- `RegexParser`: text separated by a regular expression.
- `ReadyParser`: discard bytes until a handshake marker is received.
- `InterByteTimeoutParser`: split frames after an inter-byte timeout.
- `CCTalkParser`: CCTalk frames.
- `PacketLengthParser`: frames with a length field.
- `SlipEncoder` and `SlipDecoder`: SLIP encoding and decoding.
- `SpacePacketParser`: CCSDS space packets.

`DelimiterParser` and `ReadlineParser` accept an optional `maxFrameLength` to reject oversized frames, including incomplete input that never receives a terminator:

```js
const lines = port.pipe(new ReadlineParser({ maxFrameLength: 4096 }));
lines.on('error', error => {
  if (error.code === 'ERR_SERIALPORT_FRAME_TOO_LARGE') console.error('Device sent an oversized line');
});
```

The limit is a nonnegative integer counting payload bytes before decoding, excluding the delimiter even with `includeDelimiter: true`. A possible delimiter prefix may be buffered beyond the limit until it is resolved; at end of input an incomplete delimiter counts as payload. Overflow reports a `RangeError` with code `ERR_SERIALPORT_FRAME_TOO_LARGE` and releases the buffered frame. The usual Transform error/destroy behavior applies; the parser does not silently discard bytes and resume.

Omitting the limit preserves SerialPort 13 framing behavior, including unlimited incomplete frames. `InterByteTimeoutParser` supports `maxBufferSize`; `PacketLengthParser` supports `maxLen` with its SerialPort-compatible behavior.

## Native receive batching

The Rust stream automatically groups already-ready follow-up reads into fewer
native callbacks. Small partial reads keep their direct delivery path; no fill
timer or tuning option is needed. Applications receive ordinary Buffer chunks and use the same
stream API. See [native batching](native-batching.md) for details.
