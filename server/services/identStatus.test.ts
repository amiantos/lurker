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
  registerIdent,
  resetOidentdStateForTest,
  startIdentd,
  stopIdentd,
  stopOidentdFile,
  unregisterIdent,
  whenIdentdSettled,
  whenOidentdSettled,
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
    try {
      startIdentd(port, '127.0.0.1');
      await whenIdentdSettled();
      expect(identStatus()).toBe('failed');
      startIdentd(0, '127.0.0.1');
      await whenIdentdSettled();
      expect(identStatus()).toBe('on');
    } finally {
      await free();
    }
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

  // Boot writes the file in place; every write after goes through a sibling
  // temp file and a rename. Either can work where the other cannot, so the
  // status follows the last write, in both directions.
  it('follows the writes after the first', async () => {
    const file = path.join(dir, 'later', 'oidentd.conf');
    process.env.LURKER_OIDENTD_FILE = file;
    initOidentdFile();
    expect(identStatus()).toBe('on');

    const entry = {
      localAddress: '127.0.0.1',
      localPort: 40001,
      remoteAddress: '127.0.0.1',
      remotePort: 6667,
      ident: 'later',
    };
    // Something in the temp file's place: the write cannot land.
    fs.mkdirSync(`${file}.tmp`);
    const first = registerIdent(entry);
    await whenOidentdSettled();
    expect(identStatus()).toBe('failed');

    fs.rmdirSync(`${file}.tmp`);
    unregisterIdent(first);
    await whenOidentdSettled();
    expect(identStatus()).toBe('on');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('later');
  });

  // The file being written says nothing about a :113 that is not answering.
  it('is failed when either of two modes is', async () => {
    const { port, free } = await takenPort();
    try {
      startIdentd(port, '127.0.0.1');
      await whenIdentdSettled();
      process.env.LURKER_OIDENTD_FILE = path.join(dir, 'both', 'oidentd.conf');
      initOidentdFile();
      expect(identStatus()).toBe('failed');
    } finally {
      await free();
    }
  });
});
