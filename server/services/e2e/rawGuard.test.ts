// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Every way #1116 found of writing a PRIVMSG to an E2E channel that "the first two
// words" didn't see, and the legitimate lines the guard must leave alone.

import '../../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { createUser } from '../../db/users.js';
import { createNetwork } from '../../db/networks.js';
import { e2eManager } from './manager.js';
import { cleartextE2eLeak } from './rawGuard.js';

let userId: number;
let networkId: number;

beforeAll(() => {
  userId = createUser('rawguard-alice').id;
  networkId = createNetwork(userId, { name: 'n', host: 'h', nick: 'alice' })!.id;
  e2eManager.setChannelConfig(userId, networkId, '#secret', true, 'normal');
  // Configured but switched off: not a leak.
  e2eManager.setChannelConfig(userId, networkId, '#paused', false, 'normal');
});

const leak = (line: string) => cleartextE2eLeak(userId, networkId, line);

describe('cleartextE2eLeak', () => {
  it('reads the verb and target past what a server strips', () => {
    const lines = [
      'PRIVMSG #secret :plain',
      'privmsg   #secret   :plain',
      '@+draft/reply=abc PRIVMSG #secret :plain',
      '@label=x;time=2026-01-01T00:00:00.000Z privmsg #secret :plain',
      ':me!u@h PRIVMSG #secret :plain',
      '@+draft/reply=abc :me PRIVMSG #secret :plain',
      // raw() strips NUL before writing, so this reaches the wire as a clean PRIVMSG.
      'PRIVMSG\u0000 #secret :plain',
      'PRIVMSG #sec\u0000ret :plain',
      '  PRIVMSG #secret :plain',
      // A trailing parameter is still the first parameter: the server reads the target.
      'PRIVMSG :#secret',
    ];
    expect(lines.map((l) => [l, leak(l)])).toEqual(
      lines.map((l) => [l, { command: 'PRIVMSG', channel: '#secret' }]),
    );
  });

  it('covers the verbs ircManager refuses in the clear', () => {
    expect(leak('NOTICE #secret :plain')).toEqual({ command: 'NOTICE', channel: '#secret' });
    expect(leak('@+draft/react=👍;+draft/reply=abc TAGMSG #secret')).toEqual({
      command: 'TAGMSG',
      channel: '#secret',
    });
  });

  it('checks every target in a comma list', () => {
    expect(leak('PRIVMSG #public,#secret :plain')?.channel).toBe('#secret');
    expect(leak('PRIVMSG #secret,#public :plain')?.channel).toBe('#secret');
    expect(leak('NOTICE bob,#public,,#secret :plain')?.channel).toBe('#secret');
    expect(leak('PRIVMSG #public,bob :plain')).toBeNull();
  });

  it("matches the channel by the network's case folding", () => {
    expect(leak('PRIVMSG #Secret :plain')?.channel).toBe('#secret');
    expect(leak('PRIVMSG #SECRET :plain')?.channel).toBe('#secret');
    expect(leak('PRIVMSG #secret2 :plain')).toBeNull();
  });

  it('peels a STATUSMSG prefix off the channel', () => {
    const targets = ['@#secret', '+#secret', '%#secret', '~#secret', '&#secret', '%+#secret'];
    expect(targets.map((t) => [t, leak(`PRIVMSG ${t} :plain`)?.channel])).toEqual(
      targets.map((t) => [t, '#secret']),
    );
  });

  it('leaves everything else alone', () => {
    const lines = [
      'MODE #secret +o bob',
      'KICK #secret bob :spam',
      'TOPIC #secret :new topic',
      'PRIVMSG #open :plain',
      'PRIVMSG #paused :plain',
      'PRIVMSG bob :plain',
      'PRIVMSG #secretary :plain',
      // IRC separates fields on ASCII space alone: this names one channel, and it isn't #secret.
      'NOTICE #secret\u00a0other :plain',
      'PRIVMSG\t#secret :plain',
      'PRIVMSG',
      '@tags-only',
      '',
    ];
    expect(lines.map((l) => [l, leak(l)])).toEqual(lines.map((l) => [l, null]));
  });
});
