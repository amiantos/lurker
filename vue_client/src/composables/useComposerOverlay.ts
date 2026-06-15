// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-component state for the composer's overlay popovers — the nick and
// emoji suggestion strips and the mIRC colour picker. They live in
// StatusBar's DOM (visually they overlay the bar) but their state and the
// "what to do when the user picks" logic belong with MessageInput (which
// owns the textarea content). Same module-level singleton shape as
// useComposing — there is only ever one composer on screen at a time.

import { reactive, readonly, type DeepReadonly } from 'vue';
import type { EmojiMatch } from '../utils/emojiData.js';

export interface NickStripItem {
  nick: string;
  color: string | null;
}

export interface ComposerOverlayState {
  // Nick suggestion strip — mobile by default, opt-in on desktop. Items are
  // pushed by the host (MessageInput) so candidate building and ignore
  // filtering stay in one place and mirror the emoji flow.
  nickOpen: boolean;
  nickItems: NickStripItem[];
  nickActiveIndex: number;
  // Emoji `:shortcode:` strip.
  emojiOpen: boolean;
  emojiItems: EmojiMatch[];
  emojiActiveIndex: number;
  // mIRC colour picker.
  colorPickerOpen: boolean;
}

const state = reactive<ComposerOverlayState>({
  nickOpen: false,
  nickItems: [],
  nickActiveIndex: 0,
  emojiOpen: false,
  emojiItems: [],
  emojiActiveIndex: 0,
  colorPickerOpen: false,
});

type NickSelectHandler = (nick: string) => void;
type EmojiSelectHandler = (item: EmojiMatch) => void;
type ColorApplyHandler = (fg: string | null, bg: string | null) => void;
type VoidHandler = () => void;

// Handlers MessageInput registers on mount. Defaults are no-ops so a pick
// before registration is dropped silently rather than crashing.
let onNickSelect: NickSelectHandler = () => {};
let onEmojiSelect: EmojiSelectHandler = () => {};
let onColorApply: ColorApplyHandler = () => {};
let onColorReset: VoidHandler = () => {};
let onColorClose: VoidHandler = () => {};
let onPickFile: VoidHandler = () => {};
// Address a nick from outside the composer (the message action bar's Reply).
// Same signature as a nick pick, but it prepends `nick: ` to the whole draft
// rather than splicing at a token span, so it gets its own handler.
let onAddress: NickSelectHandler = () => {};

export interface ComposerOverlayHandlers {
  onNickSelect?: NickSelectHandler;
  onEmojiSelect?: EmojiSelectHandler;
  onColorApply?: ColorApplyHandler;
  onColorReset?: VoidHandler;
  onColorClose?: VoidHandler;
  onPickFile?: VoidHandler;
  onAddress?: NickSelectHandler;
}

export function setComposerOverlayHandlers(h: ComposerOverlayHandlers): void {
  if (h.onNickSelect) onNickSelect = h.onNickSelect;
  if (h.onEmojiSelect) onEmojiSelect = h.onEmojiSelect;
  if (h.onColorApply) onColorApply = h.onColorApply;
  if (h.onColorReset) onColorReset = h.onColorReset;
  if (h.onColorClose) onColorClose = h.onColorClose;
  if (h.onPickFile) onPickFile = h.onPickFile;
  if (h.onAddress) onAddress = h.onAddress;
}

export function setNickStrip(open: boolean, items: NickStripItem[] = []): void {
  state.nickOpen = open;
  state.nickItems = items;
  state.nickActiveIndex = 0;
}

export function setEmojiStrip(open: boolean, items: EmojiMatch[] = []): void {
  state.emojiOpen = open;
  state.emojiItems = items;
  state.emojiActiveIndex = 0;
}

export function setColorPickerOpen(open: boolean): void {
  state.colorPickerOpen = open;
}

// Emoji-strip keyboard navigation, driven from MessageInput's keydown.
// Wraps at both ends so a held arrow cycles the whole row.
export function moveEmojiActive(delta: number): void {
  const n = state.emojiItems.length;
  if (n === 0) return;
  state.emojiActiveIndex = (state.emojiActiveIndex + delta + n) % n;
}

export function setEmojiActive(index: number): void {
  if (index >= 0 && index < state.emojiItems.length) state.emojiActiveIndex = index;
}

export function confirmEmojiActive(): void {
  const item = state.emojiItems[state.emojiActiveIndex];
  if (item !== undefined) onEmojiSelect(item);
}

export function hasEmojiCandidates(): boolean {
  return state.emojiItems.length > 0;
}

// Nick-strip keyboard navigation — same shape as the emoji helpers above so
// the host's keydown handler treats both strips identically.
export function moveNickActive(delta: number): void {
  const n = state.nickItems.length;
  if (n === 0) return;
  state.nickActiveIndex = (state.nickActiveIndex + delta + n) % n;
}

export function setNickActive(index: number): void {
  if (index >= 0 && index < state.nickItems.length) state.nickActiveIndex = index;
}

export function confirmNickActive(): void {
  const item = state.nickItems[state.nickActiveIndex];
  if (item !== undefined) onNickSelect(item.nick);
}

export function hasNickCandidates(): boolean {
  return state.nickItems.length > 0;
}

// Renderer-side dispatchers — bound by StatusBar's popover event handlers,
// route back through the registered MessageInput callbacks.
export function selectNick(nick: string): void {
  onNickSelect(nick);
}
// Reply affordance: route an "address this nick" request to MessageInput,
// which owns the draft text and the focus/caret dance.
export function addressNick(nick: string): void {
  onAddress(nick);
}
export function selectEmoji(item: EmojiMatch): void {
  onEmojiSelect(item);
}
export function applyColor(fg: string | null, bg: string | null): void {
  onColorApply(fg, bg);
}
export function resetColor(): void {
  onColorReset();
}
export function closeColorPicker(): void {
  onColorClose();
}
export function pickComposerFile(): void {
  onPickFile();
}

export function useComposerOverlay(): DeepReadonly<ComposerOverlayState> {
  return readonly(state);
}
