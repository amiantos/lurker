// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Characterization cover for decorateMessage's `notify` fold (#359 follow-up).
//
// `notify` is the single authoritative "alert the user" gate: the content-signal
// union (matched/dm/notifyAlways) with the ignore/mute veto folded in, so every
// live client (web toast, native buzz) and the push path can trust one flag
// instead of re-deriving the verdict — which is how a per-channel mute leaked
// back through to native clients that trusted `notify`. These lock in which
// ignore levels clear it: a hide-level or NONOTIFY rule suppresses; a NOHIGHLIGHT
// rule does NOT (it's display-only — the message stays visible and counted).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';
import type { MessageEvent } from '../db/messages.js';

const testDb = setupTestDb('wshub-decorate');

let decorateMessage: typeof import('./wsHub.js').decorateMessage;
let ignoreRulesService: typeof import('./ignoreRulesService.js').default;
let setChannelNotifyAlways: typeof import('../db/channelNotify.js').setChannelNotifyAlways;

let userId: number;
let networkId: number;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const { createNetwork } = await import('../db/networks.js');
  ({ setChannelNotifyAlways } = await import('../db/channelNotify.js'));
  ignoreRulesService = (await import('./ignoreRulesService.js')).default;
  ({ decorateMessage } = await import('./wsHub.js'));

  userId = createUser('decorateuser').id;
  networkId = createNetwork(userId, {
    name: 'libera',
    host: 'irc.example',
    port: 6697,
    tls: true,
    nick: 'decorateuser',
  })!.id;
});

afterAll(() => {
  testDb.cleanup();
});

beforeEach(() => {
  for (const rule of ignoreRulesService.list(userId, networkId)) {
    ignoreRulesService.removeById(userId, networkId, rule.id);
  }
  for (const rule of ignoreRulesService.listGlobal(userId)) {
    ignoreRulesService.removeById(userId, null, rule.id);
  }
  setChannelNotifyAlways(userId, networkId, '#lurker', false);
});

// A base inbound message event from bob. `id`/`time` don't affect the notify
// decision; callers override target/type/matched/nick as needed. A bare target
// (no '#') on a 'message' makes decorateMessage derive dm → notify.
function ev(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    id: 1,
    networkId,
    target: 'bob',
    time: new Date().toISOString(),
    type: 'message',
    nick: 'bob',
    text: 'ping',
    kind: null,
    self: false,
    userhost: 'bob!bob@example.host',
    alt: false,
    matched: false,
    matchedRuleId: null,
    fromIgnored: false,
    mirrored: false,
    ...overrides,
  };
}

// A sender-scoped rule on bob. `levels` is the only knob most tests touch.
function addSenderRule(levels: string[]): void {
  ignoreRulesService.add(userId, networkId, {
    mask: 'bob!*@*',
    channels: null,
    pattern: null,
    patternKind: 'substr',
    levels,
    isExcept: false,
    expiresAt: null,
  });
}

// A channel-scoped, null-mask mute — exactly what the notify ladder writes to
// mute #lurker (mask null = anyone, scoped to the channel).
function addChannelMute(levels: string[]): void {
  ignoreRulesService.add(userId, networkId, {
    mask: null,
    channels: ['#lurker'],
    pattern: null,
    patternKind: 'substr',
    levels,
    isExcept: false,
    expiresAt: null,
  });
}

describe('decorateMessage notify fold', () => {
  it('sets notify on a DM when nothing suppresses it', () => {
    const d = decorateMessage(userId, ev());
    expect(d.dm).toBe(true);
    expect(d.notify).toBe(true);
  });

  it('a NONOTIFY rule clears notify while the raw signals still ride the wire', () => {
    addSenderRule(['NONOTIFY']);
    const d = decorateMessage(userId, ev());
    expect(d.notify).toBe(false);
    // The content signal is untouched — clients still learn it was a DM.
    expect(d.dm).toBe(true);
  });

  it('a hide-level rule clears notify', () => {
    addSenderRule(['ALL']);
    expect(decorateMessage(userId, ev()).notify).toBe(false);
  });

  it('a NOHIGHLIGHT rule does NOT clear notify (display-only, matches push)', () => {
    // Deliberate (#359): NOHIGHLIGHT means "don't light it up", not "don't tell
    // me". Only hide + NONOTIFY clear notify. If this flips, the levels have
    // been conflated and a de-highlighted DM would stop notifying.
    addSenderRule(['NOHIGHLIGHT']);
    expect(decorateMessage(userId, ev()).notify).toBe(true);
  });

  it('a muted channel forces notify:false on a highlight while matched stays true', () => {
    // The headline case: a muted-channel highlight must arrive as
    // matched:true, notify:false — styled as a highlight in history, but no
    // toast/buzz. matched is stamped at insert time and rides in on the event.
    addChannelMute(['NOUNREAD', 'NONOTIFY']);
    const d = decorateMessage(
      userId,
      ev({
        target: '#lurker',
        nick: 'carol',
        userhost: 'carol!c@h',
        matched: true,
        matchedRuleId: 7,
      }),
    );
    expect(d.matched).toBe(true);
    expect(d.notify).toBe(false);
  });

  it('a NONOTIFY mute wins even in a notify-always channel', () => {
    setChannelNotifyAlways(userId, networkId, '#lurker', true);
    addChannelMute(['NONOTIFY']);
    const d = decorateMessage(
      userId,
      ev({ target: '#lurker', nick: 'carol', userhost: 'carol!c@h' }),
    );
    expect(d.notifyAlways).toBe(true);
    expect(d.notify).toBe(false);
  });
});
