// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  parseProxyUrl,
  validateProxy,
  describeProxy,
  sameProxy,
  sameProxyRoute,
  isProxyProblem,
  type ProxyConfig,
} from './proxy.js';

/** Parse and assert it worked, so a test reads as the thing it is checking. */
function ok(raw: string): ProxyConfig {
  const parsed = parseProxyUrl(raw);
  if (isProxyProblem(parsed)) throw new Error(`expected ${raw} to parse: ${parsed.error}`);
  return parsed;
}

function err(raw: string): string {
  const parsed = parseProxyUrl(raw);
  if (!isProxyProblem(parsed)) throw new Error(`expected ${raw} to be refused`);
  return parsed.error;
}

describe('parseProxyUrl', () => {
  it('reads every scheme it accepts onto the two types', () => {
    expect(ok('socks5://127.0.0.1:9050').type).toBe('socks5');
    expect(ok('socks://127.0.0.1:9050').type).toBe('socks5');
    // curl's spelling for remote-DNS SOCKS5, which is the only mode we have.
    expect(ok('socks5h://127.0.0.1:9050').type).toBe('socks5');
    expect(ok('http://proxy.example:3128').type).toBe('http');
    expect(ok('SOCKS5://127.0.0.1:9050').type).toBe('socks5');
  });

  it('defaults the port by scheme', () => {
    expect(ok('socks5://127.0.0.1').port).toBe(1080);
    expect(ok('http://proxy.example').port).toBe(3128);
  });

  it('carries credentials, percent-decoded', () => {
    const p = ok('socks5://user:p%40ss%20word@10.0.0.5:1080');
    expect(p).toMatchObject({ username: 'user', password: 'p@ss word', host: '10.0.0.5' });
  });

  it('leaves credentials off when there are none', () => {
    const p = ok('socks5://127.0.0.1:9050');
    expect(p.username).toBeUndefined();
    expect(p.password).toBeUndefined();
  });

  it('unwraps an IPv6 literal to the address, not its URL spelling', () => {
    // The column stores an address; describeProxy puts the brackets back.
    expect(ok('socks5://[::1]:9050').host).toBe('::1');
  });

  it('names SOCKS4 specifically rather than calling it unknown', () => {
    // Someone asking for SOCKS4 has a reason and deserves better than
    // "unsupported protocol" (PROXY_PLAN.md §1a).
    expect(err('socks4://10.0.0.5:1080')).toMatch(/SOCKS4/);
    expect(err('socks4a://10.0.0.5:1080')).toMatch(/SOCKS4/);
    expect(err('ftp://10.0.0.5:1080')).toMatch(/not supported/);
  });

  it('asks for a protocol instead of guessing one', () => {
    // Guessing between socks5 and http would be wrong half the time.
    const message = err('127.0.0.1:9050');
    expect(message).toMatch(/socks5:\/\/127\.0\.0\.1:9050/);
    expect(message).toMatch(/http:\/\/127\.0\.0\.1:9050/);
  });

  it('refuses the shapes that would otherwise dial the wrong thing', () => {
    // `socks5` is not a WHATWG "special" scheme, so these parse with an EMPTY
    // hostname rather than throwing — and would dial the app's own loopback.
    expect(err('socks5://')).toMatch(/needs a host/);
    expect(err('socks5:///x')).toMatch(/needs a host/);
    // This one throws in the parser instead, so it lands on the generic message.
    expect(err('socks5://:1080')).toMatch(/not a valid proxy address/);
    // A percent-encoded space decodes into the host, which then trims to
    // nothing — so it lands on the same refusal an empty host does.
    expect(err('socks5://%20:1080')).toMatch(/needs a host/);
    expect(err('')).toMatch(/needs an address/);
    // Port 0 parses in WHATWG URL and is caught by validateProxy; anything
    // above 65535 never gets that far, because `new URL` refuses it first.
    expect(err('socks5://host:0')).toMatch(/not a valid port/);
    expect(err('socks5://host:70000')).toMatch(/not a valid proxy address/);
  });

  it('returns an error, not a THROW, on a malformed percent-escape', () => {
    // ⚠ `new URL` accepts these — `socks5://%zz:1080` parses with hostname
    // '%zz' — and decodeURIComponent then throws URIError. The only caller is
    // /network's parser, reached from an async handler with no catch, so a
    // throw here was an unhandled rejection and no feedback at all.
    expect(err('socks5://%zz:1080')).toMatch(/not a valid proxy address/);
    expect(err('socks5://%zz:p@host:1080')).toMatch(/not a valid proxy address/);
    expect(err('socks5://u:%zz@host:1080')).toMatch(/not a valid proxy address/);
  });

  it('refuses half a credential', () => {
    // RFC 1929 and HTTP Basic both carry a pair; sending one half silently
    // would authenticate as nobody.
    expect(err('socks5://:secret@10.0.0.5:1080')).toMatch(/needs a username/);
  });
});

describe('validateProxy', () => {
  it('accepts what the columns hold', () => {
    const p = validateProxy({ type: 'http', host: 'proxy.example', port: 8080 });
    expect(p).toEqual({ type: 'http', host: 'proxy.example', port: 8080 });
  });

  it('takes a port that arrived as a string', () => {
    // SQLite and JSON bodies are both loose about this.
    expect(validateProxy({ type: 'socks5', host: 'h', port: '1080' })).toMatchObject({
      port: 1080,
    });
  });

  it('refuses a type it does not speak', () => {
    // Reachable without anyone typing it: archive import writes network columns
    // verbatim, so an archive from a newer Lurker can hold anything.
    expect(validateProxy({ type: 'socks4', host: 'h', port: 1 })).toMatchObject({ field: 'type' });
    expect(validateProxy({ type: null, host: 'h', port: 1 })).toMatchObject({ field: 'type' });
  });

  it('refuses credentials that cannot be encoded or would inject', () => {
    const long = 'x'.repeat(256);
    expect(validateProxy({ type: 'socks5', host: 'h', port: 1, username: long })).toMatchObject({
      field: 'username',
    });
    expect(
      validateProxy({ type: 'socks5', host: 'h', port: 1, username: 'u', password: long }),
    ).toMatchObject({ field: 'password' });
    // A line break in a credential would add a header to the CONNECT request.
    expect(
      validateProxy({ type: 'http', host: 'h', port: 1, username: 'u\r\nX-Evil: 1' }),
    ).toMatchObject({ field: 'username' });
    // HTTP Basic splits on the first colon, so a colon in the username is
    // ambiguous on the wire.
    expect(validateProxy({ type: 'http', host: 'h', port: 1, username: 'a:b' })).toMatchObject({
      field: 'username',
    });
  });

  it('refuses a host with whitespace', () => {
    // It would be written verbatim into a CONNECT request line and split it.
    expect(validateProxy({ type: 'http', host: 'a b', port: 1 })).toMatchObject({ field: 'host' });
  });
});

describe('describeProxy', () => {
  // This is the only shape allowed near a log line, so the password must not
  // survive it — whatever else the config holds. The secret is distinct from
  // every other field so a leak cannot be mistaken for a legitimate echo.
  const secret = 'c0rrect-horse-battery';

  it('never emits the password', () => {
    const shapes: ProxyConfig[] = [
      { type: 'socks5', host: 'h', port: 1080, username: 'u', password: secret },
      { type: 'http', host: 'proxy.example', port: 3128, username: 'someone', password: secret },
      { type: 'socks5', host: '::1', port: 1080, username: 'u', password: secret },
      // No username: the password cannot be sent at all, and must still not show.
      { type: 'socks5', host: 'h', port: 1080, password: secret },
    ];
    for (const shape of shapes) {
      expect(describeProxy(shape)).not.toContain(secret);
    }
  });

  it('reads back as the URL a user would have typed', () => {
    expect(describeProxy({ type: 'socks5', host: '127.0.0.1', port: 9050 })).toBe(
      'socks5://127.0.0.1:9050',
    );
    expect(
      describeProxy({ type: 'http', host: 'p.example', port: 3128, username: 'u', password: 'p' }),
    ).toBe('http://u:***@p.example:3128');
    // A username with no password is legal and shows as itself.
    expect(describeProxy({ type: 'socks5', host: 'h', port: 1, username: 'u' })).toBe(
      'socks5://u@h:1',
    );
    // IPv6 gets its brackets back for display.
    expect(describeProxy({ type: 'socks5', host: '::1', port: 9050 })).toBe('socks5://[::1]:9050');
  });
});

describe('sameProxyRoute', () => {
  // The engine drops the proxy password once the dial has it and compares a
  // digest instead, so it needs a comparison that ignores the password while
  // still catching every other route change.
  const base: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: 9050, username: 'u' };

  it('ignores the password but nothing else', () => {
    expect(sameProxyRoute(base, { ...base, password: 'anything' })).toBe(true);
    expect(sameProxyRoute(base, { ...base, username: 'other' })).toBe(false);
    expect(sameProxyRoute(base, { ...base, host: '10.0.0.1' })).toBe(false);
    expect(sameProxyRoute(base, { ...base, port: 1080 })).toBe(false);
    expect(sameProxyRoute(base, { ...base, type: 'http' })).toBe(false);
    expect(sameProxyRoute(base, null)).toBe(false);
    expect(sameProxyRoute(null, null)).toBe(true);
  });
});

describe('sameProxy', () => {
  const base: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: 9050 };

  it('is true only for an identical dial', () => {
    expect(sameProxy(base, { ...base })).toBe(true);
    expect(sameProxy(null, null)).toBe(true);
  });

  // ⚠⚠ Each of these is a case where saying "same" would re-attach the engine
  // to a socket dialled under the OLD proxy. Because a proxy change applies on
  // the next connect and nothing tears down the live socket (PROXY_PLAN.md §0),
  // this function is the ONLY thing that makes an edit take effect at all.
  it('is false for every change that is a different dial', () => {
    expect(sameProxy(base, { ...base, host: '10.0.0.1' })).toBe(false);
    expect(sameProxy(base, { ...base, port: 1080 })).toBe(false);
    expect(sameProxy(base, { ...base, type: 'http' })).toBe(false);
    expect(sameProxy(base, { ...base, username: 'u' })).toBe(false);
    // A changed password is a changed dial: the proxy may accept one identity
    // and refuse the other, and the user asked for the new one.
    expect(
      sameProxy(
        { ...base, username: 'u', password: 'a' },
        { ...base, username: 'u', password: 'b' },
      ),
    ).toBe(false);
  });

  it('is false when a proxy is added or removed', () => {
    expect(sameProxy(base, null)).toBe(false);
    expect(sameProxy(null, base)).toBe(false);
  });
});
