// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The notification "quietness" ladder (issue #359), shared by the channel/DM
// buffer menu (useBufferActions) and the network menu (useNetworkActions). A
// single monotonically-quieter radio group per buffer/network:
//
//   Channel:  All messages · Highlights only (default) · Nothing · Muted
//   DM:       All messages (default) · Nothing · Muted     (no "Highlights only"
//             — every DM is already the signal)
//   Network:  Highlights only (default) · Nothing · Muted  (no "All" — a network
//             firehose makes no sense)
//
// Beside the ladder, channels and networks get a "Suppress Highlights" box
// (#1414): on any rung, nothing said there highlights. Muted alone still
// badges a highlight, which is the point of muting a room you follow; the box
// is for a room where a mention of your nick is noise too. Not on the DM menu,
// where the conversation itself is the signal, not a matched word.
//
// The box is an ignore rule of its own (NOHIGHLIGHT, same scope), beside the
// rung's rule and never merged into it: ticking it rewrites nothing. The
// server stamps a highlight as a line arrives, so counts already on a buffer
// stay; the message list reads today's rules, so the tint goes at once.
//
// What the menu SHOWS is read from every silencing rule at that scope, not
// only the ones it writes (the ignores store's bufferSilencing /
// networkSilencing). When those are not exactly the menu's own shapes (a rule
// combining the levels, a timed mute, two of a kind) the rows show what is in
// force but are disabled, with a line saying a custom rule has them: a change
// from here would rewrite or strand what the user typed.
//
// Under the hood the suppressor rungs are ignore rules: "Nothing" = a NONOTIFY
// rule, "Muted" = NONOTIFY + NOUNREAD, both scoped to the buffer (channel/DM
// target) or the whole network. "All messages" is the channel-only notify_always
// flag. The rungs are mutually exclusive, so no conflicting state can be created
// from the menu; if a hand-typed /ignore contradicts, the ignore veto wins.

import { CircleDotIcon, CircleIcon } from '@lucide/vue';
import { checkboxItem, type ContextMenuItem } from './useContextMenu.js';
import { useIgnoresStore } from '../stores/ignores.js';
import { useChannelNotifyStore } from '../stores/channelNotify.js';
import { canonicalizeLevels, type IgnoreRule } from '../utils/ignoreMatch.js';

type Rung = 'all' | 'highlights' | 'nothing' | 'muted';

export const CUSTOM_NOTE = 'Set by a custom ignore rule';

// Levels for the suppressor rungs; 'all'/'highlights' carry no ignore rule.
function levelsForRung(rung: Rung): string[] | null {
  if (rung === 'nothing') return canonicalizeLevels(['NONOTIFY']);
  if (rung === 'muted') return canonicalizeLevels(['NOUNREAD', 'NONOTIFY']);
  return null;
}

function sameLevels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((l) => set.has(l));
}

// Which rung a mute rule's levels represent. Keyed on NONOTIFY (the notify
// dimension): NONOTIFY+NOUNREAD = Muted, NONOTIFY alone = Nothing. A NOUNREAD-only
// rule (badge hidden but notifications still fire — only reachable by hand-typed
// /ignore) falls through to `base`, since it is neither "Nothing" nor "Muted".
function rungFromLevels(levels: string[], base: Rung): Rung {
  if (levels.includes('NONOTIFY')) return levels.includes('NOUNREAD') ? 'muted' : 'nothing';
  return base;
}

export function useNotifyLadder() {
  const ignores = useIgnoresStore();
  const channelNotify = useChannelNotifyStore();

  function rungItem(label: string, active: boolean, onClick: () => void): ContextMenuItem {
    return { label, icon: active ? CircleDotIcon : CircleIcon, onClick };
  }

  // The rows as given, or, when a custom rule has this scope, the same rows
  // disabled over a line saying so.
  function guarded(custom: boolean, rows: ContextMenuItem[]): ContextMenuItem[] {
    if (!custom) return rows;
    return [
      ...rows.map((row) => (row.heading ? row : { ...row, disabled: true })),
      { note: CUSTOM_NOTE },
    ];
  }

  // Reconcile the per-buffer (or, when channels is null, per-network) mute rule
  // to the desired rung: remove a stale rule and add the wanted one. Idempotent
  // when the current rule already matches. A new rule is added at `addNetworkId`
  // (network scope), but a stale rule is removed from ITS OWN scope
  // (existing.networkId, null = global) so a hand-typed global mute is cleared
  // from the right bucket rather than orphaned.
  function reconcileRule(
    addNetworkId: number,
    existing: { id: number; levels: string[]; networkId: number | null } | null,
    want: string[] | null,
    channels: string[] | null,
  ): void {
    if (existing && want && sameLevels(existing.levels, want)) return;
    if (existing) ignores.removeRule(existing.networkId, { id: existing.id });
    if (want) {
      const rule: IgnoreRule = {
        mask: null,
        channels,
        pattern: null,
        patternKind: 'substr',
        levels: want,
        isExcept: false,
        expiresAt: null,
      };
      ignores.addRule(addNetworkId, rule);
    }
  }

  // The Suppress Highlights box: add the rule, or remove the one that is there
  // now, from the scope it is in. `find` runs at the tap (#1136).
  function suppressItem(
    networkId: number,
    shown: boolean,
    find: () => { id: number; networkId: number | null } | null,
    channels: string[] | null,
  ): ContextMenuItem {
    return checkboxItem('Suppress Highlights', shown, (next) => {
      const existing = find();
      if (next && !existing) {
        ignores.addRule(networkId, {
          mask: null,
          channels,
          pattern: null,
          patternKind: 'substr',
          levels: ['NOHIGHLIGHT'],
          isExcept: false,
          expiresAt: null,
        });
      } else if (!next && existing) {
        ignores.removeRule(existing.networkId, { id: existing.id });
      }
    });
  }

  // ---- Channel: 4 rungs (notify_always + buffer mute rule) ------------------
  function channelItems(networkId: number, target: string): ContextMenuItem[] {
    const notifyAlways = channelNotify.notifyAlways(networkId, target);
    const { levels, custom } = ignores.bufferSilencing(networkId, target);
    // A custom rule that silences wins over All messages, as it does when a
    // line arrives (the ignore veto).
    const current: Rung =
      notifyAlways && !(custom && levels.includes('NONOTIFY'))
        ? 'all'
        : rungFromLevels(levels, 'highlights');
    // Each rung is a target, so it reconciles against the state as it is when
    // tapped, not as it was when the menu opened (#1136).
    const set = (rung: Rung) => {
      if ((rung === 'all') !== channelNotify.notifyAlways(networkId, target)) {
        channelNotify.setNotifyAlways(networkId, target, rung === 'all');
      }
      reconcileRule(networkId, ignores.bufferMuteRule(networkId, target), levelsForRung(rung), [
        target.toLowerCase(),
      ]);
    };
    return guarded(custom, [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
      suppressItem(
        networkId,
        levels.includes('NOHIGHLIGHT'),
        () => ignores.bufferSuppressRule(networkId, target),
        [target.toLowerCase()],
      ),
    ]);
  }

  // ---- DM: 3 rungs (buffer mute rule only, no notify_always) ----------------
  function dmItems(networkId: number, target: string): ContextMenuItem[] {
    const { levels, custom } = ignores.bufferSilencing(networkId, target);
    const current: Rung = rungFromLevels(levels, 'all');
    const set = (rung: Rung) =>
      reconcileRule(networkId, ignores.bufferMuteRule(networkId, target), levelsForRung(rung), [
        target.toLowerCase(),
      ]);
    return guarded(custom, [
      { heading: 'Notifications' },
      rungItem('All messages', current === 'all', () => set('all')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
    ]);
  }

  // ---- Network: 3 rungs (network-wide mute rule) ----------------------------
  function networkItems(networkId: number): ContextMenuItem[] {
    const { levels, custom } = ignores.networkSilencing(networkId);
    const current: Rung = rungFromLevels(levels, 'highlights');
    const set = (rung: Rung) =>
      reconcileRule(networkId, ignores.networkMuteRule(networkId), levelsForRung(rung), null);
    return guarded(custom, [
      { heading: 'Notifications' },
      rungItem('Highlights only', current === 'highlights', () => set('highlights')),
      rungItem('Nothing', current === 'nothing', () => set('nothing')),
      rungItem('Muted', current === 'muted', () => set('muted')),
      suppressItem(
        networkId,
        levels.includes('NOHIGHLIGHT'),
        () => ignores.networkSuppressRule(networkId),
        null,
      ),
    ]);
  }

  return { channelItems, dmItems, networkItems };
}
