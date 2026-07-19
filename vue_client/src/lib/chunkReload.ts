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
const CHUNK_ERROR_RE =
  /(dynamically imported module|importing a module script failed|module script failed|failed to load module|expected a javascript(?:-or-wasm)? module)/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return CHUNK_ERROR_RE.test(message);
}

const RELOAD_KEY = 'lurker:chunk-reload';
// One reload attempt per path per window. A second failure inside it means the
// chunk is genuinely unavailable (not a blip), and reloading again would spin
// the app in a boot loop — far worse than the dead button we're fixing.
export const RELOAD_WINDOW_MS = 30_000;

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

function readAttempt(storage: Storage): { path: string; at: number } | null {
  try {
    const raw = storage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof parsed?.path !== 'string' || typeof parsed?.at !== 'number') return null;
    return { path: parsed.path, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * Decide whether to hard-reload into `path`, recording the attempt when we do.
 * Returns false if we already tried this same path within RELOAD_WINDOW_MS —
 * the caller should then surface the failure to the user instead of looping.
 *
 * A null `storage` (unavailable — see safeSessionStorage) allows the reload:
 * losing the loop guard is the lesser evil versus never recovering at all.
 */
export function shouldReloadFor(path: string, now: number, storage: Storage | null): boolean {
  if (!storage) return true;
  const prev = readAttempt(storage);
  if (prev && prev.path === path && now - prev.at < RELOAD_WINDOW_MS) return false;
  try {
    storage.setItem(RELOAD_KEY, JSON.stringify({ path, at: now }));
  } catch {
    // Storage unavailable — allow the reload anyway. Losing the loop guard is
    // the lesser evil versus never recovering at all.
  }
  return true;
}
