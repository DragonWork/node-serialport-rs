// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

export { SerialPort, SerialPortStream, DisconnectedError } from './lib/stream';
export { RustBinding, BindingsError, autoDetect } from './lib/binding';
export { SerialPortMock, MockBinding, MockPortBinding, CanceledError } from './lib/mock';
export { ByteLengthParser } from './lib/parsers/byte-length';
export { CCTalkParser } from './lib/parsers/cctalk';
export { DelimiterParser } from './lib/parsers/delimiter';
export { InterByteTimeoutParser } from './lib/parsers/inter-byte-timeout';
export { PacketLengthParser } from './lib/parsers/packet-length';
export { ReadlineParser } from './lib/parsers/readline';
export { ReadyParser } from './lib/parsers/ready';
export { RegexParser } from './lib/parsers/regex';
export { SlipEncoder, SlipDecoder } from './lib/parsers/slip';
export { SpacePacketParser } from './lib/parsers/spacepacket';
