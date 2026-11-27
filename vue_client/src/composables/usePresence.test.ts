// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The presence frame follows attention (useAttention), not bare visibility:
// a visible tab nobody has touched stops claiming to be in front of anyone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../stores/settings.js', () => ({
  useSettingsStore: () => ({ effective: () => 600 }),
}));
vi.mock('./useSocket.js', () => ({
  socketSend: vi.fn<(payload: unknown) => boolean>(),
  onSocketOpen: vi.fn<(fn: () => void) => void>(),
}));

import { socketSend } from './useSocket.js';
import { resetAttentionForTests } from './useAttention.js';
import { reportNow, startPresenceReporter } from './usePresence.js';

const sent = () => vi.mocked(socketSend).mock.calls.map(([p]) => p);

describe('presence reporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAttentionForTests();
    vi.mocked(socketSend).mockClear();
  });

  afterEach(() => {
    resetAttentionForTests();
    vi.useRealTimers();
  });

  it('reports visible, then not once the client sits idle, then visible on input', () => {
    startPresenceReporter();
    reportNow();
    expect(sent()).toEqual([{ type: 'presence', visible: true }]);

    vi.advanceTimersByTime(600_000);
    expect(sent()).toEqual([
      { type: 'presence', visible: true },
      { type: 'presence', visible: false },
    ]);

    window.dispatchEvent(new Event('keydown'));
    expect(sent().at(-1)).toEqual({ type: 'presence', visible: true });
    expect(sent()).toHaveLength(3);
  });
});
