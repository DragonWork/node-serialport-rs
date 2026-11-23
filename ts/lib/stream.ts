// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AsyncResource } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
import { BindingPort, RustBinding } from './binding';
import { modemOptions, validateOptions } from './options';
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
  // Early Node.js 20 releases only have the EventTarget methods.
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
  #writing = false;
  #drains?: Map<Buffer, (port: RuntimePort) => Promise<void>>;
  declare settings: Required<Omit<StreamSettings, 'signal'>> & Pick<StreamSettings, 'signal'>;
  declare opening: boolean;
  declare closing: boolean;
  declare port?: RuntimePort;
  declare _readRequested: boolean;
  declare _readPort?: RuntimePort;
  declare _waitingWrite?: { resume: () => void; callback: WriteCallback };
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
    waiting?.callback(error);
  }

  _resumeIO() {
    if (this.destroyed || !this.isOpen) return;
    if (this._waitingWrite) {
      const waiting = this._waitingWrite;
      this._waitingWrite = undefined;
      waiting.resume();
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
      this._waitingWrite = { resume: () => this._write(data, encoding, callback), callback };
      return;
    }
    const port = this.port!;
    const drain = this.#drains?.get(data);
    this._writeToPort(port, drain ? () => drain(port) : () => port.write(data), callback);
  }

  _writeToPort(port: RuntimePort, operation: () => Promise<void>, callback: WriteCallback) {
    this.#writing = true;
    bindingCall(operation).then(
      () => {
        this.#writing = false;
        callback(null);
      },
      error => {
        this.#writing = false;
        this._writeError(port, error, callback);
      },
    );
  }

  _writeError(port: RuntimePort, error: unknown, callback: WriteCallback) {
    const failure = asError(error);
    if (!failure.canceled && this.port === port && this.isOpen)
      this.close(undefined, new DisconnectedError(failure.message, { cause: failure }));
    callback(failure);
  }

  _writev(chunks: { chunk: Buffer; encoding: BufferEncoding }[], callback: WriteCallback) {
    if (this.#drains) {
      if (!this.isOpen) {
        this._waitingWrite = { resume: () => this._writev(chunks, callback), callback };
        return;
      }
      const port = this.port!;
      this._writeToPort(port, () => this.#writeWithDrains(port, chunks), callback);
      return;
    }
    if (!this.isOpen || !this.port!.writev) {
      this._write(Buffer.concat(chunks.map(({ chunk }) => chunk)), 'buffer', callback);
      return;
    }
    const port = this.port!;
    this._writeToPort(port, () => port.writev!(chunks.map(({ chunk }) => chunk)), callback);
  }

  async #writeWithDrains(port: RuntimePort, chunks: { chunk: Buffer }[]) {
    let buffers: Buffer[] = [];
    const write = () => (port.writev ? port.writev(buffers) : port.write(Buffer.concat(buffers)));
    for (const { chunk } of chunks) {
      const drain = this.#drains?.get(chunk);
      if (!drain) {
        buffers.push(chunk);
        continue;
      }
      if (buffers.length) {
        await write();
        buffers = [];
      }
      await drain(port);
    }
    if (buffers.length) await write();
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
    const flags = { ...options };
    this._operation(port => port.set(port instanceof BindingPort ? flags : modemOptions(flags)), callback);
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
    } else if (
      this.port instanceof BindingPort &&
      this.isOpen &&
      this.writable &&
      !this.#writing &&
      !this._waitingWrite &&
      !this.writableCorked &&
      !this.writableLength
    ) {
      // The native command queue also orders writes submitted before this drain resolves.
      drained();
    } else {
      this.#queueDrain().then(
        () => callback?.call(this, null),
        error => this._report(error, callback),
      );
    }
  }

  #queueDrain() {
    const marker = Buffer.alloc(0);
    const drains = (this.#drains ??= new Map());
    return new Promise<void>((resolve, reject) => {
      let submitted = false;
      // Settle this request at its position in the writable queue, even if Node
      // puts a later, backpressured write in the same _writev batch.
      drains.set(marker, (port: RuntimePort) => {
        submitted = true;
        return bindingCall(() => port.drain()).then(resolve, reject);
      });
      const finished = (error?: Error | null) => {
        drains.delete(marker);
        if (!drains.size) this.#drains = undefined;
        if (error) reject(error);
        // A subclass can consume the marker in its own _write or _writev.
        else if (!submitted)
          this._operation(
            port => port.drain(),
            error => (error ? reject(error) : resolve()),
          );
      };
      try {
        super.write(marker, finished);
      } catch (error) {
        finished(asError(error));
      }
    });
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
