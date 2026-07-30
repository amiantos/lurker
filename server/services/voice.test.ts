// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it } from 'vitest';

import {
  isChannelTarget,
  liveKitConfig,
  mintVoiceToken,
  parseVoiceEnabled,
  roomFor,
  voiceEnabled,
  voiceMasterEnabled,
  meetsJoinMode,
  canModerateCall,
  canAdminCall,
  guestIdentity,
} from './voice.js';

describe('parseVoiceEnabled', () => {
  it('treats the conventional truthy values as on (trimmed, case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(parseVoiceEnabled(v)).toBe(true);
    }
  });

  it('is off for unset / empty / anything else (opt-in only)', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(parseVoiceEnabled(v)).toBe(false);
    }
  });
});

describe('isChannelTarget', () => {
  it('recognises IRC channel sigils', () => {
    for (const t of ['#dev', '&local', '!ABCDEchan', '+modeless']) {
      expect(isChannelTarget(t)).toBe(true);
    }
  });
  it('treats a nick as a non-channel (DM) target', () => {
    for (const t of ['alice', 'Bob', '', 'nick|away']) {
      expect(isChannelTarget(t)).toBe(false);
    }
  });
});

describe('roomFor', () => {
  it('makes a channel room everyone on the same host+channel derives identically', () => {
    // self is irrelevant for a channel; the host is shared across users and
    // instances, so two different accounts produce the same room.
    expect(roomFor('irc.libera.chat', '#dev', 'alice')).toBe('net-irc.libera.chat-c-#dev');
    expect(roomFor('irc.libera.chat', '#dev', 'bob')).toBe('net-irc.libera.chat-c-#dev');
  });

  it('folds host + channel ASCII-only, leaving sigils and non-ASCII intact', () => {
    expect(roomFor('IRC.Libera.Chat', '#DevOps', 'x')).toBe('net-irc.libera.chat-c-#devops');
    // [] and {} are NOT folded (RFC casemapping deliberately absent, §9.2).
    expect(roomFor('irc.libera.chat', '#Foo[Bar]', 'x')).toBe('net-irc.libera.chat-c-#foo[bar]');
  });

  it('gives a DM the SAME room from either end (canonical sorted pair)', () => {
    // The bug this prevents: A's target is "B", B's target is "A" — verbatim
    // naming would split one call into two rooms.
    const fromAlice = roomFor('irc.libera.chat', 'Bob', 'Alice');
    const fromBob = roomFor('irc.libera.chat', 'Alice', 'Bob');
    expect(fromAlice).toBe(fromBob);
    expect(fromAlice).toBe('net-irc.libera.chat-d-alice-bob');
  });

  it('scopes rooms by host, not by per-user network id', () => {
    // Same channel on two different networks → different rooms.
    expect(roomFor('irc.libera.chat', '#dev', 'x')).not.toBe(roomFor('irc.rizon.net', '#dev', 'x'));
  });
});

describe('config gating (env)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('liveKitConfig is null unless all three vars are present', () => {
    delete process.env.LIVEKIT_WS_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    expect(liveKitConfig()).toBeNull();

    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    expect(liveKitConfig()).toBeNull(); // secret still missing

    process.env.LIVEKIT_API_SECRET = 'devsecret';
    expect(liveKitConfig()).toEqual({
      wsUrl: 'wss://sfu.example',
      apiKey: 'devkey',
      apiSecret: 'devsecret',
    });
  });

  it('voiceEnabled requires BOTH the master switch and a full config', () => {
    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret';

    process.env.LURKER_VOICE_ENABLED = 'off';
    expect(voiceMasterEnabled()).toBe(false);
    expect(voiceEnabled()).toBe(false);

    process.env.LURKER_VOICE_ENABLED = 'true';
    expect(voiceEnabled()).toBe(true);

    delete process.env.LIVEKIT_API_SECRET;
    expect(voiceEnabled()).toBe(false); // master on, but config incomplete
  });
});

describe('mintVoiceToken', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('throws when voice is not configured', async () => {
    delete process.env.LIVEKIT_WS_URL;
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    await expect(mintVoiceToken({ identity: 'alice', room: 'net-1-c-#dev' })).rejects.toThrow();
  });

  it('mints a room-scoped token carrying the connection URL', async () => {
    process.env.LIVEKIT_WS_URL = 'wss://sfu.example';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'devsecret-long-enough-for-hs256';

    const minted = await mintVoiceToken({ identity: 'alice', room: 'net-1-c-#dev' });
    expect(minted.room).toBe('net-1-c-#dev');
    expect(minted.url).toBe('wss://sfu.example');
    expect(typeof minted.token).toBe('string');
    // A JWT is three dot-separated base64url segments.
    expect(minted.token.split('.')).toHaveLength(3);
  });
});

describe('meetsJoinMode', () => {
  it("'none' lets anyone in", () => {
    expect(meetsJoinMode([], 'none')).toBe(true);
    expect(meetsJoinMode(['v'], 'none')).toBe(true);
  });
  it('ranks voice < halfop < op; owner/admin count as op', () => {
    expect(meetsJoinMode([], 'voice')).toBe(false);
    expect(meetsJoinMode(['v'], 'voice')).toBe(true);
    expect(meetsJoinMode(['v'], 'op')).toBe(false);
    expect(meetsJoinMode(['h'], 'op')).toBe(false);
    expect(meetsJoinMode(['h'], 'halfop')).toBe(true);
    expect(meetsJoinMode(['o'], 'op')).toBe(true);
    expect(meetsJoinMode(['q'], 'op')).toBe(true);
    expect(meetsJoinMode(['o'], 'halfop')).toBe(true); // op exceeds the halfop bar
  });
});

describe('canModerateCall / canAdminCall', () => {
  it('moderation allows q/a/o/h; admin (policy + guest links) allows q/a/o only', () => {
    expect(canModerateCall(['h'])).toBe(true);
    expect(canModerateCall(['o'])).toBe(true);
    expect(canModerateCall(['v'])).toBe(false);
    expect(canModerateCall([])).toBe(false);
    expect(canAdminCall(['h'])).toBe(false);
    expect(canAdminCall(['o'])).toBe(true);
    expect(canAdminCall(['q'])).toBe(true);
    expect(canAdminCall([])).toBe(false);
  });
});

describe('guestIdentity', () => {
  it('namespaces + sanitizes so a guest can never be a bare IRC nick', () => {
    expect(guestIdentity('Alice')).toMatch(/^guest-alice-[0-9a-f]{8}$/);
    expect(guestIdentity('bad nick!@#')).toMatch(/^guest-badnick-[0-9a-f]{8}$/);
    expect(guestIdentity('')).toMatch(/^guest-guest-[0-9a-f]{8}$/);
    expect(guestIdentity('x')).not.toBe(guestIdentity('x')); // random suffix
  });
});
