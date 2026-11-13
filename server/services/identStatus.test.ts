// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// identStatus says what this process's ident services are doing, from their
// own state. The environment only says what was asked for: a :113 that would
// not bind is logged and survived, and the admin pane has to be able to tell
// that apart from ident working (#1139).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  identStatus,
  initOidentdFile,
  isIdentConfigured,
  resetOidentdStateForTest,
  startIdentd,
  stopIdentd,
  stopOidentdFile,
  whenIdentdSettled,
} from './identd.js';

let dir: string;
const ENV = ['LURKER_IDENTD_ENABLED', 'LURKER_OIDENTD_FILE'] as const;
const saved = ENV.map((k) => process.env[k]);

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-ident-status-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

afterEach(() => {
  stopIdentd();
  resetOidentdStateForTest();
  ENV.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
});

// A port something else already holds, so a bind to it fails.
async function takenPort(): Promise<{ port: number; free: () => Promise<void> }> {
  const holder = net.createServer();
  await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
  return {
    port: (holder.address() as net.AddressInfo).port,
    free: () => new Promise((r) => holder.close(() => r())),
  };
}

describe('identStatus (#1139)', () => {
  it('is off when nothing was started, whatever the environment asks for', () => {
    process.env.LURKER_IDENTD_ENABLED = '1';
    expect(isIdentConfigured()).toBe(true);
    expect(identStatus()).toBe('off');
  });

  it('is on once the listener is up, and off again when it is stopped', async () => {
    startIdentd(0, '127.0.0.1');
    await whenIdentdSettled();
    expect(identStatus()).toBe('on');
    stopIdentd();
    expect(identStatus()).toBe('off');
  });

  it('is failed when the port would not bind', async () => {
    const { port, free } = await takenPort();
    try {
      startIdentd(port, '127.0.0.1');
      await whenIdentdSettled();
      expect(identStatus()).toBe('failed');
    } finally {
      await free();
    }
  });

  it('is on again when a later start binds', async () => {
    const { port, free } = await takenPort();
    startIdentd(port, '127.0.0.1');
    await whenIdentdSettled();
    await free();
    startIdentd(port, '127.0.0.1');
    await whenIdentdSettled();
    expect(identStatus()).toBe('on');
  });

  it('is on when the oidentd file was written, and off after the stop', () => {
    process.env.LURKER_OIDENTD_FILE = path.join(dir, 'ok', 'oidentd.conf');
    initOidentdFile();
    expect(identStatus()).toBe('on');
    stopOidentdFile();
    expect(identStatus()).toBe('off');
  });

  it('is failed when the oidentd file cannot be written', () => {
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, '');
    // A path beneath a regular file: mkdir cannot make it.
    process.env.LURKER_OIDENTD_FILE = path.join(blocker, 'oidentd.conf');
    initOidentdFile();
    expect(identStatus()).toBe('failed');
  });

  it('is on when one of two modes works', async () => {
    const { port, free } = await takenPort();
    try {
      startIdentd(port, '127.0.0.1');
      await whenIdentdSettled();
      process.env.LURKER_OIDENTD_FILE = path.join(dir, 'both', 'oidentd.conf');
      initOidentdFile();
      expect(identStatus()).toBe('on');
    } finally {
      await free();
    }
  });
});
