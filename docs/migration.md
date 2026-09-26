<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Moving from SerialPort

Install the package, then change the import:

```diff
- import { SerialPort } from 'serialport';
+ import { SerialPort } from 'serialport-rs';
```

Keep your port options, event handlers, and read/write code. Parsers come from the same package:

```js
import { SerialPort, ReadlineParser } from 'serialport-rs';
```

Streams, parsers, mocks, and binding types can all be imported from the package root:

| Previous package | Imports from `serialport-rs` |
| --- | --- |
| `serialport` | `SerialPort`, `SerialPortMock`, and parsers |
| `@serialport/stream` | `SerialPortStream`, `DisconnectedError`, `OpenOptions`, `StreamOptions`, and callback types |
| `@serialport/bindings-cpp` | `autoDetect()` or `RustBinding` for the native binding, plus `BindingsError` |
| `@serialport/bindings-interface` | `BindingInterface`, `BindingPortInterface`, `PortInfo`, `PortStatus`, `SetOptions`, `UpdateOptions`, `BindingsErrorInterface`, and binding type helpers |
| `@serialport/binding-mock` | `MockBinding`, `MockPortBinding`, `CanceledError`, `MockBindingInterface`, `MockPortInternal`, and `CreatePortOptions` |
| `@serialport/parser-byte-length` | `ByteLengthParser`, `ByteLengthOptions` |
| `@serialport/parser-cctalk` | `CCTalkParser` |
| `@serialport/parser-delimiter` | `DelimiterParser`, `DelimiterOptions` |
| `@serialport/parser-inter-byte-timeout` | `InterByteTimeoutParser`, `InterByteTimeoutOptions` |
| `@serialport/parser-packet-length` | `PacketLengthParser`, `PacketLengthOptions` |
| `@serialport/parser-readline` | `ReadlineParser`, `ReadlineOptions` |
| `@serialport/parser-ready` | `ReadyParser`, `ReadyParserOptions` |
| `@serialport/parser-regex` | `RegexParser`, `RegexParserOptions` |
| `@serialport/parser-slip-encoder` | `SlipEncoder`, `SlipDecoder`, `SlipEncoderOptions`, `SlipDecoderOptions` |
| `@serialport/parser-spacepacket` | `SpacePacketParser`, `SpacePacketOptions`, `SpacePacket`, `SpacePacketHeader` |

All ten parser packages are covered by eleven parser classes, including both SLIP directions. Their options and stream interfaces are available from the same package. `RegexParser` accepts a string, `RegExp`, or Buffer pattern; SLIP options also accept Node.js `TransformOptions`, such as `highWaterMark`.

For tests, change the mock-binding import directly:

```diff
- import { MockBinding } from '@serialport/binding-mock';
+ import { MockBinding } from 'serialport-rs';
```

The export is the same default binding used by `SerialPortMock.binding`, so existing code using that property continues to work. It also works with custom stream wrappers:

```js
import { MockBinding, SerialPortStream, ReadlineParser } from 'serialport-rs';

MockBinding.createPort('/mock/device', { echo: true });
const port = new SerialPortStream({ path: '/mock/device', baudRate: 115200, binding: MockBinding });
const lines = port.pipe(new ReadlineParser());
```

`MockPortBinding` is available for instance checks and type annotations. Create its instances through `MockBinding.open()` or a serial stream; its device constructor is internal. Mock cancellations use `CanceledError`, with `canceled: true`.

The raw binding options type is named `BindingOpenOptions` to distinguish it from the stream's `OpenOptions`. If migrating a type import from `@serialport/bindings-interface`, use `import type { BindingOpenOptions as OpenOptions } from 'serialport-rs'`. Platform-specific C++ binding classes are replaced by the portable Rust binding, rather than exported as aliases.

`BindingsError` has the same constructor shape as the C++ binding helper: `new BindingsError(message, { canceled: true })`. The flag defaults to `false`. Native binding cancellations use this class; mock cancellations use `CanceledError`. Validation and OS errors can still be ordinary errors, so check the `canceled` flag when handling both native and mock bindings.

The standalone `@serialport/list`, `@serialport/terminal`, and `@serialport/repl` command-line tools are not bundled. Use `SerialPort.list()` or `RustBinding.list()` for programmatic discovery. Internal `dist/*` modules, parser buffers, and C++-specific pollers or file descriptors are not part of this package's compatibility surface.

Once no imports use the old packages, remove those direct dependencies with your package manager. If another library imports SerialPort internally, update that library too. Changing your application's import does not replace its dependencies.
