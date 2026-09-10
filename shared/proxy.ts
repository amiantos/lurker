// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A network's proxy setting, parsed and validated (#303).
//
// Shared for the same reason `clientCertPem.ts` is: both ends need the same
// answer for different reasons. The client parses what someone typed into
// `/network -proxy` so it can say what is wrong before sending anything; the
// server parses what arrives because it cannot trust the client to have done
// it, and re-validates stored columns on every dial because archive import
// writes them verbatim.
//
// Pure — no sockets, no database, no Node built-ins — so `server/engine/*` can
// import it without pulling the app in, and the browser bundle pays nothing.
//
// The stored shape is COLUMNS, not a URL (PROXY_PLAN.md §3). That is a
// consequence of Lurker never handing a stored secret back to a client: under a
// single `socks5://user:pass@host:1080` string, a payload the form can show is
// necessarily redacted, so changing the port would mean retyping the password.
// Columns give the password its own field with the "leave blank to keep"
// treatment `server_password` already has.
//
// A URL is still how a human writes a proxy — `ALL_PROXY`, `curl -x`,
// `/network -proxy` — so `parseProxyUrl` exists for the INPUT edges only. It
// never round-trips: nothing stores what it returns as text.

/** The proxy protocols Lurker speaks. SOCKS4/4a is deliberately absent: no
 *  authentication, no domain addressing in 4, and of the reference clients only
 *  WeeChat still carries it. */
export type ProxyType = 'socks5' | 'http';

/** A network's proxy, in the shape the columns store and the dialer takes. */
export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Why a proxy setting can't be used, in words a user can act on. `field` names
 *  the part at fault so a form can point at it. */
export interface ProxyProblem {
  error: string;
  field?: 'type' | 'host' | 'port' | 'username' | 'password';
}

export function isProxyProblem(v: ProxyConfig | ProxyProblem): v is ProxyProblem {
  return 'error' in v;
}

const encoder = new TextEncoder();
function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

const DEFAULT_PORTS: Record<ProxyType, number> = {
  // 1080 is the registered SOCKS port and what TheLounge defaults to; 3128 is
  // squid's, and what WeeChat defaults an http proxy to.
  socks5: 1080,
  http: 3128,
};

// `socks5h` is curl's spelling for "resolve the destination AT the proxy",
// which is the only thing proxyDial does — so a user pasting a working
// ALL_PROXY value must not be told it is invalid. `socks` is accepted as the
// bare form for the same reason. There is no variant here that resolves
// locally, so the distinction curl draws does not exist for us.
const SCHEMES: Record<string, ProxyType> = {
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
  http: 'http',
};

/** Parse a proxy URL into the stored column shape. INPUT ONLY — `/network
 *  -proxy`, and a pasted value in the form. Never used to read back what was
 *  stored. */
export function parseProxyUrl(raw: string): ProxyConfig | ProxyProblem {
  const text = (raw || '').trim();
  if (!text) return { error: 'a proxy needs an address, e.g. socks5://127.0.0.1:9050' };
  // A bare `host:port` is ambiguous (which protocol?) and guessing would pick
  // wrong half the time, so the scheme is required — but say what is missing
  // rather than emitting a URL parser's error about it.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return {
      error: `a proxy address needs a protocol — try socks5://${text} or http://${text}`,
      field: 'type',
    };
  }
  // ⚠ decodeURIComponent is INSIDE this try, not after it. `new URL` accepts a
  // malformed percent-escape — `socks5://%zz:1080` parses with hostname '%zz' —
  // and the decode then throws URIError. The only caller is /network's parser,
  // reached from an async command handler with no catch of its own, so that
  // throw was an unhandled rejection and no feedback at all rather than the
  // `{kind:'error'}` this returns.
  let url: URL;
  let host: string;
  let username: string;
  let password: string;
  try {
    url = new URL(text);
    // `socks5` is not a "special" scheme to WHATWG URL, so unlike `http://` it
    // parses `socks5://` and `socks5:///x` with an EMPTY hostname instead of
    // throwing — and a proxy with no host would dial the app's own loopback.
    // (`socks5://:1080` does throw, and is caught here.)
    // Brackets come off an IPv6 literal so the stored column holds the address,
    // not its URL spelling; describeProxy puts them back.
    host = decodeURIComponent(url.hostname).replace(/^\[|\]$/g, '');
    username = url.username ? decodeURIComponent(url.username) : '';
    password = url.password ? decodeURIComponent(url.password) : '';
  } catch {
    return { error: `"${text}" is not a valid proxy address` };
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const type = SCHEMES[scheme];
  if (!type) {
    // SOCKS4 is the one worth naming, because someone asking for it has a
    // reason and deserves better than "unknown protocol".
    if (scheme === 'socks4' || scheme === 'socks4a') {
      return {
        error:
          'SOCKS4 proxies are not supported — it has no authentication, and anything running SOCKS4 also speaks SOCKS5. Try socks5://',
        field: 'type',
      };
    }
    return {
      error: `${scheme}:// proxies are not supported — use socks5:// or http://`,
      field: 'type',
    };
  }
  if (!host) return { error: 'a proxy needs a host', field: 'host' };
  // No range check here: `new URL` has already refused anything above 65535,
  // and validateProxy below owns the rest (it has to anyway, for the values
  // that never came from a URL). One definition, not two that can drift.
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[type];
  return validateProxy({ type, host, port, username, password });
}

/** The same checks against a config that never saw a URL — a PATCH body, or an
 *  archive import, which writes network columns verbatim. This is what the dial
 *  path calls before it dials anything (PROXY_PLAN.md §2). */
export function validateProxy(input: {
  type?: string | null;
  host?: string | null;
  port?: number | string | null;
  username?: string | null;
  password?: string | null;
}): ProxyConfig | ProxyProblem {
  const type = (input.type || '').toLowerCase();
  if (type !== 'socks5' && type !== 'http') {
    return { error: `"${input.type ?? ''}" is not a proxy type Lurker speaks`, field: 'type' };
  }
  const host = (input.host || '').trim();
  if (!host) return { error: 'a proxy needs a host', field: 'host' };
  // Whitespace in a host would be sent verbatim into a SOCKS request or a
  // CONNECT line; in the latter it would split the request line outright.
  if (/\s/.test(host)) {
    return { error: 'a proxy host cannot contain spaces', field: 'host' };
  }
  const port = typeof input.port === 'string' ? Number(input.port) : (input.port ?? NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `${String(input.port ?? '')} is not a valid port`, field: 'port' };
  }
  const username = (input.username || '').trim();
  const password = input.password || '';
  // A password with no username can't be sent: RFC 1929 and HTTP Basic both
  // carry a pair. Refuse rather than silently dropping half a credential.
  if (password && !username) {
    return { error: 'a proxy password needs a username too', field: 'username' };
  }
  // RFC 1929 length-prefixes each half with a single byte, so anything longer
  // cannot be encoded at all. Caught here rather than truncated at the socket.
  // TextEncoder rather than Buffer.byteLength: this module runs in the browser
  // too, where Buffer does not exist.
  if (utf8Bytes(username) > 255) {
    return { error: 'a proxy username can be at most 255 bytes', field: 'username' };
  }
  if (utf8Bytes(password) > 255) {
    return { error: 'a proxy password can be at most 255 bytes', field: 'password' };
  }
  // A credential with a line break would inject a header into the CONNECT
  // request. Colons are fine — HTTP Basic base64s the pair, and the server
  // splits on the FIRST colon, so only a colon in the username is ambiguous.
  if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) {
    return { error: 'proxy credentials cannot contain line breaks', field: 'username' };
  }
  if (username.includes(':')) {
    return { error: 'a proxy username cannot contain a colon', field: 'username' };
  }
  return {
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/** The redacted display form. THE ONLY SHAPE ALLOWED NEAR A LOG LINE — the
 *  config carries a password, and the engine's rule of never logging a frame
 *  verbatim (CertFP, #459) applies here for the same reason. */
export function describeProxy(proxy: ProxyConfig): string {
  const auth = proxy.username ? `${proxy.username}${proxy.password ? ':***' : ''}@` : '';
  const host = proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.type}://${auth}${host}:${proxy.port}`;
}

/** Is this the same proxy? The `matchesDial` comparison (engine/upstream.ts).
 *
 *  ⚠⚠ Load-bearing, and more so than it looks. A proxy change takes effect on
 *  the NEXT CONNECT by design (PROXY_PLAN.md §0) — nothing tears down the live
 *  socket. This function is therefore the only thing that makes that next
 *  connect actually apply the change: if it says "same", the engine re-attaches
 *  to the socket held under the OLD proxy and the edit never lands at all.
 *  Credentials are compared for the same reason — a changed password is a
 *  changed dial. */
export function sameProxy(a: ProxyConfig | null, b: ProxyConfig | null): boolean {
  return sameProxyRoute(a, b) && (a?.password || '') === (b?.password || '');
}

/** Everything about a proxy except the password. Split out for the engine,
 *  which drops the password once the dial has it and compares a digest of the
 *  credentials instead — see EngineUpstream.matchesDial. */
export function sameProxyRoute(a: ProxyConfig | null, b: ProxyConfig | null): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.type === b.type &&
    a.host === b.host &&
    a.port === b.port &&
    (a.username || '') === (b.username || '')
  );
}
