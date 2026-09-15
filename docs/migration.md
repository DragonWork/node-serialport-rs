<!-- Copyright 2026 DragonWork -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Moving from SerialPort

Install the package, then change the import:

```diff
- import {SerialPort} from 'serialport';
+ import {SerialPort} from 'serialport-rs';
```

Keep your port options, event handlers, and read/write code. Parsers come from the same package:

```js
import {SerialPort, ReadlineParser} from 'serialport-rs';
```

For tests, replace a separate mock-binding import with:

```js
import {SerialPortMock} from 'serialport-rs';
const MockBinding = SerialPortMock.binding;
```

Once no imports use the old packages, remove those direct dependencies with your package manager. If another library imports SerialPort internally, update that library too. Changing your application's import does not replace its dependencies.
