// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deployment edition for this Lurker instance — the single source of truth for
// "is this a self-hosted instance, or a cell in the hosted lurker.chat service?"
//
//   'standalone' — the default, and the only mode self-hosters ever run: one
//     instance, one operator, fully featured (admin UI, invites, and server
//     config all visible). Unchanged behavior for every existing deploy.
//   'node'       — this instance is a *cell* in the hosted service, managed by a
//     remote orchestrator (the control plane). Node mode gates operator-only UI
//     (A3), exposes an orchestrator-authenticated control API (A2), and
//     registers + heartbeats to the control plane (A4).
//
// Edition is fixed for the process lifetime: it is read once from LURKER_EDITION
// and cached. Anything that never sets the var stays 'standalone', so this is a
// zero-impact addition for self-hosted installs.

export type Edition = 'standalone' | 'node';

const EDITIONS: readonly Edition[] = ['standalone', 'node'];

/**
 * Parse a raw LURKER_EDITION value into an Edition. Pure (no env access) so the
 * parsing rules can be unit-tested directly. Empty/unset means standalone; an
 * unrecognized value warns and falls back to standalone rather than refusing to
 * boot — an instance should always come up in the safe, fully-featured mode.
 */
export function parseEdition(raw: string | undefined): Edition {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'standalone';
  if ((EDITIONS as readonly string[]).includes(value)) return value as Edition;
  console.warn(
    `[lurker] unknown LURKER_EDITION='${raw}', falling back to 'standalone' (valid: ${EDITIONS.join(', ')})`,
  );
  return 'standalone';
}

let cached: Edition | null = null;

/** The resolved edition for this process (cached after first call). */
export function getEdition(): Edition {
  if (cached === null) cached = parseEdition(process.env.LURKER_EDITION);
  return cached;
}

/** True when this instance is a cell under an orchestrator. */
export function isNodeMode(): boolean {
  return getEdition() === 'node';
}

/**
 * What a cell puts in front of the OAuth codes and access tokens it mints (#891):
 * its fleet name and a `~`. Neither carries a session the orchestrator could route
 * by, so it reads the name instead. The secret after the last `~` is base64url,
 * which never contains one. Empty in standalone edition, where there's nothing to
 * route.
 */
export function oauthRoutingPrefix(): string {
  if (!isNodeMode()) return '';
  const name = (process.env.LURKER_NODE_NAME ?? '').trim();
  return name ? `${name}~` : '';
}

// app_meta keys reserved for node identity. Populated by the orchestrator
// handshake (A2) and the registration/heartbeat client (A4); never written in
// standalone. Centralized here so the cell and its control surfaces agree on the
// key names instead of scattering string literals.
export const NODE_META = {
  /** Stable id the control plane assigns this cell at first registration. */
  id: 'node.id',
  /** Base URL of the orchestrator this cell reports to. */
  orchestratorUrl: 'node.orchestrator_url',
  /** Shared secret authenticating the cell↔orchestrator channel. */
  secret: 'node.secret',
} as const;
