// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// The schemaVersion-29 cutover: Admin → Networks lost its "Offered" checkbox, so
// a network an admin had un-offered would sit in the table with no way to bring
// it back or to see it. Those rows are deleted (not re-offered: that would put
// back what the admin took away, and under the lockdown would let users connect
// to it again).
//
// The table's shape does not change, so the fixture is the real schema with rows
// seeded and schema_version wound back to 28; re-importing with a reset module
// registry runs the migration against them.

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-offered-'));
const dbPath = path.join(tmpDir, 'test.db');
process.env.DATABASE_PATH = dbPath;

let nets: typeof import('./instanceNetworks.js');

beforeAll(async () => {
  const fresh = (await import('./index.js')).default;
  fresh.close();

  const raw = new Database(dbPath);
  raw.exec(`
    INSERT INTO instance_network (name, host, enabled, position) VALUES
      ('Offered', 'irc.offered.example', 1, 0),
      ('Hidden', 'irc.hidden.example', 0, 1),
      ('Also offered', 'irc.two.example', 1, 2);
    UPDATE app_meta SET value = '28' WHERE key = 'schema_version';
  `);
  raw.close();

  vi.resetModules();
  await import('./index.js');
  nets = await import('./instanceNetworks.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('instance_network v29 migration', () => {
  it('deletes the networks that were not offered, and only those', () => {
    expect(nets.listInstanceNetworks().map((n) => n.name)).toEqual(['Offered', 'Also offered']);
  });

  it('leaves what users are offered exactly as it was', () => {
    expect(nets.listEnabledInstanceNetworks().map((n) => n.host)).toEqual([
      'irc.offered.example',
      'irc.two.example',
    ]);
  });
});
