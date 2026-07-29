// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { normalizeUrl, userAgent, fetchingEnabled, bufferStream } from './linkFetch.js';
import { isBlockedIpLiteral, isBlockedIpv4 } from '../utils/ipGuard.js';

describe('isBlockedIpv4', () => {
  it('blocks every internal range', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254', // the one that matters most: cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1']) {
      expect(isBlockedIpv4(ip)).toBe(false);
    }
  });

  it('fails safe on anything malformed', () => {
    for (const ip of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '1.2.3.-1']) {
      expect(isBlockedIpv4(ip)).toBe(true);
    }
  });
});

describe('isBlockedIpLiteral', () => {
  it('blocks internal IPv6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::3', 'ff02::1']) {
      expect(isBlockedIpLiteral(ip)).toBe(true);
    }
  });

  it('judges IPv4-mapped IPv6 by the embedded address', () => {
    expect(isBlockedIpLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedIpLiteral('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    expect(isBlockedIpLiteral('2606:4700:4700::1111')).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('accepts ordinary http and https URLs', () => {
    expect(normalizeUrl('https://example.com/a')?.toString()).toBe('https://example.com/a');
    expect(normalizeUrl('http://example.com/a')?.toString()).toBe('http://example.com/a');
  });

  it('rejects schemes that have no business being fetched', () => {
    for (const raw of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'ftp://example.com/x',
      'data:text/html,<script>',
      'javascript:alert(1)',
      'not a url at all',
    ]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it('rejects embedded credentials, which a redirect would carry onward', () => {
    expect(normalizeUrl('https://user:pass@example.com/')).toBeNull();
    expect(normalizeUrl('https://user@example.com/')).toBeNull();
  });

  it('rejects hosts that are literally an internal address', () => {
    for (const raw of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://[::1]/',
      'http://[fd00::1]/',
    ]) {
      expect(normalizeUrl(raw)).toBeNull();
    }
  });

  it('allows a public IP literal', () => {
    expect(normalizeUrl('http://8.8.8.8/')).not.toBeNull();
  });

  it('drops the fragment so #a and #b share one cache entry', () => {
    expect(normalizeUrl('https://example.com/p#section')?.toString()).toBe('https://example.com/p');
  });

  it('leaves hostnames to be judged at connect time, not parse time', () => {
    // A name that resolves internally must still PARSE — the guard that catches
    // it is the pinned lookup, because only that one can't be raced by DNS.
    expect(normalizeUrl('http://localhost.example.com/')).not.toBeNull();
  });
});

describe('userAgent', () => {
  it('identifies as Lurker and as a preview fetcher, with a contact URL', () => {
    const ua = userAgent();
    expect(ua).toContain('Lurker');
    expect(ua).toContain('+https://');
    expect(ua).toContain('facebookexternalhit');
  });

  it('is overridable by the operator', () => {
    const saved = process.env.LURKER_PREVIEW_USER_AGENT;
    process.env.LURKER_PREVIEW_USER_AGENT = 'CustomAgent/9';
    try {
      expect(userAgent()).toBe('CustomAgent/9');
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEW_USER_AGENT;
      else process.env.LURKER_PREVIEW_USER_AGENT = saved;
    }
  });
});

describe('fetchingEnabled', () => {
  it('defaults on', () => {
    const saved = process.env.LURKER_LINK_PREVIEWS;
    delete process.env.LURKER_LINK_PREVIEWS;
    try {
      expect(fetchingEnabled()).toBe(true);
    } finally {
      if (saved !== undefined) process.env.LURKER_LINK_PREVIEWS = saved;
    }
  });

  it('honours the operator kill switch in its usual spellings', () => {
    const saved = process.env.LURKER_LINK_PREVIEWS;
    try {
      for (const v of ['off', 'OFF', '0', 'false', ' off ']) {
        process.env.LURKER_LINK_PREVIEWS = v;
        expect(fetchingEnabled()).toBe(false);
      }
      process.env.LURKER_LINK_PREVIEWS = 'on';
      expect(fetchingEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.LURKER_LINK_PREVIEWS;
      else process.env.LURKER_LINK_PREVIEWS = saved;
    }
  });
});

describe('bufferStream', () => {
  // A RawResponse over a canned body. The SSRF guard blocks loopback (correctly), so a real
  // local origin can't be used here — and this is a pure stream-consumption question anyway.
  function fake(body: string | Buffer, headers: Record<string, string> = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    return {
      status: 200,
      headers: headers as never,
      contentType: 'text/html',
      finalUrl: new URL('https://example.com/'),
      stream: Readable.from([buf]) as never,
    };
  }

  it('reads a whole small body', async () => {
    const res = await bufferStream(fake('hello'), { maxBytes: 1000 });
    expect(res.body.toString()).toBe('hello');
    expect(res.truncated).toBe(false);
  });

  it('truncates at the cap and says so', async () => {
    const res = await bufferStream(fake('x'.repeat(500)), { maxBytes: 100 });
    expect(res.body.length).toBe(100);
    expect(res.truncated).toBe(true);
  });

  it('reads a PREFIX of an oversized body rather than refusing it', async () => {
    // ⚠ Regression guard. An earlier version threw on a Content-Length over the cap, which
    // broke two things at once: Wikipedia (a 572 KB article) got NO preview at all, and
    // image dimensions failed for every image over the 64 KB header read — i.e. most of
    // them. `maxBytes` means "read at most this much", never "refuse anything bigger".
    const res = await bufferStream(fake('y'.repeat(5000), { 'content-length': '5000' }), {
      maxBytes: 100,
    });
    expect(res.body.length).toBe(100);
    expect(res.truncated).toBe(true);
  });

  it('stops once the head closes, so a long document costs only its head', async () => {
    const html = `<html><head><title>T</title></head><body>${'z'.repeat(100_000)}</body></html>`;
    const res = await bufferStream(fake(html), { maxBytes: 512 * 1024, stopAtHeadEnd: true });
    expect(res.body.length).toBeLessThan(1000);
    expect(res.body.toString()).toContain('<title>T</title>');
    // Stopping early on purpose is not truncation — we got everything we wanted.
    expect(res.truncated).toBe(false);
  });

  it('finds a </head> split across chunk boundaries', async () => {
    const chunks = [Buffer.from('<head><title>T</title></he'), Buffer.from('ad><body>tail</body>')];
    const res = await bufferStream(
      {
        status: 200,
        headers: {} as never,
        contentType: 'text/html',
        finalUrl: new URL('https://example.com/'),
        stream: Readable.from(chunks) as never,
      },
      { maxBytes: 512 * 1024, stopAtHeadEnd: true },
    );
    expect(res.body.toString()).toContain('<title>T</title>');
  });

  it('reads to the end when a document has no head at all', async () => {
    const res = await bufferStream(fake('just text, no tags'), {
      maxBytes: 1000,
      stopAtHeadEnd: true,
    });
    expect(res.body.toString()).toBe('just text, no tags');
  });

  it('refuses a body it cannot measure', async () => {
    // We ask for identity precisely so the byte counter means something; a compressed
    // response would let a small payload expand into something enormous.
    await expect(
      bufferStream(fake('...', { 'content-encoding': 'gzip' }), { maxBytes: 1000 }),
    ).rejects.toThrow(/content-encoding/);
  });
});
