// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

const {Duplex} = require('node:stream');
const {RustBinding, validateOptions} = require('./binding');

class DisconnectedError extends Error {
  constructor(message) { super(message); this.disconnected = true; }
}

class SerialPortStream extends Duplex {
  constructor(options, callback) {
    const settings = {autoOpen: true, endOnClose: false, highWaterMark: 64 * 1024, ...validateOptions(options)};
    super({highWaterMark: settings.highWaterMark, autoDestroy: false, emitClose: false});
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

  get path() { return this.settings.path; }
  get baudRate() { return this.settings.baudRate; }
  get isOpen() { return Boolean(this.port?.isOpen) && !this.closing; }

  _report(error, callback) {
    if (callback) callback.call(this, error);
    else this.emit('error', error);
  }
  _asyncError(message, callback) { process.nextTick(() => this._report(new Error(message), callback)); }

  open(callback) {
    if (this.destroyed) return this._asyncError('Port is destroyed', callback);
    if (this.isOpen) return this._asyncError('Port is already open', callback);
    if (this.opening || this.closing) return this._asyncError('Port is opening or closing', callback);
    this.opening = true;
    const {binding, autoOpen, endOnClose, highWaterMark, ...options} = this.settings;
    try { this._opening = binding.open(options); }
    catch (error) { this._opening = Promise.reject(error); }
    this._opening.then(async port => {
      this.opening = false;
      this.port = port;
      if (this.closing) {
        await port.close();
        const error = Object.assign(new Error('Port opening canceled'), {canceled: true});
        this._failWaitingWrite(error);
        this._finishClose(null);
        if (callback) callback.call(this, error);
        return;
      }
      port.onClose = error => {
        if (this.port !== port) return;
        const reason = error && new DisconnectedError(error.message);
        if (port.isOpen) this.close(undefined, reason);
        else this._finishClose(reason);
      };
      port.onData = data => {
        if (this.port === port && this.isOpen) {
          this._readRequested = false;
          this.push(data);
        }
      };
      this.emit('open');
      if (callback) callback.call(this, null);
      if (this._waitingWrite) {
        const waiting = this._waitingWrite;
        this._waitingWrite = undefined;
        this._write(...waiting);
      }
      if (this._readRequested) this._read(this.readableHighWaterMark);
    }, error => {
      this.opening = false;
      this._failWaitingWrite(error);
      if (this.closing) {
        this._finishClose(null);
        if (callback) callback.call(this, error);
      } else this._report(error, callback);
    }).catch(error => this._report(error));
  }

  _failWaitingWrite(error) {
    const waiting = this._waitingWrite;
    this._waitingWrite = undefined;
    if (waiting) waiting[2](error);
  }

  close(callback, disconnectError = null) {
    if (this.closing) return this._asyncError('Port is closing', callback);
    if (!this.isOpen && !this.opening) return this._asyncError('Port is not open', callback);
    this.closing = true;
    this._closeError = disconnectError;
    if (callback) this._closeCallbacks.push(callback);
    if (this.opening) { this._opening.cancel?.(); return; }
    const port = this.port;
    port.close().then(() => {
      // Third-party bindings do not have an onClose hook.
      if (this.port === port) this._finishClose(disconnectError);
    }, error => {
      if (this.port !== port) return;
      this.closing = false;
      this._closeError = null;
      const callbacks = this._closeCallbacks.splice(0);
      if (callbacks.length) for (const cb of callbacks) cb.call(this, error);
      else this.emit('error', error);
    });
  }

  _finishClose(error) {
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

  write(chunk, encoding, callback) {
    return super.write(Array.isArray(chunk) ? Buffer.from(chunk) : chunk, encoding, callback);
  }

  _write(data, encoding, callback) {
    if (!this.isOpen) { this._waitingWrite = [data, encoding, callback]; return; }
    const port = this.port;
    port.write(data).then(() => callback(null), error => this._writeError(port, error, callback));
  }

  _writeError(port, error, callback) {
    if (!error.canceled && this.port === port && this.isOpen) this.close(undefined, new DisconnectedError(error.message));
    callback(error);
  }

  _writev(chunks, callback) {
    if (!this.isOpen || !this.port.writev) {
      this._write(Buffer.concat(chunks.map(({chunk}) => chunk)), 'buffer', callback);
      return;
    }
    const port = this.port;
    port.writev(chunks.map(({chunk}) => chunk)).then(() => callback(null), error => this._writeError(port, error, callback));
  }

  _read(length) {
    this._readRequested = true;
    if (!this.isOpen || this._readPort === this.port) return;
    if (this.port.startReading) {
      try { this.port.startReading(length); }
      catch (error) { this.close(undefined, new DisconnectedError(error.message)); }
      return;
    }
    const port = this.port;
    this._readPort = port;
    const request = port.readChunk ? port.readChunk(length) : (() => {
      const buffer = Buffer.allocUnsafe(length);
      return port.read(buffer, 0, length).then(({bytesRead}) => buffer.subarray(0, bytesRead));
    })();
    request.then(data => {
      if (this._readPort === port) this._readPort = undefined;
      if (this.port === port && this.isOpen) {
        this._readRequested = false;
        this.push(data);
      } else if (this.isOpen) this._read(length);
    }, error => {
      if (this._readPort === port) this._readPort = undefined;
      if (!error.canceled && this.port === port && this.isOpen) this.close(undefined, new DisconnectedError(error.message));
      else if (this.isOpen && this.port !== port) this._read(length);
    });
  }

  _operation(name, args, callback, completed = () => {}) {
    if (!this.isOpen) return this._asyncError('Port is not open', callback);
    const port = this.port;
    port[name](...args).then(result => {
      if (this.port === port) completed();
      if (callback) callback.call(this, null, result);
    }, error => this._report(error, callback));
  }

  update(options, callback) {
    const baudRate = options?.baudRate;
    this._operation('update', [{baudRate}], callback, () => { this.settings.baudRate = baudRate; });
  }
  set(options, callback) { this._operation('set', [options], callback); }
  get(callback) { this._operation('get', [], callback); }
  flush(callback) { this._operation('flush', [], callback); }
  drain(callback) {
    this.write(Buffer.alloc(0), error => {
      if (error) this._report(error, callback);
      else this._operation('drain', [], callback);
    });
  }

  _destroy(error, callback) {
    this._failWaitingWrite(error || new Error('Port is destroyed'));
    if (this.closing) this._closeCallbacks.push(closeError => callback(error || closeError));
    else if (this.isOpen || this.opening) this.close(closeError => callback(error || closeError));
    else callback(error);
  }
}

class SerialPort extends SerialPortStream {
  static binding = RustBinding;
  static list = RustBinding.list;
  constructor(options, callback) { super({...options, binding: options?.binding || SerialPort.binding}, callback); }
}

module.exports = {SerialPort, SerialPortStream, DisconnectedError};
