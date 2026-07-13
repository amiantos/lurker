// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useOnboarding, resetOnboarding, ONBOARDING_SETTING } from './useOnboarding.js';
import { useSettingsStore } from '../stores/settings.js';
import { useNetworksStore } from '../stores/networks.js';
import { useAuthStore } from '../stores/auth.js';
import type { Network } from '../stores/networks.js';

// The gate's whole job is deciding *not* to fire, so the stores are driven
// directly rather than through the network — what's under test is the predicate,
// not the fetches.
function setup(opts: {
  settingsLoaded?: boolean;
  networksLoaded?: boolean;
  networks?: number;
  completed?: boolean;
  paused?: boolean;
}) {
  const settings = useSettingsStore();
  const networks = useNetworksStore();
  const auth = useAuthStore();

  settings.loaded = opts.settingsLoaded ?? true;
  if (opts.completed) settings.values[ONBOARDING_SETTING] = true;
  networks.loaded = opts.networksLoaded ?? true;
  networks.networks = Array.from(
    { length: opts.networks ?? 0 },
    (_, i) => ({ id: i + 1 }) as Network,
  );
  auth.user = { id: 1, username: 'alice', role: 'user', is_paused: opts.paused ?? false };

  const setValue = vi.spyOn(settings, 'setValue').mockResolvedValue(undefined);
  return { onboarding: useOnboarding(), setValue };
}

beforeEach(() => {
  setActivePinia(createPinia());
  // isOpen and the `decided` latch are module-scoped, so they survive between
  // tests — the same reason resetSession() has to clear them between users.
  resetOnboarding();
});

describe('useOnboarding.evaluate', () => {
  it('opens for a brand-new account: loaded, no networks, flag unset', () => {
    const { onboarding } = setup({});
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(true);
  });

  // The trap this gate exists for. An empty `networks` array means BOTH "no
  // networks" and "we haven't asked yet" — keying off length alone would flash
  // the welcome screen at every established user on every boot.
  it('does not open while the networks fetch is still in flight', () => {
    const { onboarding } = setup({ networksLoaded: false });
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(false);
  });

  it('does not open while settings are still in flight', () => {
    const { onboarding } = setup({ settingsLoaded: false });
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(false);
  });

  it('does not open once the flow has been completed or skipped', () => {
    const { onboarding } = setup({ completed: true });
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(false);
  });

  // A paused account is read-only server-side, so the create at the end of the
  // flow would 403. Better the empty state (plus the paused banner, which says
  // what's actually wrong) than a welcome that dead-ends.
  it('does not open for a paused account, and does not burn the flag', () => {
    const { onboarding, setValue } = setup({ paused: true });
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  // An established user predates the flag entirely, so it reads as unset. Rather
  // than leave them one "delete my last network" away from a welcome screen,
  // backfill it the first time we see they already have networks.
  it('backfills the flag for an existing user instead of opening', () => {
    const { onboarding, setValue } = setup({ networks: 3 });
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(false);
    expect(setValue).toHaveBeenCalledWith(ONBOARDING_SETTING, true);
  });
});

describe('useOnboarding.dismiss', () => {
  // Esc and the modal's × land here. A reflexive keystroke must not be a
  // permanent, cross-device decision — that's what "Skip setup" is for.
  it('closes without persisting the flag, so the flow returns next login', () => {
    const { onboarding, setValue } = setup({});
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(true);

    onboarding.dismiss();

    expect(onboarding.isOpen.value).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
  });

  // The shells remount useChatBootstrap on every Desktop<->Mobile viewport swap,
  // so evaluate() runs again with the same underlying conditions (no networks,
  // flag unset). Without the `decided` latch, rotating a phone would resurrect a
  // flow the user just dismissed.
  it('stays closed when a viewport swap re-runs evaluate', () => {
    const { onboarding } = setup({});
    onboarding.evaluate();
    onboarding.dismiss();

    onboarding.evaluate();

    expect(onboarding.isOpen.value).toBe(false);
  });
});

describe('useOnboarding.complete', () => {
  it('closes the flow and persists the flag', async () => {
    const { onboarding, setValue } = setup({});
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(true);

    await onboarding.complete();

    expect(onboarding.isOpen.value).toBe(false);
    expect(setValue).toHaveBeenCalledWith(ONBOARDING_SETTING, true);
  });

  // Closing is the point; persisting is best-effort. A failed write just means
  // the flow is offered again next boot, which is the safe direction to fail.
  it('still closes when the flag write fails', async () => {
    const { onboarding, setValue } = setup({});
    setValue.mockRejectedValueOnce(new Error('offline'));
    onboarding.evaluate();

    await expect(onboarding.complete()).resolves.toBeUndefined();

    expect(onboarding.isOpen.value).toBe(false);
  });
});

describe('resetOnboarding', () => {
  // isOpen and `decided` are module state, invisible to resetSession()'s $reset()
  // sweep over the Pinia stores. Without an explicit reset, user A's half-filled
  // first-run form — nick, and on a hosted cell a typed SASL password — would
  // still be mounted when user B logs in, before evaluate() ever runs.
  it('clears an open flow so it cannot survive a logout into the next session', () => {
    const { onboarding } = setup({});
    onboarding.evaluate();
    expect(onboarding.isOpen.value).toBe(true);

    resetOnboarding();

    expect(onboarding.isOpen.value).toBe(false);
  });

  it('clears the decided latch so the next user gets their own first run', () => {
    const { onboarding } = setup({});
    onboarding.evaluate();
    onboarding.dismiss();

    // A new session: fresh stores, a different (also brand-new) account.
    resetOnboarding();
    setActivePinia(createPinia());
    const next = setup({});

    next.onboarding.evaluate();

    expect(next.onboarding.isOpen.value).toBe(true);
  });
});
