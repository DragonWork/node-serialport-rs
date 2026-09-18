<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# serialport-rs for Node.js

**SerialPort-compatible serial I/O for Node.js, backed by Rust.**

Use a familiar SerialPort 13-style API with a Rust native backend. Streams,
parsers, bindings, and mock ports come together in one package, with no JavaScript
runtime dependencies.

[Install](#install) · [Migration](#migrating-from-serialport) ·
[API](https://github.com/DragonWork/node-serialport-rs/blob/main/docs/api.md) ·
[Tests](https://github.com/DragonWork/node-serialport-rs/actions)

## Why this exists

This project started after Node.js 26.4 exposed a bug in the existing C++ bindings: serial I/O could stall until unrelated JavaScript activity caused pending Promises to continue.

The root cause was how `@serialport/bindings-cpp` called back into JavaScript, using an approach Node.js does not recommend. Fixes were proposed upstream, but SerialPort has seen limited maintenance, making timely fixes difficult as Node.js evolves.

**This is an independent project, not an official SerialPort release.**

For the technical background, see the
[Node.js event-loop optimization](https://github.com/nodejs/node/pull/62969),
[Azq2's upstream poller fix](https://github.com/serialport/bindings-cpp/pull/239),
and [DragonWork's follow-up callback-scope fix](https://github.com/serialport/bindings-cpp/pull/243).

## Install

Requires Node.js 20 or newer. Get the [latest npm release](https://www.npmjs.com/package/serialport-rs):

```sh
npm install serialport-rs
```

## Quick start

Save this as `example.mjs`. Set the device path, baud rate, and line delimiter to
match your device; a Windows device path might be `COM3`.

```js
import { SerialPort, ReadlineParser } from 'serialport-rs';

const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 115200,
});

const lines = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

port.on('error', error => console.error('Serial port error:', error.message));
port.on('close', () => console.log('Serial port closed'));
lines.on('error', error => console.error('Parser error:', error.message));
lines.on('data', line => console.log('Received:', line));

port.on('open', () => {
  console.log('Serial port opened');
  // Replace this with a command understood by your device.
  port.write('status\r\n', error => {
    if (error) console.error('Write failed:', error.message);
  });
});
```

CommonJS is also supported:

```js
const { SerialPort, ReadlineParser } = require('serialport-rs');
```

## Migrating from SerialPort

Start by changing your application import:

```diff
- import { SerialPort } from 'serialport';
+ import { SerialPort } from 'serialport-rs';
```

Parsers and mocks are exported by the same package. See the
[migration guide](docs/migration.md)
for those changes and for applications whose dependencies import SerialPort
internally. Changing your own import does not replace another package's dependency.

Compatibility is a project goal backed by automated stream and parser comparisons,
not a promise that every application and driver combination behaves identically.
Unexpected behavior when migrating is useful feedback — so please
[report it](https://github.com/DragonWork/node-serialport-rs/issues).

## Design and performance

Serial I/O runs on a dedicated, bounded Rust worker pool. Idle reads do not depend
on a heartbeat timer. Read-ahead and pending-operation queues are bounded; your
application must still honor stream backpressure.

The [architecture guide](docs/architecture.md)
explains buffer ownership, worker lifetime, and recovery behavior. Reconnection
and protocol recovery belong to the application. A blocked physical-output drain
can also delay closing a port.

Recorded Linux x64 and ARM64 pseudo-terminal comparisons show lower tail latency
against a **patched C++ baseline that includes the callback-scope fix**. These
measurements cover the host software path, not physical UART speed. Exact versions,
workloads, results, and reproduction commands are in the
[benchmark documentation](bench/README.md).

## Documentation

- [Migrating from SerialPort](docs/migration.md)
- [Stream and binding API, options, and parsers](docs/api.md)
- [Mock ports](docs/mocking.md)
- [Architecture, memory ownership, and lifecycle](docs/architecture.md)
- [Native build targets](docs/platforms.md)
- [Development and checks](docs/development.md)
- [Changelog](CHANGELOG.md)
- [Benchmarks](bench/README.md)

## Acknowledgements

Thanks to the [SerialPort](https://serialport.io/) maintainers and contributors. Its API and testing approach helped shape this project.

## License

Copyright 2026 DragonWork. [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [third-party licenses](THIRD_PARTY_LICENSES.md).
