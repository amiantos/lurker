// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { DEFAULT_PREFIX, rankIndex, type PrefixMode } from '../../../shared/channelModes.js';
import { isChannelTarget } from '../../../shared/channels.js';

// A member's channel-mode glyph, rank, and glyph colour, read from the
// network's own PREFIX (`modeSpec.prefix`, highest rank first). Shared by the
// member list, the self-identity prompt, the message list, and the whois
// channel list so the glyph stays consistent everywhere it appears (#1032).
//
// `prefix` is null while the network hasn't sent its ISUPPORT yet; that falls
// back to the conventional q/a/o/h/v → ~/&/@/%/+ table. Display only — rank
// gates go through hasRankAtLeast.
type Prefix = readonly PrefixMode[] | null | undefined;

const orDefault = (prefix: Prefix): readonly PrefixMode[] => prefix ?? DEFAULT_PREFIX;

// The symbol of the highest-ranked prefix mode the member holds, or '' when
// they hold none.
export function prefixOf(modes: readonly string[] | null | undefined, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  return i === -1 ? '' : list[i].symbol;
}

// Sort key for the member list: 0 for the top rank, and members with no prefix
// mode after every rank the network has.
export function prefixRank(modes: readonly string[] | null | undefined, prefix: Prefix): number {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  return i === -1 ? list.length : i;
}

// The five colour tiers (the --member-* tokens), keyed by the letter's
// conventional role. Not by symbol: another symbol for op is still op. And not
// by position alone: on Libera's (ov)@+ the top rank is op, and colouring by
// position would paint it as owner.
const TIER_BY_LETTER: Record<string, string> = {
  q: 'owner',
  a: 'admin',
  o: 'op',
  h: 'halfop',
  v: 'voice',
};

// CSS class for the glyph colour (e.g. `mode-op`), or '' when there's no
// prefix. A letter outside q/a/o/h/v takes the tier of the nearest known
// letter that outranks it, or owner when none does: on (Yqaohv)!~&@%+ a `Y`
// is coloured as an owner, whatever its symbol.
export function prefixClass(modes: readonly string[] | null | undefined, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = rankIndex(modes, list);
  if (i === -1) return '';
  for (let j = i; j >= 0; j--) {
    const tier = TIER_BY_LETTER[list[j].mode];
    if (tier) return `mode-${tier}`;
  }
  return 'mode-owner';
}

// Split a WHOIS channel token (`@#chan`, `@%#chan`) into its rank symbols and
// the channel name. `&`, `+` and `!` are channel types as well as symbols, so
// take the longest run of symbols that still leaves a channel name: `&ops` is
// a channel, not an admin on "ops", and `!#chan` is `#chan` under a `!` rank.
export function splitChannelToken(token: string, prefix: Prefix): { prefix: string; name: string } {
  const symbols = new Set(orDefault(prefix).map((p) => p.symbol));
  let run = 0;
  while (run < token.length && symbols.has(token[run])) run++;
  for (let i = run; i > 0; i--) {
    if (isChannelTarget(token.slice(i))) return { prefix: token.slice(0, i), name: token.slice(i) };
  }
  return { prefix: '', name: token };
}

const AUDIENCE_BY_LETTER: Record<string, string> = {
  q: 'owners',
  a: 'admins',
  o: 'ops',
  h: 'halfops',
  v: 'voiced users',
};

// Who a line sent to `@#chan` reached (STATUSMSG, #1408): the rank the symbol
// names and everyone above it. A symbol the network's PREFIX does not list, or
// a letter outside q/a/o/h/v, is named by the symbol itself.
export function statusAudience(symbol: string, prefix: Prefix): string {
  const list = orDefault(prefix);
  const i = list.findIndex((p) => p.symbol === symbol);
  const who = (i === -1 ? undefined : AUDIENCE_BY_LETTER[list[i].mode]) ?? symbol;
  return i === 0 ? `sent only to ${who}` : `sent only to ${who} and above`;
}

// The channel a STATUSMSG target (`@#room`) is shown in, or null when `target`
// is not one on this network. `symbols` is the network's own STATUSMSG
// (`modeSpec.statusmsg`), as the server reads it: the two must agree on which
// buffer the line is in.
export function statusmsgChannel(target: string, symbols: string): string | null {
  if (!target || !symbols.includes(target[0])) return null;
  const rest = target.slice(1);
  return isChannelTarget(rest) ? rest : null;
}
