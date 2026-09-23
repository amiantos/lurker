// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A network's channel-mode vocabulary, parsed ONCE on the server from its
// ISUPPORT and handed to clients as `modeSpec` (#727). The browser never sees
// 005 (see shared/modes.ts), so everything a client needs to render a mode
// control, rank a member, or split a MODE line lives in this one shape.
//
// Parsing follows weechat and irssi, the spec-faithful references:
//
//   - CHANMODES=A,B,C,D: A = list modes (a mask on both + and -), B = always a
//     param, C = a param only when set, D = flags. Absent → the RFC defaults.
//   - PREFIX=(modes)symbols, highest rank first. A letter that appears in both
//     PREFIX and CHANMODES is a prefix (weechat irc-mode.c, irssi
//     irc-servers.c — some ircds list prefix letters in group A).
//   - MODES = the most PARAMETER-taking changes one MODE line may carry. A bare
//     `MODES` token means no limit; absent means 3.
//
// ⚠ `q` is the classic trap: a quiet LIST mode on solanum (in CHANMODES A, not
// in PREFIX), an owner PREFIX on InspIRCd/Unreal. Nothing here hardcodes it.

/** One membership mode from PREFIX, e.g. `{ mode: 'o', symbol: '@' }`. */
export interface PrefixMode {
  mode: string;
  symbol: string;
}

export interface ModeSpec {
  /** CHANMODES group A — list modes: bans, exceptions, invite-exceptions, quiets. */
  list: string;
  /** CHANMODES group B — always take a param (`k`). */
  always: string;
  /** CHANMODES group C — take a param only when set (`l`). */
  onSet: string;
  /** CHANMODES group D — plain flags. */
  flags: string;
  /** Membership modes, highest rank first. */
  prefix: PrefixMode[];
  /** Param-taking changes allowed per MODE line; null = no limit. */
  maxModes: number | null;
  /** Longest topic the server accepts, in bytes; null = not advertised. */
  topicLen: number | null;
}

export const DEFAULT_CHANMODES: readonly string[] = ['beI', 'k', 'l', 'imnst'];
export const DEFAULT_PREFIX: readonly PrefixMode[] = [
  { mode: 'q', symbol: '~' },
  { mode: 'a', symbol: '&' },
  { mode: 'o', symbol: '@' },
  { mode: 'h', symbol: '%' },
  { mode: 'v', symbol: '+' },
];
export const DEFAULT_MAX_MODES = 3;

// The conventional ladder, used only to pick a stand-in when a gate names a
// letter the network doesn't have (see hasRankAtLeast).
const CONVENTIONAL_RANK = ['q', 'a', 'o', 'h', 'v'];

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Build a ModeSpec from irc-framework's `network.options`. That object holds
 * CHANMODES already split on commas, PREFIX as `{symbol, mode}` pairs (or the
 * raw string when the token was malformed), and every other token as its raw
 * value — `true` for a token with no `=value`.
 */
export function parseModeSpec(options: Record<string, unknown> | null | undefined): ModeSpec {
  const opts = options ?? {};

  const rawPrefix = opts.PREFIX;
  const prefix: PrefixMode[] = Array.isArray(rawPrefix)
    ? rawPrefix
        .filter(
          (p): p is PrefixMode =>
            !!p &&
            typeof p.mode === 'string' &&
            p.mode.length === 1 &&
            typeof p.symbol === 'string',
        )
        .map((p) => ({ mode: p.mode, symbol: p.symbol }))
    : DEFAULT_PREFIX.map((p) => ({ ...p }));
  const prefixLetters = new Set(prefix.map((p) => p.mode));

  const rawChanmodes = opts.CHANMODES;
  const groups: string[] = Array.isArray(rawChanmodes)
    ? rawChanmodes.map((g) => (typeof g === 'string' ? g : ''))
    : typeof rawChanmodes === 'string'
      ? rawChanmodes.split(',')
      : [...DEFAULT_CHANMODES];
  // Each letter lands in the first group that claims it, and never in two.
  const seen = new Set(prefixLetters);
  const group = (i: number): string => {
    let out = '';
    for (const letter of groups[i] ?? '') {
      if (seen.has(letter)) continue;
      seen.add(letter);
      out += letter;
    }
    return out;
  };

  const rawModes = opts.MODES;
  return {
    list: group(0),
    always: group(1),
    onSet: group(2),
    flags: group(3),
    prefix,
    maxModes: rawModes === true ? null : (positiveInt(rawModes) ?? DEFAULT_MAX_MODES),
    topicLen: positiveInt(opts.TOPICLEN),
  };
}

/** Whether a change to `letter` carries a param, per the spec's groups. */
export function modeTakesParam(spec: ModeSpec, letter: string, sign: '+' | '-'): boolean {
  if (spec.prefix.some((p) => p.mode === letter)) return true;
  if (spec.list.includes(letter) || spec.always.includes(letter)) return true;
  if (spec.onSet.includes(letter)) return sign === '+';
  return false;
}

/**
 * Where a member's highest membership mode sits in PREFIX order: 0 for the top
 * rank, -1 when they hold none. Scans by rank, never by array position — the
 * modes array is not guaranteed to be sorted.
 */
export function rankIndex(
  modes: readonly string[] | null | undefined,
  prefix: readonly PrefixMode[],
): number {
  if (!modes?.length) return -1;
  return prefix.findIndex((p) => modes.includes(p.mode));
}

/** A member's modes in PREFIX rank order; letters PREFIX doesn't know keep their order, last. */
export function sortByRank(modes: readonly string[], prefix: readonly PrefixMode[]): string[] {
  const order = new Map(prefix.map((p, i) => [p.mode, i]));
  return modes.toSorted(
    (a, b) => (order.get(a) ?? prefix.length) - (order.get(b) ?? prefix.length),
  );
}

/**
 * Whether a member ranks at or above `letter` (e.g. `'o'` for "op or higher").
 *
 * When the network has no `letter` in PREFIX, the gate moves UP the
 * conventional ladder to the next letter it does have — a network without
 * halfops asks "op or higher" of a halfop gate. Rounding up is the direction
 * that can't hand out a control the server will refuse.
 */
export function hasRankAtLeast(
  modes: readonly string[] | null | undefined,
  prefix: readonly PrefixMode[],
  letter: string,
): boolean {
  const held = rankIndex(modes, prefix);
  if (held === -1) return false;
  let threshold = prefix.findIndex((p) => p.mode === letter);
  if (threshold === -1) {
    const start = CONVENTIONAL_RANK.indexOf(letter);
    for (let i = start - 1; i >= 0 && threshold === -1; i--) {
      threshold = prefix.findIndex((p) => p.mode === CONVENTIONAL_RANK[i]);
    }
  }
  return threshold !== -1 && held <= threshold;
}

/** One change to send; `param` is required exactly when modeTakesParam says so. */
export interface OutgoingModeChange {
  sign: '+' | '-';
  letter: string;
  param?: string;
}

// RFC 1459's 512 bytes less CRLF, less headroom for the `:nick!user@host `
// prefix the server adds when it relays our line to the channel.
const MODE_LINE_BUDGET = 400;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Pack mode changes into as few `MODE <target> …` lines as the server allows.
 *
 * Only changes that carry a param count against `maxModes` (irssi's
 * channel_set_mode, modes.c). Params stay in the same order as their letters,
 * and each line restates its sign.
 */
export function batchModeLines(
  target: string,
  changes: readonly OutgoingModeChange[],
  maxModes: number | null,
): string[] {
  const lines: string[] = [];
  let letters = '';
  let params: string[] = [];
  let lastSign = '';
  let paramCount = 0;

  const render = (l: string, p: readonly string[]) =>
    `MODE ${target} ${l}${p.length ? ' ' + p.join(' ') : ''}`;
  const flush = () => {
    if (letters) lines.push(render(letters, params));
    letters = '';
    params = [];
    lastSign = '';
    paramCount = 0;
  };

  for (const c of changes) {
    const hasParam = c.param != null && c.param !== '';
    if (hasParam && maxModes != null && paramCount >= maxModes) flush();
    let piece = (c.sign === lastSign ? '' : c.sign) + c.letter;
    const nextParams = hasParam ? [...params, c.param!] : params;
    if (letters && byteLength(render(letters + piece, nextParams)) > MODE_LINE_BUDGET) {
      flush();
      piece = c.sign + c.letter;
    }
    letters += piece;
    lastSign = c.sign;
    if (hasParam) {
      params.push(c.param!);
      paramCount++;
    }
  }
  flush();
  return lines;
}
