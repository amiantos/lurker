// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { ref, type Ref } from 'vue';

// Soft-keyboard detector. Exposes a reactive `keyboardOpen` ref and
// mirrors it to a `data-keyboard-open="true"` attribute on <html>.
// Consumer: MobileChat's .composer-host binds `.keyboard-open` from the
// ref so the safe-area inset padding collapses when the keyboard is up
// (the keyboard already covers the home-indicator zone, so leaving the
// inset in place would push the input bar partway behind the keyboard).
//
// We deliberately don't use this to drive positioning math (e.g. a JS
// --kb-bottom variable bound to `bottom: ...`): production chat apps
// have converged on plain `100dvh` shells, since `100dvh` already tracks
// the keyboard in current Safari and a JS-driven `bottom` value gets
// bitten by a known iOS 26 visualViewport regression that returns
// phantom offsets after keyboard dismiss.
//
// Three signals feed `open`; ANY of them sets it true:
//   - visualViewport.height delta > threshold (Android, current iOS Safari)
//   - visualViewport.offsetTop > 50 (iOS Safari edge case where iOS
//     auto-scrolls the visible viewport rather than shrinking its height)
//   - a text-like input has focus (the reliable fallback for iOS PWA,
//     where visualViewport.resize doesn't fire when the keyboard opens)
// :focus-visible alone would partially work but Chrome Android can
// retain it after keyboard dismiss in focus-shuffle scenarios; combining
// it with the viewport signals avoids that false positive.

const keyboardOpen = ref(false);

// Threshold for "keyboard is up." Smaller height deltas are attributed to
// URL-bar collapse, browser zoom, or sub-pixel rounding. 150px clears every
// soft keyboard we've measured while ignoring the ~80px Android URL bar.
const KEYBOARD_HEIGHT_THRESHOLD_PX = 150;

let initialized = false;

export interface VisualViewportState {
  keyboardOpen: Ref<boolean>;
}

export function installVisualViewport(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const root = document.documentElement;

  const isTextInputFocused = (): boolean => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.tagName === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      return (
        type === 'text' ||
        type === 'search' ||
        type === 'email' ||
        type === 'tel' ||
        type === 'url' ||
        type === 'password' ||
        type === 'number'
      );
    }
    return false;
  };

  const update = () => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    const offsetTop = vv ? vv.offsetTop : 0;
    // Three signals; ANY of them sets open=true. iOS PWA doesn't always
    // fire a meaningful visualViewport.resize when the keyboard opens
    // (the height delta can stay near zero), so we also accept:
    //   - vv.offsetTop > 50 (iOS auto-scrolled the visible viewport)
    //   - a text-like input has focus (mobile keyboard MUST be up)
    // Desktop with a focused input is a false positive, but .composer-host
    // is mobile-only so there's no visible side effect.
    const heightOpen = window.innerHeight - height > KEYBOARD_HEIGHT_THRESHOLD_PX;
    const offsetOpen = offsetTop > 50;
    const focusOpen = isTextInputFocused();
    const open = heightOpen || offsetOpen || focusOpen;
    keyboardOpen.value = open;
    if (open) root.setAttribute('data-keyboard-open', 'true');
    else root.removeAttribute('data-keyboard-open');
    // Document-scroll watchdog (#581). The shell never scrolls the document
    // (html/body are overflow:hidden), but a browser's keyboard-reveal logic
    // can scroll it anyway — Chrome Android under resizes-visual scrolled the
    // layout viewport to expose the focused composer and sometimes never
    // scrolled back after dismiss, leaving the input bar off-screen until a
    // full refresh (touch-action:none + user-scalable=no block manual
    // recovery). The resizes-content viewport meta removes the cause; this
    // heals any residue: with the keyboard down, a scrolled document is
    // always a bug state, so snap it home. Runs on every update() — vv
    // resize/scroll, focusout, orientationchange — so a stuck offset
    // self-corrects on the next signal.
    if (!open) {
      const se = document.scrollingElement;
      if (se && se.scrollTop > 0) se.scrollTop = 0;
    }
  };

  update();

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
  }
  // Covers desktop browsers and the handful of mobile UAs that don't fire
  // visualViewport events reliably; harmless double-fire elsewhere.
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  // Focus changes drive the iOS-PWA fallback signal — without these, the
  // focus-based detection would only update on visualViewport events,
  // which iOS PWA may not fire when the keyboard opens. The setTimeout
  // on blur gives focus a chance to move to another input first (so
  // tabbing between fields doesn't briefly flicker keyboardOpen to false).
  document.addEventListener('focusin', update, true);
  document.addEventListener(
    'focusout',
    () => {
      setTimeout(update, 50);
    },
    true,
  );
}

export function useVisualViewport(): VisualViewportState {
  // Self-init so callers don't have to remember to bootstrap separately —
  // the `initialized` guard inside makes this idempotent with the explicit
  // call in main.ts. Matches the pattern in useViewport.
  installVisualViewport();
  return { keyboardOpen };
}
