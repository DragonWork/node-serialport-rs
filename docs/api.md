<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# API

## Runtime identification

```js
import { version } from 'serialport-rs';

console.log(version.version); // Package version
console.log(version.arch);    // Node architecture, such as 'x64' or 'arm64'
console.log(version.target);  // Compatible prebuilt Rust target
```

`version` is a frozen object with `name`, `version`, `node`, `napi`, `platform`, `arch`, `endian`, `libc`, and `target` properties. `napi` is the addon's required Node-API level. `libc` is `'gnu'` or `'musl'` on Linux and `undefined` elsewhere. `target` is `undefined` for unsupported prebuilt platforms; it describes the compatible prebuilt target even when a local addon takes precedence.

The metadata does not load the native addon. Target and libc detection run only when those properties are read, and the result is shared with the native loader. `JSON.stringify(version)` includes the detected values. CommonJS callers can use `require('serialport-rs').version`.

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

### Cancellation and errors

Pass an `AbortSignal` to cancel a stream, including an in-progress open:

```js
const controller = new AbortController();
const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 115200,
  signal: controller.signal,
});
port.on('error', error => {
  if (error.code !== 'ABORT_ERR') console.error(error);
});

// When the application no longer needs the connection:
controller.abort('shutdown');
```

Aborting destroys the stream and closes its connection. The stream emits an `AbortError` with code `ABORT_ERR` and the signal's reason in `cause`. An already aborted signal prevents the device from opening. With automatic opening, the constructor callback also receives that error. A custom binding without open cancellation is closed as soon as its pending open resolves.

The signal remains attached across ordinary `close()`/`open()` cycles and is removed on destruction. An aborted stream cannot reopen; create a new stream and signal for a new connection. The signal is a stream option and is not passed to the binding. Physical drain and a custom binding's close behavior can still delay resource release.

Disconnect notifications carry `disconnected: true` and preserve the original error in `cause`. Custom binding methods may reject promises or throw synchronously; both reach the same error callbacks and connection cleanup paths. A rejection that is not an `Error` is wrapped in an `Error` with the original value in `cause`. Failed writes can leave the writable side errored, so use a new stream when recovering from a write failure.

### Discovery

```js
const ports = await SerialPort.list();
for (const port of ports) console.log(port.path, port.manufacturer, port.serialNumber);
```

Each entry includes `path`, `manufacturer`, `serialNumber`, `vendorId`, `productId`, `pnpId`, `locationId`, and `friendlyName`. Unavailable metadata is `undefined`; listing does not open the serial ports.

On Windows, `pnpId` is the full device instance ID (including `BTHENUM` for Bluetooth ports), `locationId` is the Device Manager location such as `Port_#0003.Hub_#0006`, and `friendlyName` is the Device Manager display name. Manufacturer and display metadata are queried for non-USB ports too. USB vendor/product IDs use uppercase hexadecimal, matching SerialPort on Windows. USB serial numbers preserve the complete instance component; composite USB and FTDI ports use the matching parent USB device when available. Optional property lookup failures leave existing metadata intact.

On macOS, USB `locationId` uses the eight-digit lowercase hexadecimal IOKit location, such as `14320000`, matching SerialPort. Linux discovery uses `/dev/serial/by-id` when available for `pnpId`; `locationId` remains `undefined` there, as in SerialPort. `friendlyName` is Windows-only.

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
| `signal` | Unset | `AbortSignal` that destroys the stream on cancellation |

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

`SlipDecoder` also accepts `maxFrameLength`. Its limit counts decoded payload bytes, excluding start/end markers and escape overhead. The limit applies to completed frames and incomplete input, including across chunk boundaries:

```js
import { SlipDecoder } from 'serialport-rs';

const packets = port.pipe(new SlipDecoder({ maxFrameLength: 4096 }));
packets.on('error', error => console.error('Invalid SLIP frame:', error));
```

Overflow uses the same `RangeError` and `ERR_SERIALPORT_FRAME_TOO_LARGE` code and releases buffered payload. A limit of zero permits only empty frames. Omitting the option retains unlimited frames, including the existing invalid-escape and trailing-frame behavior. It is a decoder option; `SlipEncoder` has no frame limit.

## Native receive batching

The Rust stream automatically groups already-ready follow-up reads into fewer
native callbacks. Small partial reads keep their direct delivery path; no fill
timer or tuning option is needed. Applications receive ordinary Buffer chunks and use the same
stream API. See [native batching](native-batching.md) for details.
