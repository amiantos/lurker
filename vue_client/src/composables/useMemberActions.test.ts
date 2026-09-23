// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(() => true),
}));

import { useMemberActions } from './useMemberActions.js';
import { useNetworksStore } from '../stores/networks.js';
import { parseModeSpec } from '../../../shared/channelModes.js';

function labelsFor(selfModes: string[]): string[] {
  return useMemberActions()
    .buildItems(
      { nick: 'target', modes: [] },
      { networkId: 1, isSelf: () => false, onIgnore: () => {}, channel: '#chan', selfModes },
    )
    .map((i) => i.label ?? '');
}

function prefix(spec: string): void {
  // `(Yohv)!@%+` → the pairs irc-framework hands parseModeSpec.
  const [, modes, symbols] = /\((.*)\)(.*)/.exec(spec)!;
  const PREFIX = [...modes].map((mode, i) => ({ mode, symbol: symbols[i] }));
  useNetworksStore().states[1] = {
    networkId: 1,
    channels: [],
    modeSpec: parseModeSpec({ PREFIX }),
  };
}

// Channel-operator actions are gated on the user's RANK in the network's PREFIX
// order (#727), not on a hardcoded letter list.
describe('useMemberActions channel-operator gating', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('offers moderation to a halfop but op management only from op up', () => {
    prefix('(qaohv)~&@%+');
    expect(labelsFor(['h'])).toContain('Kick…');
    expect(labelsFor(['h'])).not.toContain('Give Op');
    expect(labelsFor(['a'])).toContain('Give Op');
    expect(labelsFor(['v'])).not.toContain('Kick…');
  });

  it('lets a rank above op through, whatever its letter', () => {
    prefix('(Yohv)!@%+');
    expect(labelsFor(['Y'])).toContain('Give Op');
  });

  it('offers only the modes the network has', () => {
    // No voice on this network: nothing may send +v.
    prefix('(Yoh)!@%');
    expect(labelsFor(['Y'])).toContain('Give Op');
    expect(labelsFor(['Y'])).not.toContain('Give Voice');
  });

  it('falls back to the conventional ladder before the spec arrives', () => {
    expect(labelsFor(['q'])).toContain('Give Op');
    expect(labelsFor(['v'])).not.toContain('Kick…');
  });
});
