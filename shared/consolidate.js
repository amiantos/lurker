// Consolidation of join/part/quit/nick "noise" events into a per-identity
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
//      Renames transfer the identity to the new key so we follow the chain.
//   3. Classify by the first/last J|L action:
//        first=L, last=J → reconnected     (was present; left and came back)
//        first=L, last=L → left            (was present; net result: gone)
//        first=J, last=J → joined          (was absent; net result: present)
//        first=J, last=L → joinedAndLeft   (was absent; net result: gone)
//      Identities with only 'R' actions are categorized as renamed.
//   4. A run of exactly one event is passed through unchanged (so a lone
//      "Alice joined" still renders with the familiar --> styling).

const CONSOLIDATABLE_TYPES = new Set(['join', 'part', 'quit', 'nick']);

function classify(actions) {
  const jl = actions.filter((a) => a === 'J' || a === 'L');
  if (jl.length === 0) return 'renamed';
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
function rankEntries(entries, recentSpeakersLc) {
  const idx = new Map(entries.map((e, i) => [e, i]));
  return entries.slice().sort((a, b) => {
    const aKey = (a.nick || a.to || '').toLowerCase();
    const bKey = (b.nick || b.to || '').toLowerCase();
    const aRecent = recentSpeakersLc && recentSpeakersLc.has(aKey) ? 0 : 1;
    const bRecent = recentSpeakersLc && recentSpeakersLc.has(bKey) ? 0 : 1;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return idx.get(a) - idx.get(b);
  });
}

function cap(entries, maxNames, recentSpeakersLc) {
  if (entries.length <= maxNames) return { visible: entries, hidden: 0 };
  const ranked = rankEntries(entries, recentSpeakersLc);
  return {
    visible: ranked.slice(0, maxNames),
    hidden: ranked.length - maxNames,
  };
}

function consolidateRun(events, opts) {
  const speakersLc = opts.recentSpeakers
    ? new Set(Array.from(opts.recentSpeakers, (s) => String(s).toLowerCase()))
    : null;
  const maxNames = Math.max(1, opts.maxNames || 5);

  // identityKey (lowercased current nick) → { displayNick, originalNick, actions[] }
  const ids = new Map();
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
        existing.displayNick = e.newNick;
        ids.delete(oldLc);
        ids.set(newLc, existing);
      } else {
        ids.set(newLc, {
          displayNick: e.newNick,
          originalNick: e.nick,
          actions: ['R'],
          seenIndex: seenCounter++,
        });
      }
    } else {
      const lc = String(e.nick || '').toLowerCase();
      if (!ids.has(lc)) {
        ids.set(lc, {
          displayNick: e.nick,
          originalNick: e.nick,
          actions: [],
          seenIndex: seenCounter++,
        });
      }
      if (e.type === 'join') ids.get(lc).actions.push('J');
      else if (e.type === 'part' || e.type === 'quit') ids.get(lc).actions.push('L');
    }
  }

  const buckets = {
    joined: [],
    left: [],
    reconnected: [],
    joinedAndLeft: [],
    renamed: [],
  };
  const sorted = Array.from(ids.values()).sort((a, b) => a.seenIndex - b.seenIndex);
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
  const groupOrder = ['joined', 'left', 'reconnected', 'joinedAndLeft', 'renamed'];
  const groups = [];
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
export function consolidateRows(rows, options = {}) {
  if (!options.enabled) return rows;
  const opts = {
    recentSpeakers: options.recentSpeakers || null,
    maxNames: options.maxNames || 5,
  };
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
      run = [];
      return;
    }
    const events = run.map((r) => r.m);
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
export function consolidateMessages(messages, options = {}) {
  const rows = messages.map((m, i) => ({ m, key: m.id ?? `idx:${i}` }));
  return consolidateRows(rows, { enabled: true, ...options });
}

export { CONSOLIDATABLE_TYPES };
