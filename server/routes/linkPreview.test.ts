// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  createAnonAgent,
} from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-link-preview');

let app: Express;
let agent: LurkerTestAgent;
let alice: User;
let putPreview: typeof import('../db/linkPreviews.js').putPreview;
let mintProxyToken: typeof import('../services/mediaProxyToken.js').mintProxyToken;
let OK_TTL_MS: number;
let urlHash: typeof import('../db/linkPreviews.js').urlHash;
let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;

const SAVED_SECRET = process.env.SESSION_SECRET;

beforeAll(async () => {
  process.env.SESSION_SECRET = 'link-preview-route-test-secret';
  ({ createUser } = await import('../db/users.js'));
  ({ putPreview, OK_TTL_MS, urlHash } = await import('../db/linkPreviews.js'));
  db = (await import('../db/index.js')).default;
  ({ mintProxyToken } = await import('../services/mediaProxyToken.js'));
  const router = (await import('./linkPreview.js')).default;

  alice = createUser('alice');
  app = createTestApp({ '/api/link-preview': router });
  agent = await createAuthedAgent(app, alice.id);
});

afterAll(() => {
  if (SAVED_SECRET === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = SAVED_SECRET;
  ctx.cleanup();
});

/** Seed the cache so a test can exercise the happy path without any network. */
function seed(url: string, over: Partial<Parameters<typeof putPreview>[0]> = {}) {
  putPreview({
    url,
    status: 'ok',
    kind: 'page',
    title: 'A Title',
    description: 'A description',
    siteName: 'Example',
    author: null,
    imageUrl: 'https://cdn.example.com/thumb.png',
    imageWidth: 1200,
    imageHeight: 630,
    embedUrl: null,
    mime: null,
    expiresAt: new Date(Date.now() + OK_TTL_MS).toISOString(),
    ...over,
  });
}

/** When the cached row for `url` was fetched, or null if there isn't one. */
function firstFetchedAt(url: string): string | null {
  const row = db
    .prepare('SELECT fetched_at FROM link_previews WHERE url_hash = ?')
    .get(urlHash(url)) as { fetched_at: string } | undefined;
  return row?.fetched_at ?? null;
}

function rowCount(url: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM link_previews WHERE url_hash = ?')
    .get(urlHash(url)) as { n: number };
  return row.n;
}

describe('POST /api/link-preview/resolve', () => {
  it('requires authentication', async () => {
    const anon = createAnonAgent(app);
    const res = await anon.post('/api/link-preview/resolve').send({ urls: [] });
    expect(res.status).toBe(401);
  });

  it('rejects a body without a urls array', async () => {
    expect((await agent.post('/api/link-preview/resolve').send({})).status).toBe(400);
    expect((await agent.post('/api/link-preview/resolve').send({ urls: 'nope' })).status).toBe(400);
  });

  it('returns a descriptor for a cached page, with the thumbnail proxied', async () => {
    const url = 'https://example.com/cached-article';
    seed(url);

    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);

    const [preview] = res.body.previews;
    expect(preview.status).toBe('ok');
    expect(preview.kind).toBe('page');
    expect(preview.title).toBe('A Title');
    expect(preview.siteName).toBe('Example');
    expect(preview.thumbWidth).toBe(1200);

    // The client is handed OUR url, never the origin's — that's the whole
    // privacy property, so assert it rather than trusting it.
    expect(preview.thumb).toMatch(/^\/api\/link-preview\/media\//);
    expect(JSON.stringify(preview)).not.toContain('cdn.example.com');
  });

  it('puts direct media in src rather than thumb', async () => {
    const url = 'https://example.com/photo.png';
    seed(url, { kind: 'image', imageUrl: url, title: null, mime: 'image/png' });

    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);
    const [preview] = res.body.previews;
    expect(preview.kind).toBe('image');
    expect(preview.src).toMatch(/^\/api\/link-preview\/media\//);
    expect(preview.thumb).toBeUndefined();
  });

  it('carries an embed URL for a video, and it is the no-cookie host', async () => {
    const url = 'https://www.youtube.com/watch?v=abc123';
    seed(url, {
      kind: 'video-embed',
      embedUrl: 'https://www.youtube-nocookie.com/embed/abc123?autoplay=1&rel=0',
    });

    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);
    expect(res.body.previews[0].embedUrl).toContain('youtube-nocookie.com');
  });

  it('omits every metadata field on an unavailable preview', async () => {
    const url = 'https://example.com/gone';
    seed(url, { status: 'unavailable' });

    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);
    const [preview] = res.body.previews;
    expect(preview.status).toBe('unavailable');
    expect(preview.title).toBeUndefined();
    expect(preview.thumb).toBeUndefined();
  });

  it('answers one descriptor per input, in order', async () => {
    seed('https://example.com/one', { title: 'One' });
    seed('https://example.com/two', { title: 'Two' });

    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: ['https://example.com/two', 'https://example.com/one'] })
      .expect(200);

    expect(res.body.previews.map((p: { title?: string }) => p.title)).toEqual(['Two', 'One']);
  });

  it('refuses an internal address that is genuinely reachable, without dialling it', async () => {
    // A test that only asserts "unavailable" would pass for the wrong reason —
    // an unreachable URL is also unavailable. So stand up a real server on
    // loopback, PROVE it answers, then prove Lurker refuses to touch it. The
    // request counter is the actual assertion: not "the fetch failed" but "no
    // fetch happened".
    let hits = 0;
    const origin = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<head><meta property="og:title" content="INTERNAL SECRET"></head>');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const port = (origin.address() as import('node:net').AddressInfo).port;
    const target = `http://127.0.0.1:${port}/admin`;

    try {
      // Validate the probe: the origin really is serving the thing we're about
      // to prove we can't reach.
      const probe = await new Promise<string>((resolve, reject) => {
        http
          .get(target, (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      expect(probe).toContain('INTERNAL SECRET');
      expect(hits).toBe(1);

      const res = await agent
        .post('/api/link-preview/resolve')
        .send({
          urls: [
            target,
            'http://169.254.169.254/latest/meta-data/', // cloud metadata
            'http://10.0.0.1/',
            'http://[::1]/',
            'file:///etc/passwd',
          ],
        })
        .expect(200);

      for (const preview of res.body.previews) {
        expect(`${preview.url} → ${preview.status}`).toBe(`${preview.url} → unavailable`);
        expect(JSON.stringify(preview)).not.toContain('INTERNAL SECRET');
      }
      // Still 1 — the probe's own request, and nothing from Lurker.
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });

  it('refuses a HOSTNAME that resolves internally', async () => {
    // Distinct code path from the test above. `127.0.0.1` is caught by the URL
    // parse because it's literally an address; `localhost` parses fine and is
    // only caught when the pinned lookup sees what it resolves to. That's the
    // path DNS rebinding would attack, so it needs its own proof.
    let hits = 0;
    const origin = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<head><meta property="og:title" content="VIA HOSTNAME"></head>');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const port = (origin.address() as import('node:net').AddressInfo).port;

    try {
      const probe = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://localhost:${port}/`, (r) => {
            let body = '';
            r.on('data', (c) => (body += c));
            r.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
      expect(probe).toContain('VIA HOSTNAME');
      expect(hits).toBe(1);

      const res = await agent
        .post('/api/link-preview/resolve')
        .send({ urls: [`http://localhost:${port}/`] })
        .expect(200);

      expect(res.body.previews[0].status).toBe('unavailable');
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });

  it('caps how many URLs one request can fan out to', async () => {
    const urls = Array.from({ length: 50 }, (_, i) => `http://127.0.0.1/${i}`);
    const res = await agent.post('/api/link-preview/resolve').send({ urls }).expect(200);
    expect(res.body.previews.length).toBe(20);
  });

  it('ignores non-string entries rather than failing the whole batch', async () => {
    seed('https://example.com/mixed', { title: 'Mixed' });
    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [42, null, 'https://example.com/mixed', { a: 1 }] })
      .expect(200);
    expect(res.body.previews.length).toBe(1);
    expect(res.body.previews[0].title).toBe('Mixed');
  });
});

describe('one resolve serves every user on the cell', () => {
  it('does not refetch for a second user', async () => {
    // The guarantee: ten people in a channel scrolling past one link is ONE outbound
    // fetch, not ten. The cache is keyed by URL with no user_id anywhere in it, so this
    // holds across accounts by construction — but it's the kind of property that breaks
    // quietly, so it gets a test.
    //
    // A blocked address makes "fetching" deterministic and offline: it resolves to
    // `unavailable`, which is cached exactly like a success.
    const url = 'http://10.1.2.3/shared-link';
    const bob = createUser('bob-cache');
    const bobAgent = await createAuthedAgent(app, bob.id);

    await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);
    const first = firstFetchedAt(url);
    expect(first).not.toBeNull();

    await bobAgent
      .post('/api/link-preview/resolve')
      .send({ urls: [url] })
      .expect(200);
    // Same row, untouched — the second user read the first user's answer.
    expect(firstFetchedAt(url)).toBe(first);
    expect(rowCount(url)).toBe(1);
  });

  it('answers ten simultaneous asks for one URL identically', async () => {
    const url = 'http://10.9.9.9/hot-link';
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        agent.post('/api/link-preview/resolve').send({ urls: [url] }),
      ),
    );
    for (const res of results) expect(res.status).toBe(200);
    expect(rowCount(url)).toBe(1);
  });
});

describe('the URL a descriptor is keyed by', () => {
  it('echoes the URL as asked, so a client lookup matches', async () => {
    // ⚠ Regression guard for a two-headed bug. Descriptors used to echo the URL the fetch
    // ENDED at, so for anything that redirects (http→https, www canonicalisation, a
    // renamed article) the client's lookup by the string it sent missed and the preview
    // never rendered — while the cache row, written under that same unreachable key, was
    // never read either, so every resolve went back out to the origin.
    const asked = 'http://10.4.4.4/redirects-somewhere';
    const res = await agent
      .post('/api/link-preview/resolve')
      .send({ urls: [asked] })
      .expect(200);
    expect(res.body.previews[0].url).toBe(asked);
    expect(rowCount(asked)).toBe(1);
  });
});

describe('GET /api/link-preview/media/:token', () => {
  it('requires authentication', async () => {
    const anon = createAnonAgent(app);
    const token = mintProxyToken('https://cdn.example.com/a.png');
    expect((await anon.get(`/api/link-preview/media/${token}`)).status).toBe(401);
  });

  it('rejects a token it did not sign', async () => {
    expect((await agent.get('/api/link-preview/media/forged.signature')).status).toBe(403);
  });

  it('rejects a token whose payload was swapped for an internal address', async () => {
    const token = mintProxyToken('https://cdn.example.com/a.png');
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const payload = Buffer.from('http://169.254.169.254/', 'utf8').toString('base64url');
    expect((await agent.get(`/api/link-preview/media/${payload}.${sig}`)).status).toBe(403);
  });

  it('refuses a validly-signed token that points somewhere internal', async () => {
    // Belt and braces: even a token WE signed gets re-vetted, because the DNS
    // answer may have moved since it was minted.
    const token = mintProxyToken('http://127.0.0.1/secret.png');
    expect((await agent.get(`/api/link-preview/media/${token}`)).status).toBe(403);
  });

  it('is a 404, not a crash, when the origin cannot be reached', async () => {
    const token = mintProxyToken('https://not-a-real-host.invalid/a.png');
    expect((await agent.get(`/api/link-preview/media/${token}`)).status).toBe(404);
  });

  it('goes dark entirely when the operator kill switch is set', async () => {
    const saved = process.env.LURKER_LINK_PREVIEWS;
    process.env.LURKER_LINK_PREVIEWS = 'off';
    try {
      const token = mintProxyToken('https://cdn.example.com/a.png');
      expect((await agent.get(`/api/link-preview/media/${token}`)).status).toBe(404);
    } finally {
      if (saved === undefined) delete process.env.LURKER_LINK_PREVIEWS;
      else process.env.LURKER_LINK_PREVIEWS = saved;
    }
  });
});
