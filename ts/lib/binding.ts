// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { types } from 'node:util';
import { validateOptions, validateBaudRate, validateSetOptions } from './options';
import type {
  BindingOpenOptions,
  BindingsErrorOptions,
  SerialPortErrorCode,
  SetOptions,
  UpdateOptions,
} from '../public-api';
import type { NativeAddon, NativeHandle, NativeEvent, ControlOperation } from './native';
const { isSharedArrayBuffer } = types;
let native: NativeAddon | undefined;
const loadNative = (): NativeAddon => (native ??= (require('./native') as typeof import('./native')).loadNative());
const CHUNK_SIZE = 64 * 1024;
const READ_SLOTS = 32;
const RESOLVED = Promise.resolve();
const localStores = new WeakSet();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getBackingStore = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')!.get!;

class BindingsError extends Error {
  canceled: boolean;
  code?: SerialPortErrorCode;
  errno?: number;
  path?: string;

  constructor(message: string, options: BindingsErrorOptions = {}) {
    super(message, options);
    this.canceled = options.canceled ?? false;
    this.code = options.code;
    this.errno = options.errno;
    this.path = options.path;
  }
}

function canceled(message = 'Port is closed') {
  return new BindingsError(message, { canceled: true });
}

function localBuffer(buffer: Buffer): Buffer {
  // Other JS threads may mutate shared memory while Rust borrows it.
  const store = getBackingStore.call(buffer);
  if (!localStores.has(store)) {
    if (isSharedArrayBuffer(store)) return Buffer.from(buffer);
    localStores.add(store);
  }
  return buffer;
}

interface Pending {
  resolve: (result?: NativeEvent) => void;
  reject: (error: unknown) => void;
  ordered: boolean;
}

class BindingPort {
  declare openOptions: Readonly<Required<BindingOpenOptions>>;
  declare isOpen: boolean;
  declare onClose?: (error: Error | null) => void;
  declare onData?: (data: Buffer) => void;
  declare _pending: Map<number, Pending>;
  declare _ordered: number;
  declare _nextId: number;
  declare _reading: boolean;
  declare _streaming: boolean;
  declare _readBytes: number;
  declare _readSlots: number;
  declare _writing: boolean;
  declare _closing: boolean;
  declare _finished: boolean;
  declare _failure: Error | null;
  declare _closed: Promise<void>;
  declare _resolveClosed: () => void;
  declare opened: Promise<BindingPort> & { cancel?: () => void };
  declare _resolveOpen: (port: BindingPort) => void;
  declare _rejectOpen: (error: Error) => void;
  declare _native: NativeHandle | null;
  declare _writePromise?: Promise<NativeEvent | void>;

  constructor(options: BindingOpenOptions) {
    this.openOptions = Object.freeze(validateOptions(options));
    this.isOpen = false;
    this.onClose = undefined;
    this.onData = undefined;
    this._pending = new Map();
    this._ordered = 0;
    this._nextId = 1;
    this._reading = false;
    this._streaming = false;
    this._readBytes = 0;
    this._readSlots = 0;
    this._writing = false;
    this._closing = false;
    this._finished = false;
    this._failure = null;
    this._closed = new Promise(resolve => {
      this._resolveClosed = resolve;
    });
    this.opened = new Promise<BindingPort>((resolve, reject) => {
      this._resolveOpen = resolve;
      this._rejectOpen = reject;
    });
    const { NativePort } = loadNative();
    // Keep native read callbacks in one FIFO, including data retained after a
    // listener throws. Reuse one microtask callback for singles and batches.
    let pendingRead: Buffer | Buffer[] | undefined;
    let queuedReads: (Buffer | Buffer[])[] | undefined;
    const retainRead = (events: Buffer[], offset: number): void => {
      if (pendingRead !== undefined) (queuedReads ??= []).unshift(pendingRead);
      pendingRead = events.slice(offset);
      // An already scheduled callback may now be responsible for this head
      // item, so add one callback to keep every queued read covered.
      queueMicrotask(deliverRead);
    };
    const deliverRead = (): void => {
      const event = pendingRead;
      pendingRead = queuedReads?.shift();
      if (queuedReads?.length === 0) queuedReads = undefined;
      if (event === undefined) return;
      if (!Array.isArray(event)) {
        if (this.isOpen) {
          this._readBytes -= event.length;
          this._readSlots--;
          this.onData?.(event);
        }
      } else {
        this._deliverBatch(event, 0, retainRead);
      }
    };
    this._native = new NativePort(
      this.openOptions,
      (error, event) => {
        if (error) {
          this._failure = error;
          this._native?.close();
        } else if (Buffer.isBuffer(event) || Array.isArray(event)) {
          if (pendingRead === undefined) pendingRead = event;
          else (queuedReads ??= []).push(event);
          // Retain one microtask per native callback, including the first-buffer
          // continuation boundary, while reusing the dispatch callback.
          queueMicrotask(deliverRead);
        } else this._event(event);
      },
      Buffer.allocUnsafe,
    );
  }

  _deliverBatch(events: Buffer[], offset = 0, retain?: (events: Buffer[], offset: number) => void) {
    let index = offset;
    try {
      while (index < events.length && this.isOpen) {
        const data = events[index++];
        this._readBytes -= data.length;
        this._readSlots--;
        this.onData?.(data);
      }
    } finally {
      // An application that handles an uncaught listener exception must not lose
      // the remaining native buffers or their credits. The native callback uses
      // retain to put them ahead of later reads; direct callers keep the fallback.
      if (index < events.length && this.isOpen) {
        if (retain) retain(events, index);
        else queueMicrotask(() => this._deliverBatch(events, index));
      }
    }
  }

  _event(event: NativeEvent) {
    if (event.kind === 'open') {
      if (!this._closing) {
        this.isOpen = true;
        this._resolveOpen(this);
      }
      return;
    }
    if (event.kind === 'close') {
      this._finishClose(this._failure || (event.message ? this._nativeError(event) : null));
      return;
    }
    this._settle(event.id, event.kind === 'error' ? this._nativeError(event) : null, event);
  }

  _nativeError(event: NativeEvent) {
    return new BindingsError(event.message || 'Serial operation failed', {
      code: event.code ?? undefined,
      errno: event.errno ?? undefined,
      path: this.openOptions.path,
    });
  }

  _settle(id: number, error: unknown, result?: NativeEvent) {
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    if (pending.ordered) this._ordered--;
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  _finishClose(error: Error | null) {
    if (this._finished) return;
    this._finished = true;
    const wasOpen = this.isOpen;
    const intentional = this._closing;
    // Streams acknowledge I/O failures through close(); isOpen must allow that call.
    // Rust has already released the descriptor, even if the consumer never closes.
    if (!wasOpen || intentional) this._native = null;
    const reason: Error & { disconnected?: boolean } = intentional ? canceled() : error || canceled();
    if (!intentional && wasOpen) reason.disconnected = true;
    this._rejectOpen(reason);
    for (const pending of this._pending.values()) pending.reject(reason);
    this._pending.clear();
    this._ordered = 0;
    this._resolveClosed();
    this.onClose?.(intentional ? null : reason);
  }

  _request(
    op: ControlOperation | 'read' | 'write' | 'writev',
    value = 0,
    data?: Buffer | Buffer[],
  ): Promise<NativeEvent | void> {
    if (!this.isOpen || this._closing) return Promise.reject(canceled());
    if (this._pending.size >= 64) return Promise.reject(new Error('Too many pending serial operations'));
    const id = this._id();
    const ordered = op !== 'read';
    if (ordered) this._ordered++;
    try {
      let completed = false;
      if (op === 'read') this._native!.read(id, value);
      else if (op === 'write') completed = this._native!.write(id, localBuffer(data as Buffer), this._ordered === 1);
      else if (op === 'writev') {
        const buffers = data as Buffer[];
        for (let i = 0; i < buffers.length; i++) buffers[i] = localBuffer(buffers[i]);
        completed = this._native!.writev(id, buffers, value, this._ordered === 1);
      } else this._native!.request(id, op, value);
      if (completed) {
        this._ordered--;
        return RESOLVED;
      }
    } catch (error) {
      if (ordered) this._ordered--;
      return Promise.reject(error);
    }
    // Native completions cannot run until this JS call yields. Only queued
    // operations need a pending record and a separately allocated Promise.
    return new Promise<NativeEvent | void>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, ordered });
    });
  }

  _id() {
    let id;
    do {
      id = this._nextId;
      this._nextId = id === 0xffffffff ? 1 : id + 1;
    } while (this._pending.has(id));
    return id;
  }

  cancelOpen() {
    this._closing = true;
    this._native?.close();
  }

  async close() {
    if (!this.isOpen || this._closing) throw new Error('Port is not open');
    this._closing = true;
    this.isOpen = false;
    this._native!.close();
    await this._closed;
    this._native = null;
  }

  async readChunk(length: number): Promise<Buffer> {
    if (!Number.isInteger(length) || length < 1) throw new TypeError('Invalid read length');
    if (this._reading || this._streaming) throw new Error('Read already pending');
    this._reading = true;
    try {
      return (await this._request('read', Math.min(length, CHUNK_SIZE)))!.data!;
    } finally {
      this._reading = false;
    }
  }

  startReading(length: number) {
    if (!this.isOpen || this._closing) throw canceled();
    if (this._reading) throw new Error('Read already pending');
    const window = Math.max(1, Math.min(length, CHUNK_SIZE));
    this._streaming = true;
    if (this._readBytes <= window / 2 || this._readSlots <= READ_SLOTS / 2) {
      const bytes = window - this._readBytes;
      const slots = READ_SLOTS - this._readSlots;
      if (bytes > 0 && slots > 0) {
        this._native!.readCredit(bytes, slots);
        this._readBytes += bytes;
        this._readSlots += slots;
      }
    }
  }

  async read(buffer: Buffer, offset: number, length: number) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > buffer.length
    )
      throw new RangeError('Invalid read range');
    const data = await this.readChunk(length);
    if (offset + length > buffer.length) throw new RangeError('Read buffer changed size');
    return { buffer, bytesRead: data.copy(buffer, offset) };
  }

  async write(buffer: Buffer): Promise<void> {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
    if (buffer.length > CHUNK_SIZE) return this.writev([buffer]);
    if (!this.isOpen || this._closing) throw canceled();
    if (this._writing) throw new Error('Write already pending');
    this._writing = true;
    try {
      this._writePromise = RESOLVED;
      if (buffer.length) {
        if (this._pending.size >= 64) throw new Error('Too many pending serial operations');
        const id = this._id();
        this._ordered++;
        let completed;
        try {
          completed = this._native!.write(id, localBuffer(buffer), this._ordered === 1);
        } catch (error) {
          this._ordered--;
          throw error;
        }
        if (completed) this._ordered--;
        // Native completions cannot run until this JS call yields.
        else
          this._writePromise = new Promise<NativeEvent | void>((resolve, reject) => {
            this._pending.set(id, { resolve, reject, ordered: true });
          });
      }
      await this._writePromise;
    } finally {
      this._writing = false;
    }
  }

  async writev(buffers: readonly Buffer[]): Promise<void> {
    if (!Array.isArray(buffers) || !buffers.every(Buffer.isBuffer)) throw new TypeError('Expected an array of Buffers');
    if (!this.isOpen || this._closing) throw canceled();
    if (this._writing) throw new Error('Write already pending');
    this._writing = true;
    this._writePromise = (async () => {
      let batch: Buffer[] = [];
      let size = 0;
      for (const buffer of buffers) {
        for (let offset = 0; offset < buffer.length;) {
          const count = Math.min(buffer.length - offset, CHUNK_SIZE - size);
          // N-API sees the intrinsic view length, even if JavaScript shadows .length.
          batch.push(
            offset === 0 && count === getLength.call(buffer) ? buffer : buffer.subarray(offset, offset + count),
          );
          offset += count;
          size += count;
          if (size === CHUNK_SIZE || batch.length === 1024) {
            await this._request(batch.length === 1 ? 'write' : 'writev', size, batch.length === 1 ? batch[0] : batch);
            batch = [];
            size = 0;
          }
        }
      }
      if (size)
        await this._request(batch.length === 1 ? 'write' : 'writev', size, batch.length === 1 ? batch[0] : batch);
    })();
    try {
      await this._writePromise;
    } finally {
      this._writing = false;
    }
  }

  async update(options: UpdateOptions) {
    const baudRate = validateBaudRate(options?.baudRate);
    await this._request('update', baudRate);
  }

  async set(options: SetOptions = {}) {
    const flags = { dtr: true, rts: true, brk: false, ...validateSetOptions(options) };
    await this._request('set', Number(flags.dtr) | (Number(flags.rts) << 1) | (Number(flags.brk) << 2));
  }

  async get() {
    const { cts, dsr, dcd } = (await this._request('get'))!;
    return { cts: cts!, dsr: dsr!, dcd: dcd! };
  }
  async getBaudRate() {
    return { baudRate: (await this._request('getBaudRate'))!.baudRate! };
  }
  async flush() {
    await this._request('flush');
  }
  async drain() {
    await this._writePromise;
    await this._request('drain');
  }
}

const RustBinding = {
  async list() {
    return (await loadNative().listPorts()).map(port => ({
      path: port.path,
      manufacturer: port.manufacturer ?? undefined,
      serialNumber: port.serialNumber ?? undefined,
      vendorId: port.vendorId ?? undefined,
      productId: port.productId ?? undefined,
      pnpId: port.pnpId ?? undefined,
      locationId: port.locationId ?? undefined,
      friendlyName: port.friendlyName ?? undefined,
    }));
  },
  open(options: BindingOpenOptions) {
    try {
      const port = new BindingPort(options);
      port.opened.cancel = () => port.cancelOpen();
      return port.opened;
    } catch (error) {
      return Promise.reject(error);
    }
  },
};

export const autoDetect = () => RustBinding;
export { RustBinding, BindingPort, BindingsError };
