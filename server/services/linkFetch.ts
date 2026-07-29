// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The outbound half of link previews: fetching a URL that an arbitrary IRC user
// pasted, from a server that sits inside a VPC, without becoming an SSRF hole or
// a memory hazard.
//
// On node:http/https rather than fetch, for two reasons — one shared with the
// uploader and one specific to here:
//
//   1. DNS pinning needs a custom `lookup`, and fetch/undici gives no equivalent
//      hook. Without it, "validate the hostname, then connect" is a TOCTOU bug:
//      DNS rebinding makes the second resolution return 127.0.0.1 and the guard
//      you wrote never sees it. See `pinnedLookup` below.
//   2. undici buffers, and buffering a response whose size we don't trust is the
//      whole problem. Streaming with a running byte counter is the point.
//
// Everything here fails CLOSED. A malformed URL, an unresolvable host, an
// unexpected content-encoding, a redirect we can't re-validate — all of it ends
// as `null`/throw, never as "well, try connecting and see".

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { isBlockedIpLiteral } from '../utils/ipGuard.js';

/** Wall-clock budget for a single hop. */
const TIMEOUT_MS = 5000;
/** Redirects followed before giving up. Each hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * How much of an HTML document we read before giving up on finding metadata.
 *
 * Metadata lives in `<head>`, so this is generous rather than tight. The Lounge
 * defaults to 50 KB and had to expose it as a config knob specifically because
 * YouTube pushes its og: tags past 300 KB; Slack asks for the first 32 KB via a
 * Range header and simply misses anything later. 256 KB covers the sites people
 * actually paste without turning a preview into a download.
 */
export const MAX_SCRAPE_BYTES = 256 * 1024;

/**
 * What we tell the origin we are.
 *
 * We are not a crawler. We fetch one URL, once, because a person pasted it in a
 * channel and another person is looking at it — which is exactly the traffic
 * class the social-preview user-agents denote, and exactly the class sites
 * deliberately serve, because a preview card is free distribution. It is
 * categorically not what "block AI crawlers" is aimed at; that's bulk
 * training-data scraping.
 *
 * The two shipped implementations we have to compare against both reached the
 * same conclusion: The Lounge sends `facebookexternalhit/1.1 Twitterbot/1.0`,
 * halloy defaults to `WhatsApp/2` "for wide compatibility". We lead with our own
 * identity and a contact URL, then name the class, so an operator reading their
 * logs can tell exactly who we are and block us on purpose if they want to.
 *
 * Overridable because reasonable operators will disagree, and because the string
 * that gets served will drift over time.
 */
export function userAgent(): string {
  return (
    process.env.LURKER_PREVIEW_USER_AGENT ||
    'Mozilla/5.0 (compatible; Lurker/1.0; +https://lurker.chat/bot) facebookexternalhit/1.1'
  );
}

/**
 * Whether this instance may make outbound preview requests at all.
 *
 * Distinct from the two per-user settings on purpose. A user setting decides
 * whether *you* see previews; this decides whether the instance reaches out to
 * the internet — which is the operator's bandwidth, the operator's IP
 * reputation, and the operator's problem if someone tries to use a channel to
 * aim the cell at something. Operators get a switch that no user can override.
 */
export function fetchingEnabled(): boolean {
  const v = (process.env.LURKER_LINK_PREVIEWS || '').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false';
}

export class UnsafeUrlError extends Error {}

/**
 * Parse and vet a URL string before anything dials it.
 *
 * Rejects non-http(s) schemes (`file:`, `gopher:`, and friends have no business
 * here), embedded credentials (which a redirect would happily carry somewhere
 * else), and hosts that are *literally* an internal address. A hostname that
 * merely resolves to one is caught later, at connect time — see `pinnedLookup`.
 */
export function normalizeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  // `new URL` keeps IPv6 literals bracketed; the guard wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Only judge things that are already addresses. A name gets judged by what it
  // resolves to, which is a question for connect time, not parse time.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isBlockedIpLiteral(host)) return null;
  }

  // The fragment is client-side only and never reaches the origin; dropping it
  // means `#a` and `#b` share one cache entry instead of two.
  url.hash = '';
  return url;
}

/**
 * A `lookup` that resolves once, refuses internal addresses, and hands node the
 * exact address it approved.
 *
 * This is the pin. node connects to whatever this callback yields, so there is
 * no second resolution for an attacker's short-TTL record to win — the classic
 * DNS-rebinding SSRF (validate `evil.com` → A 1.2.3.4, connect → A 127.0.0.1)
 * has nowhere to happen. Validating a hostname anywhere else in this file would
 * be theatre.
 */
function pinnedLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: never, family?: number) => void,
): void {
  const wantAll = typeof options === 'object' && options !== null && options.all === true;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, undefined as never);
    const safe = addresses.filter((a) => !isBlockedIpLiteral(a.address));
    if (safe.length === 0) {
      const e: NodeJS.ErrnoException = new UnsafeUrlError(
        `refusing to connect to ${hostname}: resolves only to internal addresses`,
      );
      e.code = 'EACCES';
      return callback(e, undefined as never);
    }
    if (wantAll) return callback(null, safe as never);
    callback(null, safe[0].address as never, safe[0].family);
  });
}

/**
 * Dedicated connection pools. **Never `globalAgent`.**
 *
 * A reused socket skips DNS entirely — which means it skips `pinnedLookup`,
 * which means it skips the guard. `http.globalAgent` has been keep-alive by
 * default since node 19 and is shared with every other part of the process, so
 * using it would let a socket that something else opened, to a host we never
 * vetted, be handed to a preview fetch. That is not hypothetical: it is exactly
 * how the route test caught this, when a probe's pooled socket was reused by the
 * fetcher and the lookup never ran.
 *
 * A private agent with keep-alive off means every request we make goes through
 * the pin, every time. Preview fetching is not a hot path; correctness of the
 * guard is worth one handshake.
 */
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

export interface FetchOptions {
  /** `Accept` header. Defaults to a browser-ish HTML preference. */
  accept?: string;
  /** Overall byte ceiling. The stream is destroyed the moment it's crossed. */
  maxBytes?: number;
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  contentType: string;
  /** The URL actually served, after redirects — the base for relative og:image. */
  finalUrl: URL;
  stream: IncomingMessage;
}

/**
 * One hop, no redirect following, no body read. The caller decides whether to
 * buffer it (scraping) or pipe it (the byte proxy).
 */
function requestOnce(url: URL, opts: FetchOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: pinnedLookup,
        agent: mod === https ? httpsAgent : httpAgent,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': userAgent(),
          Accept: opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
          // No Accept-Encoding on purpose. A byte cap counts *compressed* bytes,
          // so accepting gzip would let a small response decompress into
          // something enormous — a zip bomb aimed straight at the scrape buffer.
          // Identity costs bandwidth and removes a whole class of surprise.
          'Accept-Encoding': 'identity',
          // No cookies, no auth, ever. Included explicitly so a future edit that
          // adds a header set has to walk past this note.
        },
      },
      (res) => {
        const contentType = String(res.headers['content-type'] || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          contentType,
          finalUrl: url,
          stream: res,
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Follow up to MAX_REDIRECTS hops, re-vetting the target of every single one.
 *
 * A redirect into internal space is the most common way this bug actually ships:
 * the entry URL passes review, and `https://harmless.example/go` 302s to
 * `http://169.254.169.254/latest/meta-data/`. Each `Location` goes back through
 * `normalizeUrl` and a fresh pinned lookup, so hop 3 is checked exactly as hard
 * as hop 0.
 */
export async function safeRequest(start: URL, opts: FetchOptions = {}): Promise<RawResponse> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, opts);
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.location;
    if (!isRedirect) return res;

    res.stream.resume(); // drain, so the socket can be reused rather than hung
    if (hop === MAX_REDIRECTS) throw new UnsafeUrlError('too many redirects');
    const next = normalizeUrl(new URL(String(res.headers.location), url).toString());
    if (!next) throw new UnsafeUrlError('redirect to a disallowed target');
    url = next;
  }
  throw new UnsafeUrlError('too many redirects');
}

export interface BufferedResponse {
  status: number;
  contentType: string;
  finalUrl: URL;
  body: Buffer;
  /** True when we stopped early because the cap was reached. */
  truncated: boolean;
}

/**
 * Fetch and buffer, hard-capped.
 *
 * The cap is enforced on bytes actually received rather than on `Content-Length`,
 * because a hostile or merely broken origin can lie about the latter or omit it.
 * `Content-Length` is still honoured as an early exit so we don't open a socket
 * to something we already know is too big.
 */
export async function fetchBuffered(url: URL, opts: FetchOptions = {}): Promise<BufferedResponse> {
  const maxBytes = opts.maxBytes ?? MAX_SCRAPE_BYTES;
  const res = await safeRequest(url, opts);

  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.stream.destroy();
    throw new UnsafeUrlError(`response too large (${declared} bytes)`);
  }
  // We asked for identity; anything else means we can't reason about the byte
  // count, so we don't try.
  const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    res.stream.destroy();
    throw new UnsafeUrlError(`unexpected content-encoding: ${encoding}`);
  }

  return await new Promise<BufferedResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    res.stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Keep the prefix — for an HTML scrape a truncated head is often still
        // enough to find og: tags in, and a partial answer beats no answer.
        chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
        truncated = true;
        res.stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.stream.on('error', (err) => (truncated ? resolve(done()) : reject(err)));
    res.stream.on('close', () => resolve(done()));
    res.stream.on('end', () => resolve(done()));

    function done(): BufferedResponse {
      return {
        status: res.status,
        contentType: res.contentType,
        finalUrl: res.finalUrl,
        body: Buffer.concat(chunks),
        truncated,
      };
    }
  });
}
