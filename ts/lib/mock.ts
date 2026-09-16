// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import {SerialPortStream, type PortSettings} from './stream';
import {validateOptions} from './binding';
import {ByteQueue, integer} from './parsers/bytes';
import type {BindingOpenOptions, CreatePortOptions, ErrorCallback, PortInfo, SetOptions, UpdateOptions} from '../public-api';

const devices = new Map<string, VirtualDevice>();
let sequence = 0;
const nextTick = () => new Promise<void>(resolve => process.nextTick(resolve));
const canceled = () => Object.assign(new Error('Port is closed'), {canceled: true});

class VirtualDevice {
  #bytes = new ByteQueue();
  #sessions = new Set<MockPortBinding>();
  declare echo: boolean;
  declare record: boolean;
  declare maxReadSize: number;
  declare readyData?: Buffer;
  declare info: PortInfo;
  declare openOpt?: Required<BindingOpenOptions>;

  constructor(path: string, options: CreatePortOptions) {
    this.echo = options.echo ?? false;
    this.record = options.record ?? false;
    if (typeof this.echo !== 'boolean' || typeof this.record !== 'boolean') throw new TypeError('Invalid mock port flags');
    this.maxReadSize = integer(options.maxReadSize ?? 1024, 'maxReadSize');
    this.readyData = options.readyData === undefined ? undefined : Buffer.from(options.readyData);
    this.info = {path, manufacturer: options.manufacturer ?? 'The J5 Robotics Company',
      serialNumber: String(++sequence), pnpId: undefined, locationId: undefined,
      vendorId: options.vendorId, productId: options.productId};
    this.openOpt = undefined;
  }

  get data() { return this.#bytes.peek(this.#bytes.length); }
  set data(value: Buffer) { this.#bytes.clear(); this.feed(value); }

  open(options: Required<BindingOpenOptions>) {
    if ([...this.#sessions].some(port => port.openOptions.lock) || (options.lock && this.#sessions.size)) {
      throw new Error('Port is locked');
    }
    const port = new MockPortBinding(this, options);
    this.#sessions.add(port);
    this.openOpt = {...options};
    return port;
  }

  close(port: MockPortBinding) {
    this.#sessions.delete(port);
    if (!this.#sessions.size) { this.#bytes.clear(); this.openOpt = undefined; }
  }

  feed(data: Buffer | string) {
    this.#bytes.append(Buffer.from(data));
    for (const port of this.#sessions) port._wake();
  }

  read(buffer: Buffer, offset: number, length: number) {
    const count = Math.min(length, this.maxReadSize, this.#bytes.length);
    if (!count) return 0;
    const copied = this.#bytes.peek(count).copy(buffer, offset);
    this.#bytes.discard(copied);
    return copied;
  }

  flush() { this.#bytes.clear(); }
}

class MockPortBinding {
  #pending?: {buffer: Buffer; offset: number; length: number;
    resolve: (result: {buffer: Buffer; bytesRead: number}) => void; reject: (error: unknown) => void};
  #scheduled = false;
  #recorded: Buffer[] = [];
  #recordedSize = 0;
  declare port: VirtualDevice;
  declare openOptions: Readonly<Required<BindingOpenOptions>>;
  declare isOpen: boolean;
  declare lastWrite: Buffer | null;
  declare writeOperation: Promise<void> | null;
  declare serialNumber?: string;

  constructor(device: VirtualDevice, options: Required<BindingOpenOptions>) {
    this.port = device;
    this.openOptions = Object.freeze({...options});
    this.isOpen = true;
    this.lastWrite = null;
    this.writeOperation = null;
    this.serialNumber = device.info.serialNumber;
    const ready = device.readyData;
    if (ready) process.nextTick(() => { if (this.isOpen) this.emitData(ready); });
  }

  get recording() { return Buffer.concat(this.#recorded, this.#recordedSize); }
  set recording(data: Buffer) {
    const snapshot = Buffer.from(data);
    this.#recorded = snapshot.length ? [snapshot] : [];
    this.#recordedSize = snapshot.length;
  }

  #check() { if (!this.isOpen) throw canceled(); }

  emitData(data: Buffer | string) { this.#check(); this.port.feed(data); }

  _wake() {
    if (!this.#pending || this.#scheduled) return;
    this.#scheduled = true;
    process.nextTick(() => {
      this.#scheduled = false;
      const request = this.#pending;
      if (!request) return;
      try {
        if (request.offset + request.length > request.buffer.length) throw new RangeError('Read buffer changed size');
        const bytesRead = this.port.read(request.buffer, request.offset, request.length);
        if (!bytesRead) return;
        this.#pending = undefined;
        request.resolve({buffer: request.buffer, bytesRead});
      } catch (error) { this.#pending = undefined; request.reject(error); }
    });
  }

  async read(buffer: Buffer, offset: number, length: number) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > buffer.length) {
      throw new RangeError('Invalid read range');
    }
    this.#check();
    if (this.#pending) throw new Error('Read already pending');
    return new Promise<{buffer: Buffer; bytesRead: number}>((resolve, reject) => {
      this.#pending = {buffer, offset, length, resolve, reject};
      this._wake();
    });
  }

  async close() {
    this.#check();
    this.isOpen = false;
    this.serialNumber = undefined;
    this.port.close(this);
    const request = this.#pending;
    this.#pending = undefined;
    request?.reject(canceled());
  }

  async write(buffer: Buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    this.#check();
    if (this.writeOperation) throw new Error('Write already pending');
    const snapshot = Buffer.from(buffer);
    this.writeOperation = this.#write(snapshot);
    try { await this.writeOperation; }
    finally { this.writeOperation = null; }
  }

  async #write(data: Buffer) {
    await nextTick();
    this.#check();
    this.lastWrite = Buffer.from(data);
    if (this.port.record) { this.#recorded.push(data); this.#recordedSize += data.length; }
    if (this.port.echo) process.nextTick(() => { if (this.isOpen) this.emitData(data); });
  }

  async update(options: UpdateOptions) {
    const {baudRate} = validateOptions({...this.openOptions, baudRate: options?.baudRate});
    this.#check();
    await nextTick();
    this.#check();
    this.port.openOpt!.baudRate = baudRate;
  }

  async set(options: SetOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    for (const name of ['dtr', 'rts', 'brk', 'cts', 'dsr'] as const) {
      if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`Invalid ${name}`);
    }
    this.#check();
    await nextTick();
    this.#check();
  }

  async get() { this.#check(); await nextTick(); this.#check(); return {cts: true, dsr: false, dcd: false}; }
  async getBaudRate() { this.#check(); await nextTick(); this.#check(); return {baudRate: this.port.openOpt!.baudRate}; }
  async flush() { this.#check(); await nextTick(); this.#check(); this.port.flush(); }
  async drain() { this.#check(); await this.writeOperation; await nextTick(); this.#check(); }
}

const MockBinding = {
  reset() { devices.clear(); sequence = 0; },
  createPort(path: string, options: CreatePortOptions = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('Invalid mock port path');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    devices.set(path, new VirtualDevice(path, options));
  },
  async list() { return [...devices.values()].map(device => ({...device.info})); },
  async open(options: BindingOpenOptions) {
    if (Array.isArray(options)) throw new TypeError('options must be an object');
    const settings = validateOptions(options);
    const device = devices.get(settings.path);
    await nextTick();
    if (!device) throw new Error('Mock port does not exist');
    return device.open(settings);
  },
};

class SerialPortMock extends SerialPortStream {
  static binding = MockBinding;
  static list = MockBinding.list;
  constructor(options: PortSettings, callback?: ErrorCallback) { super({...options, binding: options?.binding || MockBinding}, callback); }
}

export {SerialPortMock};
