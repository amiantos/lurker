// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveSessionSecret } from './sessionSecret.js';

describe('resolveSessionSecret', () => {
  let dataDir: string;
  const savedEnv = process.env.SESSION_SECRET;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-secret-'));
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedEnv;
  });

  it('uses SESSION_SECRET env var when set', () => {
    process.env.SESSION_SECRET = 'env-secret';
    const { secret, source } = resolveSessionSecret({ dataDir });
    expect(secret).toBe('env-secret');
    expect(source).toBe('env');
    expect(fs.existsSync(path.join(dataDir, 'session-secret.key'))).toBe(false);
  });

  it('generates and persists a new secret when none exists', () => {
    const { secret, source, path: secretPath } = resolveSessionSecret({ dataDir });
    expect(source).toBe('generated');
    expect(secret.length).toBeGreaterThan(40);
    expect(secretPath).toBe(path.join(dataDir, 'session-secret.key'));
    expect(fs.readFileSync(secretPath!, 'utf8')).toBe(secret);
  });

  it('reuses an existing on-disk secret on subsequent boots', () => {
    const first = resolveSessionSecret({ dataDir });
    const second = resolveSessionSecret({ dataDir });
    expect(second.source).toBe('file');
    expect(second.secret).toBe(first.secret);
  });

  it('treats an empty SESSION_SECRET env var as unset', () => {
    process.env.SESSION_SECRET = '';
    const { source } = resolveSessionSecret({ dataDir });
    expect(source).toBe('generated');
  });

  it('creates the data directory if missing', () => {
    const missingDir = path.join(dataDir, 'nested', 'data');
    expect(fs.existsSync(missingDir)).toBe(false);
    resolveSessionSecret({ dataDir: missingDir });
    expect(fs.existsSync(missingDir)).toBe(true);
  });
});
