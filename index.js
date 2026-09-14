// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {SerialPort, SerialPortStream, DisconnectedError} = require('./lib/stream');
const {RustBinding, autoDetect} = require('./lib/binding');

exports.SerialPort = SerialPort;
exports.SerialPortMock = require('./lib/mock').SerialPortMock;
exports.SerialPortStream = SerialPortStream;
exports.DisconnectedError = DisconnectedError;
exports.RustBinding = RustBinding;
exports.autoDetect = autoDetect;
exports.ByteLengthParser = require('./lib/parsers/byte-length').ByteLengthParser;
exports.CCTalkParser = require('./lib/parsers/cctalk').CCTalkParser;
exports.DelimiterParser = require('./lib/parsers/delimiter').DelimiterParser;
exports.InterByteTimeoutParser = require('./lib/parsers/inter-byte-timeout').InterByteTimeoutParser;
exports.PacketLengthParser = require('./lib/parsers/packet-length').PacketLengthParser;
exports.ReadlineParser = require('./lib/parsers/readline').ReadlineParser;
exports.ReadyParser = require('./lib/parsers/ready').ReadyParser;
exports.RegexParser = require('./lib/parsers/regex').RegexParser;
exports.SlipEncoder = require('./lib/parsers/slip').SlipEncoder;
exports.SlipDecoder = require('./lib/parsers/slip').SlipDecoder;
exports.SpacePacketParser = require('./lib/parsers/spacepacket').SpacePacketParser;
