// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AsyncResource } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
import { RustBinding } from './binding';
import { validateOptions } from './options';
import type {
  BindingInterface,
  BindingOpenOptions,
  BindingPortInterface,
  BaudRateCallback,
  BaudRateResult,
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
  signal?: AbortSignal;
};
export type PortSettings = Omit<StreamSettings, 'binding'> & { binding?: StreamSettings['binding'] };
type WriteCallback = (error?: Error | null) => void;
type OperationCallback<T> = (error: Error | null, result?: T) => void;
type SerialError = Error & { canceled?: boolean };

function asError(error: unknown): SerialError {
  return error instanceof Error ? error : new Error('Serial binding operation failed', { cause: error });
}

function bindingCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

function watchAbort(signal: AbortSignal, listener: () => void): () => void {
  if (typeof addAbortListener === 'function') {
    const subscription = addAbortListener(signal, listener);
    return () => subscription[Symbol.dispose]();
  }
  // addAbortListener was introduced in Node 20.5; retain support for earlier 20.x.
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

class DisconnectedError extends Error {
  declare disconnected: true;
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.disconnected = true;
  }
}

class SerialPortStream extends Duplex {
  declare settings: Required<Omit<StreamSettings, 'signal'>> & Pick<StreamSettings, 'signal'>;
  declare opening: boolean;
  declare closing: boolean;
  declare port?: RuntimePort;
  declare _readRequested: boolean;
  declare _readPort?: RuntimePort;
  declare _waitingWrite?: [Buffer, string, WriteCallback];
  declare _closeCallbacks: ErrorCallback[];
  declare _closeError: Error | null;
  declare _opening?: Promise<RuntimePort> & { cancel?: () => void };
  declare _removeAbortListener?: () => void;

  constructor(options: StreamSettings, callback?: ErrorCallback) {
    const settings = { autoOpen: true, endOnClose: false, highWaterMark: 64 * 1024, ...validateOptions(options) };
    for (const key of ['autoOpen', 'endOnClose'] as const) {
      if (typeof settings[key] !== 'boolean') throw new TypeError(`"${key}" must be a boolean`);
    }
    const { signal } = settings;
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    )
      throw new TypeError('"signal" must be an AbortSignal');
    super({ highWaterMark: settings.highWaterMark, autoDestroy: false, emitClose: false });
    if (typeof settings.binding?.open !== 'function') throw new TypeError('Pass a binding in options.binding');
    this.settings = settings;
    this.opening = false;
    this.closing = false;
    this.port = undefined;
    this._readRequested = false;
    this._readPort = undefined;
    this._waitingWrite = undefined;
    this._closeCallbacks = [];
    this._closeError = null;
    if (signal !== undefined) {
      const abort = () =>
        this.destroy(
          Object.assign(new Error('The operation was aborted', { cause: signal.reason }), {
            name: 'AbortError',
            code: 'ABORT_ERR',
          }),
        );
      if (signal.aborted) abort();
      else this._removeAbortListener = watchAbort(signal, abort);
    }
    if (settings.autoOpen) {
      if (!this.destroyed) this.open(callback);
      else if (callback) process.nextTick(() => callback.call(this, this.errored));
    }
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

  _report(error: unknown, callback?: ErrorCallback) {
    const failure = asError(error);
    if (callback) callback.call(this, failure);
    else this.emit('error', failure);
  }
  _asyncError(message: string, callback?: ErrorCallback) {
    process.nextTick(() => this._report(new Error(message), callback));
  }

  open(callback?: ErrorCallback) {
    if (this.destroyed) return this._asyncError('Port is destroyed', callback);
    if (this.isOpen) return this._asyncError('Port is already open', callback);
    if (this.opening || this.closing) return this._asyncError('Port is opening or closing', callback);
    this.opening = true;
    const { binding, autoOpen, endOnClose, highWaterMark, signal, ...options } = this.settings;
    this._opening = bindingCall(() => binding.open(options));
    this._opening
      .then(
        async port => {
          this._opening = undefined;
          this.opening = false;
          this.port = port;
          port.onClose = error => {
            if (this.port !== port) return;
            const reason = error && new DisconnectedError(asError(error).message, { cause: error });
            if (port.isOpen) this.close(undefined, reason);
            else this._finishClose(reason);
          };
          port.onData = data => {
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
              closeError = asError(error);
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
        error => {
          this._opening = undefined;
          this.opening = false;
          error = asError(error);
          this._failWaitingWrite(error);
          if (this.closing) {
            this._finishClose(null);
            if (callback) callback.call(this, error);
          } else this._report(error, callback);
        },
      )
      .catch(error => this._report(error));
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
    bindingCall(() => port.close()).then(
      () => {
        // Third-party bindings do not have an onClose hook.
        if (this.port === port) this._finishClose(disconnectError);
      },
      error => this._closeFailed(port, error),
    );
  }

  _closeFailed(port: RuntimePort, error: unknown) {
    if (this.port !== port) return;
    const failure = asError(error);
    if (!port.isOpen) return this._finishClose(failure);
    this.closing = false;
    this._closeError = null;
    const callbacks = this._closeCallbacks.splice(0);
    if (callbacks.length) for (const cb of callbacks) cb.call(this, failure);
    else this.emit('error', failure);
    this._resumeIO();
  }

  _finishClose(error: Error | null) {
    if (!this.port && !this.closing) return;
    error = this._closeError || error;
    this._closeError = null;
    if (this.port) {
      this.port.onClose = undefined;
      this.port.onData = undefined;
    }
    this.port = undefined;
    this.closing = false;
    this._readPort = undefined;
    this._readRequested = true;
    const callbacks = this._closeCallbacks.splice(0);
    this.emit('close', error);
    if (this.settings.endOnClose) this.emit('end');
    for (const callback of callbacks) callback.call(this, error);
  }

  write(
    chunk: string | Uint8Array | readonly number[],
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ) {
    return super.write(Array.isArray(chunk) ? Buffer.from(chunk) : chunk, encoding as BufferEncoding, callback);
  }

  _write(data: Buffer, encoding: string, callback: WriteCallback) {
    if (!this.isOpen) {
      this._waitingWrite = [data, encoding, callback];
      return;
    }
    const port = this.port!;
    bindingCall(() => port.write(data)).then(
      () => callback(null),
      error => this._writeError(port, error, callback),
    );
  }

  _writeError(port: RuntimePort, error: unknown, callback: WriteCallback) {
    const failure = asError(error);
    if (!failure.canceled && this.port === port && this.isOpen)
      this.close(undefined, new DisconnectedError(failure.message, { cause: failure }));
    callback(failure);
  }

  _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], callback: WriteCallback) {
    if (!this.isOpen || !this.port!.writev) {
      this._write(Buffer.concat(chunks.map(({ chunk }) => chunk)), 'buffer', callback);
      return;
    }
    const port = this.port!;
    bindingCall(() => port.writev!(chunks.map(({ chunk }) => chunk))).then(
      () => callback(null),
      error => this._writeError(port, error, callback),
    );
  }

  _read(length: number) {
    length = Math.max(1, length);
    this._readRequested = true;
    if (!this.isOpen || this._readPort === this.port) return;
    const port = this.port!;
    if (port.startReading) {
      try {
        port.startReading(length);
      } catch (error) {
        this._readError(port, error, length);
      }
      return;
    }
    this._readPort = port;
    const request = bindingCall(() => {
      if (port.readChunk) return port.readChunk(length);
      const buffer = Buffer.allocUnsafe(length);
      return port.read(buffer, 0, length).then(({ bytesRead }) => {
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length)
          throw new RangeError('Invalid binding read length');
        return buffer.subarray(0, bytesRead);
      });
    });
    request.then(
      data => {
        if (this._readPort === port) this._readPort = undefined;
        if (this.port === port && this.isOpen) {
          this._readRequested = false;
          this.push(data.length ? data : null);
        } else if (this.isOpen) this._read(length);
      },
      error => this._readError(port, error, length),
    );
  }

  _readError(port: RuntimePort, error: unknown, length: number) {
    const failure = asError(error);
    if (this._readPort === port) this._readPort = undefined;
    if (!failure.canceled && this.port === port && this.isOpen)
      this.close(undefined, new DisconnectedError(failure.message, { cause: failure }));
    else if (this.isOpen && this.port !== port) this._read(length);
  }

  _operation<T>(operation: (port: RuntimePort) => Promise<T>, callback?: OperationCallback<T>, completed = () => {}) {
    if (!this.isOpen) return this._asyncError('Port is not open', callback);
    const port = this.port!;
    bindingCall(() => operation(port)).then(
      result => {
        if (this.port === port) completed();
        if (callback) callback.call(this, null, result);
      },
      error => this._report(error, callback),
    );
  }

  update(options: UpdateOptions, callback?: ErrorCallback) {
    const baudRate = options?.baudRate;
    this._operation(
      port => port.update({ baudRate }),
      callback,
      () => {
        this.settings.baudRate = baudRate;
      },
    );
  }
  set(options?: SetOptions, callback?: ErrorCallback) {
    const flags = { brk: false, cts: false, dtr: true, rts: true, ...options };
    this._operation(port => port.set(flags), callback);
  }
  get(callback?: ModemBitsCallback) {
    this._operation(port => port.get(), callback);
  }
  getBaudRate(callback: BaudRateCallback) {
    this._operation(port => port.getBaudRate(), callback);
  }
  flush(callback?: ErrorCallback) {
    this._operation(port => port.flush(), callback);
  }
  drain(callback?: ErrorCallback) {
    const drained = (error?: Error | null) => {
      if (error) this._report(error, callback);
      else this._operation(port => port.drain(), callback);
    };
    if (this.writableEnded) {
      // Wait for final writes without submitting a write after end().
      finished(this, { readable: false, cleanup: true }).then(() => drained(), drained);
    } else this.write(Buffer.alloc(0), drained);
  }

  _promise<T>(invoke: (callback: (error?: Error | null, value?: T) => void) => unknown): Promise<T> {
    return new Promise((resolve, reject) =>
      invoke((error, value) => {
        if (error) reject(error);
        else resolve(value as T);
      }),
    );
  }

  openAsync(): Promise<void> {
    return this._promise(callback => this.open(callback));
  }
  closeAsync(): Promise<void> {
    return this._promise(callback => this.close(callback));
  }
  writeAsync(data: string | Uint8Array | readonly number[], encoding?: BufferEncoding): Promise<void> {
    return this._promise(callback => this.write(data, encoding, callback));
  }
  updateAsync(options: UpdateOptions): Promise<void> {
    return this._promise(callback => this.update(options, callback));
  }
  setAsync(options?: SetOptions): Promise<void> {
    return this._promise(callback => this.set(options, callback));
  }
  getAsync(): Promise<PortStatus> {
    return this._promise<PortStatus>(callback => this.get(callback));
  }
  getBaudRateAsync(): Promise<BaudRateResult> {
    return this._promise<BaudRateResult>(callback => this.getBaudRate(callback));
  }
  flushAsync(): Promise<void> {
    return this._promise(callback => this.flush(callback));
  }
  drainAsync(): Promise<void> {
    return this._promise(callback => this.drain(callback));
  }

  _destroy(error: Error | null, callback: WriteCallback) {
    this._removeAbortListener?.();
    this._removeAbortListener = undefined;
    this._failWaitingWrite(error || new Error('Port is destroyed'));
    if (this.closing)
      this._closeCallbacks.push(
        AsyncResource.bind(closeError => callback(error || closeError), 'serialport-rs.destroy', this),
      );
    else if (this.isOpen || this.opening) this.close(closeError => callback(error || closeError));
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
