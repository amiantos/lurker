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
  // Notify flags are buffer_id-keyed (schema 18) — the flag only exists for a
  // registered buffer.
  const { ensureExists } = await import('../db/buffers.js');
  ensureExists(userId, networkId, '#lurker');
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

  it('a replayed line (a history backfill, #1283) is never a notification', () => {
    const d = decorateMessage(userId, ev({ replay: true }));
    expect(d.notify).toBe(false);
    // Still a DM for everything else: unread, highlight styling, the badge.
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

// #965: the bell says "every message in this channel", not "every frame about
// it". decorateMessage sees EVERY event a connection publishes — the nicklist
// republish, the typing notice, the mode sync, ephemeral and persisted alike —
// so without a type gate the notify-always flag turned channel bookkeeping into
// notifications. The nick-less ones are how it surfaced: push composes them as
// "someone in #channel" with an empty body, and the web client toasts on the
// same flag.
describe('decorateMessage notify-always is conversation-only (#965)', () => {
  const chan = (overrides: Partial<MessageEvent> = {}) =>
    ev({ target: '#lurker', nick: 'carol', userhost: 'carol!c@h', ...overrides });

  beforeEach(() => {
    setChannelNotifyAlways(userId, networkId, '#lurker', true);
  });

  it.each(['message', 'action', 'notice'])('notifies on a %s', (type) => {
    const d = decorateMessage(userId, chan({ type }));
    expect(d.notifyAlways).toBe(true);
    expect(d.notify).toBe(true);
  });

  // The nick-less control events. The gate is an allow-list, so a type added to
  // ircConnection later is excluded automatically and nothing forces it into
  // this list — these are named individually because each is a real publish site
  // that reached push, not because the enumeration is load-bearing.
  it.each([
    'names',
    'member-update',
    'channel-joined',
    'channel-parted',
    'channel-modes',
    'channel-topic',
    'join-error',
    'typing',
    'error',
    'e2e',
    'ctcp',
  ])('does not notify on a %s', (type) => {
    const d = decorateMessage(userId, chan({ type, nick: null, text: null }));
    expect(d.notifyAlways).toBe(false);
    expect(d.notify).toBe(false);
  });

  // The other half, and the louder one: persisted lifecycle rows DO carry a
  // nick, so under the old gate every person entering or leaving a belled
  // channel fired a real notification ("bob in #lurker", empty body). A kick or
  // a topic change goes quiet too — deliberate, and the reason the rule is
  // "conversation" rather than "has a sender".
  it.each(['join', 'part', 'quit', 'nick', 'mode', 'topic', 'kick', 'invite'])(
    'does not notify on a %s even though it has a sender',
    (type) => {
      const d = decorateMessage(userId, chan({ type, text: 'whatever' }));
      expect(d.nick).toBe('carol');
      expect(d.notifyAlways).toBe(false);
      expect(d.notify).toBe(false);
    },
  );

  it('leaves a DM and a highlight alone', () => {
    // Both paths are already type-limited upstream (DM_ELIGIBLE_TYPES,
    // matchEvent's eligible types), so the gate must be a no-op for them.
    // With the bell OFF, so the highlight is carrying the notify on its own.
    setChannelNotifyAlways(userId, networkId, '#lurker', false);
    expect(decorateMessage(userId, ev()).notify).toBe(true);
    expect(decorateMessage(userId, chan({ matched: true, matchedRuleId: 3 })).notify).toBe(true);
  });
});

// #968. The one event ABOUT you that isn't conversation, so it rides beside the
// COUNTABLE_TYPES gate rather than inside it. It is its own signal, not a
// channel one: it fires with the bell off, because the thing people asked not to
// happen is a channel vanishing from the sidebar with no word.
describe('decorateMessage kick-of-us signal (#968)', () => {
  const kick = (overrides: Partial<MessageEvent> = {}) =>
    ev({
      target: '#lurker',
      type: 'kick',
      nick: 'carol',
      userhost: 'carol!c@h',
      kicked: 'decorateuser',
      selfKicked: true,
      text: 'read the topic',
      ...overrides,
    });

  it('notifies with the bell OFF', () => {
    // The whole point: no notify-always flag is set on #lurker here.
    const d = decorateMessage(userId, kick());
    expect(d.notifyAlways).toBe(false);
    expect(d.selfKicked).toBe(true);
    expect(d.notify).toBe(true);
  });

  it('stays quiet for a kick of someone else', () => {
    const d = decorateMessage(userId, kick({ kicked: 'bob', selfKicked: undefined }));
    expect(d.selfKicked).toBeUndefined();
    expect(d.notify).toBe(false);
  });

  it('overwrites a stray flag on a non-kick rather than passing it through', () => {
    // The gate reads the type too, so a flag that arrived on another row can't
    // smuggle a notification past the conversation rule — and the decorated
    // row must not go on carrying it, since maybePush reads the decorate's
    // answer, not the raw event's.
    const d = decorateMessage(userId, kick({ type: 'part' }));
    expect(d.selfKicked).toBeUndefined();
    expect(d.notify).toBe(false);
  });

  it('costs nothing on the wire for the rows it does not apply to', () => {
    // A snapshot ships ~200 rows per buffer across every buffer, so the flag
    // must serialize away on the ordinary ones — `undefined` drops out of
    // JSON.stringify where a `false` would not. This is the assertion that
    // actually pins the claim; an in-process key set to undefined is fine.
    const line = JSON.parse(JSON.stringify(decorateMessage(userId, ev())));
    expect(line).not.toHaveProperty('selfKicked');
    const stray = JSON.parse(
      JSON.stringify(decorateMessage(userId, kick({ type: 'message', selfKicked: true }))),
    );
    expect(stray).not.toHaveProperty('selfKicked');
    // ...and rides the one row that means it.
    expect(JSON.parse(JSON.stringify(decorateMessage(userId, kick())))).toHaveProperty(
      'selfKicked',
      true,
    );
  });

  it('a NONOTIFY mute on the channel still wins', () => {
    // Asked and decided, not defaulted into: the mute is the user's own
    // standing instruction about this channel, and `notify` stays the one
    // authoritative gate rather than growing a per-signal exception. The
    // settings copy says so out loud, so the two move together.
    addChannelMute(['NONOTIFY']);
    const d = decorateMessage(userId, kick());
    expect(d.selfKicked).toBe(true);
    expect(d.notify).toBe(false);
  });
});
