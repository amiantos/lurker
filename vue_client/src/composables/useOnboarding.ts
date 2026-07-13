// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// First-run flow gate (#300). Module-scoped singleton, same shape as
// useNetworkEditor — the shells render one <OnboardingFlow> off `isOpen`.

import { ref } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useNetworksStore } from '../stores/networks.js';
import { useAuthStore } from '../stores/auth.js';

export const ONBOARDING_SETTING = 'onboarding.completed';

const isOpen = ref(false);

// Whether evaluate() has already reached a verdict this session. The shells
// remount useChatBootstrap on every Desktop<->Mobile viewport swap, so evaluate()
// runs more than once per session — and without this latch, a flow the user
// dismissed with Esc would pop straight back up the moment they rotated their
// phone, since the underlying conditions (no networks, flag unset) still hold.
let decided = false;

// Session-scoped, like the socket and the presence reporter — and, being module
// state rather than a Pinia store, invisible to resetSession()'s $reset() sweep
// unless it's cleared explicitly. Without this, a half-filled first-run form
// (nick, and on a hosted cell a typed SASL password) would survive a logout and
// render into the *next* user's session, before evaluate() gets a chance to run.
// Called from useSessionReset alongside resetSocket/resetPresence.
export function resetOnboarding(): void {
  isOpen.value = false;
  decided = false;
}

export function useOnboarding() {
  // Decide whether this is a genuine first run. Called from useChatBootstrap
  // once both stores have actually answered — never from a store's initial
  // state, which is the whole trap here (see below).
  //
  // The flow opens only when BOTH conditions hold:
  //
  //   1. The user has no networks. An empty `networks` array is only meaningful
  //      once `networks.loaded` is true; before that it also means "we haven't
  //      asked yet", and gating on length alone would flash the first-run modal
  //      at every established user on every boot.
  //
  //   2. `onboarding.completed` is unset. Necessary because condition 1 is not
  //      durable: a user who deletes their last network years later still has
  //      zero networks, and should not be shown a welcome screen.
  //
  // If either store failed to load we do nothing at all and the user gets the
  // normal (empty-state) app. Failing closed matters: the cost of not showing
  // onboarding to a new user is that they see "add one with the + button", while
  // the cost of showing it to an existing user is a welcome screen ambushing
  // someone with ten years of history.
  function evaluate(): void {
    if (decided) return;
    const settings = useSettingsStore();
    const networks = useNetworksStore();
    // Not a verdict — we simply don't know yet. Leave `decided` alone so a later
    // call (or a later mount) can still reach one.
    if (!settings.loaded || !networks.loaded) return;
    if (settings.effective(ONBOARDING_SETTING) === true) return;

    // A paused account is read-only — blockWritesWhenPaused would 403 the
    // create at the end of the flow. Walking someone through onboarding only to
    // dead-end them is worse than the empty state plus the paused banner, which
    // at least tells them what's actually wrong. Don't burn the flag either:
    // they should get their first run once the account is live again.
    if (useAuthStore().isPaused) return;

    decided = true;

    if (networks.networks.length > 0) {
      // An established user who predates this flag. Backfill it rather than
      // leaving them one "delete my last network" away from a welcome screen.
      // Best-effort: if the write fails we just re-evaluate next boot.
      void complete();
      return;
    }
    isOpen.value = true;
  }

  // Close without deciding anything: Esc and the modal's × land here. A reflexive
  // keystroke shouldn't be a permanent, cross-device choice, so this only closes
  // the flow for *this* session (the `decided` latch keeps a viewport swap from
  // reopening it) and the user is offered it again next login. Choosing "Skip
  // setup" explicitly is what makes it permanent — see complete().
  function dismiss(): void {
    isOpen.value = false;
  }

  // Both "I finished" and "I skipped, deliberately" land here — from the flow's
  // point of view they're the same event, because both mean "never show again".
  async function complete(): Promise<void> {
    isOpen.value = false;
    const settings = useSettingsStore();
    if (settings.effective(ONBOARDING_SETTING) === true) return;
    try {
      await settings.setValue(ONBOARDING_SETTING, true);
    } catch {
      // Non-critical: the flow has already closed for this session, and the
      // next boot will simply offer it again.
    }
  }

  return { isOpen, evaluate, dismiss, complete };
}
