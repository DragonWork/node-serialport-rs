// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

/// <reference types="node" />

import {Duplex, Transform, type TransformOptions} from 'node:stream';

export interface BindingOpenOptions {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: string;
  lock?: boolean;
  rtscts?: boolean;
  xon?: boolean;
  xoff?: boolean;
  xany?: boolean;
  hupcl?: boolean;
}

export interface PortInfo {
  path: string;
  manufacturer: string | undefined;
  serialNumber: string | undefined;
  vendorId: string | undefined;
  productId: string | undefined;
  pnpId: string | undefined;
  locationId: string | undefined;
}

export interface PortStatus {cts: boolean; dsr: boolean; dcd: boolean;}
export interface SetOptions {dtr?: boolean; rts?: boolean; brk?: boolean; cts?: boolean; dsr?: boolean;}
export interface UpdateOptions {baudRate: number;}
export type ErrorCallback = (error: Error | null) => void;
export type ModemBitsCallback = (error: Error | null, status?: PortStatus) => void;

export interface BindingPortInterface {
  readonly openOptions: Required<BindingOpenOptions>;
  isOpen: boolean;
  close(): Promise<void>;
  read(buffer: Buffer, offset: number, length: number): Promise<{buffer: Buffer; bytesRead: number}>;
  write(buffer: Buffer): Promise<void>;
  update(options: UpdateOptions): Promise<void>;
  set(options: SetOptions): Promise<void>;
  get(): Promise<PortStatus>;
  getBaudRate(): Promise<{baudRate: number}>;
  flush(): Promise<void>;
  drain(): Promise<void>;
}

export interface BindingInterface<P extends BindingPortInterface = BindingPortInterface,
  O extends BindingOpenOptions = BindingOpenOptions> {
  list(): Promise<PortInfo[]>;
  open(options: O): Promise<P>;
}

export interface RustPort extends BindingPortInterface {
  readChunk(length: number): Promise<Buffer>;
  writev(buffers: Buffer[]): Promise<void>;
  onClose?: (error: Error | null) => void;
}

export const RustBinding: BindingInterface<RustPort>;
export type AutoDetectTypes = typeof RustBinding;
export function autoDetect(): AutoDetectTypes;
export type PortInterfaceFromBinding<B extends BindingInterface> = Awaited<ReturnType<B['open']>>;
export type OpenOptionsFromBinding<B extends BindingInterface> = Parameters<B['open']>[0];

export interface StreamOptions<B extends BindingInterface = AutoDetectTypes> {
  binding: B;
  autoOpen?: boolean;
  highWaterMark?: number;
  endOnClose?: boolean;
}
export type OpenOptions<B extends BindingInterface = AutoDetectTypes> = StreamOptions<B> & OpenOptionsFromBinding<B>;
export type SerialPortOpenOptions<B extends BindingInterface = AutoDetectTypes> = Omit<OpenOptions<B>, 'binding'> & {binding?: B};

export class DisconnectedError extends Error {disconnected: true;}
export class SerialPortStream<B extends BindingInterface = AutoDetectTypes> extends Duplex {
  constructor(options: OpenOptions<B>, callback?: ErrorCallback);
  readonly path: string;
  readonly baudRate: number;
  readonly isOpen: boolean;
  readonly settings: Required<StreamOptions<B>> & OpenOptionsFromBinding<B>;
  port?: PortInterfaceFromBinding<B>;
  opening: boolean;
  closing: boolean;
  open(callback?: ErrorCallback): void;
  close(callback?: ErrorCallback, disconnectError?: Error | null): void;
  update(options: UpdateOptions, callback?: ErrorCallback): void;
  set(options: SetOptions, callback?: ErrorCallback): void;
  get(callback: ModemBitsCallback): void;
  flush(callback?: ErrorCallback): void;
  drain(callback?: ErrorCallback): void;
}
export class SerialPort<B extends BindingInterface = AutoDetectTypes> extends SerialPortStream<B> {
  constructor(options: SerialPortOpenOptions<B>, callback?: ErrorCallback);
  static binding: AutoDetectTypes;
  static list(): Promise<PortInfo[]>;
}

export interface CreatePortOptions {
  echo?: boolean;
  record?: boolean;
  readyData?: Buffer | string;
  maxReadSize?: number;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
}

export interface MockPortBinding extends BindingPortInterface {
  lastWrite: Buffer | null;
  recording: Buffer;
  writeOperation: Promise<void> | null;
  serialNumber?: string;
  emitData(data: Buffer | string): void;
  readonly port: {
    data: Buffer;
    echo: boolean;
    record: boolean;
    info: PortInfo;
    maxReadSize: number;
    readyData?: Buffer;
    openOpt?: BindingOpenOptions;
  };
}

export interface MockBindingInterface extends BindingInterface<MockPortBinding> {
  reset(): void;
  createPort(path: string, options?: CreatePortOptions): void;
}

export type SerialPortMockOpenOptions = Omit<OpenOptions<MockBindingInterface>, 'binding'> & {binding?: MockBindingInterface};
export class SerialPortMock extends SerialPortStream<MockBindingInterface> {
  constructor(options: SerialPortMockOpenOptions, callback?: ErrorCallback);
  static binding: MockBindingInterface;
  static list(): Promise<PortInfo[]>;
}

export interface ByteLengthOptions extends TransformOptions {length: number;}
export class ByteLengthParser extends Transform {constructor(options: ByteLengthOptions);}
export interface DelimiterOptions extends TransformOptions {
  delimiter: string | Buffer | number[];
  includeDelimiter?: boolean;
  /** Maximum payload bytes per frame, excluding the delimiter. Unlimited when omitted. */
  maxFrameLength?: number;
}
export class DelimiterParser extends Transform {constructor(options: DelimiterOptions);}
export interface ReadlineOptions extends TransformOptions {
  delimiter?: string | Buffer | number[];
  includeDelimiter?: boolean;
  /** Maximum payload bytes before decoding, excluding the delimiter. Unlimited when omitted. */
  maxFrameLength?: number;
  encoding?: BufferEncoding;
}
export class ReadlineParser extends DelimiterParser {constructor(options?: ReadlineOptions);}
export interface ReadyParserOptions extends TransformOptions {delimiter: string | Buffer | number[];}
export class ReadyParser extends Transform {constructor(options: ReadyParserOptions); readonly ready: boolean;}
export interface RegexParserOptions extends TransformOptions {regex: string | RegExp; encoding?: BufferEncoding;}
export class RegexParser extends Transform {constructor(options: RegexParserOptions);}
export interface InterByteTimeoutOptions extends TransformOptions {interval: number; maxBufferSize?: number;}
export class InterByteTimeoutParser extends Transform {
  constructor(options: InterByteTimeoutOptions);
  emitPacket(): void;
}
export class CCTalkParser extends Transform {constructor(maxDelayBetweenBytesMs?: number);}
export interface PacketLengthOptions extends TransformOptions {
  delimiter?: number | number[];
  delimiterBytes?: number;
  packetOverhead?: number;
  lengthBytes?: number;
  lengthOffset?: number;
  maxLen?: number;
}
export class PacketLengthParser extends Transform {constructor(options?: PacketLengthOptions);}
export interface SlipDecoderOptions extends TransformOptions {
  START?: number;
  END?: number;
  ESC?: number;
  ESC_START?: number;
  ESC_END?: number;
  ESC_ESC?: number;
}
export interface SlipEncoderOptions extends SlipDecoderOptions {bluetoothQuirk?: boolean;}
export class SlipEncoder extends Transform {constructor(options?: SlipEncoderOptions);}
export class SlipDecoder extends Transform {constructor(options?: SlipDecoderOptions);}
export interface SpacePacketHeader {
  versionNumber: 1 | 'UNKNOWN_VERSION';
  identification: {apid: number; secondaryHeader: number; type: number};
  sequenceControl: {packetName: number; sequenceFlags: number};
  dataLength: number;
}
export interface SpacePacket {
  header: SpacePacketHeader;
  secondaryHeader?: {timeCode?: string; ancillaryData?: string};
  data: string;
}
export interface SpacePacketOptions extends Omit<TransformOptions, 'objectMode'> {
  timeCodeFieldLength?: number;
  ancillaryDataFieldLength?: number;
}
export class SpacePacketParser extends Transform {constructor(options?: SpacePacketOptions);}
