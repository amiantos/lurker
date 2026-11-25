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
// master switch. Sound is off unless `sound` asks for it, so no Audio is
// constructed; `viewedSound` is the setting that lets it play for the buffer
// on screen (#1411). `played` counts the sounds.
let played: Mock<() => void>;
async function load(
  opts: {
    viewed?: string;
    hidden?: boolean;
    enabled?: boolean;
    sound?: boolean;
    viewedSound?: boolean;
  } = {},
) {
  vi.resetModules();
  push = vi.fn<(t: unknown) => void>();
  effective = vi.fn<(key: string) => unknown>((key: string) => {
    if (key === 'notifications.viewed_buffer.sound') return opts.viewedSound ?? false;
    if (key.endsWith('.sound.enabled')) return opts.sound ?? false;
    if (key.endsWith('.sound.choice')) return 'ping';
    if (key.endsWith('.sound.volume')) return 60;
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
  played = vi.fn<() => void>();
  vi.stubGlobal(
    'Audio',
    class {
      preload = '';
      cloneNode() {
        return { volume: 0, play: played };
      }
    },
  );
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

  it('strips mIRC formatting codes from the toast body (#606)', async () => {
    // The toast renders body as plain text, so \x03 colors / \x02 bold would
    // otherwise surface as literal control chars.
    const { notifyForEvent } = await load();
    notifyForEvent(dm({ text: '\x0304red\x03 and \x02bold\x02 text' }));
    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0][0] as { body: string }).body).toBe('red and bold text');
  });
});

describe('notifyForEvent sound', () => {
  beforeEach(() => vi.resetModules());

  it('plays with the toast for a buffer that is off-screen', async () => {
    const { notifyForEvent } = await load({ sound: true });
    notifyForEvent(dm());
    expect(push).toHaveBeenCalledTimes(1);
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('stays silent in the viewed buffer by default', async () => {
    const { notifyForEvent } = await load({ sound: true, viewed: '1::bob' });
    notifyForEvent(dm());
    expect(played).not.toHaveBeenCalled();
  });

  it('plays in the viewed buffer when asked to, still with no toast (#1411)', async () => {
    const { notifyForEvent } = await load({ sound: true, viewed: '1::bob', viewedSound: true });
    notifyForEvent(dm());
    expect(played).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('plays nothing in the viewed buffer for a kind whose sound is off', async () => {
    const { notifyForEvent } = await load({ sound: false, viewed: '1::bob', viewedSound: true });
    notifyForEvent(dm());
    expect(played).not.toHaveBeenCalled();
  });

  it('plays nothing in the viewed buffer for a kind that is off', async () => {
    const { notifyForEvent } = await load({
      enabled: false,
      sound: true,
      viewed: '1::bob',
      viewedSound: true,
    });
    notifyForEvent(dm());
    expect(played).not.toHaveBeenCalled();
  });

  it('plays nothing in a hidden tab, whatever is asked', async () => {
    const { notifyForEvent } = await load({
      hidden: true,
      sound: true,
      viewed: '1::bob',
      viewedSound: true,
    });
    notifyForEvent(dm());
    expect(played).not.toHaveBeenCalled();
  });

  it('plays once for a burst from one sender in the viewed buffer', async () => {
    const { notifyForEvent } = await load({ sound: true, viewed: '1::bob', viewedSound: true });
    notifyForEvent(dm());
    notifyForEvent(dm({ id: 2 }));
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('still toasts the next line once the user looks away', async () => {
    const opts = { sound: true, viewed: '1::bob', viewedSound: true };
    const { notifyForEvent } = await load(opts);
    notifyForEvent(dm());
    opts.viewed = '1::#chan';
    notifyForEvent(dm({ id: 2 }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(played).toHaveBeenCalledTimes(2);
  });
});

// #968. The toast side of the kick signal. A kick is the room telling you you're
// out of it, so it can't wear the "<nick> in <where>" title every other alert
// here uses — that would read as something bob said in the channel.
describe('notifyForEvent kick-of-us', () => {
  beforeEach(() => vi.resetModules());

  function kick(overrides: Record<string, unknown> = {}) {
    return dm({
      target: '#lurker',
      type: 'kick',
      nick: 'op',
      kicked: 'me',
      selfKicked: true,
      text: 'read the topic',
      dm: false,
      ...overrides,
    });
  }

  it('leads with the outcome and moves the kicker into the body', async () => {
    // The title is nowrap + ellipsis in a 360px stack, so a sentence opening
    // with the kicker's nick would clip the channel — the one fact the toast
    // exists to deliver. The push title has no such cap and keeps the sentence.
    const { notifyForEvent } = await load();
    notifyForEvent(kick());
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({
      kind: 'kicked',
      title: 'Kicked from libera | #lurker',
      body: 'op: read the topic',
    });
  });

  it('drops whichever half of the body is missing', async () => {
    const { notifyForEvent } = await load();
    // A server kick has no nick...
    notifyForEvent(kick({ nick: null }));
    expect(push.mock.calls[0][0]).toMatchObject({
      title: 'Kicked from libera | #lurker',
      body: 'read the topic',
    });
    // ...and a kick with no reason is ordinary.
    notifyForEvent(kick({ text: '' }));
    expect((push.mock.calls[1][0] as { body: string }).body).toBe('op');
  });

  it('strips formatting codes out of the kick reason too', async () => {
    const { notifyForEvent } = await load();
    notifyForEvent(kick({ text: '\x0304read\x03 the \x02topic\x02' }));
    expect((push.mock.calls[0][0] as { body: string }).body).toBe('op: read the topic');
  });

  it('reads its own master toggle, not the channel signals', async () => {
    const { notifyForEvent } = await load();
    notifyForEvent(kick());
    expect(effective).toHaveBeenCalledWith('notifications.kicked.enabled');
  });

  it('still defers to the server verdict', async () => {
    // A NONOTIFY-muted channel arrives as notify:false and stays silent, same
    // as every other signal — the client never re-derives the veto.
    const { notifyForEvent } = await load();
    notifyForEvent(kick({ notify: false }));
    expect(push).not.toHaveBeenCalled();
  });
});
