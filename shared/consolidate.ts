// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Consolidation of join/part/quit/nick/chghost "noise" events into a per-identity
// net effect, IRCCloud-style, plus op/voice churn folded alongside it. Pure,
// side-effect-free, no DOM/Vue deps — safe to import from the Vue renderer, the
// Node demo script, and tests.
//
// Algorithm:
//   1. Walk a stream of message rows; group consecutive foldable events into a
//      "run". Any other row (a real message, a kick, a topic, a divider)
//      terminates it. A `mode` row folds when it is pure member-status churn
//      and terminates the run otherwise — one ban or channel flag in the
//      message and it stands alone (see foldsIntoRun / isChurnMode). Before
//      that, EVERY mode row broke the run, which is why a netsplit rejoin on an
//      auto-op channel came out as summary, mode, summary, mode, summary.
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
//   4. Mode rows are folded by a SECOND pass, keyed on (nick, letter) rather
//      than on identity, since a mode change has no join/leave sequence and its
//      target need never have joined inside the run. The run's last change to a
//      pair wins and nothing is dropped — see modeGroups.
//   5. A run of exactly one event is passed through unchanged (so a lone
//      "Alice joined" still renders with the familiar --> styling, and a lone
//      "+o alice" still renders as its narrated mode line).

import { isChurnMode, modeLetter, type ModeChange } from './modes.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** The subset of a message consumed by the consolidation algorithm. */
export interface ConsolidatableMessage {
  id?: number | string | null;
  type: string;
  nick?: string;
  newNick?: string;
  time: string;
  to?: string;
  /** A `mode` row's parsed change list, each entry stamped with its `kind`. */
  modes?: readonly ModeChange[] | null;
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

/**
 * How a run's net effect is classified.
 *
 * The first six are per-identity: one nick, one verdict, derived from its
 * join/leave/rename/rehost sequence. The last two are per-(nick, mode letter)
 * and come from a separate pass — see modeGroups for why they can't share the
 * identity chain.
 */
export type ConsolidationKind =
  | 'joined'
  | 'left'
  | 'reconnected'
  | 'joinedAndLeft'
  | 'renamed'
  | 'rehosted'
  | 'modeGranted'
  | 'modeRevoked'
  | 'modeBriefly'
  | 'modeRegranted';

/**
 * The kinds the per-identity walk can produce. Split out so the bucket record
 * below stays exhaustive by construction: adding a mode kind to
 * ConsolidationKind must not silently leave a hole there.
 */
type IdentityKind = Exclude<
  ConsolidationKind,
  'modeGranted' | 'modeRevoked' | 'modeBriefly' | 'modeRegranted'
>;

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
  /**
   * For the four `mode*` kinds only: the member-prefix letter the group
   * is about (`o`, `v`, …). The WORDS for it are the renderer's business —
   * each client picks its own phrasing, the way it already does for joined /
   * left — so only the letter travels.
   */
  letter?: string;
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
  /** The rows the summary stands for, in order: what a reader expands it into. */
  rows: readonly MessageStreamRow[];
  /** Set when those rows follow the summary in the list (`isExpanded`). */
  expanded?: true;
}

export interface ConsolidateOptions {
  enabled?: boolean;
  recentSpeakers?: Iterable<string> | null;
  maxNames?: number;
  /**
   * Whether the reader has opened this run (#1430). An open run keeps its
   * summary and is followed by its own rows, so the summary reads as the
   * heading of what it folded. Asked once per run of two or more.
   */
  isExpanded?: (rows: readonly MessageStreamRow[]) => boolean;
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

/**
 * Whether a message can sit inside a consolidation run.
 *
 * Wider than CONSOLIDATABLE_TYPES, and deliberately a separate question. A
 * `mode` row folds when it is pure member-status churn, but it is NOT a member
 * of that set — because that set also defines the `renderable` page unit
 * (shared/eventFilter.ts), and moving `mode` into it would change what a
 * `countBy:'renderable'` page contains for every client, shipped iOS builds
 * included.
 *
 * What folds and what counts are therefore two questions, and they must stay in
 * step: `countsTowardPage` subtracts churn modes under `renderable` for exactly
 * this reason. Folding MORE than the unit counts is the harmful direction — the
 * page renders shorter than budgeted and the client re-fetches (#10). Folding
 * LESS is harmless: the page renders longer than asked, which is where a client
 * that folds presence but not mode sits.
 */
function foldsIntoRun(m: ConsolidatableMessage): boolean {
  if (CONSOLIDATABLE_TYPES.has(m.type)) return true;
  return m.type === 'mode' && isChurnMode(m.modes);
}

function classify(actions: readonly EventAction[]): IdentityKind {
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

/** Mutable per-(nick, letter) bookkeeping while walking a run's mode changes. */
interface ModeState {
  nick: string;
  letter: string;
  /** The run's first change to this pair — which implies the state BEFORE it. */
  first: '+' | '-';
  /** The run's last change, i.e. the state after. */
  last: '+' | '-';
  seenIndex: number;
}

/**
 * Classify a (nick, letter) pair by its first and last change in the run —
 * the same first/last reading `classify()` gives a presence identity, and for
 * the same reason: the FIRST change implies the prior state. An opening `-o`
 * means they held op before the run started.
 *
 *   +…+  didn't have it, does now          → modeGranted     "was opped"
 *   -…-  had it, doesn't now               → modeRevoked     "was deopped"
 *   +…-  didn't have it, blipped, doesn't  → modeBriefly     "was briefly opped"
 *   -…+  had it, lost it, has it again     → modeRegranted   "was opped again"
 *
 * The last two are the mode-side of `joinedAndLeft` and `reconnected`. Keeping
 * them means a cancelled pair is never silently dropped OR misreported as its
 * end state alone — which matters here more than for presence, because the
 * summary has to stand on its own: only some clients can open it (#1430).
 */
function classifyMode(first: '+' | '-', last: '+' | '-'): ConsolidationKind {
  if (first === '+') return last === '+' ? 'modeGranted' : 'modeBriefly';
  return last === '+' ? 'modeRegranted' : 'modeRevoked';
}

/**
 * Fold a run's member-status changes into per-(nick, letter) net effects.
 *
 * This is a SEPARATE pass from the identity walk, and has to be. That walk is
 * keyed on identity and classifies by a join/leave sequence; a mode change has
 * neither shape — its subject is a (nick, letter) pair, its verdict is a sign,
 * and its target need never have joined inside the run at all. Trying to reuse
 * the identity chain would mean two meanings for one bucket. The cost is a
 * second summary vocabulary, which is exactly what the lurker-ios prototype
 * flagged when it tried this and backed it out; we pay it deliberately.
 *
 * Each pair is classified by its first and last change (see classifyMode), so a
 * nick appears exactly once per letter and a cancelled pair reads "was briefly
 * opped" — the mode-side of `joinedAndLeft`, and the same vocabulary the
 * presence half already uses for the same shape. Nothing is ever dropped: a
 * client that cannot open the summary (#1430) has no other way to get a
 * dropped nick back.
 *
 * Renames are NOT followed. The identity walk migrates a nick across an 'R'
 * action; this keys on the parameter as written, so alice→bob opped as bob is
 * reported as bob. Threading two identity models through one run costs more
 * than it buys.
 */
function modeGroups(
  events: readonly ConsolidatableMessage[],
  maxNames: number,
  speakersLc: ReadonlySet<string> | null,
): ConsolidationGroup[] {
  const net = new Map<string, ModeState>();
  let seen = 0;
  for (const e of events) {
    for (const c of e.modes ?? []) {
      // Only member-status changes fold. A run can only contain mode rows that
      // passed isChurnMode, so this is a narrowing rather than a second filter.
      if (!c || c.kind !== 'prefix' || !c.param) continue;
      const letter = modeLetter(c.mode);
      if (!letter) continue;
      const key = `${c.param.toLowerCase()}\u0000${letter}`;
      const sign: '+' | '-' = c.mode.startsWith('-') ? '-' : '+';
      const prev = net.get(key);
      net.set(key, {
        nick: c.param,
        letter,
        // The first change is captured once and never overwritten — it is what
        // says whether they held the mode before the run.
        first: prev ? prev.first : sign,
        last: sign,
        // First appearance fixes the display order; later changes to the same
        // pair update the verdict without moving it.
        seenIndex: prev ? prev.seenIndex : seen++,
      });
    }
  }

  interface Bucket {
    kind: ConsolidationKind;
    letter: string;
    entries: NickEntry[];
    seenIndex: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const st of Array.from(net.values()).toSorted((a, b) => a.seenIndex - b.seenIndex)) {
    const kind = classifyMode(st.first, st.last);
    const bucketKey = `${kind}${st.letter}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { kind, letter: st.letter, entries: [], seenIndex: st.seenIndex };
      buckets.set(bucketKey, bucket);
    }
    bucket.entries.push({ nick: st.nick });
  }

  const groups: ConsolidationGroup[] = [];
  for (const bucket of Array.from(buckets.values()).toSorted((a, b) => a.seenIndex - b.seenIndex)) {
    const { visible, hidden } = cap(bucket.entries, maxNames, speakersLc);
    groups.push({ kind: bucket.kind, visible, hidden, letter: bucket.letter });
  }
  return groups;
}

function consolidateRun(
  events: readonly ConsolidatableMessage[],
  opts: RunOptions,
): ConsolidationGroup[] {
  const speakersLc: ReadonlySet<string> | null = opts.recentSpeakers
    ? new Set(Array.from(opts.recentSpeakers, (s) => String(s).toLowerCase()))
    : null;
  const maxNames = Math.max(1, opts.maxNames || 5);

  // The two passes read disjoint slices of the run: the identity walk below
  // takes presence events, modeGroups takes the mode rows.
  const modeEvents = events.filter((e) => e.type === 'mode');
  const presenceEvents = modeEvents.length > 0 ? events.filter((e) => e.type !== 'mode') : events;

  // identityKey (lowercased current nick) → identity bookkeeping
  const ids = new Map<string, IdentityState>();
  // Preserve first-seen order across rename migrations: when a rename moves an
  // entry to a new key, we'd otherwise re-insert it at the end. Track an
  // explicit seenIndex so display ordering reflects when each identity first
  // appeared in the run.
  let seenCounter = 0;

  for (const e of presenceEvents) {
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
  const buckets: Record<IdentityKind, Array<NickEntry | RenameEntry>> = {
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
  const groupOrder: IdentityKind[] = [
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
  // Mode groups trail the presence ones: who is here reads first, what they
  // were given second.
  groups.push(...modeGroups(modeEvents, maxNames, speakersLc));
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
    // A run that produced nothing to say renders as its own rows rather than as
    // an empty summary. Unreachable today — every foldable row contributes a
    // group — but it is the guard that keeps it that way, since widening
    // foldsIntoRun without teaching a pass about the new type would otherwise
    // swallow those rows into a blank line. lurker-ios has had this since #59.
    if (groups.length === 0) {
      out.push(...run);
      run = [];
      return;
    }
    const expanded = !!options.isExpanded?.(run);
    out.push({
      consolidation: true,
      groups,
      eventCount: events.length,
      time: events[events.length - 1].time,
      firstId: events[0].id ?? null,
      lastId: events[events.length - 1].id ?? null,
      key: `cons:${run[0].key}-${run[run.length - 1].key}`,
      rows: run,
      ...(expanded ? { expanded } : {}),
    });
    if (expanded) out.push(...run);
    run = [];
  };

  for (const r of rows) {
    if (r && r.m && foldsIntoRun(r.m)) {
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
