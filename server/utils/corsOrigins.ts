// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The browser origin(s) this instance trusts for cross-origin access — the single
// source of truth shared by the HTTP CORS layer (app.ts) and the WebSocket upgrade
// origin check (wsHub.ts), so the two can never silently disagree about what is
// allowed.
//
// Sourced from CORS_ORIGIN. Two things about the raw env value are error-prone,
// and both are normalized away here:
//
//   1. It is read as a COMMA-SEPARATED ALLOWLIST, not one opaque string. Setting
//      `CORS_ORIGIN=https://a.example,https://b.example` now means what it looks
//      like it means. (It used to be compared as a single literal, so a list
//      matched nothing at all.)
//   2. Each entry is normalized to its URL origin — scheme + host + port, with no
//      path and no trailing slash. A browser's `Origin` header never carries a
//      trailing slash or path, so a natural-to-paste `https://x.example/` would
//      never match a real request. Normalizing both sides removes that footgun.
//
// Defaults to the dev origin when unset, matching the historical app.ts default.

const DEFAULT_ORIGIN = 'https://irc.local.bradroot.me:5173';

// Parse + normalize CORS_ORIGIN into a deduped list of URL origins. An unparseable
// entry (e.g. a bare host with no scheme) is dropped: it can never equal a real
// browser Origin anyway, so dropping it only ever means "never matches" — never a
// false allow.
export function allowedBrowserOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN || DEFAULT_ORIGIN;
  const origins = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      /* not a URL — can't match a browser Origin; drop it */
    }
  }
  return [...origins];
}

// True when `origin` (a browser `Origin` header value) is in the configured
// allowlist, comparing on normalized URL origin so a trailing slash on the
// configured value doesn't cause a spurious miss. A missing or unparseable origin
// is never allowed here — callers decide separately what an absent Origin means
// (the WS upgrade treats it as a non-browser client and allows it).
export function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return allowedBrowserOrigins().includes(normalized);
}
