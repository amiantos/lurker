// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import sharp from 'sharp';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';
import type { UploadSource } from '../services/uploadProviders/source.js';
import type { ContentClass } from '../services/uploadProviders/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '../utils/dataDir.js';

const ctx = setupTestDb('routes-uploads');

// The free-disk floor, switchable per test (same shape as uploadSessions.test.ts).
const disk = vi.hoisted(() => ({ full: false, asked: [] as number[] }));
vi.mock('../utils/diskSpace.js', () => ({
  FREE_DISK_FLOOR_BYTES: 1024 ** 3,
  hasFreeSpaceFor: (_dir: string, bytes: number) => {
    disk.asked.push(bytes);
    return !disk.full;
  },
}));

// Stub driver — the route exercises resolve/upload/url plumbing without reaching
// the real network. Behavior is configurable per-test via state on the
// module-level `stub`. The seed migration creates a real `x0` instance default in
// the test DB; the resolver falls back to it, and the mocked getDriver returns
// this stub for whatever driver id the resolved uploader names.
const stub = {
  driver: 'stub',
  label: 'Stub',
  capabilities: {
    storesRemotely: true,
    supportsDelete: false,
    mintsKeys: false,
    acceptsContentClasses: ['image', 'text'] as ContentClass[],
  },
  configSchema: [],
  shouldThrow: null as Error | null,
  capturedConfig: null as Record<string, string> | null,
  // When set, upload() returns this instead of the default remote URL — used to
  // exercise the storesRemotely:false (local-style relative URL) absolutization.
  nextResult: null as { url: string; ref?: string } | null,
  capturedDeleteRef: null as string | null,
  // What the route handed us. Drivers take an UploadSource now (#543): a
  // passthrough upload must arrive as a `file` (streamed off multer's temp file,
  // never in the heap), while an optimized image arrives as a small `buffer`.
  capturedSource: null as UploadSource | null,
  // The bytes the driver was actually given — the only place to prove that what
  // leaves the building is scrubbed, since the temp file is unlinked afterwards.
  capturedBytes: null as Buffer | null,
  capturedMeta: null as { filename: string; mime: string } | null,
  // Set to simulate a driver that streams its body, so the route's progress wiring
  // (#545) can be driven end to end: the real byte counting lives in multipart.ts and
  // is tested against a real socket there, but ONLY a driver call proves the route
  // actually handed its callback down.
  emitBytes: null as { total: number } | null,
  async upload(
    source: UploadSource,
    meta: { filename: string; mime: string; onProgress?: (s: number, t: number) => void },
    config?: Record<string, string>,
  ) {
    stub.capturedConfig = config ?? null;
    stub.capturedSource = source;
    stub.capturedMeta = meta;
    stub.capturedBytes =
      source.kind === 'file' ? fs.readFileSync(source.path) : Buffer.from(source.data);
    if (stub.emitBytes && meta.onProgress) {
      const { total } = stub.emitBytes;
      meta.onProgress(Math.floor(total / 2), total);
      meta.onProgress(total, total);
    }
    if (stub.shouldThrow) throw stub.shouldThrow;
    if (stub.nextResult) return stub.nextResult;
    return { url: `https://stub.example/${meta.filename}` };
  },
  async delete(ref: string) {
    stub.capturedDeleteRef = ref;
  },
};

// Capture the WS frames the upload route fans out (#545) while leaving the rest of
// wsHub real — createTestApp wires the actual hub, so replacing the whole module
// would take attachWsHub with it.
const fanOutSpy = vi.fn<(userId: number, payload: unknown) => void>();
vi.mock('../services/wsHub.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wsHub.js')>()),
  fanOutToUser: (userId: number, payload: unknown) => fanOutSpy(userId, payload),
}));

// Mock the registry so getDriver returns the stub for whatever driver the
// resolved uploader names. splitConfigBySchema is provided because
// db/uploaderConfig.ts imports it at load; the resolver reads driver.capabilities
// + driver.configSchema off the stub.
vi.mock('../services/uploadProviders/index.js', () => ({
  driverIds: ['x0', 'catbox', 'hoarder'],
  getDriver: () => stub,
  splitConfigBySchema: (_driver: unknown, values: Record<string, string>) => ({
    config: values,
    secrets: {},
  }),
}));

let app: Express;
let agent: LurkerTestAgent;
let user: User;
let smallPng: Buffer;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const router = (await import('./uploads.js')).default;

  user = createUser('upload-alice');
  app = createTestApp({ '/api/uploads': router });
  agent = await createAuthedAgent(app, user.id);

  // Real 16x16 image bytes so the sharp pipeline runs end-to-end without
  // needing a fixture file.
  smallPng = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
});

afterAll(() => ctx.cleanup());

describe('POST /api/uploads', () => {
  it('rejects unauthenticated', async () => {
    const res = await createAnonAgent(app).post('/api/uploads');
    expect(res.status).toBe(401);
  });

  // #1131: with the ceiling the admin's to raise, one request can be as large as
  // the disk, so the single-request path checks the floor a session does.
  it('507s before reading a file the disk has no room for', async () => {
    disk.full = true;
    disk.asked.length = 0;
    try {
      const res = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });
      expect(res.status).toBe(507);
      // Asked for the body it was told about, not for the whole cap.
      expect(disk.asked).toHaveLength(1);
      expect(disk.asked[0]).toBeGreaterThanOrEqual(smallPng.length);
      expect(disk.asked[0]).toBeLessThan(smallPng.length + 4096);
    } finally {
      disk.full = false;
    }
  });

  it('400 when no file is attached', async () => {
    const res = await agent.post('/api/uploads');
    expect(res.status).toBe(400);
  });

  it('uploads an image through the stub provider and records history', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/stub\.example\//);
    expect(typeof res.body.id).toBe('number');

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row).toBeTruthy();
    // Whatever the registry default is, the route persists it as the
    // provider id and our mocked getProvider routed to the stub uploader.
    expect(row.provider).toBe('x0');
    expect(row.thumbnail_url).toBe(`/api/uploads/${res.body.id}/thumb`);
  });

  it('uploads a text/plain attachment via the long-message → .txt path', async () => {
    const res = await agent.post('/api/uploads').attach('image', Buffer.from('hello there'), {
      filename: 'note.txt',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.txt$/);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    // Text uploads have no thumbnail.
    expect(row.thumbnail_url).toBeUndefined();
  });

  // #788, end to end. These bytes always went through — a `.md` is signature-less
  // UTF-8, exactly what the text branch takes — but came back as `.txt`, and the
  // recorded mime lost the one thing telling an editor how to read the file.
  it('keeps a markdown or JSON upload under its own name and mime', async () => {
    const cases: [string, string, string, string][] = [
      ['README.md', 'text/markdown', 'md', 'text/markdown'],
      ['data.json', 'application/json', 'json', 'application/json'],
      // The Windows gap: no registered mime for `.md`, so the claim arrives as plain
      // text and the filename is the only signal left.
      ['notes.md', 'text/plain', 'md', 'text/markdown'],
    ];
    for (const [filename, contentType, ext, mime] of cases) {
      const res = await agent
        .post('/api/uploads')
        .attach('image', Buffer.from('# notes — ünïcodé\n'), { filename, contentType });
      expect({ filename, status: res.status }).toEqual({ filename, status: 200 });
      expect(res.body.url).toMatch(new RegExp(`\\.${ext}$`));

      const list = await agent.get('/api/uploads');
      const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
      expect({ filename, mime: row.mime }).toEqual({ filename, mime });
      // …and it is findable under the filter it belongs to, which for JSON only works
      // because the kind clause names the mime explicitly (shared/uploadKinds.ts).
      const filtered = await agent.get('/api/uploads?kind=text');
      expect(filtered.body.items.map((r: { id: number }) => r.id)).toContain(res.body.id);
    }
  });

  // The relaxation is bounded by the dialect table, not by the caller. An `.html` that
  // decodes as UTF-8 is still text, and must never name the key we serve.
  it('will not let an unlisted extension become the served one', async () => {
    const res = await agent
      .post('/api/uploads')
      .attach('image', Buffer.from('<b>not markup to us</b>'), {
        filename: 'evil.html',
        contentType: 'text/html',
      });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.txt$/);
    expect(res.body.url).not.toContain('html');
  });

  it('preserves an animated GIF (no re-encode)', async () => {
    // sharp().gif() above produces a single-frame GIF, which the pipeline
    // re-encodes as JPEG. The 'animated bypass' branch is exercised when
    // metadata.pages > 1. Since we don't have a real animated buffer
    // handy, drop a minimal 2-frame GIF created via sharp's joinImages.
    // (sharp's `animated: true` option requires composing multiple frames.)
    const frame = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .raw()
      .toBuffer();
    const animated = await sharp(frame, { raw: { width: 8, height: 8, channels: 3 } })
      .gif({ loop: 0 })
      .toBuffer();
    const res = await agent
      .post('/api/uploads')
      .attach('image', animated, { filename: 'anim.gif', contentType: 'image/gif' });
    expect(res.status).toBe(200);
  });

  it('maps PROVIDER_AUTH into 502 — provider auth is not session auth', async () => {
    // A 401 here would trip the client's bounce-to-login handler and hard-reload
    // the app over a bad *provider* credential while the Lurker session is fine.
    const err = Object.assign(new Error('bad creds'), { code: 'PROVIDER_AUTH' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'auth.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    stub.shouldThrow = null;
  });

  it('maps PROVIDER_CONFIG into 400', async () => {
    const err = Object.assign(new Error('missing config'), { code: 'PROVIDER_CONFIG' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'cfg.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    stub.shouldThrow = null;
  });

  it('maps unknown provider errors into 502', async () => {
    const err = Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
    stub.shouldThrow = err;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'down.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    stub.shouldThrow = null;
  });

  it('rejects a content class the resolved driver does not accept (415)', async () => {
    const prev = stub.capabilities.acceptsContentClasses;
    stub.capabilities.acceptsContentClasses = ['image']; // no text
    try {
      const res = await agent.post('/api/uploads').attach('image', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });
      expect(res.status).toBe(415);
    } finally {
      stub.capabilities.acceptsContentClasses = prev;
    }
  });
});

describe('POST /api/uploads — an avatar (#1189)', () => {
  it('crops the image square, and thumbs the crop', async () => {
    const wide = await sharp({
      create: { width: 60, height: 40, channels: 3, background: { r: 0, g: 200, b: 0 } },
    })
      .png()
      .toBuffer();
    const res = await agent
      .post('/api/uploads')
      .field('purpose', 'avatar')
      .attach('image', wide, { filename: 'me.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    const meta = await sharp(stub.capturedBytes!).metadata();
    expect([meta.width, meta.height]).toEqual([40, 40]);
  });

  it('refuses a file that is not an image', async () => {
    const res = await agent
      .post('/api/uploads')
      .field('purpose', 'avatar')
      .attach('image', Buffer.from('hello'), { filename: 'me.txt', contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('an avatar must be an image');
  });

  it('400s a purpose it does not know', async () => {
    const res = await agent
      .post('/api/uploads')
      .field('purpose', 'banner')
      .attach('image', smallPng, { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});

describe('local-style (storesRemotely:false) uploads', () => {
  it('absolutizes a relative driver URL against the request origin', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/abcdef012345.png', ref: 'abcdef012345.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', 'irc.example.com')
        .attach('image', smallPng, { filename: 'local.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://irc.example.com/uploads/abcdef012345.png');

      // The absolutized URL — not the relative one — is what gets persisted.
      const list = await agent.get('/api/uploads');
      const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
      expect(row.url).toBe('https://irc.example.com/uploads/abcdef012345.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('ignores a spoofed non-http(s) X-Forwarded-Proto', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/ccddeeff0011.png', ref: 'ccddeeff0011.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Proto', 'javascript')
        .set('X-Forwarded-Host', 'irc.example.com')
        .attach('image', smallPng, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // The bogus scheme is dropped; never javascript://.
      expect(res.body.url).toBe('https://irc.example.com/uploads/ccddeeff0011.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('leaves the URL relative when the forwarded host is malformed', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/223344556677.png', ref: '223344556677.png' };
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Host', 'evil.example.com/@attacker')
        .attach('image', smallPng, { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // A host with authority-breaking chars is rejected → no base is prefixed.
      expect(res.body.url).toBe('/uploads/223344556677.png');
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('prefers PUBLIC_BASE_URL over the request origin when set', async () => {
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/aabbccddeeff.png', ref: 'aabbccddeeff.png' };
    process.env.PUBLIC_BASE_URL = 'https://cdn.example.org/';
    try {
      const res = await agent
        .post('/api/uploads')
        .set('X-Forwarded-Host', 'ignored.example.com')
        .attach('image', smallPng, { filename: 'local2.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      // Trailing slash on the base is trimmed; the request host is ignored.
      expect(res.body.url).toBe('https://cdn.example.org/uploads/aabbccddeeff.png');
    } finally {
      delete process.env.PUBLIC_BASE_URL;
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });

  it('destroys the bytes via driver.delete before removing a deletable upload', async () => {
    stub.capabilities.storesRemotely = false;
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: '/uploads/112233445566.png', ref: '112233445566.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'reap.png', contentType: 'image/png' });
      expect(up.status).toBe(200);
      expect(up.body.can_delete).toBe(true);

      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(200);
      // Bytes-first: by the time the response lands, the driver has run.
      expect(stub.capturedDeleteRef).toBe('112233445566.png');
      const list = await agent.get('/api/uploads');
      expect(list.body.items.find((r: { id: number }) => r.id === up.body.id)).toBeFalsy();
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('refuses to delete when the driver cannot destroy the bytes (no fake delete)', async () => {
    // A ref is present, but supportsDelete is false → there is no "remove the
    // record but leave the file up" path; the request is refused and the row stays.
    stub.capabilities.storesRemotely = false;
    stub.nextResult = { url: '/uploads/778899aabbcc.png', ref: '778899aabbcc.png' };
    stub.capturedDeleteRef = null;
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'keep.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(false);
      const del = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(del.status).toBe(409);
      expect(stub.capturedDeleteRef).toBeNull();
      const list = await agent.get('/api/uploads');
      expect(list.body.items.find((r: { id: number }) => r.id === up.body.id)).toBeTruthy();
    } finally {
      stub.capabilities.storesRemotely = true;
      stub.nextResult = null;
    }
  });
});

// #545. The pieces are unit-tested (multipart.ts counts real socket bytes;
// uploadProgress.ts throttles), but only the route proves they were wired together:
// that it announces the phases the browser can't see, and that it actually hands its
// byte callback DOWN to the driver.
describe('POST /api/uploads — progress narration', () => {
  const frames = () =>
    fanOutSpy.mock.calls
      .map((c) => c[1] as { kind: string; phase: string; percent: number | null; token: string })
      .filter((f) => f.kind === 'upload-progress');

  it('narrates processing → sending, with the provider byte count', async () => {
    fanOutSpy.mockClear();
    stub.emitBytes = { total: 1000 };
    try {
      const res = await agent
        .post('/api/uploads')
        .field('progressToken', 'tok-abc')
        .attach('image', smallPng, { filename: 'p.png', contentType: 'image/png' });
      expect(res.status).toBe(200);

      // The driver really was given the callback — the wiring this test exists for.
      expect(typeof (stub.capturedMeta as any).onProgress).toBe('function');

      const seen = frames();
      expect(seen.every((f) => f.token === 'tok-abc')).toBe(true);
      expect(seen.map((f) => `${f.phase}:${f.percent}`)).toEqual([
        'processing:null',
        // Indeterminate until a byte is actually counted — a driver that reports none
        // (local) must not sit at a frozen "0%".
        'sending:null',
        // The 50% frame is swallowed by the throttle (both callbacks land in the same
        // millisecond here); 100 always survives it, because a bar stranded at 99%
        // would be the same lie in a new outfit.
        'sending:100',
      ]);
    } finally {
      stub.emitBytes = null;
    }
  });

  // The token is echoed in every progress frame, and those go to all the user's
  // devices as JSON, so its cap must not split an emoji (#1038).
  it('caps a long token without splitting an emoji', async () => {
    fanOutSpy.mockClear();
    stub.emitBytes = { total: 1000 };
    try {
      const res = await agent
        .post('/api/uploads')
        .field('progressToken', 'x'.repeat(63) + '😀')
        .attach('image', smallPng, { filename: 'p.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      const seen = frames();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((f) => f.token === 'x'.repeat(63))).toBe(true);
    } finally {
      stub.emitBytes = null;
    }
  });

  // Progress is a courtesy, never a precondition. An older client that sends no token
  // must upload exactly as before — and cost the server nothing.
  it('stays silent when the client sends no token', async () => {
    fanOutSpy.mockClear();
    stub.emitBytes = { total: 1000 };
    try {
      const res = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'q.png', contentType: 'image/png' });
      expect(res.status).toBe(200);
      expect(res.body.url).toBeTruthy();
      expect(frames()).toEqual([]);
    } finally {
      stub.emitBytes = null;
    }
  });

  // NOTE: "the thumbnail upload must not drive the bar" is asserted in
  // uploads.node.test.ts, not here. Standalone keeps the thumb as an inline BLOB, so
  // the driver is only ever called once and the test would pass without proving
  // anything. It only bites where hostsThumbnails sends the thumb through the driver
  // as a second upload.
});

// #547. The WHERE clauses are exercised in db/uploadHistory.test.ts; this is about the
// route actually plumbing the query params into them, and refusing to be steered by a
// kind it doesn't recognize.
describe('GET /api/uploads — search params', () => {
  const upload = async (filename: string, contentType: string, body: Buffer) =>
    agent.post('/api/uploads').attach('image', body, { filename, contentType });

  beforeAll(async () => {
    await upload('needle-in-haystack.png', 'image/png', smallPng);
    await upload('unrelated.png', 'image/png', smallPng);
    await upload('needle.txt', 'text/plain', Buffer.from('hay'));
  });

  it('filters by filename substring', async () => {
    const res = await agent.get('/api/uploads?q=needle');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { filename: string }) => i.filename).toSorted()).toEqual([
      'needle-in-haystack.png',
      'needle.txt',
    ]);
  });

  it('filters by kind, and combines it with the search', async () => {
    const res = await agent.get('/api/uploads?q=needle&kind=text');
    expect(res.body.items.map((i: { filename: string }) => i.filename)).toEqual(['needle.txt']);
  });

  // Arbitrary user text arrives here. A term with a URL metacharacter has to survive
  // the trip, and one with a LIKE metacharacter must not become a wildcard.
  it('handles a search term with special characters', async () => {
    await upload('100% & done.png', 'image/png', smallPng);
    const res = await agent.get(`/api/uploads?q=${encodeURIComponent('100% & done')}`);
    expect(res.body.items.map((i: { filename: string }) => i.filename)).toEqual([
      '100% & done.png',
    ]);
  });

  // A kind we never shipped can only come from a hand-typed URL. Showing everything
  // beats erroring out of a browse.
  it('ignores an unknown kind rather than failing', async () => {
    const res = await agent.get('/api/uploads?kind=malware');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  // The 200 cap lands inside the emoji. Half of one reaches SQLite as U+FFFD,
  // and a query ending in that matches nothing (#1038).
  it('caps a long search term without splitting an emoji', async () => {
    const stem = 'q'.repeat(199);
    await upload(`${stem}😀.png`, 'image/png', smallPng);
    const res = await agent.get(`/api/uploads?q=${encodeURIComponent(`${stem}😀`)}`);
    expect(res.body.items.map((i: { filename: string }) => i.filename)).toEqual([`${stem}😀.png`]);
  });

  it('returns an empty list, not an error, when nothing matches', async () => {
    const res = await agent.get('/api/uploads?q=zzzz-no-such-file');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// Starred uploads — the user's own quick-access set, backing the composer picker.
describe('uploads favourites', () => {
  const upload = async (filename: string) => {
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename, contentType: 'image/png' });
    return res.body.id as number;
  };
  const favorites = async (query = '') =>
    (await agent.get(`/api/uploads?favorites=1${query}`)).body.items as Array<{
      id: number;
      filename: string;
      favorite: boolean;
    }>;

  // Every test starts from an empty starred set — they share one DB, and a star
  // left behind by a neighbour would show up as an extra row in someone else's
  // assertion about the whole list.
  afterEach(async () => {
    for (const row of await favorites()) await agent.delete(`/api/uploads/${row.id}/favorite`);
  });

  it('stars an upload, and the list reflects it both ways', async () => {
    const id = await upload('star-me.png');

    const before = await agent.get('/api/uploads');
    expect(before.body.items.find((r: { id: number }) => r.id === id).favorite).toBe(false);
    expect(await favorites()).toEqual([]);

    const put = await agent.put(`/api/uploads/${id}/favorite`);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true, favorite: true });

    expect((await favorites()).map((r) => r.id)).toEqual([id]);
    const after = await agent.get('/api/uploads');
    expect(after.body.items.find((r: { id: number }) => r.id === id).favorite).toBe(true);
  });

  it('unstars it again', async () => {
    const id = await upload('unstar-me.png');
    await agent.put(`/api/uploads/${id}/favorite`);

    const del = await agent.delete(`/api/uploads/${id}/favorite`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, favorite: false });
    expect(await favorites()).toEqual([]);
  });

  // The route's 404 has to mean "no such upload", not "wasn't starred" — otherwise
  // a client that unstars a row it already unstarred (a double click, a second tab)
  // surfaces a phantom error.
  it('unstarring an already-unstarred upload succeeds rather than 404ing', async () => {
    const id = await upload('never-starred.png');
    const del = await agent.delete(`/api/uploads/${id}/favorite`);
    expect(del.status).toBe(200);
  });

  it("404s for an upload that doesn't exist", async () => {
    expect((await agent.put('/api/uploads/999999/favorite')).status).toBe(404);
    expect((await agent.delete('/api/uploads/999999/favorite')).status).toBe(404);
  });

  // ⚠ The whole reason favourites store a timestamp instead of a boolean. Star a
  // two-year-old upload today and it belongs at the FRONT of your quick-access
  // list — under `id DESC` it would sink to the bottom, which is exactly the
  // opposite of what starring it meant.
  it('orders by when you starred, not by when you uploaded', async () => {
    const older = await upload('older-upload.png');
    const newer = await upload('newer-upload.png');
    expect(newer).toBeGreaterThan(older);

    await agent.put(`/api/uploads/${newer}/favorite`);
    // favorited_at has millisecond resolution and `id DESC` breaks exact ties, so
    // without a gap here the assertion could pass for the wrong reason.
    await new Promise((r) => setTimeout(r, 10));
    await agent.put(`/api/uploads/${older}/favorite`);

    expect((await favorites()).map((r) => r.id)).toEqual([older, newer]);
  });

  it('composes with the kind and search filters', async () => {
    const png = await upload('starred-picture.png');
    const txt = (
      await agent.post('/api/uploads').attach('image', Buffer.from('notes'), {
        filename: 'starred-notes.txt',
        contentType: 'text/plain',
      })
    ).body.id as number;
    const unstarred = await upload('starred-picture-decoy.png');

    await agent.put(`/api/uploads/${png}/favorite`);
    await agent.put(`/api/uploads/${txt}/favorite`);

    expect((await favorites()).map((r) => r.id).toSorted()).toEqual([png, txt].toSorted());
    expect((await favorites('&kind=image')).map((r) => r.id)).toEqual([png]);
    expect((await favorites('&q=notes')).map((r) => r.id)).toEqual([txt]);
    // The decoy matches the search but was never starred.
    expect((await favorites('&q=starred-picture')).map((r) => r.id)).toEqual([png]);
    expect(unstarred).toBeGreaterThan(0);
  });

  // A moderated takedown destroys the bytes but keeps the row as a tombstone. It
  // must not sit in a quick-access list offering to insert a URL that now 404s —
  // but the owner still has to be able to unstar it.
  it('drops a moderated upload out of the starred view, yet still lets it be unstarred', async () => {
    const { markUploadRemovedById } = await import('../db/uploadHistory.js');
    const id = await upload('taken-down.png');
    await agent.put(`/api/uploads/${id}/favorite`);
    expect((await favorites()).map((r) => r.id)).toEqual([id]);

    markUploadRemovedById(id);
    expect(await favorites()).toEqual([]);

    // Still reachable through the unfiltered browse, still flagged as starred, and
    // the unstar goes through.
    const all = await agent.get('/api/uploads');
    const row = all.body.items.find((r: { id: number }) => r.id === id);
    expect(row.removed).toBe(true);
    expect(row.favorite).toBe(true);
    expect((await agent.delete(`/api/uploads/${id}/favorite`)).status).toBe(200);
  });

  it('never leaks the favourite timestamp to the client — just the boolean', async () => {
    const id = await upload('boolean-only.png');
    await agent.put(`/api/uploads/${id}/favorite`);
    const row = (await favorites())[0];
    expect(row.favorite).toBe(true);
    expect(row).not.toHaveProperty('favorited_at');
  });
});

// #627: clients hardcoded a cap because nothing advertised one — lurker-ios shipped
// a Cloudflare-safe 90 MiB guess that is simply wrong for a self-hoster.
describe('GET /api/uploads — advertised size cap', () => {
  // DELETE rather than restore-to-a-number: this user had no row for the key
  // before, so the registry default applied for the rest of the file. Writing a
  // value here would silently re-cap every later test in the file.
  afterEach(async () => {
    delete process.env.LURKER_MAX_UPLOAD_MB;
    const { deleteUserSetting } = await import('../db/settings.js');
    deleteUserSetting(user.id, 'uploads.image.max_upload_mb');
  });

  it("advertises the user's effective cap in bytes", async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    const res = await agent.get('/api/uploads');
    expect(res.status).toBe(200);
    expect(res.body.maxUploadBytes).toBe(25 * 1024 * 1024);
  });

  // The whole point of the feature: what the client is told has to account for the
  // proxy in front of us, not just the cap this process knows how to enforce. Note
  // the number is NOT 100 MiB — decimal MB, minus the multipart envelope, because
  // the proxy's limit is on the whole body while this describes the file part.
  it('reports the transport ceiling when it is lower than the user cap', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 200);
    process.env.LURKER_MAX_UPLOAD_MB = '100';
    const res = await agent.get('/api/uploads');
    expect(res.body.maxUploadBytes).toBe(100 * 1_000_000 - 64 * 1024);
    // A client that compressed to exactly this and added an envelope still fits.
    expect(res.body.maxUploadBytes).toBeLessThan(100 * 1_000_000);
  });
});

// #872: the longest edge the pipeline keeps, so a client can shrink a 48MP photo
// instead of uploading ~100 MB to produce a ~300 KB WebP.
describe('GET /api/uploads — advertised image dimension', () => {
  afterEach(async () => {
    const { deleteUserSetting } = await import('../db/settings.js');
    deleteUserSetting(user.id, 'uploads.image.max_dimension');
  });

  it("advertises the user's effective static-image dimension", async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_dimension', 1280);
    const res = await agent.get('/api/uploads');
    expect(res.status).toBe(200);
    expect(res.body.maxStaticImageDimension).toBe(1280);
  });
});

describe('POST /api/uploads — transport ceiling (#627)', () => {
  afterEach(async () => {
    delete process.env.LURKER_MAX_UPLOAD_MB;
    const { deleteUserSetting } = await import('../db/settings.js');
    deleteUserSetting(user.id, 'uploads.image.max_upload_mb');
  });

  // An over-ceiling body would be killed at the edge with a connection reset the
  // client can't interpret. Enforcing the operator's declared limit here turns that
  // into a 413 naming the real number.
  it('refuses a body over the declared proxy limit with a 413, even under the user cap', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 200);
    process.env.LURKER_MAX_UPLOAD_MB = '5';
    const big = Buffer.alloc(6 * 1024 * 1024, 0x7a);
    const res = await agent
      .post('/api/uploads')
      .attach('image', big, { filename: 'big.bin', contentType: 'text/plain' });
    expect(res.status).toBe(413);
    // 4.7, not 5: the 413 has to name the number the user can actually hit, or
    // they come back with another file that fails the same way.
    expect(res.body.error).toBe('file exceeds 4.7 MB');
  });
});

describe('GET /api/uploads/:id/thumb', () => {
  it('serves thumbnail bytes', async () => {
    const upload = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'thumby.png', contentType: 'image/png' });
    const res = await agent.get(`/api/uploads/${upload.body.id}/thumb`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("404 for an id we don't own", async () => {
    const res = await agent.get('/api/uploads/999999/thumb');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/uploads/:id', () => {
  it('409 for a row without a delete handle (no ref → never deletable)', async () => {
    // The stub's default upload result carries no ref — like x0 or an anonymous
    // catbox upload. Its row must refuse deletion and stay put.
    const upload = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'delete-me.png', contentType: 'image/png' });
    expect(upload.body.can_delete).toBe(false);
    const del = await agent.delete(`/api/uploads/${upload.body.id}`);
    expect(del.status).toBe(409);
    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === upload.body.id);
    expect(row).toBeTruthy();
    expect(row.can_delete).toBe(false);
  });

  it("404 for a row that doesn't exist", async () => {
    const res = await agent.delete('/api/uploads/999999');
    expect(res.status).toBe(404);
  });

  it('keeps the row and surfaces the failure when the driver delete throws', async () => {
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/fail.png', ref: 'fail.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'fail.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(true);

      const origDelete = stub.delete;
      stub.delete = async () => {
        throw Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
      };
      try {
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(502);
      } finally {
        stub.delete = origDelete;
      }
      // The bytes weren't destroyed, so the record must survive for a retry.
      const list = await agent.get('/api/uploads');
      const row = list.body.items.find((r: { id: number }) => r.id === up.body.id);
      expect(row).toBeTruthy();
      expect(row.can_delete).toBe(true);

      // And the retry succeeds once the driver recovers.
      const retry = await agent.delete(`/api/uploads/${up.body.id}`);
      expect(retry.status).toBe(200);
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('maps a PROVIDER_AUTH delete failure to 502, never 401', async () => {
    // 401 would make the client treat a revoked provider token as a dead Lurker
    // session and reload to the login page mid-click.
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/auth.png', ref: 'auth.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'auth.png', contentType: 'image/png' });
      const origDelete = stub.delete;
      stub.delete = async () => {
        throw Object.assign(new Error('bad creds'), { code: 'PROVIDER_AUTH' });
      };
      try {
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(502);
      } finally {
        stub.delete = origDelete;
      }
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });

  it('409s (and hides the button) when the config no longer satisfies canDeleteWith', async () => {
    // catbox-shaped case: the row captured a ref while a userhash existed, but
    // the config has since lost it. The row must not advertise can_delete and
    // the route must refuse — a button that always errors is not offered.
    stub.capabilities.supportsDelete = true;
    stub.nextResult = { url: 'https://stub.example/hash.png', ref: 'hash.png' };
    try {
      const up = await agent
        .post('/api/uploads')
        .attach('image', smallPng, { filename: 'hash.png', contentType: 'image/png' });
      expect(up.body.can_delete).toBe(true);

      (stub as { canDeleteWith?: (c: Record<string, string>) => boolean }).canDeleteWith = () =>
        false;
      try {
        const list = await agent.get('/api/uploads');
        const row = list.body.items.find((r: { id: number }) => r.id === up.body.id);
        expect(row.can_delete).toBe(false);
        const del = await agent.delete(`/api/uploads/${up.body.id}`);
        expect(del.status).toBe(409);
      } finally {
        delete (stub as { canDeleteWith?: unknown }).canDeleteWith;
      }
    } finally {
      stub.capabilities.supportsDelete = false;
      stub.nextResult = null;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #543: uploads stream through a temp file instead of living in the heap. What
// matters here is the shape handed to the driver and that the temp file never
// outlives the request — an orphan per upload is a slow disk leak.
const tmpDir = (): string => path.join(resolveDataDir(), 'tmp', 'uploads');
const tempFiles = (): string[] => {
  try {
    return fs.readdirSync(tmpDir()).filter((f) => f.startsWith('up-'));
  } catch {
    return [];
  }
};
// The handler unlinks the temp file in a `finally`, which runs AFTER the response
// is sent, so poll — and poll for the ABSOLUTE invariant (the dir drains to empty),
// not a delta against a `before` count, which is itself racy against a preceding
// test's pending unlink.
const waitForNoTemps = async (timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (tempFiles().length > 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`temp files not cleaned up: ${tempFiles().join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('temp-file lifecycle (#543)', () => {
  // The handler unlinks the temp file in a `finally`, which runs AFTER the response
  // is sent — so the client can observe the reply before the unlink has landed.
  // Two consequences, both of which bit this test in CI:
  //   1. Assert by polling, not on the next line (same-tick passes locally, loses
  //      the race on a slower runner).
  //   2. Assert the ABSOLUTE invariant — the temp dir drains to empty — not a
  //      delta against a `before` count, because a previous test's pending unlink
  //      makes that baseline itself a race.
  const waitForNoTemps = async (timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (tempFiles().length > 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`temp files not cleaned up: ${tempFiles().join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const tempFiles = (): string[] => {
    try {
      return fs.readdirSync(tmpDir()).filter((f) => f.startsWith('up-'));
    } catch {
      return [];
    }
  };

  it('hands the driver a FILE source for passthrough, a BUFFER source for images', async () => {
    stub.shouldThrow = null;

    // Text passes through untouched: it must arrive as a file the driver streams,
    // never read into memory. This is the property the whole PR exists for.
    await agent.post('/api/uploads').attach('image', Buffer.from('a passthrough upload'), {
      filename: 'note.txt',
      contentType: 'text/plain',
    });
    expect(stub.capturedSource!.kind).toBe('file');

    // An image is re-encoded by the pipeline, so what goes out is the optimized
    // buffer — small, bounded, and not worth a temp-file round trip.
    await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'pic.png', contentType: 'image/png' });
    expect(stub.capturedSource!.kind).toBe('buffer');
    await waitForNoTemps();
  });

  it('removes the temp file after a successful upload', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'clean.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    await waitForNoTemps();
  });

  it('removes the temp file when the driver fails', async () => {
    stub.shouldThrow = Object.assign(new Error('upstream down'), { code: 'PROVIDER_ERROR' });
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'boom.png', contentType: 'image/png' });
    expect(res.status).toBe(502);
    // A failed upload must not strand its bytes on disk.
    await waitForNoTemps();
    stub.shouldThrow = null;
  });

  it('rejects an over-cap upload with 413 — mid-stream, not after ingesting it', async () => {
    const { setUserSetting } = await import('../db/settings.js');
    setUserSetting(user.id, 'uploads.image.max_upload_mb', 1);
    try {
      const big = Buffer.alloc(2 * 1024 * 1024, 0x7a); // 2 MB against a 1 MB cap
      const res = await agent
        .post('/api/uploads')
        .attach('image', big, { filename: 'big.bin', contentType: 'text/plain' });
      expect(res.status).toBe(413);
      // multer aborts and unlinks its own partial file when the limit trips.
      await waitForNoTemps();
    } finally {
      setUserSetting(user.id, 'uploads.image.max_upload_mb', 25);
    }
  });

  it('sweeps orphaned temp files a crash left behind, but never a live one', async () => {
    const { sweepTempUploads } = await import('./uploads.js');
    fs.mkdirSync(tmpDir(), { recursive: true });
    const stale = path.join(tmpDir(), 'up-stale-orphan');
    const fresh = path.join(tmpDir(), 'up-fresh-inflight');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    // Backdate the orphan past the age gate; the fresh one stands in for an
    // upload in flight right now, which a sweep must not yank out from under.
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(old), new Date(old));

    const removed = await sweepTempUploads();
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.unlinkSync(fresh);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #515: media uploads. The route classifies from magic bytes and scrubs metadata
// before dispatch — the two things that make "we accept video" safe to say.
describe('filenames are UTF-8', () => {
  it('round-trips a non-ASCII filename intact', async () => {
    stub.shouldThrow = null;
    // macOS puts a NARROW NO-BREAK SPACE (U+202F) between the time and AM/PM in
    // screen-recording names. Its UTF-8 bytes are E2 80 AF, and busboy's DEFAULT is
    // to decode multipart params as latin1 — which renders them as "â¯".
    const name = 'Screen Recording 2026-07-12 at 8.10.56\u202fPM.mov';
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: name, contentType: 'image/png' });
    expect(res.status).toBe(200);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row.filename).toBe(name);
    expect(row.filename).not.toContain('â');
    await waitForNoTemps();
  });
});

describe('media uploads (#515)', () => {
  /** An mp4 carrying GPS in moov/udta/©xyz, exactly where a phone puts it. */
  const GPS = '+37.7749-122.4194/';
  function box(type: string, payload: Buffer): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + payload.length);
    return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
  }
  function mp4WithGps(): Buffer {
    const ftyp = box(
      'ftyp',
      Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('mp42')]),
    );
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(0xe679e672, 4);
    const udta = box(
      'udta',
      box('©xyz', Buffer.concat([Buffer.from([0, 0x12, 0x15, 0xc7]), Buffer.from(GPS)])),
    );
    const moov = box('moov', Buffer.concat([box('mvhd', mvhd), udta]));
    return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(1024, 0xab))]);
  }

  beforeAll(() => {
    stub.capabilities.acceptsContentClasses = ['image', 'text', 'media'];
  });
  afterAll(() => {
    stub.capabilities.acceptsContentClasses = ['image', 'text'];
  });

  it('accepts an mp4, passes it through unoptimized, and gives it no thumbnail', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', mp4WithGps(), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('video/mp4');
    // Passthrough: the driver gets the temp FILE, streamed, not a buffer.
    expect(stub.capturedSource!.kind).toBe('file');
    expect(stub.capturedMeta!.filename).toMatch(/\.mp4$/);

    const list = await agent.get('/api/uploads');
    const row = list.body.items.find((r: { id: number }) => r.id === res.body.id);
    expect(row.thumbnail_url).toBeUndefined(); // no ffmpeg, no poster frame
    await waitForNoTemps();
  });

  // The whole reason video needs anything more than "pass the bytes through".
  it('strips the GPS out of a video BEFORE it leaves the server', async () => {
    stub.shouldThrow = null;
    const original = mp4WithGps();
    expect(original.includes(Buffer.from(GPS))).toBe(true);

    await agent
      .post('/api/uploads')
      .attach('image', original, { filename: 'vacation.mp4', contentType: 'video/mp4' });

    const sent = stub.capturedBytes!;
    expect(sent.includes(Buffer.from(GPS))).toBe(false);
    expect(sent.includes(Buffer.from('udta'))).toBe(false);
    // Size-preserving, so the recorded byte_size is still right.
    expect(sent.length).toBe(original.length);
    await waitForNoTemps();
  });

  // The real-world shape of the case 3GPP support was added for. A Samsung voice memo
  // arrives NAMED `.m4a` and CLAIMED as audio/x-m4a, but its bytes are a `3gp4`-brand
  // container — so the claim decides nothing and the sniff picks the class, the served
  // extension, and the scrub. Before #685 this 415'd.
  it('accepts a Samsung voice memo whose name and claim both say m4a', async () => {
    stub.shouldThrow = null;
    const FINGERPRINT = 'com.sec.android.app.voicenote.common.util.VoiceRecorderData';
    const ftyp = box(
      'ftyp',
      Buffer.concat([
        Buffer.from('3gp4'),
        Buffer.alloc(4),
        Buffer.from('isom'),
        Buffer.from('3gp4'),
      ]),
    );
    const udta = box('udta', box('vrdt', Buffer.from(FINGERPRINT)));
    const moov = box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), udta]));
    // mdat BEFORE moov, the way the recorder writes it.
    const memo = Buffer.concat([ftyp, box('mdat', Buffer.alloc(1024, 0xcd)), moov]);
    expect(memo.includes(Buffer.from(FINGERPRINT))).toBe(true);

    const res = await agent.post('/api/uploads').attach('image', memo, {
      filename: 'Voice 260804_013303.m4a',
      contentType: 'audio/x-m4a',
    });

    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('video/3gpp');
    // The honest container extension, NOT the `.m4a` the recorder and the client
    // both claimed.
    expect(stub.capturedMeta!.filename).toMatch(/\.3gp$/);
    // And the recorder's fingerprint never left the machine.
    expect(stub.capturedBytes!.includes(Buffer.from(FINGERPRINT))).toBe(false);
    expect(stub.capturedBytes!.length).toBe(memo.length);
    await waitForNoTemps();
  });

  it('415s a type we cannot clean, naming what is allowed', async () => {
    const webm = Buffer.from([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2,
      0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x42, 0x87,
      0x81, 0x02, 0x42, 0x85, 0x81, 0x02, 0x18, 0x53, 0x80, 0x67, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const res = await agent
      .post('/api/uploads')
      .attach('image', webm, { filename: 'rec.webm', contentType: 'video/webm' });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/not accepted/);
    await waitForNoTemps();
  });

  it('415s media when the resolved uploader does not accept it (the hosted dropper)', async () => {
    stub.capabilities.acceptsContentClasses = ['image', 'text'];
    try {
      const res = await agent
        .post('/api/uploads')
        .attach('image', mp4WithGps(), { filename: 'clip.mp4', contentType: 'video/mp4' });
      expect(res.status).toBe(415);
      expect(res.body.error).toMatch(/does not accept media/);
    } finally {
      stub.capabilities.acceptsContentClasses = ['image', 'text', 'media'];
    }
    await waitForNoTemps();
  });

  // The claim cannot pick the class — otherwise it's a route around the EXIF scrub.
  it('optimizes an image even when the client swears it is a video', async () => {
    stub.shouldThrow = null;
    const res = await agent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'liar.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(200);
    expect(res.body.mime).toBe('image/webp'); // ran through the pipeline regardless
    expect(stub.capturedSource!.kind).toBe('buffer');
    await waitForNoTemps();
  });
});

describe('an account held off the uploaders', () => {
  it('is refused before a byte of the body is read', async () => {
    const { createUser, setUserRestrictions } = await import('../db/users.js');
    const held = createUser('upload-held');
    setUserRestrictions(held.id, { networks: null, uploads: false });
    const heldAgent = await createAuthedAgent(app, held.id);
    disk.asked.length = 0;
    const res = await heldAgent
      .post('/api/uploads')
      .attach('image', smallPng, { filename: 'photo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('uploads are not enabled for this account');
    // The disk floor runs inside the multer wrapper, so no ask proves the body
    // was never spooled.
    expect(disk.asked).toHaveLength(0);
  });
});
