// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Per-account restrictions: what ONE account may do on an instance that is
// otherwise open. Two knobs, each a narrowing of something the instance
// already gates globally:
//
//   networks   the hosts this account may connect to, or null for "any the
//              instance allows". Sits UNDER the instance lockdown (#298): a
//              host has to clear both.
//   uploads    whether this account may put files on the instance's uploaders.
//
// Set by the instance's admin (standalone) or pushed by the control plane
// (node edition, where it is how a free hosted account is held to the
// community server and kept off the CDN). The cell never learns WHY an account
// is restricted — plan, trial, abuse — only what the restriction is, the same
// billing-blind shape the pause verdict has.
//
// Shared by both sides: the server validates and enforces, the client hides
// what the server would refuse (the picker's manual entry, the attach button).

export interface AccountRestrictions {
  /** Hosts this account may connect to, lowercased, or null for any. */
  networks: string[] | null;
  /** May this account upload to the instance's uploaders? */
  uploads: boolean;
}

export const UNRESTRICTED: Readonly<AccountRestrictions> = Object.freeze({
  networks: null,
  uploads: true,
});

/** What every upload path answers (403) for an account held off the uploaders. */
export const UPLOADS_RESTRICTED = 'uploads are not enabled for this account';

// Longest a DNS name can be. A host is compared, never resolved, here; the
// bound only keeps a stored row from being arbitrarily large.
const MAX_HOST_LENGTH = 253;

export function isUnrestricted(r: AccountRestrictions): boolean {
  return r.networks === null && r.uploads === true;
}

/** Compare the way the connect path does: trimmed, case-insensitively. */
export function foldHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Validate a restrictions object from a request body. Returns null when it is
 * malformed — a caller answers 400, never guesses. The set is WHOLE: both
 * fields present, nothing else. A field left out is not "unchanged" and not
 * "allowed"; reading an omission as a grant is how a half-written body would
 * quietly lift a restriction. Hosts are folded and de-duplicated; an empty
 * list is legal and means "no networks at all".
 */
export function parseAccountRestrictions(input: unknown): AccountRestrictions | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'networks' && key !== 'uploads') return null;
  }
  if (!('networks' in obj) || !('uploads' in obj)) return null;
  let networks: string[] | null = null;
  if (obj.networks !== null) {
    if (!Array.isArray(obj.networks)) return null;
    const seen = new Set<string>();
    for (const item of obj.networks) {
      if (typeof item !== 'string') return null;
      const host = foldHost(item);
      if (!host || host.length > MAX_HOST_LENGTH || /[\s,/]/.test(host)) return null;
      seen.add(host);
    }
    // Sorted so two writes of the same set compare equal whatever order the
    // caller listed them in (sameRestrictions is a string compare).
    networks = [...seen].toSorted();
  }
  if (typeof obj.uploads !== 'boolean') return null;
  return { networks, uploads: obj.uploads };
}

/**
 * The stored form: NULL for the unrestricted norm, so a row that has never
 * been touched costs nothing and reads as "no restrictions" everywhere.
 */
export function serializeAccountRestrictions(r: AccountRestrictions): string | null {
  return isUnrestricted(r) ? null : JSON.stringify({ networks: r.networks, uploads: r.uploads });
}

/**
 * Read the stored form back. NULL is the one unrestricted sentinel. Only our
 * own validated writes reach the column, so anything else that fails to parse
 * (an empty string included) is corruption — and a restriction that fails to
 * read must fail CLOSED (nothing allowed), never silently open an account up.
 * The admin or control plane re-sets it; nothing is lost.
 */
export function restrictionsFromStored(raw: string | null | undefined): AccountRestrictions {
  if (raw == null) return UNRESTRICTED;
  try {
    const parsed = parseAccountRestrictions(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    /* fall through to the closed shape */
  }
  return { networks: [], uploads: false };
}

export function sameRestrictions(a: AccountRestrictions, b: AccountRestrictions): boolean {
  return serializeAccountRestrictions(a) === serializeAccountRestrictions(b);
}
