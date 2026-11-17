// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which buffer a command was typed in, so an error it draws can be said there
// (#816). Most refusals name a channel or a nick and are placed by that (see
// the 'irc error' handler in ircConnection.ts). The rest name the command
// (421, 461) or nothing at all (481), and reach only the server buffer, where
// someone who typed `/oper` in a channel isn't looking.
//
// The client says where each raw line came from (`issuingTarget` on the `raw`
// frame), and every raw line is noted here as it goes out, whoever sent it. An
// error then takes the command it answers:
//
//   - one that names its command takes the last such command sent. A bouncer
//     client's command is noted with no buffer, so its error is taken by it and
//     said nowhere new, where a window alone would hand it to the user.
//   - one that names nothing takes the last command sent, whoever sent it.
//     When that wasn't the user's, the error is said nowhere new: a line
//     missing from a channel costs less than one that doesn't belong there.
//
// Either way the command is spent: one command, one error. What is kept is
// short-lived, since a server answers in well under a second.

/** How long after a command went out an error can still be its answer. */
export const COMMAND_ISSUER_WINDOW_MS = 15_000;

// A connect-command burst is the most that is ever in the window at once.
const MAX_SENT = 64;

// Errors that name the command they refuse where a reply names its target.
const NAMES_COMMAND = new Set(['263', '400', '421', '461']);

// Errors outside 4xx and 5xx: RPL_TRYAGAIN, ERR_NOPRIVS, ERR_CANNOTDOCOMMAND.
const OTHER_ERRORS = new Set(['263', '723', '972']);

/** Whether a server line is an error numeric: the refusal of something sent. */
export function isErrorNumeric(command: string): boolean {
  return /^[45]\d\d$/.test(command) || OTHER_ERRORS.has(command);
}

/** The command an error numeric names as refused, upper-cased, or null. */
export function refusedCommand(command: string, params: string[]): string | null {
  if (!NAMES_COMMAND.has(command)) return null;
  const named = (params[1] ?? '').toUpperCase();
  // A word, and not the sentence a server sends when it names no command.
  return /^[A-Z0-9]+$/.test(named) ? named : null;
}

interface Sent {
  verb: string;
  /** The buffer it was typed in, or null where there is none to say it in. */
  issuingTarget: string | null;
  at: number;
}

export class CommandIssuers {
  private sent: Sent[] = [];

  /**
   * A raw line went out. `issuingTarget` is the buffer the user typed it in:
   * null for a line with no such buffer (MCP, a connect command) and for one
   * that is not the user's (`user` false: a bouncer client's, Lurker's own).
   */
  note(line: string, issuingTarget: string | null, user: boolean, now = Date.now()): void {
    const verb = (line.trim().split(/ +/)[0] ?? '').toUpperCase();
    if (!verb) return;
    this.prune(now);
    if (this.sent.length >= MAX_SENT) this.sent.shift();
    this.sent.push({ verb, issuingTarget: user ? issuingTarget : null, at: now });
  }

  /**
   * The buffer the command behind this error was typed in, spending the
   * command. Null when no command answers to it, or the one that does has no
   * buffer.
   */
  take(command: string, params: string[], now = Date.now()): string | null {
    this.prune(now);
    const named = refusedCommand(command, params);
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const entry = this.sent[i];
      if (named && entry.verb !== named) continue;
      this.sent.splice(i, 1);
      return entry.issuingTarget;
    }
    return null;
  }

  /** The socket went: what was sent on it is answered by nothing now. */
  clear(): void {
    this.sent = [];
  }

  private prune(now: number): void {
    const from = this.sent.findIndex((entry) => now - entry.at <= COMMAND_ISSUER_WINDOW_MS);
    this.sent = from === -1 ? [] : this.sent.slice(from);
  }
}
