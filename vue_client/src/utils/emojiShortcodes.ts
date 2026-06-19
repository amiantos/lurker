// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Slack-style `:shortcode:` emoji entry — the pure parsing + ranking helpers.
// These never carry the emoji table itself, so MessageInput can import them
// eagerly while the ~1,900-entry map in `emojiData.ts` stays a lazily-loaded
// chunk (see `loadEmoji` below).
//
// A shortcode is `:name:` where `name` is one or more of `[a-z0-9_+-]` — the
// gemoji character set (`:+1:`, `:e-mail:`, `:thumbsup:`). Matching is
// case-insensitive: the captured `name` is lowercased before it's returned,
// so a typed `:Bone:` resolves straight against the (lowercase) gemoji table.
//
// The opening `:` must not sit immediately behind another shortcode
// character, so a clock like `12:00` or an `http://` URL never reads as a
// shortcode start. ASCII smileys fall out for free: `:-)` never closes at the
// caret because `)` isn't a shortcode character.

const NAME = '[a-z0-9_+-]+';
// `(?<![a-z0-9_+-])` keeps the opening colon off the back of a word or number.
const OPEN_RE = new RegExp(`(?<![a-z0-9_+-]):(${NAME})$`, 'i');
const CLOSE_RE = new RegExp(`(?<![a-z0-9_+-]):(${NAME}):$`, 'i');

// A *global* matcher for every completed `:name:` in a string, used by the
// render-time emoji pass (`splitTextByEmoji` in nickColor). It shares NAME and
// the same opening-boundary rule as OPEN_RE/CLOSE_RE, so the renderer
// recognises exactly what the composer auto-converts on send — a clock
// (`12:00`), an `http://` URL, or `word:bone` never reads as a shortcode. A
// fresh instance is returned per call because a global regex carries mutable
// `lastIndex`.
export function shortcodeScanRegex(): RegExp {
  return new RegExp(`(?<![a-z0-9_+-]):(${NAME}):`, 'gi');
}

export interface ShortcodeToken {
  /** The shortcode body, lowercased, colons stripped. */
  name: string;
  /** Index of the opening `:` in the source string. */
  start: number;
  /** Index just past the token — equal to the caret position passed in. */
  end: number;
}

// An *in-progress* shortcode ending at the caret: `:bo|` → { name: 'bo' }.
// Returns null when the caret isn't sitting in a shortcode body. Drives the
// suggester strip; the caller decides the minimum query length to act on.
export function findActiveShortcode(text: string, caret: number): ShortcodeToken | null {
  const m = OPEN_RE.exec(text.slice(0, caret));
  if (!m) return null;
  return { name: m[1].toLowerCase(), start: caret - m[1].length - 1, end: caret };
}

// A *complete* shortcode whose closing `:` is the character just before the
// caret — i.e. the user just typed the final `:` of `:bone:|`. Returns null
// otherwise. The caller still has to confirm `name` is a real emoji (via
// `emojiForShortcode`) before converting.
export function findCompletedShortcode(text: string, caret: number): ShortcodeToken | null {
  const m = CLOSE_RE.exec(text.slice(0, caret));
  if (!m) return null;
  return { name: m[1].toLowerCase(), start: caret - m[1].length - 2, end: caret };
}

// Rank shortcode `names` against `query` for the suggester. `names` are
// expected lowercase (they come straight from the gemoji table's keys); only
// `query` is lowercased here, which is what makes matching case-insensitive
// from the typist's side. An exact hit sorts first, then prefix matches, then
// substring matches; non-matches drop out. Within a tier the shorter name
// wins (a tighter match reads as more relevant), then alphabetical so the
// order is stable.
export function rankShortcodes(names: string[], query: string): string[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored: { name: string; rank: number }[] = [];
  for (const name of names) {
    const idx = name.indexOf(q);
    if (idx === -1) continue;
    scored.push({ name, rank: name === q ? 0 : idx === 0 ? 1 : 2 });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return scored.map((s) => s.name);
}

// Lazy gateway to the emoji table. The ~1,900-entry map is its own chunk; the
// import is kicked off the first time a caller actually needs the table — the
// suggester once a `:query` is 2+ characters, or the inline auto-convert on a
// completed `:name:` — and every later caller shares this one cached promise.
// A failed import (offline, etc.) clears the cache so the next caller retries
// rather than being stuck with a permanently-rejected promise.
let emojiModule: Promise<typeof import('./emojiData.js')> | null = null;
// The resolved table, cached for synchronous render-time lookups (`emojiGlyph`).
// Stays null until the chunk lands; the render pass treats that as "no emoji
// yet" and shows the literal `:name:` until a reload re-runs the split.
let loadedTable: Record<string, string> | null = null;
// One-shot listeners fired when the table first becomes available, whichever
// caller triggered the load. Lets the render layer (useEmoji) recover even if
// its own preload failed: a later successful load from anywhere — the
// composer's suggester or auto-convert — still flips the render gate, no
// reload needed. Cleared on success; a failed load keeps them registered so
// the next attempt still notifies.
const loadedListeners = new Set<() => void>();
function notifyEmojiLoaded(): void {
  const cbs = [...loadedListeners];
  loadedListeners.clear();
  for (const cb of cbs) cb();
}
export function loadEmoji(): Promise<typeof import('./emojiData.js')> {
  if (!emojiModule) {
    emojiModule = import('./emojiData.js');
    emojiModule
      .then((mod) => {
        loadedTable = mod.EMOJI;
        notifyEmojiLoaded();
        return mod;
      })
      .catch(() => {
        emojiModule = null;
      });
  }
  return emojiModule;
}

// Register a callback for when the emoji table is available. Fires immediately
// if it's already loaded, otherwise once the (current or a later) load resolves.
export function onEmojiLoaded(cb: () => void): void {
  if (loadedTable) {
    cb();
    return;
  }
  loadedListeners.add(cb);
}

// Synchronous `:shortcode:` → glyph resolver for the render-time pass. Returns
// null when `name` isn't a known emoji, or when the table chunk hasn't loaded
// yet — so render stays synchronous and a not-yet-loaded shortcode falls
// through as literal text. Callers kick the load off up front (`preloadEmoji`)
// and re-render once it resolves. Matching is case-insensitive, mirroring
// `emojiForShortcode` in emojiData.ts.
export function emojiGlyph(name: string): string | null {
  return loadedTable?.[name.toLowerCase()] ?? null;
}
