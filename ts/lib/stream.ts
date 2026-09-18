// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AsyncResource } from 'node:async_hooks';
import { RustBinding, validateOptions } from './binding';
import type {
  BindingInterface,
  BindingOpenOptions,
  BindingPortInterface,
  ErrorCallback,
  ModemBitsCallback,
  PortStatus,
  SetOptions,
  UpdateOptions,
} from '../public-api';

interface RuntimePort extends BindingPortInterface {
  onClose?: (error: Error | null) => void;
  onData?: (data: Buffer) => void;
  readChunk?: (length: number) => Promise<Buffer>;
  startReading?: (length: number) => void;
  writev?: (buffers: Buffer[]) => Promise<void>;
}

export type StreamSettings = BindingOpenOptions & {
  binding: BindingInterface<RuntimePort>;
  autoOpen?: boolean;
  endOnClose?: boolean;
  highWaterMark?: number;
};
export type PortSettings = Omit<StreamSettings, 'binding'> & { binding?: StreamSettings['binding'] };
type WriteCallback = (error?: Error | null) => void;
type OperationCallback = (error: Error | null, result?: PortStatus) => void;
type SerialError = Error & { canceled?: boolean };

class DisconnectedError extends Error {
  declare disconnected: true;
  constructor(message: string) {
    super(message);
    this.disconnected = true;
  }
}

class SerialPortStream extends Duplex {
  declare settings: Required<StreamSettings>;
  declare opening: boolean;
  declare closing: boolean;
  declare port?: RuntimePort;
  declare _readRequested: boolean;
  declare _readPort?: RuntimePort;
  declare _waitingWrite?: [Buffer, string, WriteCallback];
  declare _closeCallbacks: ErrorCallback[];
  declare _closeError: Error | null;
  declare _opening?: Promise<RuntimePort> & { cancel?: () => void };

  constructor(options: StreamSettings, callback?: ErrorCallback) {
    const settings = { autoOpen: true, endOnClose: false, highWaterMark: 64 * 1024, ...validateOptions(options) };
    super({ highWaterMark: settings.highWaterMark, autoDestroy: false, emitClose: false });
    if (!settings.binding) throw new TypeError('Pass a binding in options.binding');
    this.settings = settings;
    this.opening = false;
    this.closing = false;
    this.port = undefined;
    this._readRequested = false;
    this._readPort = undefined;
    this._waitingWrite = undefined;
    this._closeCallbacks = [];
    this._closeError = null;
    if (settings.autoOpen) this.open(callback);
  }

  get path() {
    return this.settings.path;
  }
  get baudRate() {
    return this.settings.baudRate;
  }
  get isOpen() {
    return Boolean(this.port?.isOpen) && !this.closing;
  }

  _report(error: Error, callback?: ErrorCallback) {
    if (callback) callback.call(this, error);
    else this.emit('error', error);
  }
  _asyncError(message: string, callback?: ErrorCallback) {
    process.nextTick(() => this._report(new Error(message), callback));
  }

  open(callback?: ErrorCallback) {
    if (this.destroyed) return this._asyncError('Port is destroyed', callback);
    if (this.isOpen) return this._asyncError('Port is already open', callback);
    if (this.opening || this.closing) return this._asyncError('Port is opening or closing', callback);
    this.opening = true;
    const { binding, autoOpen, endOnClose, highWaterMark, ...options } = this.settings;
    try {
      this._opening = binding.open(options);
    } catch (error) {
      this._opening = Promise.reject(error);
    }
    this._opening
      .then(
        async (port) => {
          this.opening = false;
          this.port = port;
          port.onClose = (error) => {
            if (this.port !== port) return;
            const reason = error && new DisconnectedError(error.message);
            if (port.isOpen) this.close(undefined, reason);
            else this._finishClose(reason);
          };
          port.onData = (data) => {
            if (this.port === port && this.isOpen) {
              this._readRequested = false;
              this.push(data);
            }
          };
          if (this.closing) {
            const error = Object.assign(new Error('Port opening canceled'), { canceled: true });
            this._failWaitingWrite(error);
            let closeError: Error | undefined;
            try {
              await port.close();
            } catch (error) {
              closeError = error as Error;
            }
            if (closeError) this._closeFailed(port, closeError);
            else if (this.port === port) this._finishClose(null);
            if (callback) callback.call(this, error);
            return;
          }
          this.emit('open');
          if (callback) callback.call(this, null);
          this._resumeIO();
        },
        (error) => {
          this.opening = false;
          this._failWaitingWrite(error);
          if (this.closing) {
            this._finishClose(null);
            if (callback) callback.call(this, error);
          } else this._report(error, callback);
        },
      )
      .catch((error) => this._report(error));
  }

  _failWaitingWrite(error: Error) {
    const waiting = this._waitingWrite;
    this._waitingWrite = undefined;
    if (waiting) waiting[2](error);
  }

  _resumeIO() {
    if (!this.isOpen) return;
    if (this._waitingWrite) {
      const waiting = this._waitingWrite;
      this._waitingWrite = undefined;
      this._write(...waiting);
    }
    if (this._readRequested) this._read(this.readableHighWaterMark);
  }

  close(callback?: ErrorCallback, disconnectError: Error | null = null) {
    if (this.closing) return this._asyncError('Port is closing', callback);
    if (!this.isOpen && !this.opening) return this._asyncError('Port is not open', callback);
    this.closing = true;
    this._closeError = disconnectError;
    // Native onClose can run in a different async context from this request.
    if (callback) this._closeCallbacks.push(AsyncResource.bind(callback, 'serialport-rs.close', this));
    if (this.opening) {
      this._opening!.cancel?.();
      return;
    }
    const port = this.port!;
    port.close().then(
      () => {
        // Third-party bindings do not have an onClose hook.
        if (this.port === port) this._finishClose(disconnectError);
      },
      (error) => this._closeFailed(port, error),
    );
  }

  _closeFailed(port: RuntimePort, error: Error) {
    if (this.port !== port) return;
    this.closing = false;
    this._closeError = null;
    const callbacks = this._closeCallbacks.splice(0);
    if (callbacks.length) for (const cb of callbacks) cb.call(this, error);
    else this.emit('error', error);
    this._resumeIO();
  }

  _finishClose(error: Error | null) {
    if (!this.port && !this.closing) return;
    error = this._closeError || error;
    this._closeError = null;
    this.port = undefined;
    this.closing = false;
    this._readPort = undefined;
    this._readRequested = true;
    const callbacks = this._closeCallbacks.splice(0);
    this.emit('close', error);
    if (this.settings.endOnClose) this.emit('end');
    for (const callback of callbacks) callback.call(this, error);
  }

  write(chunk: string | Uint8Array | number[], encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback) {
    return super.write(Array.isArray(chunk) ? Buffer.from(chunk) : chunk, encoding as BufferEncoding, callback);
  }

  _write(data: Buffer, encoding: string, callback: WriteCallback) {
    if (!this.isOpen) {
      this._waitingWrite = [data, encoding, callback];
      return;
    }
    const port = this.port!;
    port.write(data).then(
      () => callback(null),
      (error) => this._writeError(port, error, callback),
    );
  }

  _writeError(port: RuntimePort, error: SerialError, callback: WriteCallback) {
    if (!error.canceled && this.port === port && this.isOpen)
      this.close(undefined, new DisconnectedError(error.message));
    callback(error);
  }

  _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], callback: WriteCallback) {
    if (!this.isOpen || !this.port!.writev) {
      this._write(Buffer.concat(chunks.map(({ chunk }) => chunk)), 'buffer', callback);
      return;
    }
    const port = this.port!;
    port.writev!(chunks.map(({ chunk }) => chunk)).then(
      () => callback(null),
      (error) => this._writeError(port, error, callback),
    );
  }

  _read(length: number) {
    this._readRequested = true;
    if (!this.isOpen || this._readPort === this.port) return;
    if (this.port!.startReading) {
      try {
        this.port!.startReading(length);
      } catch (error) {
        this.close(undefined, new DisconnectedError((error as Error).message));
      }
      return;
    }
    const port = this.port!;
    this._readPort = port;
    const request = port.readChunk
      ? port.readChunk(length)
      : (() => {
          const buffer = Buffer.allocUnsafe(length);
          return port.read(buffer, 0, length).then(({ bytesRead }) => buffer.subarray(0, bytesRead));
        })();
    request.then(
      (data) => {
        if (this._readPort === port) this._readPort = undefined;
        if (this.port === port && this.isOpen) {
          this._readRequested = false;
          this.push(data.length ? data : null);
        } else if (this.isOpen) this._read(length);
      },
      (error) => {
        if (this._readPort === port) this._readPort = undefined;
        if (!error.canceled && this.port === port && this.isOpen)
          this.close(undefined, new DisconnectedError(error.message));
        else if (this.isOpen && this.port !== port) this._read(length);
      },
    );
  }

  _operation(
    name: 'update' | 'set' | 'get' | 'flush' | 'drain',
    args: unknown[],
    callback?: OperationCallback,
    completed = () => {},
  ) {
    if (!this.isOpen) return this._asyncError('Port is not open', callback);
    const port = this.port!;
    (port[name] as (...args: unknown[]) => Promise<PortStatus | void>)(...args).then(
      (result) => {
        if (this.port === port) completed();
        if (callback) callback.call(this, null, result as PortStatus | undefined);
      },
      (error) => this._report(error, callback),
    );
  }

  update(options: UpdateOptions, callback?: ErrorCallback) {
    const baudRate = options?.baudRate;
    this._operation('update', [{ baudRate }], callback, () => {
      this.settings.baudRate = baudRate;
    });
  }
  set(options?: SetOptions, callback?: ErrorCallback) {
    this._operation('set', [{ brk: false, cts: false, dtr: true, rts: true, ...options }], callback);
  }
  get(callback?: ModemBitsCallback) {
    this._operation('get', [], callback);
  }
  flush(callback?: ErrorCallback) {
    this._operation('flush', [], callback);
  }
  drain(callback?: ErrorCallback) {
    const drained = (error?: Error | null) => {
      if (error) this._report(error, callback);
      else this._operation('drain', [], callback);
    };
    if (this.writableEnded) {
      // Wait for final writes without submitting a write after end().
      finished(this, { readable: false, cleanup: true }).then(() => drained(), drained);
    } else this.write(Buffer.alloc(0), drained);
  }

  _destroy(error: Error | null, callback: WriteCallback) {
    this._failWaitingWrite(error || new Error('Port is destroyed'));
    if (this.closing)
      this._closeCallbacks.push(
        AsyncResource.bind((closeError) => callback(error || closeError), 'serialport-rs.destroy', this),
      );
    else if (this.isOpen || this.opening) this.close((closeError) => callback(error || closeError));
    else callback(error);
  }
}

class SerialPort extends SerialPortStream {
  static binding = RustBinding;
  static list = RustBinding.list;
  constructor(options: PortSettings, callback?: ErrorCallback) {
    super({ ...options, binding: options?.binding || SerialPort.binding }, callback);
  }
}

export { SerialPort, SerialPortStream, DisconnectedError };
