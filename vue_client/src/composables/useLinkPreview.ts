// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client half of link previews.
//
// ⚠⚠ Resolution is driven by message INGEST, never by rendering. `primePreviews` is called
// when messages enter the store — a backlog frame, a history page, a live message — and
// components only ever READ, through `useLinkPreview`.
//
// The first version had this backwards: a row asked for its preview *while rendering*, which
// kicked off a fetch, which mutated shared state, which grew the row, which forced the list to
// correct its own scroll position. Rendering had side effects, so every scroll into history
// triggered async growth and needed bespoke compensation. QA felt it exactly as described:
// "the chat loads in completely flat, then inline content loads in a burst, throwing off the
// scroll offset".
//
// Slack and Discord don't have this problem because an unfurl is part of the message record —
// it arrives WITH the message, so scrollback is laid out correctly on first paint and async
// growth only happens for a brand-new message at the bottom, where the list already follows.
// Priming at ingest is how we get that property without the server storing unfurls on every
// message (which would mean fetching for people who have the feature off).
//
// Two layers of coalescing, catching different things:
//
//   - `cache` dedupes across TIME. Scroll past a link and back, and the second pass is free.
//   - `queue` dedupes across a TICK. A history page arrives with fifty rows; they become one
//     POST rather than fifty.

import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { api } from '../api.js';
import { previewableUrls, type PreviewToggles } from '../utils/previewUrls.js';

export type PreviewKind = 'image' | 'video' | 'audio' | 'page' | 'video-embed';

export interface LinkPreview {
  url: string;
  status: 'ok' | 'unavailable';
  kind: PreviewKind;
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  /** Proxied bytes for direct media. Server-minted — never built here. */
  src?: string;
  /** Proxied card thumbnail. Server-minted — never built here. */
  thumb?: string;
  thumbWidth?: number;
  thumbHeight?: number;
  embedUrl?: string;
  mime?: string;
  expiresAt: string;
}

// Module-level, not per-component: two message rows showing the same link must
// share one entry, and a row that unmounts on scroll must not throw away what
// it learned.
const cache = new Map<string, Ref<LinkPreview | null>>();

/**
 * URLs priming has already asked about.
 *
 * ⚠ Tracked SEPARATELY from `cache`, and that separation is load-bearing. `useLinkPreview`
 * creates an empty entry as a side effect of being read, so when the skip condition was
 * `cache.has(url)` a mere RENDER blocked that URL from ever being primed. The failure was
 * exactly the default path: with both settings off nothing primes, then the user switches one
 * on, every visible URL gets a null entry from the render pass, and no later history page or
 * live message could ever queue them because they "already existed". Previews stayed missing
 * until a full reload.
 */
const asked = new Set<string>();

/**
 * Bumped when a batch of previews lands and something changed.
 *
 * Only for the residual case: a reader scrolling fast enough to outrun the priming request,
 * so a row renders before its preview is known and grows when it arrives. With priming at
 * ingest this is the exception rather than — as it was — every single scroll into history.
 */
export const previewRevision = ref(0);

/**
 * A rendered preview is about to change height for a reason other than an answer landing: a
 * card dropping a picture that failed to load. Called BEFORE the change renders, so the lists
 * watching `previewRevision` can hold a scrolled-up reader's place across it.
 */
export function previewLayoutChanging(): void {
  previewRevision.value++;
}

let queue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Server cap per request; batching past it just means a second POST. */
const MAX_BATCH = 20;
/**
 * One frame-ish. Long enough that everything mounting in the same tick lands in
 * one batch, short enough that a preview never feels like it's lagging behind
 * the scroll.
 */
const FLUSH_MS = 24;

/**
 * Ceiling on ONE FLUSH — every slice of it, not each slice separately.
 *
 * ⚠⚠ Two distinct hangs, and the per-slice form only fixed one. `api()` had no signal and no
 * timeout, so a proxy that accepts and never answers left the promise pending for the life of the
 * tab; and `flush` awaits its slices SEQUENTIALLY, so that one stuck POST also stranded every
 * later slice with no request ever sent. Bounding each slice separately left the second hang
 * intact at 45s x sliceIndex — a 200-URL history page would not issue its last POST for seven and
 * a half minutes, and with the reveal gate every message holding one of those URLs renders no
 * attachments at all until it does. One deadline across the call bounds the blanking to this
 * number no matter how many slices there are.
 *
 * Generous against the server's own budget — 10s of queue wait plus a 30s resolve deadline,
 * answered as one `Promise.all` over the slice — so it only fires when the round trip is
 * genuinely stuck rather than merely slow.
 */
const RESOLVE_TIMEOUT_MS = 45_000;

async function flush(): Promise<void> {
  flushTimer = null;
  const urls = [...queue];
  queue = new Set();
  if (urls.length === 0) return;

  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  for (let i = 0; i < urls.length; i += MAX_BATCH) {
    const slice = urls.slice(i, i + MAX_BATCH);
    try {
      const remaining = deadline - Date.now();
      // Nothing left of the budget: put the rest back in play WITHOUT posting. A request issued
      // against an already-blown deadline would only add load to a server that has just failed to
      // answer, and the URLs reach the same recoverable state either way.
      if (remaining <= 0) throw new Error('resolve budget exhausted');
      // ⚠ A real abort, not a race. `Promise.race` against a timer leaves the socket open, the
      // body still downloading, and the completed answer discarded into a handler that has
      // already re-armed all 20 URLs for a re-ask — so one stuck slice fanned out into ~18
      // duplicate POSTs aimed at a server that was already struggling.
      //
      // ⚠ `AbortController` + `setTimeout` rather than `AbortSignal.timeout`, which no test can
      // reach: vitest's fake timers don't patch it, so the only way to exercise this would be a
      // 45-second wall-clock wait — i.e. it would never be exercised.
      const abort = new AbortController();
      const abortTimer = setTimeout(() => abort.abort(), remaining);
      let res: { previews: LinkPreview[] };
      try {
        res = await api<{ previews: LinkPreview[] }>('/api/link-preview/resolve', {
          method: 'POST',
          body: { urls: slice },
          signal: abort.signal,
        });
      } finally {
        clearTimeout(abortTimer);
      }
      const answered = new Set<string>();
      for (const preview of res.previews ?? []) {
        const entry = cache.get(preview.url);
        if (entry) {
          answered.add(preview.url);
          // The one place a cache entry gains a value, so the one place `heldValues` grows.
          if (entry.value == null) heldValues++;
          entry.value = preview;
          // ⚠ Refresh recency on every fill. `Map` preserves INSERTION order and eviction walks
          // it oldest-first, so without this a re-primed URL keeps its original position — and
          // once the cache is saturated, `evictIfNeeded` below reclaims the answer in the very
          // flush that delivered it. A URL that fell out could never come back.
          //
          // ⚠⚠ Delete-then-set re-inserts the SAME Ref OBJECT, so this moves the key's position
          // without touching identity. That is the one thing this file must never do (#694), and
          // it is not being done here: no row loses the object it is watching.
          cache.delete(preview.url);
          cache.set(preview.url, entry);
          if (preview.status === 'ok') {
            retry.delete(preview.url);
          } else {
            armReask(preview.url, Date.parse(preview.expiresAt ?? ''));
          }
        }
      }
      // ⚠⚠ Reconciled against what was SENT, not just iterated over what came back. A URL the
      // server omits — a truncated response, a batch cap drifting out of step with MAX_BATCH,
      // a 200 carrying an error body that `?? []` turns into zero previews — otherwise reached
      // a state no recovery path could see: `asked` still holds it so priming skips it, no
      // `retry` entry exists so nothing re-asks it, and `dropIfExpired` returns early because a
      // null value has no `expiresAt`. Permanently blank, from a response that looked fine.
      for (const url of slice) if (!answered.has(url)) forgetForRetry(url);
      // ⚠⚠ UNCONDITIONAL, and the condition it replaced went through two wrong versions.
      //
      // It was `if (changed)` — only an `ok` answer — guarded by a comment reading "only an `ok`
      // preview renders anything, so only an `ok` preview can change a row's height". True until
      // the reveal gate existed; after it, an `unavailable` is very often the answer that
      // COMPLETES a gate and paints a whole block. Then it was `answered.size > 0`, which still
      // missed the case where the server answers with nothing at all: `forgetForRetry` runs for
      // every unanswered URL, that too opens gates, and nothing bumped.
      //
      // The rule this now follows: ANY path that can move a URL out of the pending set can open a
      // gate, and every gate that opens grows a row. `pendingRevision` marks exactly those paths,
      // so the two are bumped together wherever a gate can open — never in `primePreviews`'s
      // queueing branch, which only ever ADDS to the pending set and so can only close one.
      //
      // ⚠ Reclaim HERE, where values actually land, not only on the next prime. `heldValues`
      // grows in this loop and nowhere else, so leaving eviction to `primePreviews` meant one
      // large ingest — a history page, or switching previews on over a loaded buffer — could sit
      // arbitrarily far above the ceiling until some later message happened to prime again. The
      // two bumps below already cover any row this blanks.
      evictIfNeeded();
      previewRevision.value++;
      pendingRevision.value++;
      scheduleReask();
    } catch {
      // A failed resolve leaves the ref null, which renders as "no preview" — the same as a
      // link the server couldn't unfurl. There is nothing useful to tell the user about a
      // decoration that didn't appear, and an error state in the message list would be worse
      // than the missing card. Every URL in the slice is put back in play; none of them got an
      // answer, so none of them has a verdict to remember.
      for (const url of slice) forgetForRetry(url);
      // ⚠ Both, for the reason above: `forgetForRetry` fails the gate OPEN, so a 502 mid-deploy
      // paints every block that was waiting on this slice — including cached siblings that have
      // been resolved all along. That is the largest single growth this feature produces, and it
      // was the one path with no re-pin at all.
      previewRevision.value++;
      pendingRevision.value++;
      scheduleReask();
    }
  }
}

// ─── Re-asking an `unavailable` once its TTL lapses ───────────────────────────
//
// ⚠⚠ The server deliberately does NOT cache some failures — pool saturation, a resolve
// deadline — and stamps them with a ~15s `expiresAt` instead of the one-hour failure TTL,
// specifically so a client comes back. Nothing was coming back: `dropIfExpired` only runs
// inside `primePreviews`, which is driven by INGEST, and a message already in the store is
// never ingested again. So a transient failure was indistinguishable from a permanent verdict
// and the row stayed blank for the life of the tab — the exact outcome the server-side
// transient/verdict split was built to avoid.
//
// This is time-driven, not render-driven, so the "a read is a read" invariant at the top of
// this file still holds: rendering a row still cannot cause a fetch.

/**
 * When to ask again about a URL, and how many times we already have.
 *
 * `at: Infinity` means "asked, waiting for the answer" — see `runReask`.
 */
const retry = new Map<string, { at: number; tries: number }>();
let reaskTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Floor on the gap between re-asks, doubling per consecutive failure up to a ceiling.
 *
 * ⚠ A FLOOR, not the delay itself — the delay is whatever the server's own `expiresAt` asks
 * for, and this only raises it. That distinction is what keeps the steady state cheap without
 * needing an attempt cap: a genuinely dead URL is answered with the one-hour failure TTL, so
 * its next ask is an hour out and the floor never binds. The floor binds only on the 15s
 * transient answer, which means the instance is saturated — precisely when backing off is the
 * right thing to do rather than re-asking every 15 seconds for as long as the tab is open.
 */
const REASK_FLOOR_MS = 15_000;
const REASK_CEILING_MS = 5 * 60_000;

/**
 * The longest TTL that still means "come back" rather than "this is the answer".
 *
 * ⚠⚠ Without this test every dead link became a perpetual poller. The server answers a real
 * failure with a one-hour TTL and a transient refusal with ~15 seconds, and re-asking both
 * meant 300 dead links scrolled past turned into 300 outbound fetches an hour, per open tab,
 * forever. Worse, the client's hourly deadline and the server's row TTL start at the same
 * instant, so the re-ask landed just AFTER `expires_at` lapsed — a guaranteed cache miss and a
 * fresh fetch to a known-dead origin every single time. A verdict is re-asked only by a new
 * priming pass, which is what `dropIfExpired` is for.
 */
const VERDICT_TTL_MS = 60_000;

/** ±25%, matching the server's own jitter on the TTL it sends. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function armReask(url: string, expiresAtMs: number): void {
  const untilExpiry = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : 0;
  if (untilExpiry > VERDICT_TTL_MS) {
    retry.delete(url);
    return;
  }
  const tries = (retry.get(url)?.tries ?? 0) + 1;
  const floor = Math.min(REASK_CEILING_MS, REASK_FLOOR_MS * 2 ** (tries - 1));
  // ⚠ Jittered, and this is not cosmetic. The server jitters its transient TTL specifically so
  // that "every loser of one saturation event doesn't come back as a single wave" — and taking
  // `max(untilExpiry, floor)` against a fixed floor threw that away, re-synchronising every
  // client onto the same millisecond. A thundering herd aimed at a server that has just said it
  // is overloaded.
  retry.set(url, { at: Date.now() + jitter(Math.max(untilExpiry, floor)), tries });
}

/**
 * Put a URL back in play after an answer that wasn't one.
 *
 * ⚠⚠ The ref is deliberately NOT deleted. `MessageAttachments` captures the Ref OBJECT in a
 * computed keyed on the message text, so a mounted row goes on watching whichever object it
 * first received. Deleting the cache entry and minting a fresh one on the next ask therefore
 * delivered the answer into an object nothing was watching: a fresh read showed `ok` while the
 * row on screen stayed blank forever. Resetting `asked` re-opens the URL to priming without
 * ever changing its identity.
 */
function forgetForRetry(url: string): void {
  if (!cache.has(url)) return;
  asked.delete(url);
  armReask(url, NaN);
}

/** One timer for the whole map, set to the earliest deadline — not a timer per URL. */
function scheduleReask(): void {
  if (reaskTimer !== null) {
    clearTimeout(reaskTimer);
    reaskTimer = null;
  }
  let earliest = Infinity;
  for (const { at } of retry.values()) earliest = Math.min(earliest, at);
  if (!Number.isFinite(earliest)) return;
  reaskTimer = setTimeout(() => runReask(), Math.max(0, earliest - Date.now()));
}

function runReask(): void {
  reaskTimer = null;
  const now = Date.now();
  let queued = false;
  for (const [url, state] of retry) {
    if (state.at > now) continue;
    // Evicted by the cache ceiling, or dropped by `dropIfExpired` on a priming pass — either
    // way nobody is holding a ref for it, so there is nothing to re-ask on behalf of.
    if (!cache.has(url)) {
      // ⚠ No bump, and not by omission: `previewPending` tests `retry` BEFORE `queue`/`asked`, so
      // a URL in this loop is already settled and stays settled — deleting its `retry` entry is
      // not a transition anything can observe. (`retry ⊆ cache` also makes this branch itself
      // unreachable today; it is kept as a guard, not as a live path.)
      retry.delete(url);
      continue;
    }
    // Parked as in-flight rather than deleted, and the difference is the whole backoff: the
    // `tries` count lives in this entry, so deleting it meant the answer re-armed at tries=1
    // every time and the floor never doubled — a "backoff" that was a flat 15s poll.
    // Re-armed by whatever comes back (an answer, or the transport-failure branch in `flush`).
    // Queued directly rather than through the `asked` gate: this URL is deliberately being
    // asked about a second time.
    retry.set(url, { at: Infinity, tries: state.tries });
    queue.add(url);
    queued = true;
  }
  if (queued && flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  if (queued) pendingRevision.value++;
  scheduleReask();
}

/**
 * Ceiling on remembered URLs.
 *
 * A long-lived tab would otherwise accumulate an entry per distinct URL for as long as it's
 * open. Evicts oldest-first: `Map` preserves insertion order, and the oldest entry is the one
 * least likely to still be on screen.
 */
const MAX_CACHE_ENTRIES = 2000;

/**
 * Number of cache entries currently holding a resolved value.
 *
 * Tracked rather than counted on demand because the map itself no longer shrinks (see
 * `evictIfNeeded`), so a count would be O(every URL the tab has ever seen) on every prime.
 * Exactly one place assigns a value — `flush` — which is what makes the counter maintainable.
 */
let heldValues = 0;

/**
 * Returns whether eviction BLANKED a card that was rendering — i.e. whether it changed a row's
 * height and so owes the scroll anchor a re-pin.
 *
 * Called from BOTH `flush` (where values land, so the ceiling binds immediately) and
 * `primePreviews` (which catches anything the flush path missed). The return value only matters
 * to the latter; `flush` bumps both revisions unconditionally anyway.
 *
 * ⚠ Not "did it evict anything". Once a long-lived tab saturates the cache, eviction runs on
 * essentially every prime — and reporting that as a layout event fired a re-pin (two forced
 * synchronous layouts over an unvirtualised 500-row list) on every incoming message, to
 * compensate for a growth that had not happened.
 *
 * ⚠⚠ The ref OBJECT is never deleted, only its value (#694). `MessageAttachments` captures the
 * Ref object in a computed keyed on the message text, so a mounted row goes on watching whichever
 * object it first received — the same rule `forgetForRetry` and `dropIfExpired` already state.
 * Deleting the entry and minting a fresh one on the next prime delivered the answer into an
 * object nothing was watching: a fresh read showed `ok` while the row on screen stayed blank for
 * the life of the tab. Nulling in place means a re-prime REFILLS the object the row is holding.
 *
 * Two consequences worth knowing:
 *   - A pending URL is never evicted, by construction: `previewPending` is false for anything
 *     holding a value, and only value-holders are reclaimed. So eviction can no longer strand an
 *     in-flight answer, and can no longer open a reveal gate — the caller's `pendingRevision`
 *     term for that is gone.
 *   - The ceiling now bounds RESOLVED VALUES, not map entries. The map keeps one null-valued ref
 *     per distinct URL the tab has seen (~200 bytes), which is the price of never breaking
 *     identity. The `LinkPreview` payloads — the actual weight — are still bounded.
 */
function evictIfNeeded(): boolean {
  if (heldValues <= MAX_CACHE_ENTRIES) return false;
  let blanked = false;
  // Oldest-first: `Map` preserves insertion order, and the oldest value is the one least likely
  // to still be on screen.
  for (const [url, entry] of cache) {
    if (heldValues <= MAX_CACHE_ENTRIES) break;
    if (entry.value == null) continue; // already reclaimed, or never answered
    entry.value = null;
    heldValues--;
    blanked = true;
    // Re-open the URL to priming, so the next ingest that mentions it refills THIS object.
    asked.delete(url);
    retry.delete(url);
  }
  return blanked;
}

/** Drop entries whose server-side TTL has lapsed, so they can be asked about again.
 *  `expiresAt` was being carried on the wire and never read. */
function dropIfExpired(url: string): void {
  const entry = cache.get(url);
  const expiresAt = entry?.value?.expiresAt;
  if (!expiresAt) return;
  if (Date.parse(expiresAt) > Date.now()) return;
  // ⚠ Neither the ref nor the backoff ladder is discarded. The ref because mounted rows hold it
  // (see `forgetForRetry`); the `retry` entry because `tries` is the only record of how many
  // times this URL has already failed — dropping it reset the ladder to zero, so a channel
  // where a bot reposts a failing link never accumulated any backoff at all. The stale value
  // keeps rendering meanwhile, which beats blanking a card that is merely due a refresh.
  asked.delete(url);
}

function entryFor(url: string): Ref<LinkPreview | null> {
  let entry = cache.get(url);
  if (!entry) {
    entry = ref<LinkPreview | null>(null);
    cache.set(url, entry);
  }
  return entry;
}

/**
 * Ask the server about every previewable URL in a batch of message bodies.
 *
 * Called at INGEST — from the socket layer, as messages enter the store — so that by the time
 * a row is rendered its preview is usually already known and the row is laid out correctly on
 * its first paint. Idempotent and cheap: a URL already known or already queued is skipped, so
 * calling this for an overlapping page costs a map lookup per URL.
 *
 * Returns immediately. Nothing awaits it: a history page must not wait on the internet before
 * it can be read.
 */
export function primePreviews(
  texts: readonly (string | null | undefined)[],
  toggles: PreviewToggles,
): void {
  if (!toggles.inlineMedia && !toggles.linkPreviews) return;
  let queued = false;
  for (const text of texts) {
    for (const url of previewableUrls(text, toggles)) {
      dropIfExpired(url);
      if (asked.has(url)) continue;
      asked.add(url);
      entryFor(url);
      queue.add(url);
      queued = true;
    }
  }
  if (queued && flushTimer === null) flushTimer = setTimeout(() => void flush(), FLUSH_MS);
  const evictionBlanked = evictIfNeeded();
  // ⚠ CONDITIONAL, and that matters more than it looks. This runs for every live message, whether
  // or not it carries a URL, and every mounted `MessageAttachments` is an eager subscriber to a
  // computed that reads this ref — so an unconditional bump made one ordinary line of channel
  // chatter refresh 100-200 computeds that all re-derive `true === true`. usePreviewBody hoists
  // `previewsActive` out of the rows for the same reason, against a colder trigger than this one.
  //
  // `dropIfExpired` is deliberately NOT a reason to bump: it only touches a URL whose ref already
  // has a value, `previewPending` short-circuits on that, and the same loop iteration re-queues it
  // and sets `queued` anyway.
  //
  // ⚠ NO TEST GUARDS THIS CONDITION, and that is stated rather than papered over. Reverting it to
  // an unconditional bump changes no observable behaviour — the computed re-evaluates to the same
  // value, so a `watch` never fires — it only burns the work. A test would have to count
  // evaluations from outside the computed, which nothing here can do.
  // ⚠ Eviction is no longer a term here (#694). The invariant is directional: it can no longer
  // move a URL from pending to SETTLED, which is the transition that opens a reveal gate, because
  // it only touches entries already holding a value and `previewPending` is false for those.
  //
  // It CAN move one the other way — blanking a value for a URL still sitting in `queue` makes
  // `previewPending` true again — but that only ever CLOSES a gate, which shrinks a block rather
  // than growing one, and the same prime that queued it already bumped via `queued`.
  if (queued) pendingRevision.value++;
  // ⚠ Eviction CAN change what renders — nulling a value blanks a card that was drawing one — so
  // it owes the anchor a re-pin. That happens during a history-page ingest, which is exactly when
  // a scrolled-up reader is being anchored.
  if (evictionBlanked) previewRevision.value++;
}

/**
 * The preview for `url`, if one is known.
 *
 * READ-ONLY: this never triggers a fetch. A component asking about a URL nobody primed gets a
 * permanently-null ref and renders nothing — which is correct, and is the property that keeps
 * rendering free of side effects.
 */
export function useLinkPreview(url: string): Ref<LinkPreview | null> {
  return entryFor(url);
}

// ─── Is an answer still coming? ───────────────────────────────────────────────
//
// `MessageAttachments` holds a message's whole attachment block back until every URL in it has
// settled, so that its arrangement is decided once instead of re-deciding as siblings trickle in.
// That gate needs to tell "still in flight" apart from "will never come", and this module is the
// only thing that knows the difference — `asked`, `queue` and `retry` ARE that knowledge.
//
// ⚠⚠ The first version of the gate guessed instead, with a 1500ms timer. The guess was wrong by
// more than an order of magnitude: `FLUSH_MS` is the coalescing debounce before the POST is sent,
// not the round trip, and the server allows MAX_QUEUE_WAIT_MS (10s) plus RESOLVE_DEADLINE_MS
// (30s) per URL while `/resolve` answers with a `Promise.all` over the whole slice. So the
// deadline fired routinely on any cold link, revealing a partial set — which re-created the exact
// arrangement flip the gate exists to remove, 1.5s later. Asking beats guessing.

/**
 * Bumped whenever a URL enters or leaves the set awaiting an answer.
 *
 * `queue`, `asked` and `retry` are plain collections and deliberately stay that way — they're
 * touched on hot paths and nothing should re-render because a Set gained a member. This counter
 * is the one reactive handle onto them, so a consumer reads it to know when to look again.
 */
const pendingRevision = ref(0);

/**
 * Whether an answer is still expected for `url`.
 *
 * ⚠⚠ THIS PREDICATE FAILS OPEN, deliberately and in every branch. Its consumer withholds a whole
 * message's attachment block while it answers true, so every "not sure" it returns turns a
 * partial failure into a blank message — a strictly worse outcome than the layout shift the gate
 * exists to prevent. Only a request we are actively waiting on counts as pending.
 *
 *   - carries a value          → settled, whatever the value says
 *   - nobody ever primed it    → settled. The divergence case: a permanently-null ref must render
 *                                as nothing NOW rather than stall the message forever.
 *   - waiting on a re-ask      → SETTLED, and this is the branch that matters most. `retry` holds
 *                                two different states — a short-TTL `unavailable` (has a value)
 *                                and a URL put back in play by `forgetForRetry` after a transport
 *                                failure or an omitted answer (value still null). Counting the
 *                                second as pending hid the block for the entire 15s→5min backoff
 *                                ladder, and indefinitely while a server kept failing: one 502
 *                                during a deploy blanked the attachments of every message that
 *                                shared a batch with it, cached siblings included.
 *   - queued or in flight      → pending, bounded by RESOLVE_TIMEOUT_MS below.
 */
function previewPending(url: string): boolean {
  if (cache.get(url)?.value != null) return false;
  // Before `queue`/`asked`, not after: `runReask` re-queues a URL it is retrying, so the retry
  // state has to win or a recovery attempt would re-hide a block that is already on screen.
  if (retry.has(url)) return false;
  return queue.has(url) || asked.has(url);
}

/**
 * Reactive "every one of these URLs has settled".
 *
 * The `pendingRevision` read is what makes it reactive, and it lives HERE rather than at the call
 * site so that the one fragile line sits next to the state it depends on.
 */
export function usePreviewsSettled(urls: Ref<readonly string[]>): ComputedRef<boolean> {
  return computed(() => {
    // ⚠ Load-bearing, and not obviously so. `previewPending` reads plain Sets and Maps, so this
    // is the computed's ONLY dependency on the pending set — without it a subscribed computed
    // (which `watch(settled, ...)` creates) never re-evaluates when a URL merely leaves the queue
    // without its ref changing, e.g. the transport-failure path above.
    void pendingRevision.value;
    return urls.value.every((url) => !previewPending(url));
  });
}

/** Test-only: drop everything so a suite starts from a known state. */
export function resetLinkPreviewCache(): void {
  previewRevision.value = 0;
  pendingRevision.value = 0;
  cache.clear();
  heldValues = 0;
  asked.clear();
  retry.clear();
  queue = new Set();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // The re-ask timer too. `retry.clear()` above already makes a leaked one a no-op — it would
  // wake to an empty map — so this is hygiene rather than a guard, and is deliberately not
  // asserted by a test that would pass with it removed. It's here because a pending timer still
  // holds the event loop open.
  if (reaskTimer !== null) {
    clearTimeout(reaskTimer);
    reaskTimer = null;
  }
}
