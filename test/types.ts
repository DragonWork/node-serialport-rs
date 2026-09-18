// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

import {SerialPort, SerialPortMock, SerialPortStream, RustBinding, ReadlineParser,
  type BindingInterface, type BindingOpenOptions, type BindingPortInterface,
  type MockBindingInterface, type OpenOptionsFromBinding, type PortInterfaceFromBinding,
  type SerialPortMockOpenOptions, type SpacePacket} from '..';

const serial = new SerialPort({path: '/test', baudRate: 115200, autoOpen: false});
serial.write([0, 255]);
serial.write('text', 'utf8', error => { if (error) throw error; });
serial.pipe(new ReadlineParser());
serial.pipe(new ReadlineParser({maxFrameLength: 4096}));
serial.port?.writev([Buffer.from([1])]);

const mockOptions: SerialPortMockOpenOptions = {path: '/mock/test', baudRate: 9600, autoOpen: false};
const mock = new SerialPortMock(mockOptions);
SerialPortMock.binding.createPort(mockOptions.path, {echo: true, record: true, readyData: Buffer.from('ready')});
mock.port?.emitData('response');
const recording: Buffer | undefined = mock.port?.recording;
const mockStream: SerialPortStream<MockBindingInterface> = mock;

interface CustomOptions extends BindingOpenOptions {channel: number;}
interface CustomPort extends BindingPortInterface {channel: number;}
declare const customBinding: BindingInterface<CustomPort, CustomOptions>;
const customOptions: OpenOptionsFromBinding<typeof customBinding> = {path: '/custom', baudRate: 9600, channel: 2};
const custom = new SerialPortStream({...customOptions, binding: customBinding});
const customPort: PortInterfaceFromBinding<typeof customBinding> | undefined = custom.port;
const channel: number | undefined = customPort?.channel;

const nativeStream = new SerialPortStream({path: '/test', baudRate: 9600, binding: RustBinding, autoOpen: false});
nativeStream.port?.readChunk(64);

// @ts-expect-error A port path is required.
new SerialPort({baudRate: 9600});
// @ts-expect-error Data bits must be a supported width.
new SerialPortMock({...mockOptions, dataBits: 9});
// @ts-expect-error Custom binding options must be preserved.
new SerialPortStream({path: '/custom', baudRate: 9600, binding: customBinding});
// @ts-expect-error Mock bindings do not expose native vectored writes.
mock.port?.writev([]);

declare const packet: SpacePacket;
const length: number = packet.header.dataLength;
void [recording, mockStream, channel, length];
