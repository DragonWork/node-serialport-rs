// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {SerialPortStream} = require('./stream');
const {validateOptions} = require('./binding');
const {ByteQueue, integer} = require('./parsers/bytes');

const devices = new Map();
let sequence = 0;
const nextTick = () => new Promise(resolve => process.nextTick(resolve));
const canceled = () => Object.assign(new Error('Port is closed'), {canceled: true});

class VirtualDevice {
  #bytes = new ByteQueue();
  #sessions = new Set();

  constructor(path, options) {
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
  set data(value) { this.#bytes.clear(); this.feed(value); }

  open(options) {
    if ([...this.#sessions].some(port => port.openOptions.lock) || (options.lock && this.#sessions.size)) {
      throw new Error('Port is locked');
    }
    const port = new MockPortBinding(this, options);
    this.#sessions.add(port);
    this.openOpt = {...options};
    return port;
  }

  close(port) {
    this.#sessions.delete(port);
    if (!this.#sessions.size) { this.#bytes.clear(); this.openOpt = undefined; }
  }

  feed(data) {
    this.#bytes.append(Buffer.from(data));
    for (const port of this.#sessions) port._wake();
  }

  read(buffer, offset, length) {
    const count = Math.min(length, this.maxReadSize, this.#bytes.length);
    if (!count) return 0;
    const copied = this.#bytes.peek(count).copy(buffer, offset);
    this.#bytes.discard(copied);
    return copied;
  }

  flush() { this.#bytes.clear(); }
}

class MockPortBinding {
  #pending;
  #scheduled = false;
  #recorded = [];
  #recordedSize = 0;

  constructor(device, options) {
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
  set recording(data) {
    const snapshot = Buffer.from(data);
    this.#recorded = snapshot.length ? [snapshot] : [];
    this.#recordedSize = snapshot.length;
  }

  #check() { if (!this.isOpen) throw canceled(); }

  emitData(data) { this.#check(); this.port.feed(data); }

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

  async read(buffer, offset, length) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > buffer.length) {
      throw new RangeError('Invalid read range');
    }
    this.#check();
    if (this.#pending) throw new Error('Read already pending');
    return new Promise((resolve, reject) => {
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

  async write(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    this.#check();
    if (this.writeOperation) throw new Error('Write already pending');
    const snapshot = Buffer.from(buffer);
    this.writeOperation = this.#write(snapshot);
    try { await this.writeOperation; }
    finally { this.writeOperation = null; }
  }

  async #write(data) {
    await nextTick();
    this.#check();
    this.lastWrite = Buffer.from(data);
    if (this.port.record) { this.#recorded.push(data); this.#recordedSize += data.length; }
    if (this.port.echo) process.nextTick(() => { if (this.isOpen) this.emitData(data); });
  }

  async update(options) {
    const {baudRate} = validateOptions({...this.openOptions, baudRate: options?.baudRate});
    this.#check();
    await nextTick();
    this.#check();
    this.port.openOpt.baudRate = baudRate;
  }

  async set(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    for (const name of ['dtr', 'rts', 'brk', 'cts', 'dsr']) {
      if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`Invalid ${name}`);
    }
    this.#check();
    await nextTick();
    this.#check();
  }

  async get() { this.#check(); await nextTick(); this.#check(); return {cts: true, dsr: false, dcd: false}; }
  async getBaudRate() { this.#check(); await nextTick(); this.#check(); return {baudRate: this.port.openOpt.baudRate}; }
  async flush() { this.#check(); await nextTick(); this.#check(); this.port.flush(); }
  async drain() { this.#check(); await this.writeOperation; await nextTick(); this.#check(); }
}

const MockBinding = {
  reset() { devices.clear(); sequence = 0; },
  createPort(path, options = {}) {
    if (typeof path !== 'string' || !path || path.includes('\0')) throw new TypeError('Invalid mock port path');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    devices.set(path, new VirtualDevice(path, options));
  },
  async list() { return [...devices.values()].map(device => ({...device.info})); },
  async open(options) {
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
  constructor(options, callback) { super({...options, binding: options?.binding || MockBinding}, callback); }
}

module.exports = {SerialPortMock};
