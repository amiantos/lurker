// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref } from 'vue';
import { emojiGlyph, loadEmoji, onEmojiLoaded } from '../utils/emojiShortcodes.js';

// Render-time `:shortcode:` → emoji glyph for the message list. The ~1,900-entry
// table lives in a lazily-loaded chunk (emojiData.ts); `preloadEmoji` kicks the
// fetch off once at app start — during the initial connect / buffer-load pause —
// so the glyphs are ready before (or shortly after) the first paint.
//
// `emojiReady` is the single reactive signal that flips when the chunk resolves.
// `emojiFn` reads it, so any render/computed that calls `emojiFn()` re-runs its
// segment split when the table arrives: a row that briefly showed the literal
// `:tada:` repaints as 🎉. Until then `emojiFn()` is null and shortcodes render
// verbatim.
const emojiReady = ref(false);

// Flip the gate on load completion from *any* caller (not just our preload), so
// render-time parsing recovers even if the initial preload failed offline and
// the table is later loaded by the composer. onEmojiLoaded fires once.
onEmojiLoaded(() => {
  emojiReady.value = true;
});

export function preloadEmoji(): void {
  // Fire-and-forget; the ready flip is handled by onEmojiLoaded above. A failed
  // load clears loadEmoji's cache, so any later load (here or elsewhere) retries
  // and still notifies.
  void loadEmoji().catch(() => {});
}

// The synchronous shortcode resolver once the table has loaded, else null.
// Call this inside a render or computed so the dependency on `emojiReady` is
// tracked and the split re-runs when the table lands.
export function emojiFn(): ((name: string) => string | null) | null {
  return emojiReady.value ? emojiGlyph : null;
}
