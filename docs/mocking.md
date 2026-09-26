<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mock ports

`SerialPortMock` uses the same JavaScript stream implementation without loading the native addon or opening hardware.

```js
import { once } from 'node:events';
import { MockBinding, SerialPortMock } from 'serialport-rs';

MockBinding.createPort('/mock/device', { echo: true, record: true });
const port = new SerialPortMock({ path: '/mock/device', baudRate: 115200 });
await once(port, 'open');

const reply = once(port, 'data');
port.write('hello');
console.log((await reply)[0].toString()); // hello
console.log(port.port.recording.toString()); // hello

await new Promise((resolve, reject) => port.close(error => (error ? reject(error) : resolve())));
MockBinding.reset();
```

Mock devices support `echo`, `record`, `readyData`, `maxReadSize`, and discovery metadata. An opened mock binding exposes `emitData()`, `lastWrite`, and `recording`. Pass `binding: MockBinding` to `SerialPortStream` or `SerialPort` to use the mock through a custom wrapper. `SerialPortMock.binding` still refers to the same default binding and device registry.

`MockBinding.open(options)` returns a `MockPortBinding`, also exported for type annotations and `instanceof` checks. Open instances through the binding or stream API; the mock port's device constructor is internal. Operations canceled by a mock port closing reject with the exported `CanceledError` class, which has `canceled: true`.

Close active mock connections before resetting the device registry. The mock exercises byte transport and lifecycle behavior; it does not simulate real baud timing, electrical modem signals, or every driver failure.
