// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push log in words (#1272): the server's gate names and device forms turn
// into something a user reads, and the admin dump is a timeline.

import { describe, it, expect } from 'vitest';
import {
  clientLabel,
  clientText,
  outcomeLabel,
  pushLogText,
  subjectLabel,
  type PushLogRow,
} from './pushLog.js';

function row(over: Partial<PushLogRow>): PushLogRow {
  return {
    id: 1,
    user_id: 1,
    at: '2026-11-04T18:31:00.000Z',
    kind: 'highlight',
    network_id: 1,
    network_name: 'Libera',
    target: '#lurker',
    nick: 'alice',
    message_id: 9002,
    outcome: 'suppressed',
    reason: 'visible_client',
    transport: null,
    device: null,
    status: null,
    ...over,
  };
}

describe('subjectLabel', () => {
  it('says who and where for each kind', () => {
    expect(subjectLabel(row({}))).toBe('alice in #lurker (Libera)');
    expect(subjectLabel(row({ kind: 'dm', nick: 'bob', target: 'bob' }))).toBe('bob (Libera)');
    expect(subjectLabel(row({ kind: 'friend_online', nick: 'bob' }))).toBe('bob (Libera)');
    expect(subjectLabel(row({ kind: 'kicked' }))).toBe('kicked from #lurker (Libera)');
    expect(subjectLabel(row({ kind: 'test', network_name: null }))).toBe('test push');
  });
});

describe('outcomeLabel', () => {
  it('turns a gate into words, and a device hold names the device', () => {
    expect(outcomeLabel(row({}))).toBe('held: a client was visible');
    expect(outcomeLabel(row({ reason: 'quiet_hours' }))).toBe('held: quiet hours');
    expect(
      outcomeLabel(row({ reason: 'relay_off', transport: 'webpush', device: 'push.lurker.chat' })),
    ).toBe('held for push.lurker.chat: the relay is off');
    // A reason this build doesn't know is shown as the server said it.
    expect(outcomeLabel(row({ reason: 'something_new' }))).toBe('held: something_new');
  });

  it('shows a sent row with its device and the status, and a failure with its reason', () => {
    expect(
      outcomeLabel(
        row({ outcome: 'sent', transport: 'webpush', device: 'push.lurker.chat', status: 201 }),
      ),
    ).toBe('sent to push.lurker.chat (201)');
    expect(
      outcomeLabel(row({ outcome: 'sent', transport: 'apns', device: 'a1b2c3d4…', status: 200 })),
    ).toBe('sent to Lurker for iOS a1b2c3d4… (200)');
    expect(
      outcomeLabel(
        row({
          outcome: 'failed',
          transport: 'webpush',
          device: 'push.lurker.chat',
          status: 403,
          reason: 'strike: status=403 message=not registered',
        }),
      ),
    ).toBe('failed for push.lurker.chat (403): strike: status=403 message=not registered');
  });
});

describe('pushLogText', () => {
  it('is one line per row, oldest first, with the username when there is one', () => {
    const text = pushLogText([
      row({
        id: 2,
        at: '2026-11-04T18:32:00.000Z',
        username: 'brad',
        outcome: 'sent',
        transport: 'webpush',
        device: 'push.lurker.chat',
        status: 201,
      }),
      row({ id: 1, username: 'brad' }),
    ]);
    expect(text.split('\n')).toEqual([
      '2026-11-04T18:31:00.000Z brad highlight alice in #lurker (Libera) — held: a client was visible',
      '2026-11-04T18:32:00.000Z brad highlight alice in #lurker (Libera) — sent to push.lurker.chat (201)',
    ]);
  });
});

describe('clientLabel', () => {
  it('names browsers, the apps, and falls back to the string', () => {
    expect(
      clientLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
      ),
    ).toBe('Safari on macOS');
    expect(clientLabel('Lurker/42 CFNetwork/1500 Darwin/24.0')).toBe('Lurker for iOS');
    expect(clientLabel('okhttp/4.12.0')).toBe('Lurker for Android');
    expect(clientLabel('curl/8.4')).toBe('curl/8.4');
    expect(clientLabel(null)).toBe('unknown client');
  });

  it('describes a live client with its presence', () => {
    expect(clientText({ userAgent: 'okhttp/4.12.0', connectedAt: null, visible: true })).toBe(
      'Lurker for Android — visible',
    );
    expect(clientText({ userAgent: null, connectedAt: null, visible: false })).toBe(
      'unknown client — in the background',
    );
  });
});
