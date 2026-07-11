// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared IRC hostmask glob matching, used by both the fserve access allowlist
// and the DCC auto-accept allowlist. Pure + unit-tested; no DB or env. Kept in
// its own module so dccConfig and fserveConfig can both use it without one
// importing the other (fserveConfig already depends on dccConfig).

/** Convert an IRC hostmask glob (`*`/`?` wildcards over nick!user@host) to a
 *  case-insensitive anchored RegExp. Everything else is escaped literally. */
export function maskToRegExp(mask: string): RegExp {
  const escaped = mask
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Whether `hostmask` (nick!user@host) matches any allowlist entry. A bare nick
 *  entry (no `!`/`@`) also matches the nick alone, so "friend" allows
 *  friend!*@*. */
export function allowlistMatches(allowlist: string[], hostmask: string, nick: string): boolean {
  for (const entry of allowlist) {
    const pat = entry.includes('!') || entry.includes('@') ? entry : `${entry}!*@*`;
    if (maskToRegExp(pat).test(hostmask)) return true;
    // Also allow a bare-nick entry to match the nick directly.
    if (!entry.includes('!') && !entry.includes('@') && maskToRegExp(entry).test(nick)) return true;
  }
  return false;
}
