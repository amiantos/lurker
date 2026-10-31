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

const SHAPE = 'body must be { networks: string[] | null, uploads: boolean }';

/**
 * Why one typed host cannot be on a list, or null when it can. A host is
 * compared with a network row's `host` and never resolved, so a port, a
 * scheme or a path can never match anything: better refused with a reason
 * than stored and silently useless.
 */
export function hostProblem(raw: string): string | null {
  const host = foldHost(raw);
  if (!host) return 'a host is empty';
  if (host.length > MAX_HOST_LENGTH) return `${host.slice(0, 40)}…: too long for a hostname`;
  if (/[\s,]/.test(host)) return `${host}: not a hostname`;
  if (/\//.test(host)) return `${host}: hostnames only, no scheme or path`;
  if (host.includes(':')) return `${host}: hostnames only, no port`;
  return null;
}

/** The first problem in a typed list, or null. */
export function hostListProblem(hosts: readonly string[]): string | null {
  for (const h of hosts) {
    const problem = hostProblem(h);
    if (problem) return problem;
  }
  return null;
}

/**
 * Validate a restrictions object from a request body, with the reason when it
 * is refused — a caller answers 400 with it, never guesses. The set is WHOLE:
 * both fields present. A field left out is not "unchanged" and not "allowed";
 * reading an omission as a grant is how a half-written body would quietly lift
 * a restriction. Keys this version does not know are ignored, not refused: the
 * cell and the control plane are released separately, and the protocol rule is
 * additive. Hosts are folded and de-duplicated; an empty list is legal and
 * means "no networks at all".
 */
export function readAccountRestrictions(
  input: unknown,
): { restrictions: AccountRestrictions; error?: undefined } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: SHAPE };
  const obj = input as Record<string, unknown>;
  if (!('networks' in obj) || !('uploads' in obj)) return { error: SHAPE };
  let networks: string[] | null = null;
  if (obj.networks !== null) {
    if (!Array.isArray(obj.networks)) return { error: SHAPE };
    const seen = new Set<string>();
    for (const item of obj.networks) {
      if (typeof item !== 'string') return { error: SHAPE };
      const problem = hostProblem(item);
      if (problem) return { error: problem };
      seen.add(foldHost(item));
    }
    // Sorted so two writes of the same set compare equal whatever order the
    // caller listed them in (sameRestrictions is a string compare).
    networks = [...seen].toSorted();
  }
  if (typeof obj.uploads !== 'boolean') return { error: SHAPE };
  return { restrictions: { networks, uploads: obj.uploads } };
}

/** readAccountRestrictions without the reason: the set, or null when refused. */
export function parseAccountRestrictions(input: unknown): AccountRestrictions | null {
  const read = readAccountRestrictions(input);
  return read.error === undefined ? read.restrictions : null;
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
