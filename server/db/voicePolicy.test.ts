// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-voicepolicy-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let vp: typeof import('./voicePolicy.js');

beforeAll(async () => {
  vp = await import('./voicePolicy.js');
});

describe('voicePolicy', () => {
  it("defaults to 'none' (anyone) when unset", () => {
    expect(vp.getPolicy('irc.libera.chat', '#unset')).toBe('none');
  });

  it('upserts and reads back, last write wins', () => {
    vp.setPolicy('irc.libera.chat', '#dev', 'op', 'jawsh');
    expect(vp.getPolicy('irc.libera.chat', '#dev')).toBe('op');
    vp.setPolicy('irc.libera.chat', '#dev', 'voice', 'jawsh');
    expect(vp.getPolicy('irc.libera.chat', '#dev')).toBe('voice');
  });

  it('normalizes unknown modes to none', () => {
    expect(vp.normalizeMinJoinMode('bogus')).toBe('none');
    expect(vp.normalizeMinJoinMode(undefined)).toBe('none');
    expect(vp.normalizeMinJoinMode('halfop')).toBe('halfop');
  });

  it('scopes by host + channel', () => {
    vp.setPolicy('irc.libera.chat', '#scoped', 'op', 'j');
    expect(vp.getPolicy('irc.rizon.net', '#scoped')).toBe('none');
    expect(vp.getPolicy('irc.libera.chat', '#other')).toBe('none');
  });
});
