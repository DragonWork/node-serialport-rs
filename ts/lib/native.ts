// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { endianness } from 'node:os';
import type { BindingOpenOptions } from '../public-api';

export interface NativeEvent {
  kind: 'open' | 'close' | 'read' | 'ok' | 'error';
  id: number;
  data?: Buffer;
  message?: string;
  cts?: boolean;
  dsr?: boolean;
  dcd?: boolean;
  baudRate?: number;
}

export interface NativeHandle {
  close(): void;
  read(id: number, length: number): void;
  readCredit(bytes: number, slots: number): void;
  write(id: number, data: Buffer, inline: boolean): boolean;
  writev(id: number, data: Buffer[], length?: number): void;
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
}

export interface NativeAddon {
  NativePort: new (
    options: Required<BindingOpenOptions>,
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

function loadNative(): NativeAddon {
  const local = join(__dirname, '../native/serialport-rs.node');
  if (existsSync(local)) return require(local);
  const { platform, arch } = process;
  const libc =
    platform === 'linux'
      ? (process.report!.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime
        ? 'gnu'
        : 'musl'
      : undefined;
  const arm = Number((process.config.variables as Record<string, unknown>).arm_version || 7);
  const target = selectTarget({ platform, arch, libc, arm });
  const binary = target && join(__dirname, '..', 'native', target, 'serialport-rs.node');
  if (!binary || !existsSync(binary)) {
    throw new Error(
      `No serialport-rs native build for ${target || `${platform}/${arch}`}. Build this package with npm run build.`,
    );
  }
  return require(binary);
}

export { loadNative, selectTarget };
