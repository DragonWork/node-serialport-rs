// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { Transform, type TransformCallback } from 'node:stream';
import type { SpacePacketOptions, SpacePacketHeader, SpacePacket } from '../../public-api';
import { ByteQueue, integer } from './bytes';

class SpacePacketParser extends Transform {
  #bytes = new ByteQueue();
  #header?: SpacePacketHeader;
  declare timeCodeFieldLength: number;
  declare ancillaryDataFieldLength: number;

  constructor({ timeCodeFieldLength = 0, ancillaryDataFieldLength = 0, ...options }: SpacePacketOptions = {}) {
    super({ ...options, objectMode: true });
    this.timeCodeFieldLength = integer(timeCodeFieldLength, 'timeCodeFieldLength', 0);
    this.ancillaryDataFieldLength = integer(ancillaryDataFieldLength, 'ancillaryDataFieldLength', 0);
  }

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.#bytes.append(chunk);
    for (;;) {
      if (!this.#header) {
        if (this.#bytes.length < 6) break;
        const header = this.#bytes.take(6);
        const id = header.readUInt16BE(0);
        const sequence = header.readUInt16BE(2);
        this.#header = {
          versionNumber: id >>> 13 === 0 ? 1 : 'UNKNOWN_VERSION',
          identification: { apid: id & 0x7ff, secondaryHeader: (id >>> 11) & 1, type: (id >>> 12) & 1 },
          sequenceControl: { packetName: sequence & 0x3fff, sequenceFlags: sequence >>> 14 },
          dataLength: header.readUInt16BE(4) + 1,
        };
      }
      if (this.#bytes.length < this.#header.dataLength) break;
      const bytes = this.#bytes.take(this.#header.dataLength);
      const timeEnd = Math.min(bytes.length, this.timeCodeFieldLength);
      const ancillaryEnd = Math.min(bytes.length, timeEnd + this.ancillaryDataFieldLength);
      const packet: SpacePacket = { header: this.#header, data: bytes.toString('utf8', ancillaryEnd) };
      if (ancillaryEnd) {
        packet.secondaryHeader = {};
        if (timeEnd) packet.secondaryHeader.timeCode = bytes.toString('utf8', 0, timeEnd);
        if (ancillaryEnd > timeEnd)
          packet.secondaryHeader.ancillaryData = bytes.toString('utf8', timeEnd, ancillaryEnd);
      }
      this.#header = undefined;
      this.push(packet);
    }
    callback();
  }

  _flush(callback: TransformCallback) {
    // The serialport API emits incomplete trailing bytes as an array in object mode.
    this.push([...this.#bytes.take()]);
    this.#header = undefined;
    callback();
  }
}

export { SpacePacketParser };
