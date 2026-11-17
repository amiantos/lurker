// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which buffer a command was typed in, so an error it draws can be said there
// (#816). Most refusals name a channel or a nick and are placed by that (see
// the 'irc error' handler in ircConnection.ts). The rest reach only the server
// buffer, where someone who typed `/oper` in a channel isn't looking.
//
// The client says where each raw line came from (`issuingTarget` on the `raw`
// frame). Every line is noted here as it goes onto the wire, whoever sent it
// and by whatever path (sent), and the user's raw lines are then given their
// buffer (typedIn). An error takes the line it answers, newest first:
//
//   - one that names its command (421, 461) takes the last line of that
//     command;
//   - one that names a channel or a nick takes the last line that named it;
//   - one that names nothing (481) takes the last line sent.
//
// A line with no buffer (Lurker's own JOIN, a bouncer client's command, a
// message) takes its error the same way, and that error is then said nowhere
// new. A line missing from a channel costs less than one that doesn't belong
// there, which a window alone would put there.
//
// Either way the line is spent: one command, one error. Newest first, though a
// server answers in order, because most lines draw no error and are never
// spent: the oldest one that fits is usually a command that worked.

// The most lines kept at once: more than a connect burst sends in the window.
const MAX_SENT = 128;

// Errors that name the command they refuse where a reply names its target.
const NAMES_COMMAND = new Set(['263', '400', '421', '461']);

// Error numerics outside 4xx and 5xx: RPL_TRYAGAIN, ERR_INVALIDMODEPARAM,
// ERR_TARGCHANGE, the KNOCK refusals, ERR_NOPRIVS, ERR_MLOCKRESTRICTED,
// ERR_INVALIDBAN, ERR_CANNOTDOCOMMAND.
const OTHER_ERRORS = new Set([
  '263',
  '696',
  '707',
  '712',
  '713',
  '714',
  '715',
  '723',
  '742',
  '743',
  '972',
]);

// Keepalives draw no error, and there is one every few seconds.
const NOT_NOTED = new Set(['PING', 'PONG']);

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

// What an error names besides us: its first middle parameter, when there is
// one. The last parameter is the sentence.
function namedTarget(params: string[]): string | null {
  if (params.length < 3) return null;
  const named = params[1] ?? '';
  return named && !named.includes(' ') ? named.toLowerCase() : null;
}

// A line's command and the words before its trailing parameter, lower-cased,
// with each comma list also split (`JOIN #a,#b`). Tags and a source go first.
function wordsOf(line: string): { verb: string; words: Set<string> } | null {
  const parts = line.trim().split(/ +/);
  while (parts.length && (parts[0].startsWith('@') || parts[0].startsWith(':'))) parts.shift();
  const verb = (parts.shift() ?? '').toUpperCase();
  if (!verb) return null;
  const words = new Set<string>();
  for (const part of parts) {
    if (part.startsWith(':')) break;
    for (const word of [part, ...part.split(',')]) if (word) words.add(word.toLowerCase());
  }
  return { verb, words };
}

interface Sent {
  verb: string;
  words: Set<string>;
  /** The buffer it was typed in, or null where there is none to say it in. */
  issuingTarget: string | null;
  at: number;
}

export class CommandIssuers {
  private lines: Sent[] = [];

  /** `windowMs`: how long after a line went out an error can still be its answer. */
  constructor(private readonly windowMs: number) {}

  /** A line went onto the wire. Call for every one, in order. */
  sent(line: string, now = Date.now()): void {
    const parsed = wordsOf(line);
    if (!parsed || NOT_NOTED.has(parsed.verb)) return;
    this.prune(now);
    if (this.lines.length >= MAX_SENT) this.lines.shift();
    this.lines.push({ ...parsed, issuingTarget: null, at: now });
  }

  /** The line that just went (see sent) was typed by the user in `issuingTarget`. */
  typedIn(line: string, issuingTarget: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.verb === wordsOf(line)?.verb) last.issuingTarget = issuingTarget;
  }

  /**
   * The buffer the command behind this error was typed in, spending the line.
   * Null when no line answers to it, or the one that does has no buffer.
   */
  take(command: string, params: string[], now = Date.now()): string | null {
    this.prune(now);
    const verb = refusedCommand(command, params);
    const target = verb ? null : namedTarget(params);
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const entry = this.lines[i];
      if (verb && entry.verb !== verb) continue;
      if (target && !entry.words.has(target)) continue;
      this.lines.splice(i, 1);
      return entry.issuingTarget;
    }
    return null;
  }

  /** The socket went: what was sent on it is answered by nothing now. */
  clear(): void {
    this.lines = [];
  }

  private prune(now: number): void {
    const from = this.lines.findIndex((entry) => now - entry.at <= this.windowMs);
    this.lines = from === -1 ? [] : this.lines.slice(from);
  }
}
