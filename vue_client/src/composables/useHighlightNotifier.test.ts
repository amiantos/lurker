// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cover for notifyForEvent's gate on the server `notify` flag (#359 follow-up).
//
// The client no longer re-derives the ignore verdict — it trusts the server's
// `notify` (the content-signal union with hide + NONOTIFY already folded in). A
// muted buffer arrives as notify:false and must not toast; a de-highlighted DM
// arrives as notify:true and still toasts (NOHIGHLIGHT is display-only). These
// lock that in so a future edit can't silently re-introduce a client-side veto
// or invert the gate.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

let push: Mock<(t: unknown) => void>;
let effective: Mock<(key: string) => unknown>;

// Load a fresh notifyForEvent with the stores it reads mocked. `viewed` is the
// buffer key currently on screen (default '' so the event's buffer is never the
// viewed one); `hidden` models a background tab; `enabled` toggles the per-kind
// master switch. Sound is forced off so no Audio is constructed.
async function load(opts: { viewed?: string; hidden?: boolean; enabled?: boolean } = {}) {
  vi.resetModules();
  push = vi.fn<(t: unknown) => void>();
  effective = vi.fn<(key: string) => unknown>((key: string) => {
    if (key.includes('.sound.')) return false; // no sound / no Audio
    if (key.endsWith('.enabled')) return opts.enabled ?? true;
    return undefined;
  });
  vi.doMock('../stores/toasts.js', () => ({ useToastsStore: () => ({ push }) }));
  vi.doMock('../stores/settings.js', () => ({ useSettingsStore: () => ({ effective }) }));
  vi.doMock('../stores/networks.js', () => ({
    useNetworksStore: () => ({ networkById: () => ({ name: 'libera' }) }),
  }));
  vi.doMock('./useViewedBuffer.js', () => ({ viewedBuffer: () => opts.viewed ?? '' }));
  vi.stubGlobal('document', { hidden: opts.hidden ?? false });
  return import('./useHighlightNotifier.js');
}

afterEach(() => vi.unstubAllGlobals());

// A DM from bob that the server flagged notify-worthy. Callers override `notify`
// (and other signals) per case.
function dm(overrides: Record<string, unknown> = {}) {
  return {
    networkId: 1,
    target: 'bob',
    nick: 'bob',
    text: 'ping',
    type: 'message',
    id: 1,
    self: false,
    dm: true,
    matched: false,
    notifyAlways: false,
    notify: true,
    ...overrides,
  };
}

describe('notifyForEvent notify gate', () => {
  beforeEach(() => vi.resetModules());

  it('toasts a notify:true event when the tab is visible and its buffer is off-screen', async () => {
    const { notifyForEvent } = await load();
    notifyForEvent(dm());
    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0][0] as { kind: string }).kind).toBe('dm');
  });

  it('does not toast when notify is false — the server already applied the mute veto', async () => {
    const { notifyForEvent } = await load();
    notifyForEvent(dm({ notify: false }));
    expect(push).not.toHaveBeenCalled();
  });

  it('does not toast an event with no notify flag (never re-derives the verdict client-side)', async () => {
    const { notifyForEvent } = await load();
    notifyForEvent(dm({ notify: undefined }));
    expect(push).not.toHaveBeenCalled();
  });

  it('still toasts a de-highlighted DM (NOHIGHLIGHT is display-only, so notify stays true)', async () => {
    // The server sends matched:false (decideStamp nulled it) but notify:true —
    // the client must NOT suppress it the way the old client-side NOHIGHLIGHT
    // check did. Kind falls through to dm.
    const { notifyForEvent } = await load();
    notifyForEvent(dm({ matched: false, notify: true }));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not toast when the tab is hidden (that is the push path’s job)', async () => {
    const { notifyForEvent } = await load({ hidden: true });
    notifyForEvent(dm());
    expect(push).not.toHaveBeenCalled();
  });

  it('does not toast when viewing the event’s own buffer', async () => {
    const { notifyForEvent } = await load({ viewed: '1::bob' });
    notifyForEvent(dm());
    expect(push).not.toHaveBeenCalled();
  });

  it('respects the per-kind enabled toggle even when notify is true', async () => {
    const { notifyForEvent } = await load({ enabled: false });
    notifyForEvent(dm());
    expect(push).not.toHaveBeenCalled();
  });
});
