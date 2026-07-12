// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploader-seed-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let seedUploaderConfig: typeof import('./uploaderConfigSeed.js').seedUploaderConfig;
let reconcileBuiltInUploaders: typeof import('./uploaderConfigSeed.js').reconcileBuiltInUploaders;
let reconcileLegacyUploadSettings: typeof import('./uploaderConfigSeed.js').reconcileLegacyUploadSettings;
let createUser: typeof import('./users.js').createUser;
let setUserSetting: typeof import('./settings.js').setUserSetting;
let getUserSettings: typeof import('./settings.js').getUserSettings;

interface Row {
  id: number;
  driver: string;
  is_default: number;
  offered_to_users: number;
  secrets_enc: string | null;
  config_json: string;
}

const instanceRows = (): Row[] =>
  db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'instance' ORDER BY driver`)
    .all() as Row[];
const userRows = (uid: number): Row[] =>
  db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'user' AND owner_user_id = ?`)
    .all(uid) as Row[];
// Insert an instance row directly (bypassing the seed) to model a pre-existing
// DB state — e.g. a P0-era DB that has x0/catbox but no local.
const ensureInstance = (driver: string, opts: { isDefault?: number }): void => {
  db.prepare(
    `INSERT INTO uploader_config
       (scope, owner_user_id, driver, label, config_json, secrets_enc,
        enabled, offered_to_users, locked, is_default)
     VALUES ('instance', NULL, ?, ?, '{}', NULL, 1, 1, 0, ?)`,
  ).run(driver, driver, opts.isDefault ?? 0);
};
const allowUserDefined = (): string | undefined =>
  (
    db
      .prepare(`SELECT value FROM instance_settings WHERE key = 'uploads.allow_user_defined'`)
      .get() as { value: string } | undefined
  )?.value;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ seedUploaderConfig, reconcileBuiltInUploaders, reconcileLegacyUploadSettings } =
    await import('./uploaderConfigSeed.js'));
  ({ createUser } = await import('./users.js'));
  ({ setUserSetting, getUserSettings } = await import('./settings.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  // Clear everything the seed touches (users cascade to their uploader_config +
  // user_settings) for a deterministic starting point.
  db.prepare('DELETE FROM uploader_config').run();
  db.prepare('DELETE FROM instance_settings').run();
  db.prepare('DELETE FROM user_settings').run();
  db.prepare('DELETE FROM users').run();
});

describe('seedUploaderConfig (self-host)', () => {
  it('seeds instance x0 (default) + catbox + local, allow_user_defined=1', () => {
    seedUploaderConfig(db);
    const inst = instanceRows();
    expect(inst.map((r) => r.driver).toSorted()).toEqual(['catbox', 'local', 'x0']);
    const x0 = inst.find((r) => r.driver === 'x0')!;
    const catbox = inst.find((r) => r.driver === 'catbox')!;
    const local = inst.find((r) => r.driver === 'local')!;
    expect(x0.is_default).toBe(1);
    expect(x0.offered_to_users).toBe(1);
    expect(catbox.is_default).toBe(0);
    expect(catbox.offered_to_users).toBe(1);
    // Local disk is offered but never the default — a self-hoster opts in.
    expect(local.is_default).toBe(0);
    expect(local.offered_to_users).toBe(1);
    expect(allowUserDefined()).toBe('1');
  });

  it('leaves a user with no legacy settings entirely alone (they follow the instance default)', () => {
    const u = createUser('seed-x0'); // no settings at all
    seedUploaderConfig(db);
    reconcileLegacyUploadSettings(db);
    // No row and no pointer — deliberately. An absent uploads.uploader_id means
    // "use the instance default", so a new account silently inherits whatever the
    // admin has set (#299) instead of being frozen onto x0 by the migration.
    expect(userRows(u.id)).toHaveLength(0);
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBeUndefined();
  });

  it('re-seed adds a newly-introduced built-in row (local) to a P0-era DB', () => {
    // Model a DB seeded by P0 (v14): x0 + catbox instance rows, no local. The
    // schema-version bump re-runs the idempotent seed, which must introduce the
    // local row rather than leave the dropdown resolving to nothing.
    seedUploaderConfig(db);
    db.prepare(`DELETE FROM uploader_config WHERE driver = 'local'`).run();
    expect(instanceRows().some((r) => r.driver === 'local')).toBe(false);

    seedUploaderConfig(db);
    const local = instanceRows().find((r) => r.driver === 'local');
    expect(local).toBeTruthy();
    expect(local!.offered_to_users).toBe(1);
    expect(local!.is_default).toBe(0);
  });

  it('reconcile self-heals a wedged DB (x0+catbox, no local) on boot', () => {
    // Model the exact wedge: a DB whose schema_version was bumped past the
    // one-shot seed without the local row ever being created, so the seed will
    // never re-run. The every-boot reconcile must add local anyway.
    ensureInstance('x0', { isDefault: 1 });
    ensureInstance('catbox', {});
    expect(instanceRows().some((r) => r.driver === 'local')).toBe(false);

    reconcileBuiltInUploaders(db);

    const local = instanceRows().find((r) => r.driver === 'local')!;
    expect(local).toBeTruthy();
    expect(local.offered_to_users).toBe(1);
    // The pre-existing x0 default is untouched — reconcile never re-asserts it.
    const x0 = instanceRows().find((r) => r.driver === 'x0')!;
    expect(x0.is_default).toBe(1);
    expect(instanceRows().filter((r) => r.is_default === 1)).toHaveLength(1);
  });

  it('reconcile is a no-op when the built-ins already exist', () => {
    seedUploaderConfig(db);
    const before = instanceRows().length;
    reconcileBuiltInUploaders(db);
    expect(instanceRows()).toHaveLength(before);
  });

  it('is idempotent — a second run adds no rows and does not clobber', () => {
    const u = createUser('seed-idem');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'hh');
    seedUploaderConfig(db);
    reconcileLegacyUploadSettings(db);
    const firstUserRowId = userRows(u.id)[0].id;
    const firstUploaderId = getUserSettings(u.id)['uploads.uploader_id'];

    seedUploaderConfig(db);
    reconcileLegacyUploadSettings(db);
    expect(instanceRows()).toHaveLength(3); // still just x0 + catbox + local
    expect(userRows(u.id)).toHaveLength(1);
    expect(userRows(u.id)[0].id).toBe(firstUserRowId);
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(firstUploaderId);
  });
});

// The migration that retires the legacy `uploads.*` keys (#514) — and, in doing
// so, fixes the P0 hole where those keys were converted ONCE and then ignored, so
// anything configured or changed afterwards was silently dropped.
describe('reconcileLegacyUploadSettings (self-host)', () => {
  const legacyKeys = (uid: number): string[] =>
    (
      db
        .prepare(`SELECT key FROM user_settings WHERE user_id = ? AND key LIKE 'uploads.%'`)
        .all(uid) as Array<{ key: string }>
    ).map((r) => r.key);

  beforeEach(() => seedUploaderConfig(db));

  it('materializes a configured catbox user into a user row + pointer', () => {
    const u = createUser('rec-catbox');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'hash1');

    reconcileLegacyUploadSettings(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('catbox');
    expect(rows[0].secrets_enc).toContain('hash1');
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(rows[0].id);
  });

  it('materializes a configured hoarder user (url public, key secret)', () => {
    const u = createUser('rec-hoarder');
    setUserSetting(u.id, 'uploads.provider', 'hoarder');
    setUserSetting(u.id, 'uploads.hoarder.url', 'https://u.example');
    setUserSetting(u.id, 'uploads.hoarder.api_key', 'k-secret');

    reconcileLegacyUploadSettings(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('hoarder');
    expect(JSON.parse(rows[0].config_json)).toEqual({ url: 'https://u.example' });
    expect(rows[0].secrets_enc).toContain('k-secret');
    expect(rows[0].config_json).not.toContain('k-secret');
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(rows[0].id);
  });

  // ── THE REGRESSION (see the module header) ─────────────────────────────────
  // A user P0 already converted (pointer at the instance x0 row, no user row) who
  // then configures Hoarder through the only UI that existed. P0's one-shot seed
  // never looked again, findAllowedByDriver('hoarder') found nothing, and their
  // upload silently went to x0 — a PUBLIC host — instead of their private one.
  it('rescues a user who configured Hoarder AFTER the P0 migration', () => {
    const u = createUser('rec-late-hoarder');
    const x0 = instanceRows().find((r) => r.driver === 'x0')!;
    setUserSetting(u.id, 'uploads.uploader_id', x0.id); // what P0 left them with
    setUserSetting(u.id, 'uploads.provider', 'hoarder');
    setUserSetting(u.id, 'uploads.hoarder.url', 'https://private.example');
    setUserSetting(u.id, 'uploads.hoarder.api_key', 'late-key');

    reconcileLegacyUploadSettings(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('hoarder');
    expect(rows[0].secrets_enc).toContain('late-key');
    // Repointed off x0 and onto their own Hoarder — the bytes stop leaking public.
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(rows[0].id);
    expect(getUserSettings(u.id)['uploads.uploader_id']).not.toBe(x0.id);
  });

  // The other half of the same hole: the row exists, but the credential in it is
  // stale because the user edited the setting afterwards and nothing re-read it.
  it('refreshes a credential the user changed after the P0 migration', () => {
    const u = createUser('rec-stale');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'old-hash');
    reconcileLegacyUploadSettings(db); // stands in for the P0 conversion
    const rowId = userRows(u.id)[0].id;

    // User later changes their userhash through the settings UI.
    setUserSetting(u.id, 'uploads.catbox.userhash', 'new-hash');
    reconcileLegacyUploadSettings(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1); // refreshed in place, not duplicated
    expect(rows[0].id).toBe(rowId);
    expect(rows[0].secrets_enc).toContain('new-hash');
    expect(rows[0].secrets_enc).not.toContain('old-hash');
  });

  it('keeps a credential the user saved but is not currently using', () => {
    const u = createUser('rec-unused');
    setUserSetting(u.id, 'uploads.provider', 'x0'); // uploading to x0 today…
    setUserSetting(u.id, 'uploads.catbox.userhash', 'kept'); // …but this is theirs
    reconcileLegacyUploadSettings(db);

    // We're deleting the only copy of that userhash, so it has to survive as a
    // row they can switch to — not evaporate because it wasn't selected.
    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('catbox');
    expect(rows[0].secrets_enc).toContain('kept');
    // …while their actual selection stays x0.
    const x0 = instanceRows().find((r) => r.driver === 'x0')!;
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(x0.id);
  });

  it('deletes the legacy keys and then no-ops forever', () => {
    const u = createUser('rec-prune');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'h');
    setUserSetting(u.id, 'uploads.paste.enabled', false); // a SURVIVING uploads.* key

    reconcileLegacyUploadSettings(db);

    const remaining = legacyKeys(u.id);
    expect(remaining).not.toContain('uploads.provider');
    expect(remaining).not.toContain('uploads.catbox.userhash');
    // The pipeline/paste keys are not part of this migration and must be intact.
    expect(remaining).toContain('uploads.paste.enabled');
    expect(remaining).toContain('uploads.uploader_id');

    // Second run: guard SELECT finds nothing, so nothing changes.
    const before = userRows(u.id);
    reconcileLegacyUploadSettings(db);
    expect(userRows(u.id)).toEqual(before);
  });

  it('points a local-disk user at the instance local row', () => {
    const u = createUser('rec-local');
    setUserSetting(u.id, 'uploads.provider', 'local');
    reconcileLegacyUploadSettings(db);

    const local = instanceRows().find((r) => r.driver === 'local')!;
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(local.id);
    expect(userRows(u.id)).toHaveLength(0); // zero-config: no user row needed
  });
});
