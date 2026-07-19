// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Recovery for a failed lazy-route chunk import (#571).
//
// Every route is a dynamic `import()`, and the JS module registry memoizes a
// FAILED import as a permanently rejected promise. So one transient failure to
// fetch e.g. Settings-<hash>.js — a network blip, an iOS PWA evicting cached
// resources from a backgrounded tab, a cell restart mid-fetch — kills that
// route for the entire life of the document. Every later click rejects
// instantly from cache without touching the network, which reads to the user
// as a dead button. Nothing in-page can un-poison the registry; only a fresh
// document can. Hence: hard reload into the target route.

// Browsers word this differently and none of it is specified, so match loosely:
//   Chrome   "Failed to fetch dynamically imported module: <url>"
//   Firefox  "error loading dynamically imported module"
//   Safari   "Importing a module script failed."
// The MIME-mismatch phrasing matters too — a stale hashed asset that the SPA
// fallback answers with index.html surfaces as a module-type refusal, not a
// fetch failure.
//
// "unable to preload css" is Vite's, not a browser's, and it is NOT optional:
// Vite rewrites every lazy route into __vitePreload(() => import(...), deps),
// and a route's stylesheet is one of those deps — Settings ships both
// Settings-<hash>.js and Settings-<hash>.css. When the CSS is the dep that
// 404s, Vite throws `Unable to preload CSS for <url>` and none of the phrasings
// above appear anywhere in it. Missing this string meant the recovery silently
// did nothing for roughly half the ways a lazy route can fail. Vite rethrows
// after dispatching vite:preloadError, so router.onError still sees it and no
// separate event listener is needed.
const CHUNK_ERROR_RE =
  /(dynamically imported module|importing a module script failed|module script failed|failed to load module|expected a javascript(?:-or-wasm)? module|unable to preload css)/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return CHUNK_ERROR_RE.test(message);
}

const RELOAD_KEY = 'lurker:chunk-reload';

// The guard COUNTS attempts rather than rate-limiting them, because a purely
// time-based window is unsafe in exactly the conditions this code exists for.
// A slow connection is both the likeliest cause of a chunk fetch failing and
// the likeliest reason a fail→reload→fail cycle takes longer than any window
// worth setting: at 45s per cycle a 30s window reads every stamp as stale and
// reloads forever. A permanent boot loop is strictly worse than the dead button
// being fixed, so the bound has to be on attempts, which no amount of slowness
// can inflate.
export const MAX_RELOAD_ATTEMPTS = 2;

// Attempts age out so the counter measures one episode rather than the tab's
// whole lifetime — a chunk that blips today shouldn't spend its budget against
// an unrelated blip hours later. Long enough to comfortably contain even a very
// slow reload cycle, so it can't reintroduce the loop the counter prevents.
export const ATTEMPT_RESET_MS = 10 * 60_000;

interface ReloadAttempt {
  path: string;
  attempts: number;
  at: number;
}

// sessionStorage (not local): the poisoned registry is per-document, and a
// reload preserves the tab's session storage, which is exactly the scope we
// need to detect "I already tried this".
//
// Reading `window.sessionStorage` AT ALL throws a SecurityError in Safari with
// cookies blocked, and in some partitioned/private contexts — so the property
// access itself has to be inside the try, not just the getItem/setItem calls.
// Callers must take the handle from here rather than passing `window.
// sessionStorage` in, or the throw happens at the call site where none of the
// guarding below can catch it. That would strand this recovery on iOS Safari,
// which is exactly where a PWA is most likely to lose a chunk in the first
// place. Same pattern as api.ts's bounceToLoginOnAuthFailure.
export function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readAttempt(storage: Storage): ReloadAttempt | null {
  try {
    const raw = storage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<keyof ReloadAttempt, unknown>>;
    if (typeof parsed?.path !== 'string' || typeof parsed?.at !== 'number') return null;
    // `attempts` is tolerated as missing so a stamp written by the previous
    // (window-based) build doesn't read as corrupt and silently reset the count.
    const attempts = typeof parsed.attempts === 'number' ? parsed.attempts : 1;
    return { path: parsed.path, attempts, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * Decide whether to hard-reload into `path`, recording the attempt when we do.
 * Returns false once this path has burned MAX_RELOAD_ATTEMPTS inside one
 * episode — the caller should then surface the failure to the user rather than
 * reload again.
 *
 * A null `storage` (unavailable — see safeSessionStorage) allows the reload:
 * losing the loop guard is the lesser evil versus never recovering at all.
 */
export function shouldReloadFor(path: string, now: number, storage: Storage | null): boolean {
  if (!storage) return true;
  const prev = readAttempt(storage);
  // A different path, or a long-idle stamp, starts a fresh episode. Note the
  // stamp holds only the most recent path: two routes failing in alternation
  // each keep resetting the other, which is deliberate — that pattern means
  // something broad is wrong (offline, server down) and each route still gets
  // its own bounded budget, rather than one poisoning the other's.
  const sameEpisode = !!prev && prev.path === path && now - prev.at < ATTEMPT_RESET_MS;
  const attempts = sameEpisode ? prev.attempts : 0;
  if (attempts >= MAX_RELOAD_ATTEMPTS) return false;
  try {
    const next: ReloadAttempt = { path, attempts: attempts + 1, at: now };
    storage.setItem(RELOAD_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — allow the reload anyway. Losing the loop guard is
    // the lesser evil versus never recovering at all.
  }
  return true;
}
