// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The cache as the route uses it: store, then look up, and everything that can
// go wrong in between. Against a real database and a real directory — the index
// and the bytes living in two places IS the design, so a suite that mocked
// either half would be testing neither.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb } from '../../test-utils/testApp.js';

// ⚠ Delegates to the real module until `dbThrows` is set, so every other test in
// this file runs against a real database and only the fail-soft case sees a
// failure. Patching `db.prepare` used to do this job and stopped working the day
// the statements were hoisted to module scope — which is exactly right for the
// hot path, and left the test asserting nothing.
let dbThrows = false;
vi.mock('../../db/previewCache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/previewCache.js')>();
  const boom = () => {
    throw new Error('SQLITE_BUSY: database is locked');
  };
  return {
    ...actual,
    lookupCached: (key: string) => (dbThrows ? boom() : actual.lookupCached(key)),
    recordCached: (entry: Parameters<typeof actual.recordCached>[0]) =>
      dbThrows ? boom() : actual.recordCached(entry),
    cachedBytes: (backend: string) => (dbThrows ? boom() : actual.cachedBytes(backend)),
  };
});

const ctx = setupTestDb('preview-cache');
const CACHE_DIR = path.join(ctx.tmpDir, 'preview-cache');

let mod: typeof import('./index.js');
let dbmod: typeof import('../../db/previewCache.js');

beforeAll(async () => {
  process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
  process.env.LURKER_PREVIEW_CACHE_DIR = CACHE_DIR;
  // Two 1 KB objects fit; the third forces an eviction.
  process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = '2048';
  await import('../../db/index.js');
  dbmod = await import('../../db/previewCache.js');
  mod = await import('./index.js');
});

afterAll(() => {
  delete process.env.LURKER_PREVIEW_CACHE_MODE;
  delete process.env.LURKER_PREVIEW_CACHE_DIR;
  delete process.env.LURKER_PREVIEW_CACHE_MAX_BYTES;
  ctx.cleanup();
});

beforeEach(async () => {
  const { default: db } = await import('../../db/index.js');
  db.prepare('DELETE FROM preview_cache').run();
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  mod.resetCacheConfigForTests();
});

/**
 * `n` bytes that are actually shaped like an image.
 *
 * ⚠ The filler used to be the whole buffer, and every test here passed with bodies
 * that were just repeated 'a'. The store path now asks what the bytes ARE — a
 * Content-Type is the origin's claim, and an origin someone else controls will
 * answer `image/png` for an HTML document — so a fixture that is not an image is
 * correctly refused. Real signature, exact length, filler behind it: the tests
 * below care about SIZES (ceilings, eviction, truncation), and this keeps those
 * arithmetic while making the fixture honest about what it always stood for.
 */
const bytes = (n: number, fill = 0x61) => {
  const buf = Buffer.alloc(n, fill);
  PNG_SIGNATURE.copy(buf, 0, 0, Math.min(PNG_SIGNATURE.length, n));
  return buf;
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('preview byte cache — local', () => {
  it('stores bytes and gives them back verbatim', async () => {
    const body = bytes(1024, 0x7f);
    expect(await mod.store('a'.repeat(64), body, 'image/png')).toBe(true);

    const hit = await mod.lookup('a'.repeat(64));
    expect(hit?.kind).toBe('buffer');
    if (hit?.kind !== 'buffer') throw new Error('unreachable');
    // ⚠ Byte equality, not length. A cache that returns the right NUMBER of wrong
    // bytes is worse than one that misses, and it would render as a broken image
    // that the browser then holds for a day.
    expect(hit.body.equals(body)).toBe(true);
    expect(hit.contentType).toBe('image/png');
  });

  it('shards the directory instead of piling everything in one', async () => {
    // A million files in one directory is a directory a filesystem walks badly and
    // an operator cannot list. Two hex characters cost nothing from a key that is
    // already a digest.
    const { objectPath } = await import('./local.js');
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    const key = 'ab' + 'c'.repeat(62);
    expect(path.dirname(objectPath(cfg, key))).toBe(path.join(CACHE_DIR, 'ab'));
  });

  it('MISSES when the index says yes but the bytes are gone, and repairs itself', async () => {
    // ⚠⚠ The state this design has to survive: the row and the file live in
    // different places, so a wiped volume, a restored backup or a manual `rm`
    // leaves rows that claim a hit. Without the repair, every one of them costs a
    // failed read before the origin fetch that was going to happen anyway — forever,
    // because nothing else ever revisits the row.
    const key = 'd'.repeat(64);
    await mod.store(key, bytes(512), 'image/gif');
    expect(dbmod.countCached()).toBe(1);

    fs.rmSync(CACHE_DIR, { recursive: true, force: true });

    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
  });

  it('evicts the coldest entry once the ceiling is passed', async () => {
    // Ceiling is 2048; three 1 KB objects cannot all fit.
    await mod.store('1'.repeat(64), bytes(1024), 'image/png');
    await mod.store('2'.repeat(64), bytes(1024), 'image/png');
    expect(dbmod.cachedBytes('local')).toBe(2048);

    await mod.store('3'.repeat(64), bytes(1024), 'image/png');

    // ⚠⚠ EXACTLY two, not "fewer than three". `toBeLessThan(3)` could not tell
    // "evicted the one it had to" from "evicted two" — changing the loop's `<=` to
    // `<` over-evicts by one and left the suite green, which is a cache throwing
    // away a live entry on every store once it is near its ceiling.
    expect(dbmod.countCached()).toBe(2);
    expect(dbmod.cachedBytes('local')).toBe(2048);
    // ⚠ The budget, not a named victim: `last_access` has one-second resolution and
    // these are written in the same tick, so which of the first two is coldest is
    // genuinely a tie — demanding a specific key would assert SQLite's tie-break.
    // The newest surviving is the only ordering guarantee that matters.
    expect(await mod.lookup('3'.repeat(64))).not.toBeNull();
  });

  it('refuses an object bigger than the whole ceiling, without wiping the cache', async () => {
    // ⚠⚠ `evictLocal` loops toward a total it can never reach when the incoming
    // object alone exceeds the ceiling — so it throws away up to a full batch of
    // LIVE entries and then stores the oversized object anyway. A small ceiling with
    // large images therefore means every single store wipes the cache and the hit
    // rate collapses to nothing, each miss paying a full eviction pass on the shared
    // connection for the privilege.
    await mod.store('1'.repeat(64), bytes(1024), 'image/png');
    expect(dbmod.countCached()).toBe(1);

    // The ceiling here is 2048; this is bigger than all of it.
    expect(await mod.store('9'.repeat(64), bytes(4096), 'image/png')).toBe(false);

    expect(dbmod.countCached()).toBe(1);
    expect(await mod.lookup('1'.repeat(64))).not.toBeNull();
  });

  it('settles rather than hanging when the write stream errors', async () => {
    // A write stream that fails at open (ENOTDIR here — the shard directory is
    // replaced by a FILE, which fails the same way for everyone on every platform)
    // must settle and store nothing, rather than leaving the caller waiting.
    //
    // ⚠ HONEST SCOPE: this does NOT distinguish `handle.end(cb)` from waiting on
    // `close`, which is what the implementation was changed to. Node's docs say
    // end's callback "may or may not" be called when a stream errors, and `close`
    // is the event that always fires — but on this runtime the callback did fire
    // for every errno reachable from here, so the mutation stays green. The change
    // is defensive against documented uncertainty, not against a reproduced hang,
    // and saying so is better than a test comment implying otherwise.
    const key = 'c'.repeat(64);
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    const shard = path.dirname(mod.objectPath(cfg, key));
    fs.mkdirSync(cfg.dir, { recursive: true });
    fs.writeFileSync(shard, 'not a directory');

    try {
      // ⚠ The timeout is the assertion. Before the fix this never resolved at all,
      // and a hanging promise reads as a passing test right up until the suite
      // times out with no useful message.
      const settled = await Promise.race([
        mod.store(key, bytes(64), 'image/png'),
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 3000)),
      ]);
      expect(settled).toBe(false);
      expect(dbmod.countCached()).toBe(0);
    } finally {
      fs.rmSync(shard, { force: true });
    }
  });

  it('stores timestamps as ISO-8601 with Z, which is what Date.parse needs', async () => {
    // ⚠⚠ MEASURED, not stylistic. `datetime('now')` yields "YYYY-MM-DD HH:MM:SS",
    // which is not ISO — so V8 parses it as LOCAL time. Verified on this machine:
    // SQLite stored 08:01:12 (UTC) and `Date.parse` read it back as 15:01:12Z, a
    // seven-hour skew straight into the age bound below. It is also the format
    // `link_previews` already uses (NOW_ISO), because ISO-with-Z is
    // lexicographically ordered and so compares correctly as TEXT in SQL.
    //
    // ⚠ The age test below CANNOT see this: it backdates by eight days against a
    // seven-day TTL, and no timezone offset is large enough to flip that. The format
    // is the thing to assert.
    const key = '5'.repeat(64);
    await mod.store(key, bytes(32), 'image/png');
    const { default: db } = await import('../../db/index.js');
    const row = db
      .prepare<[string], { created_at: string; last_access: string }>(
        'SELECT created_at, last_access FROM preview_cache WHERE cache_key = ?',
      )
      .get(key);
    const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    // ⚠ The raw value, not a labelled one — a prefix defeats the `^` anchor and the
    // pattern then matches anything ending in a timestamp. (It did, briefly.)
    expect(row?.created_at).toMatch(ISO_Z);
    expect(row?.last_access).toMatch(ISO_Z);
    // ...and it round-trips to the instant it actually was, within a minute.
    expect(Math.abs(Date.now() - Date.parse(row!.created_at))).toBeLessThan(60_000);
  });

  it('stops serving an entry once it is past the age bound', async () => {
    // ⚠ Eviction is by PRESSURE, so without an age bound an image at a stable
    // address that changed underneath us — an avatar, a `latest.png` — is served
    // from disk indefinitely under `max-age=86400, immutable`. Before this cache
    // existed the staleness window was a day; unbounded is a regression, not a
    // feature.
    //
    // ⚠ The bound is no longer the METADATA TTL, and the decoupling is the point: a
    // page's title changes, and image bytes at the content-addressed URLs most
    // og:images use do not. It is set against the bucket lifecycle rule instead —
    // see MAX_AGE_MS.
    const key = '7'.repeat(64);
    await mod.store(key, bytes(64), 'image/png');
    expect(await mod.lookup(key)).not.toBeNull();

    const { default: db } = await import('../../db/index.js');
    db.prepare(`UPDATE preview_cache SET created_at = datetime('now', '-30 days')`).run();

    expect(await mod.lookup(key)).toBeNull();
    // ...and it is cleared out rather than re-checked on every future request.
    expect(dbmod.countCached()).toBe(0);
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    expect(fs.existsSync(mod.objectPath(cfg, key))).toBe(false);
  });

  it('keeps the index row when a read fails for a reason other than ENOENT', async () => {
    // ⚠⚠ GONE and BROKEN are different. Both are a miss to the caller, so an earlier
    // version collapsed every errno to null and the caller forgot the row for all of
    // them — a transient EMFILE (24 concurrent reads is within this pool's own
    // budget) or an EACCES after a permissions change would delete the index row
    // while the object stayed on disk. That is an orphan eviction can never count
    // and lookup can never find, in a module whose whole premise is that the index
    // is how we know what exists.
    //
    // ⚠ EISDIR rather than chmod: a permissions test passes vacuously when the suite
    // runs as root, which it does in plenty of containers. A directory where a file
    // belongs fails the same way for everyone.
    const key = '8'.repeat(64);
    await mod.store(key, bytes(128), 'image/png');
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    const at = mod.objectPath(cfg, key);
    fs.rmSync(at);
    fs.mkdirSync(at);

    expect(await mod.lookup(key)).toBeNull();
    // The row SURVIVES: we could not read it, which is not the same as it being gone.
    expect(dbmod.countCached()).toBe(1);

    fs.rmdirSync(at);
  });

  it('leaves no file behind for an entry it evicted', async () => {
    for (const n of ['1', '2', '3', '4']) await mod.store(n.repeat(64), bytes(1024), 'image/png');
    const onDisk: string[] = [];
    for (const shard of fs.readdirSync(CACHE_DIR)) {
      for (const f of fs.readdirSync(path.join(CACHE_DIR, shard))) onDisk.push(f);
    }
    // ⚠ Files and rows must agree. Unlinking after forgetting the row would leak a
    // file nothing remembers, and nothing could ever find it again — the index IS
    // how we know what exists.
    expect(onDisk.length).toBe(dbmod.countCached());
    // ...and no temp files survived either.
    expect(onDisk.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('forgets, not just skips, a row left by another backend', async () => {
    // ⚠ A row whose backend no longer matches is unreachable AND uncounted if it is
    // merely skipped — its bytes sit on the volume forever with nothing able to name
    // them, because the index is how we know what exists. Dropping the row is what
    // lets a later store reclaim the space.
    const key = 'e'.repeat(64);
    await mod.store(key, bytes(64), 'image/png');
    dbmod.recordCached({ key, backend: 'somewhere-else', contentType: 'image/png', size: 64 });
    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
  });

  it('MISSES a file that is present but the wrong size, and clears it out', async () => {
    // ⚠⚠ The writer does not fsync before renaming, so a power loss or a killed
    // container can leave a short file under a row that claims the full length.
    // `readFile` succeeds, nothing throws, and the stump would be served with
    // `max-age=86400, immutable` — a permanently broken image every viewer holds for
    // a day. A zero-length Buffer is truthy, so a presence test misses it too.
    const key = 'f'.repeat(64);
    await mod.store(key, bytes(1024), 'image/png');
    const cfg = mod.cacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    fs.writeFileSync(mod.objectPath(cfg, key), Buffer.alloc(10));

    expect(await mod.lookup(key)).toBeNull();
    expect(dbmod.countCached()).toBe(0);
    expect(fs.existsSync(mod.objectPath(cfg, key))).toBe(false);
  });

  it('never throws out of lookup or store, whatever the database does', async () => {
    // ⚠⚠ The module's headline promise, and it was a CLAIM before it was true.
    // `lookupCached` takes a WAL write lock for its `last_access` touch — proven to
    // block even when it matches zero rows — and a SQLITE_BUSY thrown from there
    // escaped into the route, past a `try` that did not open for another seventy
    // lines, and 500'd an image request that would have succeeded with caching
    // switched off. A cache that can break the thing it accelerates is worse than
    // no cache; the guard belongs in this module, where the promise is made.
    dbThrows = true;
    try {
      await expect(mod.lookup('a'.repeat(64))).resolves.toBeNull();
      await expect(mod.store('b'.repeat(64), bytes(16), 'image/png')).resolves.toBe(false);
    } finally {
      dbThrows = false;
    }
  });
});

describe('preview byte cache — what is worth caching', () => {
  it('takes whole images and refuses everything else', () => {
    expect(mod.cacheable('image/png', false)).toBe(true);
    expect(mod.cacheable('image/webp', false)).toBe(true);
    // ⚠ Video and audio are excluded on purpose: 64 MB against images' 8 MB, and
    // they are read by RANGE, so one seek is many requests for one object and a
    // cached copy would have to answer partial reads. Buffering those per miss
    // trades bandwidth for unbounded memory.
    expect(mod.cacheable('video/mp4', false)).toBe(false);
    expect(mod.cacheable('audio/mpeg', false)).toBe(false);
    expect(mod.cacheable('text/html', false)).toBe(false);
    expect(mod.cacheable(undefined, false)).toBe(false);
    // ⚠ A range request is passed straight through. Serving a whole object to a
    // request that asked for bytes 100-200 is a correctness bug, not a slow path.
    expect(mod.cacheable('image/png', true)).toBe(false);
  });

  it('is off, and answers nothing, when the mode is off', async () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'off';
    mod.resetCacheConfigForTests();
    try {
      expect(mod.cacheEnabled()).toBe(false);
      expect(mod.cacheable('image/png', false)).toBe(false);
      expect(await mod.store('f'.repeat(64), bytes(16), 'image/png')).toBe(false);
      expect(await mod.lookup('f'.repeat(64))).toBeNull();
    } finally {
      process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
      mod.resetCacheConfigForTests();
    }
  });
});
