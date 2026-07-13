// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Node edition + operator upload env, set before the DB (and its seed) load.
process.env.LURKER_EDITION = 'node';
process.env.LURKER_NODE_UPLOAD_URL = 'https://dropper.test';
process.env.LURKER_NODE_UPLOAD_API_KEY = 'operator-key-123';
process.env.LURKER_NODE_UPLOAD_MAX_MB = '1';
process.env.LURKER_NODE_UPLOAD_MAX_DIM = '512';
process.env.LURKER_NODE_UPLOAD_QUALITY = '40';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploader-seed-node-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;

interface Row {
  driver: string;
  is_default: number;
  offered_to_users: number;
  locked: number;
  config_json: string;
  secrets_enc: string | null;
}

beforeAll(async () => {
  // The seed runs at DB init (below), in the hosted branch, from the env above.
  db = (await import('./index.js')).default;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LURKER_EDITION;
  delete process.env.LURKER_NODE_UPLOAD_URL;
  delete process.env.LURKER_NODE_UPLOAD_API_KEY;
  delete process.env.LURKER_NODE_UPLOAD_MAX_MB;
  delete process.env.LURKER_NODE_UPLOAD_MAX_DIM;
  delete process.env.LURKER_NODE_UPLOAD_QUALITY;
});

describe('seedUploaderConfig (hosted)', () => {
  it('seeds a single locked hoarder default baked from the operator env', () => {
    const row = db
      .prepare(`SELECT * FROM uploader_config WHERE scope = 'instance' AND locked = 1`)
      .get() as Row | undefined;
    expect(row).toBeTruthy();
    expect(row!.driver).toBe('dropper');
    expect(row!.is_default).toBe(1);
    expect(row!.offered_to_users).toBe(1);

    const cfg = JSON.parse(row!.config_json);
    expect(cfg.url).toBe('https://dropper.test');
    expect(cfg['policy.hostsThumbnails']).toBe('1');
    expect(cfg['policy.rasterOnly']).toBe('1');
    expect(cfg['policy.maxMb']).toBe('1');
    expect(cfg['policy.maxDim']).toBe('512');
    expect(cfg['policy.quality']).toBe('40');
    // api_key is a secret → secrets_enc, never config_json.
    expect(row!.secrets_enc).toContain('operator-key-123');
    expect(row!.config_json).not.toContain('operator-key-123');
  });

  it('locks users out of defining their own uploaders (allow_user_defined=0)', () => {
    const v = db
      .prepare(`SELECT value FROM instance_settings WHERE key = 'uploads.allow_user_defined'`)
      .get() as { value: string } | undefined;
    expect(v?.value).toBe('0');
  });

  it('is the only instance row on the hosted fleet (no x0/catbox offered)', () => {
    const drivers = (
      db.prepare(`SELECT driver FROM uploader_config WHERE scope = 'instance'`).all() as {
        driver: string;
      }[]
    ).map((r) => r.driver);
    expect(drivers).toEqual(['dropper']);
  });
});
