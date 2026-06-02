// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Derives the IRC ident (the user part of nick!ident@host) that the built-in
// identd reports for a connection.
//
//   node edition — the ident must identify the GLOBAL account, so it's stable
//     across cell moves and unique fleet-wide. Cells are provisioned with the
//     account username `acct-<controlPlaneAccountId>`, so we surface
//     `u<controlPlaneAccountId>` (IRCCloud-style). Using the cell-local user id
//     would change if an account were ever migrated to another cell.
//   standalone — the operator's per-network choice wins (the configured
//     username, else the nick), matching how a single-user bouncer behaves.

const NON_IDENT_CHARS = /[^A-Za-z0-9._-]/g;

function sanitizeIdent(value: string): string {
  return value.replace(NON_IDENT_CHARS, '').slice(0, 16);
}

export function deriveIdent(opts: {
  nodeMode: boolean;
  accountUsername: string;
  networkUsername: string | null;
  nick: string;
}): string {
  if (opts.nodeMode) {
    const m = /^acct-(\d+)$/.exec(opts.accountUsername.trim());
    if (m) return sanitizeIdent(`u${m[1]}`);
    // Fallback (e.g. the operator's own admin account on a cell): stay stable +
    // ident-safe rather than inventing an id.
    return sanitizeIdent(opts.accountUsername) || 'user';
  }
  return sanitizeIdent(opts.networkUsername || opts.nick) || 'user';
}
