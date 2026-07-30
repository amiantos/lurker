// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parser for the /dcc command (#270 phase 2) — the slash-command surface over
// the DCC download manager. `list` opens the Transfers view; accept / reject /
// cancel act on one transfer by its numeric id (the id shown in the list).
//
// Pure and dependency-free so it unit-tests outside the Vue SFC, like the other
// command parsers. DCC is user-wide (not per-network), so the SFC routes this
// among the network-agnostic commands.

export type DccCommand =
  | { kind: 'list' }
  | { kind: 'accept'; id: number }
  | { kind: 'reject'; id: number }
  | { kind: 'cancel'; id: number }
  | { kind: 'chat'; nick: string }
  | { kind: 'chatClose'; nick: string }
  | { kind: 'send'; nick: string }
  | { kind: 'error'; message: string };

const ACCEPT = new Set(['accept', 'ok', 'yes', 'get']);
const REJECT = new Set(['reject', 'deny', 'no']);
const CANCEL = new Set(['cancel', 'abort', 'stop']);
const LIST = new Set(['list', 'ls']);

const USAGE =
  'usage: /dcc [list] · /dcc accept|reject|cancel <id> · /dcc chat <nick> · /dcc send <nick> · /dcc close <nick>';

// A nick is any non-whitespace token; leave stricter validation to the server.
function parseNick(raw: string | undefined): string | null {
  const n = (raw || '').trim();
  return n ? n : null;
}

// Parse a positive integer transfer id, or null. Rejects empty, non-numeric, and
// non-positive values so a fat-fingered id surfaces a usage hint rather than
// POSTing to /api/dcc/NaN/accept.
function parseId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parseDccCommand(argLine: string): DccCommand {
  const trimmed = (argLine || '').trim();
  if (!trimmed) return { kind: 'list' };

  const parts = trimmed.split(/\s+/);
  const verb = parts[0].toLowerCase();

  if (LIST.has(verb)) return { kind: 'list' };

  // `/dcc chat <nick>` opens (offers) a chat; `/dcc chat close <nick>` or
  // `/dcc close <nick>` ends one.
  if (verb === 'chat') {
    if ((parts[1] || '').toLowerCase() === 'close') {
      const nick = parseNick(parts[2]);
      return nick
        ? { kind: 'chatClose', nick }
        : { kind: 'error', message: 'usage: /dcc chat close <nick>' };
    }
    const nick = parseNick(parts[1]);
    return nick ? { kind: 'chat', nick } : { kind: 'error', message: 'usage: /dcc chat <nick>' };
  }
  if (verb === 'close') {
    const nick = parseNick(parts[1]);
    return nick
      ? { kind: 'chatClose', nick }
      : { kind: 'error', message: 'usage: /dcc close <nick>' };
  }
  // `/dcc send <nick>` — the SFC opens a file picker and uploads to the peer.
  if (verb === 'send') {
    const nick = parseNick(parts[1]);
    return nick ? { kind: 'send', nick } : { kind: 'error', message: 'usage: /dcc send <nick>' };
  }

  const isAccept = ACCEPT.has(verb);
  const isReject = REJECT.has(verb);
  const isCancel = CANCEL.has(verb);
  if (isAccept || isReject || isCancel) {
    const kind = isAccept ? 'accept' : isReject ? 'reject' : 'cancel';
    const id = parseId(parts[1]);
    if (id == null) return { kind: 'error', message: `usage: /dcc ${kind} <id>` };
    return { kind, id };
  }

  return { kind: 'error', message: `unknown subcommand "${parts[0]}". ${USAGE}` };
}
