// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Consolidation of join/part/quit/nick/chghost "noise" events into a per-identity
// net effect, IRCCloud-style. Pure, side-effect-free, no DOM/Vue deps — safe
// to import from the Vue renderer, the Node demo script, and tests.
//
// Algorithm:
//   1. Walk a stream of message rows; group consecutive consolidatable events
//      into a "run". Any non-consolidatable row (real message, kick, mode,
//      topic, divider, etc.) terminates the run.
//   2. Inside a run, walk per nick and accumulate an action sequence:
//        'J' = join
//        'L' = leave (part or quit)
//        'R' = rename (this identity changed nick)
//        'H' = rehost (chghost; ident and/or host changed)
//      Renames transfer the identity to the new key so we follow the chain.
//   3. Classify by the first/last J|L action:
//        first=L, last=J → reconnected     (was present; left and came back)
//        first=L, last=L → left            (was present; net result: gone)
//        first=J, last=J → joined          (was absent; net result: present)
//        first=J, last=L → joinedAndLeft   (was absent; net result: gone)
//      Identities with no J|L action fall back to rename over rehost:
//      any 'R' → renamed, else 'H' only → rehosted.
//
//      'H' is deliberately transparent to the J|L scan (#593). Post-netsplit
//      each rejoining user emits JOIN then CHGHOST as they identify, so their
//      sequence is [J, H]; that must read as a plain "joined" rather than
//      splitting the summary into "N joined" plus "N changed host". The
//      host change only earns its own category when nothing else happened.
//   4. A run of exactly one event is passed through unchanged (so a lone
//      "Alice joined" still renders with the familiar --> styling).

// ─── Types ─────────────────────────────────────────────────────────────────

/** The subset of a message consumed by the consolidation algorithm. */
export interface ConsolidatableMessage {
  id?: number | string | null;
  type: string;
  nick?: string;
  newNick?: string;
  time: string;
  to?: string;
}

/**
 * A row in the MessageList stream: either wraps a message (`m`) or is a
 * non-message row (divider, etc.). Only `m` and `key` are read here, so the
 * functions stay generic over the caller's richer row type.
 */
export interface MessageStreamRow {
  m?: ConsolidatableMessage | null;
  key: string | number;
}

/**
 * Per-identity action within a run: join, leave (part/quit), rename, or
 * rehost (chghost).
 */
type EventAction = 'J' | 'L' | 'R' | 'H';

/** The six ways a run's net effect on an identity can be classified. */
export type ConsolidationKind =
  | 'joined'
  | 'left'
  | 'reconnected'
  | 'joinedAndLeft'
  | 'renamed'
  | 'rehosted';

/** A nick that joined / left / reconnected / rehosted within the run. */
export interface NickEntry {
  nick: string;
}

/** A nick that renamed itself within the run. */
export interface RenameEntry {
  from: string;
  to: string;
}

/** One classified category within a consolidation summary. */
export interface ConsolidationGroup {
  kind: ConsolidationKind;
  visible: Array<NickEntry | RenameEntry>;
  hidden: number;
}

/** Synthetic row that replaces a run of consolidated presence-noise rows. */
export interface ConsolidationRow {
  consolidation: true;
  groups: ConsolidationGroup[];
  eventCount: number;
  time: string;
  firstId: number | string | null;
  lastId: number | string | null;
  key: string;
}

export interface ConsolidateOptions {
  enabled?: boolean;
  recentSpeakers?: Iterable<string> | null;
  maxNames?: number;
}

/** Mutable per-identity bookkeeping while walking a run. */
interface IdentityState {
  displayNick: string;
  originalNick: string;
  actions: EventAction[];
  seenIndex: number;
}

interface RunOptions {
  recentSpeakers: Iterable<string> | null;
  maxNames: number;
}

// ─── Algorithm ─────────────────────────────────────────────────────────────

const CONSOLIDATABLE_TYPES: ReadonlySet<string> = new Set([
  'join',
  'part',
  'quit',
  'nick',
  'chghost',
]);

function classify(actions: readonly EventAction[]): ConsolidationKind {
  const jl = actions.filter((a) => a === 'J' || a === 'L');
  // No presence change: a rename outranks a rehost, since "alice → bob" says
  // more than "alice changed host" for an identity that did both.
  if (jl.length === 0) return actions.includes('R') ? 'renamed' : 'rehosted';
  const first = jl[0];
  const last = jl[jl.length - 1];
  const wasPresent = first === 'L';
  const isPresent = last === 'J';
  if (!wasPresent && isPresent) return 'joined';
  if (wasPresent && !isPresent) return 'left';
  if (!wasPresent && !isPresent) return 'joinedAndLeft';
  return 'reconnected';
}

// Stable rank: identities whose current display nick is in recentSpeakersLc
// float to the top; everything else keeps its original insertion order.
function rankEntries<T extends { nick?: string; to?: string }>(
  entries: readonly T[],
  recentSpeakersLc: ReadonlySet<string> | null,
): T[] {
  const idx = new Map(entries.map((e, i) => [e, i] as const));
  return entries.toSorted((a, b) => {
    const aKey = (a.nick || a.to || '').toLowerCase();
    const bKey = (b.nick || b.to || '').toLowerCase();
    const aRecent = recentSpeakersLc && recentSpeakersLc.has(aKey) ? 0 : 1;
    const bRecent = recentSpeakersLc && recentSpeakersLc.has(bKey) ? 0 : 1;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
  });
}

function cap<T extends { nick?: string; to?: string }>(
  entries: readonly T[],
  maxNames: number,
  recentSpeakersLc: ReadonlySet<string> | null,
): { visible: T[]; hidden: number } {
  if (entries.length <= maxNames) return { visible: entries.slice(), hidden: 0 };
  const ranked = rankEntries(entries, recentSpeakersLc);
  return {
    visible: ranked.slice(0, maxNames),
    hidden: ranked.length - maxNames,
  };
}

function consolidateRun(
  events: readonly ConsolidatableMessage[],
  opts: RunOptions,
): ConsolidationGroup[] {
  const speakersLc: ReadonlySet<string> | null = opts.recentSpeakers
    ? new Set(Array.from(opts.recentSpeakers, (s) => String(s).toLowerCase()))
    : null;
  const maxNames = Math.max(1, opts.maxNames || 5);

  // identityKey (lowercased current nick) → identity bookkeeping
  const ids = new Map<string, IdentityState>();
  // Preserve first-seen order across rename migrations: when a rename moves an
  // entry to a new key, we'd otherwise re-insert it at the end. Track an
  // explicit seenIndex so display ordering reflects when each identity first
  // appeared in the run.
  let seenCounter = 0;

  for (const e of events) {
    if (e.type === 'nick') {
      const oldLc = String(e.nick || '').toLowerCase();
      const newLc = String(e.newNick || '').toLowerCase();
      const existing = ids.get(oldLc);
      if (existing) {
        existing.actions.push('R');
        existing.displayNick = e.newNick ?? '';
        ids.delete(oldLc);
        ids.set(newLc, existing);
      } else {
        ids.set(newLc, {
          displayNick: e.newNick ?? '',
          originalNick: e.nick ?? '',
          actions: ['R'],
          seenIndex: seenCounter++,
        });
      }
    } else {
      const lc = String(e.nick || '').toLowerCase();
      let state = ids.get(lc);
      if (!state) {
        state = {
          displayNick: e.nick ?? '',
          originalNick: e.nick ?? '',
          actions: [],
          seenIndex: seenCounter++,
        };
        ids.set(lc, state);
      }
      if (e.type === 'join') state.actions.push('J');
      else if (e.type === 'part' || e.type === 'quit') state.actions.push('L');
      else if (e.type === 'chghost') state.actions.push('H');
    }
  }

  // Uniform element type per bucket so the generic `cap()` infers a single
  // entry type; `renamed` happens to only ever receive RenameEntry values.
  const buckets: Record<ConsolidationKind, Array<NickEntry | RenameEntry>> = {
    joined: [],
    left: [],
    reconnected: [],
    joinedAndLeft: [],
    renamed: [],
    rehosted: [],
  };
  const sorted = Array.from(ids.values()).toSorted((a, b) => a.seenIndex - b.seenIndex);
  for (const id of sorted) {
    const cls = classify(id.actions);
    if (cls === 'renamed') {
      buckets.renamed.push({ from: id.originalNick, to: id.displayNick });
    } else {
      buckets[cls].push({ nick: id.displayNick });
    }
  }

  // Fixed display order across all categories so the readout reads the same
  // way every time.
  const groupOrder: ConsolidationKind[] = [
    'joined',
    'left',
    'reconnected',
    'joinedAndLeft',
    'renamed',
    'rehosted',
  ];
  const groups: ConsolidationGroup[] = [];
  for (const kind of groupOrder) {
    if (buckets[kind].length === 0) continue;
    const { visible, hidden } = cap(buckets[kind], maxNames, speakersLc);
    groups.push({ kind, visible, hidden });
  }
  return groups;
}

// Walk a row list (the same shape MessageList.vue emits — items either have
// `m` for a real message or a `divider` field) and merge consecutive
// consolidatable rows into single `consolidation: true` rows.
export function consolidateRows<R extends MessageStreamRow>(
  rows: readonly R[],
  options: ConsolidateOptions = {},
): Array<R | ConsolidationRow> {
  if (!options.enabled) return rows.slice();
  const opts: RunOptions = {
    recentSpeakers: options.recentSpeakers || null,
    maxNames: options.maxNames || 5,
  };
  const out: Array<R | ConsolidationRow> = [];
  let run: R[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
      run = [];
      return;
    }
    // Every row in `run` was pushed only after `r.m` was confirmed present.
    const events = run.map((r) => r.m as ConsolidatableMessage);
    const groups = consolidateRun(events, opts);
    out.push({
      consolidation: true,
      groups,
      eventCount: events.length,
      time: events[events.length - 1].time,
      firstId: events[0].id ?? null,
      lastId: events[events.length - 1].id ?? null,
      key: `cons:${run[0].key}-${run[run.length - 1].key}`,
    });
    run = [];
  };

  for (const r of rows) {
    if (r && r.m && CONSOLIDATABLE_TYPES.has(r.m.type)) {
      run.push(r);
    } else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

// Convenience: consolidate a raw message array (no row wrapping) into a row
// list. Used by the demo script and tests.
export function consolidateMessages(
  messages: readonly ConsolidatableMessage[],
  options: ConsolidateOptions = {},
): Array<MessageStreamRow | ConsolidationRow> {
  const rows: MessageStreamRow[] = messages.map((m, i) => ({ m, key: m.id ?? `idx:${i}` }));
  return consolidateRows(rows, { enabled: true, ...options });
}

export { CONSOLIDATABLE_TYPES };
