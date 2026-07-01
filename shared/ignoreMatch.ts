// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// irssi-style ignore matcher (issue #301), shared by server and client so the
// insert-time stamp/push gate and the render-time filter can never diverge. A
// rule AND-s optional dimensions: who (mask, bare nick globs), where (channels),
// what (pattern), which (levels incl. the special NOHIGHLIGHT); is_except
// inverts it into a longest-mask-wins whitelist entry, expires_at lapses it.

import { buildTextTest, cleanForMatch, type TextKind } from './textMatch.js';
import { LEVEL_DEFS, ALL_TYPES, HIGHLIGHTABLE } from './ignoreLevels.js';

// The special "modifier" levels: they don't name an event-type to hide, they
// change how a still-visible message is treated (never highlight / don't bump
// unread / don't notify). Filtered out of the hide-level set so a modifier-only
// rule keeps `hides` false. See issues #301 (NOHIGHLIGHT) and #359.
const MODIFIER_LEVELS = new Set(['NOHIGHLIGHT', 'NOUNREAD', 'NONOTIFY']);

// Re-export the level helpers the store / parser / service pull from here.
export { KNOWN_LEVELS, canonicalLevel, canonicalizeLevels } from './ignoreLevels.js';

// ---- mask glob (bare nick globs, unlike the old exact-match maskMatch) ------

function splitMask(mask: string): { nick: string; user: string; host: string } {
  let nick = '*';
  let user = '*';
  let host = '*';
  const atIdx = mask.indexOf('@');
  let pre = mask;
  if (atIdx !== -1) {
    pre = mask.slice(0, atIdx);
    host = mask.slice(atIdx + 1) || '*';
  }
  const bangIdx = pre.indexOf('!');
  if (bangIdx !== -1) {
    nick = pre.slice(0, bangIdx) || '*';
    user = pre.slice(bangIdx + 1) || '*';
  } else if (atIdx !== -1) {
    user = pre || '*';
  } else {
    nick = pre || '*';
  }
  return { nick, user, host };
}

function globToRegex(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', caseInsensitive ? 'i' : '');
}

// Build a sender matcher from a mask. `null`/`*` matches anyone; a bare token is
// a case-insensitive nick glob; a `nick!user@host` form globs each part. Shared
// with the highlight engine so highlight `-mask` and ignore masks behave alike.
export function buildMaskMatcher(
  mask: string | null,
): (nick: string | null, userhost: string | null) => boolean {
  if (!mask || mask === '*') return () => true;
  if (mask.includes('!') || mask.includes('@')) {
    const { nick, user, host } = splitMask(mask);
    const nickRe = globToRegex(nick, true);
    const userRe = globToRegex(user, false);
    const hostRe = globToRegex(host, false);
    return (n, uh) => {
      if (!n || !nickRe.test(n)) return false;
      if (!uh) return user === '*' && host === '*';
      const bang = uh.indexOf('!');
      const at = uh.indexOf('@', bang + 1);
      if (bang === -1 || at === -1) return user === '*' && host === '*';
      return userRe.test(uh.slice(bang + 1, at)) && hostRe.test(uh.slice(at + 1));
    };
  }
  const nickRe = globToRegex(mask, true);
  return (n) => !!n && nickRe.test(n);
}

// Build a channel-scope matcher. `null`/empty matches every buffer; otherwise a
// case-insensitive glob against each channel name. Shared with the highlight engine.
export function buildChannelMatcher(channels: string[] | null): (target: string) => boolean {
  if (!channels || channels.length === 0) return () => true;
  const res = channels.map((c) => globToRegex(c, true));
  return (t) => !!t && res.some((re) => re.test(t));
}

// ---- rule shape + evaluation -----------------------------------------------

// Structural shape the matcher needs. The server's IgnoreRuleRow and the
// client's IgnoreEntry both satisfy it.
export interface IgnoreRule {
  id?: number;
  mask: string | null;
  channels: string[] | null;
  pattern: string | null;
  patternKind: 'substr' | 'full' | 'regex';
  levels: string[];
  isExcept: boolean;
  expiresAt: string | null;
}

export interface IgnoreInput {
  nick: string | null;
  userhost: string | null;
  target: string;
  text: string;
  type: string;
  isDm: boolean;
}

export interface IgnoreVerdict {
  hide: boolean;
  nohilight: boolean;
  // Modifier verdict (issue #359): the message stays visible + counted, but
  // nonotify suppresses toast/push/sound (honors longest-mask-wins + -except).
  // NOUNREAD is deliberately NOT a per-message verdict — muting the buffer-list
  // unread badge is a whole-buffer concern computed by channelMutesUnread off the
  // compiled `nounread` flag; per-sender unread accounting is deferred (#359).
  nonotify: boolean;
}

export interface CompiledIgnoreRule {
  isExcept: boolean;
  maskLen: number;
  expiresAt: number | null;
  hides: boolean;
  nohilight: boolean;
  nounread: boolean;
  nonotify: boolean;
  pattern: boolean; // has a content pattern (used by member-list gating)
  channels: boolean; // is channel-scoped
  anyNick: boolean; // mask matches everyone (null/*) — used by channelMutesUnread
  hasAll: boolean;
  matchesNick: (nick: string | null, userhost: string | null) => boolean;
  matchesChannel: (target: string) => boolean;
  matchesText: (text: string) => boolean;
  hideLevel: (type: string, isDm: boolean) => boolean;
}

// Map a stored rule `kind` to the textMatch vocabulary. Ignore uses only
// substr/full/regex; highlights add 'glob' and may carry the legacy 'plain'
// alias, both handled here so the two engines share one mapping.
export function patternKindToTextKind(kind: string): TextKind {
  if (kind === 'regex') return 'regex';
  if (kind === 'glob') return 'glob';
  if (kind === 'full' || kind === 'plain') return 'plain';
  return 'substr';
}

export function compileIgnoreRules(rules: IgnoreRule[]): CompiledIgnoreRule[] {
  const out: CompiledIgnoreRule[] = [];
  for (const rule of rules) {
    const hasNohilight = rule.levels.includes('NOHIGHLIGHT');
    const hasNounread = rule.levels.includes('NOUNREAD');
    const hasNonotify = rule.levels.includes('NONOTIFY');
    const hideLevels = rule.levels.filter((l) => !MODIFIER_LEVELS.has(l));
    const hasAll = hideLevels.includes('ALL');
    const hides = hideLevels.length > 0;

    const matchesNick = buildMaskMatcher(rule.mask);
    const matchesChannel = buildChannelMatcher(rule.channels);

    let matchesText: (text: string) => boolean;
    if (!rule.pattern) {
      matchesText = () => true;
    } else {
      const test = buildTextTest(rule.pattern, patternKindToTextKind(rule.patternKind), false);
      matchesText = test ?? (() => false);
    }

    const hideLevel = (type: string, isDm: boolean): boolean => {
      if (hasAll) return ALL_TYPES.has(type);
      for (const lvl of hideLevels) {
        const def = LEVEL_DEFS[lvl];
        if (!def) continue;
        if (def.types.includes(type) && (def.dm === undefined || def.dm === isDm)) return true;
      }
      return false;
    };

    out.push({
      isExcept: rule.isExcept,
      maskLen: rule.mask ? rule.mask.length : 0,
      expiresAt: rule.expiresAt ? Date.parse(rule.expiresAt) : null,
      hides,
      nohilight: hasNohilight,
      nounread: hasNounread,
      nonotify: hasNonotify,
      pattern: !!rule.pattern,
      channels: !!(rule.channels && rule.channels.length),
      anyNick: !rule.mask || rule.mask === '*',
      hasAll,
      matchesNick,
      matchesChannel,
      matchesText,
      hideLevel,
    });
  }
  return out;
}

// Whether any compiled rule carries a content pattern — lets callers skip the
// URL-strip when nothing consumes the text.
function anyHasPattern(compiled: CompiledIgnoreRule[]): boolean {
  for (const r of compiled) if (r.pattern) return true;
  return false;
}

export function evaluateIgnores(
  compiled: CompiledIgnoreRule[],
  input: IgnoreInput,
  now: number = Date.now(),
): IgnoreVerdict {
  if (compiled.length === 0) return { hide: false, nohilight: false, nonotify: false };
  const { nick, userhost, target, type, isDm } = input;
  // Only pay for the URL/formatting strip when a rule actually matches text.
  const text = input.text && anyHasPattern(compiled) ? cleanForMatch(input.text) : '';

  let bestHide = -1;
  let bestHideExcept = -1;
  let bestNo = -1;
  let bestNoExcept = -1;
  let bestNotify = -1;
  let bestNotifyExcept = -1;

  for (const r of compiled) {
    if (r.expiresAt !== null && r.expiresAt <= now) continue;
    const hideApplies = r.hides && r.hideLevel(type, isDm);
    // nohilight only sensibly applies to highlightable (message/action) events;
    // when the rule also carries hide levels it's bounded to those.
    const noApplies =
      r.nohilight && HIGHLIGHTABLE.has(type) && (r.hides ? r.hideLevel(type, isDm) : true);
    // nonotify gates notifications, which — via a channel's notify_always — can
    // fire for ANY event type (notices, joins, …), so it is NOT bounded to
    // highlightable types (issue #359 "quietest wins": a network/channel mute
    // must veto those too). Bounded only by the rule's own hide levels if it has
    // any; a modifier-only NONOTIFY rule applies to every type its target matches.
    const notifyApplies = r.nonotify && (r.hides ? r.hideLevel(type, isDm) : true);
    if (!hideApplies && !noApplies && !notifyApplies) continue;
    if (!r.matchesNick(nick, userhost)) continue;
    if (!r.matchesChannel(target)) continue;
    if (!r.matchesText(text)) continue;

    if (hideApplies) {
      if (r.isExcept) {
        if (r.maskLen > bestHideExcept) bestHideExcept = r.maskLen;
      } else if (r.maskLen > bestHide) {
        bestHide = r.maskLen;
      }
    }
    if (noApplies) {
      if (r.isExcept) {
        if (r.maskLen > bestNoExcept) bestNoExcept = r.maskLen;
      } else if (r.maskLen > bestNo) {
        bestNo = r.maskLen;
      }
    }
    if (notifyApplies) {
      if (r.isExcept) {
        if (r.maskLen > bestNotifyExcept) bestNotifyExcept = r.maskLen;
      } else if (r.maskLen > bestNotify) {
        bestNotify = r.maskLen;
      }
    }
  }

  return {
    hide: bestHide >= 0 && bestHideExcept < bestHide,
    nohilight: bestNo >= 0 && bestNoExcept < bestNo,
    nonotify: bestNotify >= 0 && bestNotifyExcept < bestNotify,
  };
}

// A nicklist row carries only a nick/userhost — no message text or type. Hide a
// member only when a rule would erase their whole presence regardless of
// content: a non-except, no-pattern, ALL-level rule scoped to all buffers or the
// open channel. Pattern / single-level / NOHIGHLIGHT rules must NOT drop someone
// from the nicklist (they're still present and talking).
export function isMemberHidden(
  compiled: CompiledIgnoreRule[],
  nick: string,
  userhost: string | null,
  channel: string,
  now: number = Date.now(),
): boolean {
  for (const r of compiled) {
    if (r.isExcept || r.pattern || !r.hasAll) continue;
    if (r.expiresAt !== null && r.expiresAt <= now) continue;
    if (!r.matchesChannel(channel)) continue;
    if (r.matchesNick(nick, userhost)) return true;
  }
  return false;
}

// Whether a whole buffer's plain-unread signal is muted (issue #359) — used by
// the buffer list to downgrade the unread badge, mirroring the old per-channel
// `muted` flag. True when a non-except, no-pattern, everyone-mask (null/*) rule
// carrying NOUNREAD covers this buffer. A network-wide rule (channels null)
// matches every buffer, so muting a network downgrades all its children here.
// Per-sender NOUNREAD (a masked rule) deliberately does NOT mute the whole
// buffer's badge — that would need insert-time unread accounting (deferred).
export function channelMutesUnread(
  compiled: CompiledIgnoreRule[],
  channel: string,
  now: number = Date.now(),
): boolean {
  for (const r of compiled) {
    if (r.isExcept || r.pattern || !r.nounread || !r.anyNick) continue;
    if (r.expiresAt !== null && r.expiresAt <= now) continue;
    if (r.matchesChannel(channel)) return true;
  }
  return false;
}
