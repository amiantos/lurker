// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request } from 'express';

// The instance's public origin, for anything that has to hand out an absolute
// URL: local-upload links pasted into IRC, and the OAuth discovery document's
// endpoints. PUBLIC_BASE_URL wins (explicit, proxy-safe); otherwise it's derived
// from the request, honoring the reverse-proxy forwarding headers a self-hoster's
// Caddy/nginx sets. Read here rather than via a global `trust proxy` so the rest
// of the app's request handling is unchanged.

// A forwarding header may be a list ("proto1, proto2"); take the first hop.
function firstHeaderValue(v: unknown): string {
  return String(v ?? '')
    .split(',')[0]
    .trim();
}

// A host is hostname[:port] or [ipv6][:port] — reject anything with characters
// that could break out of the authority (slash, space, userinfo '@', etc.), so a
// spoofed header can never inject path/scheme into the URL we construct + persist.
const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/;

/** The origin the request arrived on, or '' when the Host header is unusable. */
export function requestOrigin(req: Request): string {
  // Only http/https are valid schemes; anything else (a spoofed "javascript" or
  // garbage X-Forwarded-Proto) is ignored so it can never reach the built URL.
  const rawProto = firstHeaderValue(req.headers['x-forwarded-proto']) || req.protocol;
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';
  const rawHost = firstHeaderValue(req.headers['x-forwarded-host']) || req.get('host') || '';
  const host = HOST_RE.test(rawHost) ? rawHost : '';
  return host ? `${proto}://${host}` : '';
}

/** PUBLIC_BASE_URL, else the request origin, without a trailing slash. '' if neither is usable. */
export function publicBaseUrl(req: Request): string {
  return (process.env.PUBLIC_BASE_URL || requestOrigin(req)).replace(/\/+$/, '');
}
