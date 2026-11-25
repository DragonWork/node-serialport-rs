// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { endianness } from 'node:os';
import type { RustPort, SerialPortErrorCode, SetOptions } from '../public-api';

export interface NativeEvent {
  kind: 'open' | 'close' | 'read' | 'ok' | 'error';
  id: number;
  data?: Buffer;
  message?: string;
  code?: SerialPortErrorCode;
  errno?: number;
  cts?: boolean;
  dsr?: boolean;
  dcd?: boolean;
  lowLatency?: boolean;
  baudRate?: number;
}

export interface NativeHandle {
  close(): void;
  read(id: number, length: number): void;
  readCredit(bytes: number, slots: number): void;
  write(id: number, data: Buffer, inline: boolean): boolean;
  writev(id: number, data: Buffer[], length?: number, inline?: boolean): boolean;
  set(id: number, options: SetOptions): void;
  request(id: number, operation: ControlOperation, value: number): void;
}

export type ControlOperation = 'update' | 'set' | 'get' | 'getBaudRate' | 'flush' | 'drain';

interface NativePortInfo {
  path: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  vendorId?: string | null;
  productId?: string | null;
  pnpId?: string | null;
  locationId?: string | null;
  friendlyName?: string | null;
}

export interface NativeAddon {
  NativePort: new (
    options: RustPort['openOptions'],
    callback: (error: Error | null, event: Buffer | Buffer[] | NativeEvent) => void,
    allocator: (size: number) => Buffer,
  ) => NativeHandle;
  listPorts(): Promise<NativePortInfo[]>;
}

interface TargetSelection {
  platform: string;
  arch: string;
  libc?: string;
  arm?: number;
  endian?: string;
}
const targets = require('./targets.json') as (TargetSelection & { target: string })[];
const platformPackage: (target: TargetSelection) => string = require('./platform-package.cjs');
let detectedTarget: Readonly<TargetSelection & { target?: string }> | undefined;

function selectTarget({ platform, arch, libc, arm = 7, endian = endianness() }: TargetSelection): string | undefined {
  return targets
    .filter(
      target =>
        target.platform === platform &&
        target.arch === arch &&
        (!target.libc || target.libc === libc) &&
        (!target.arm || target.arm <= arm) &&
        (!target.endian || target.endian === endian),
    )
    .sort((a, b) => (b.arm || 0) - (a.arm || 0))[0]?.target;
}

function runtimeTarget() {
  if (detectedTarget) return detectedTarget;
  const { platform, arch } = process;
  const libc =
    platform === 'linux'
      ? (process.report!.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime
        ? 'gnu'
        : 'musl'
      : undefined;
  const arm = Number((process.config.variables as Record<string, unknown>).arm_version || 7);
  const endian = endianness();
  return (detectedTarget = Object.freeze({
    platform,
    arch,
    libc,
    arm,
    endian,
    target: selectTarget({ platform, arch, libc, arm, endian }),
  }));
}

function loadNative(): NativeAddon {
  const local = join(__dirname, '../native/serialport-rs.node');
  if (existsSync(local)) return require(local);
  const host = runtimeTarget();
  if (!host.target) throw new Error(`No serialport-rs native build for ${host.platform}/${host.arch}.`);
  const file = `${host.target}/serialport-rs.node`;
  const bundled = join(__dirname, '..', 'native', file);
  if (existsSync(bundled)) return require(bundled);
  const name = platformPackage(host);
  let binary: string;
  try {
    binary = require.resolve(`${name}/${file}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw cause;
    throw new Error(`Missing ${name} for ${host.target}. Install with npm install --include=optional.`, { cause });
  }
  return require(binary);
}

export { loadNative, selectTarget, runtimeTarget };
