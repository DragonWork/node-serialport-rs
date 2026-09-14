<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mock ports

`SerialPortMock` uses the same JavaScript stream implementation without loading the native addon or opening hardware.

```js
import {once} from 'node:events';
import {SerialPortMock} from '@dragonwork/node-serialport-rs';

SerialPortMock.binding.createPort('/mock/device', {echo: true, record: true});
const port = new SerialPortMock({path: '/mock/device', baudRate: 115200});
await once(port, 'open');

const reply = once(port, 'data');
port.write('hello');
console.log((await reply)[0].toString()); // hello
console.log(port.port.recording.toString()); // hello

await new Promise((resolve, reject) => port.close(error => error ? reject(error) : resolve()));
SerialPortMock.binding.reset();
```

Mock devices support `echo`, `record`, `readyData`, `maxReadSize`, and discovery metadata. An opened mock binding exposes `emitData()`, `lastWrite`, and `recording`. Pass `binding: SerialPortMock.binding` to `SerialPortStream` or `SerialPort` to use the mock through a custom wrapper.

Close active mock connections before resetting the device registry. The mock exercises byte transport and lifecycle behavior; it does not simulate real baud timing, electrical modem signals, or every driver failure.
