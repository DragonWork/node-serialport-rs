<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# node-serialport-rs

Rust-backed serial ports for Node.js, with a SerialPort 13-compatible API.

- Parallel I/O through a dedicated, bounded Rust worker pool.
- Lower p95 and p99 latency in recorded Linux x64 and ARM64 PTY comparisons. [Measurements](bench/README.md).
- Streams, parsers, bindings, and a pure-JavaScript mock in one package.
- No JavaScript runtime dependencies.
- Bounded read-ahead and explicit ownership of queued buffers.

One active port starts one I/O worker. More ports share up to four workers, which retire after their last port closes. Original SerialPort also uses native threads; this implementation separates serial I/O from Node's shared libuv worker pool.

## Install

Requires Node.js 20 or newer. Get the [latest npm release](https://www.npmjs.com/package/serialport-rs):

```sh
npm install serialport-rs
```

## Quick start

```js
import {SerialPort, ReadlineParser} from 'serialport-rs';

const port = new SerialPort({path: '/dev/ttyUSB0', baudRate: 115200});
const lines = port.pipe(new ReadlineParser({delimiter: '\r\n'}));

port.on('error', error => console.error(error.message));
lines.on('data', line => console.log(line));
port.on('open', () => {
  port.write('status\r\n', error => {
    if (error) console.error(error.message);
  });
});
```

CommonJS works too: `const {SerialPort} = require('serialport-rs')`.

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
