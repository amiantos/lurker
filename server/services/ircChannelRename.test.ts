// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 draft/channel-rename (#858), and the rule scopes that follow the
// buffer (#719). The wire shapes are ergo 2.18's, probed live: RENAME carries
// two parameters when no reason was given and three when one was.

// MUST be first: see ircConnection.test.ts.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { getBuffer, ensureOpen, close as closeBuffer } from '../db/buffers.js';
import { insertMessage, listMessages } from '../db/messages.js';
import { addRule, listRules } from '../db/ignoredMasks.js';
import { setChannelConfig } from '../db/e2e.js';
import ignoreRulesService from './ignoreRulesService.js';
import { CHANNEL_RENAME_CAP } from '../../shared/channelRename.js';

let userId: number;
let counter = 0;

beforeAll(() => {
  userId = createUser('rename-conn-test').id;
});

function makeConn() {
  const network = createNetwork(userId, {
    name: `rename-${++counter}`,
    host: 'irc.example.test',
    port: 6697,
    tls: 1,
    trusted_certificates: 1,
    nick: 'me',
    username: null,
    realname: null,
    server_password: null,
    autoconnect: 0,
    sasl_account: null,
    sasl_password: null,
    connect_commands: null,
  })!;
  const conn = new IrcConnection({ network, onEvent: () => {} });
  conn.client.user.nick = 'me';
  conn.client.raw = vi.fn<(line: string) => void>();
  const published: Array<Record<string, unknown>> = [];
  const record = (e: unknown) => {
    published.push(e as Record<string, unknown>);
  };
  conn.publish = vi.fn<(event: unknown) => void>(record) as typeof conn.publish;
  conn.publishEphemeral = vi.fn<(event: unknown) => void>(record) as typeof conn.publishEphemeral;
  const read = (line: string) => conn.client.connection.addReadBuffer(line);
  /** In `name`, with its buffer open, as a landed JOIN leaves things. */
  const joined = (name: string) => {
    const ch = conn.upsertChannel(name);
    ensureOpen(network.user_id, network.id, name, { kind: 'channel', autojoin: true });
    return ch;
  };
  const row = (name: string) => getBuffer(network.user_id, network.id, name);
  const of = (type: string) => published.filter((e) => e.type === type);
  return { conn, network, published, read, joined, row, of };
}

describe('an inbound RENAME (#858)', () => {
  it('moves the buffer, the live channel and its state to the new name', () => {
    const { conn, read, joined, row, of } = makeConn();
    const ch = joined('#old');
    ch.topic = 'the topic';
    ch.members.set('op', { nick: 'op', modes: ['o'], away: false, user: 'u', host: 'h' });
    const id = row('#old')!.id;

    read(':op!u@h RENAME #old #new :tidy up');

    // One buffer, the same one, under the new name.
    expect(row('#old')).toBeUndefined();
    expect(row('#new')).toMatchObject({ id, kind: 'channel', state: 'open', autojoin: true });
    // Membership and everything riding in it.
    expect(conn.isChannelJoined('#old')).toBe(false);
    expect(conn.isChannelJoined('#new')).toBe(true);
    expect(conn.channelState('#new')).toMatchObject({ name: '#new', topic: 'the topic' });
    expect(conn.channelState('#new')!.members.has('op')).toBe(true);
    expect(of('buffer-renamed')).toEqual([
      expect.objectContaining({ from: '#old', to: '#new', bufferId: id, merged: false }),
    ]);
    // Said in the channel, under its new name, after the announcement.
    expect(of('motd')).toEqual([
      expect.objectContaining({
        target: '#new',
        text: 'op renamed this channel from #old to #new (tidy up)',
      }),
    ]);
    // We never left: nothing says parted, and nothing was sent.
    expect(of('channel-parted')).toEqual([]);
    expect(conn.client.raw).not.toHaveBeenCalled();
  });

  it("takes ergo's form, which leaves the reason off altogether", () => {
    const { conn, read, joined, row, of } = makeConn();
    joined('#old');

    read(':op!u@h RENAME #old #new');

    expect(row('#new')).toBeDefined();
    expect(conn.isChannelJoined('#new')).toBe(true);
    expect(of('motd')[0]).toMatchObject({ text: 'op renamed this channel from #old to #new' });
  });

  it("and the spec's form, with the reason there and empty", () => {
    const { read, joined, row, of } = makeConn();
    joined('#old');

    read(':op!u@h RENAME #old #new :');

    expect(row('#new')).toBeDefined();
    expect(of('motd')[0]).toMatchObject({ text: 'op renamed this channel from #old to #new' });
  });

  it('a rename that only changes case changes how the channel is written', () => {
    const { conn, read, joined, row, of } = makeConn();
    joined('#chan');
    const id = row('#chan')!.id;

    read(':op!u@h RENAME #chan #Chan');

    expect(row('#chan')).toMatchObject({ id, target: '#Chan' });
    expect(conn.channelState('#chan')!.name).toBe('#Chan');
    expect(conn.isChannelJoined('#Chan')).toBe(true);
    expect(of('buffer-renamed')).toEqual([
      expect.objectContaining({ from: '#chan', to: '#Chan', merged: false }),
    ]);
  });

  it('keeps the history: the lines said under the old name are in the renamed buffer', () => {
    const { network, read, joined } = makeConn();
    joined('#old');
    insertMessage({
      networkId: network.id,
      target: '#old',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'peer',
      text: 'before the rename',
    });

    read(':op!u@h RENAME #old #new');

    expect(listMessages(network.id, '#new').map((m) => m.text)).toContain('before the rename');
  });

  it('absorbs a buffer already held under the new name, and says which', () => {
    const { network, read, joined, row, of } = makeConn();
    joined('#old');
    const id = row('#old')!.id;
    // A channel of that name the user was once in and closed.
    ensureOpen(network.user_id, network.id, '#new', { kind: 'channel' });
    const stale = row('#new')!.id;
    closeBuffer(network.user_id, network.id, '#new');

    read(':op!u@h RENAME #old #new');

    expect(row('#new')).toMatchObject({ id, state: 'open' });
    expect(of('buffer-renamed')).toEqual([
      expect.objectContaining({ bufferId: id, merged: true, mergedFromBufferId: stale }),
    ]);
  });

  it('a rename the engine replay got to first: the row with the history survives', () => {
    // No app was attached when the channel was renamed. The engine's replay
    // joins a fresh process to the NEW name (it followed the RENAME), and the
    // RENAME itself comes after, in the backlog: the live map never held the
    // old name, and the registry has it with all its history.
    const { conn, network, read, joined, row, of } = makeConn();
    ensureOpen(network.user_id, network.id, '#old', { kind: 'channel', autojoin: true });
    const id = row('#old')!.id;
    const fresh = joined('#new');
    fresh.topic = 'asked for after the replay';
    const minted = row('#new')!.id;

    read(':op!u@h RENAME #old #new');

    expect(row('#old')).toBeUndefined();
    expect(row('#new')!.id).toBe(id);
    expect(of('buffer-renamed')).toEqual([
      expect.objectContaining({ bufferId: id, merged: true, mergedFromBufferId: minted }),
    ]);
    // The entry the replay made is the live one, and stays.
    expect(conn.channelState('#new')!.topic).toBe('asked for after the replay');
  });

  it('given a second time, does nothing: the buffer has already moved', () => {
    const { read, joined, published } = makeConn();
    joined('#old');
    read(':op!u@h RENAME #old #new');
    const before = published.length;

    read(':op!u@h RENAME #old #new');

    expect(published).toHaveLength(before);
  });

  it('ignores a channel that is not ours', () => {
    const { read, joined, row, published } = makeConn();
    joined('#mine');

    read(':op!u@h RENAME #theirs #else :not our business');

    expect(row('#else')).toBeUndefined();
    expect(published).toEqual([]);
  });

  it.each([
    ['a sentence where the name belongs', ':op!u@h RENAME #old :#old is moving to #new'],
    ['a list', ':op!u@h RENAME #old #new,#other :tidy'],
    ['a name that is no channel', ':op!u@h RENAME #old elsewhere :tidy'],
    ['no new name at all', ':op!u@h RENAME #old'],
    ['an old name that is no channel', ':op!u@h RENAME old #new'],
  ])('does not act on %s', (_what, line) => {
    const { conn, read, joined, row, published } = makeConn();
    joined('#old');

    read(line);

    expect(row('#old')).toBeDefined();
    expect(conn.isChannelJoined('#old')).toBe(true);
    expect(published.filter((e) => e.type !== 'unknown')).toEqual([]);
  });

  it('follows on all four channel prefixes', () => {
    const { conn, read, joined, row } = makeConn();
    joined('&local');

    read(':op!u@h RENAME &local &lokal');

    expect(row('&lokal')).toBeDefined();
    expect(conn.isChannelJoined('&lokal')).toBe(true);
  });

  it('a closed buffer renames without an announcement', () => {
    // In the channel on the wire, its buffer closed here: nothing for a
    // client to rekey, and a frame would put it back in every sidebar.
    const { network, read, joined, row, of } = makeConn();
    joined('#old');
    closeBuffer(network.user_id, network.id, '#old');

    read(':op!u@h RENAME #old #new');

    expect(row('#new')).toMatchObject({ state: 'closed' });
    expect(of('buffer-renamed')).toEqual([]);
  });

  it("moves the per-channel marks, so the new name doesn't inherit a clean slate", () => {
    const { conn, read, joined } = makeConn();
    joined('#old');
    conn.unsendableTargets.add('#old');

    read(':op!u@h RENAME #old #new');

    expect(conn.unsendableTargets.has('#old')).toBe(false);
    expect(conn.unsendableTargets.has('#new')).toBe(true);
  });

  it('says so when the channel was encrypted, since the new name is not', () => {
    const { network, read, joined, of } = makeConn();
    joined('#old');
    setChannelConfig(network.user_id, network.id, {
      channel: '#old',
      enabled: true,
      mode: 'normal',
    } as Parameters<typeof setChannelConfig>[2]);

    read(':op!u@h RENAME #old #new');

    expect(of('error')).toEqual([
      expect.objectContaining({
        target: '#new',
        text: 'Encryption was on for #old and is off for #new. Type /e2e on to turn it back on.',
      }),
    ]);
  });

  it('and says nothing about encryption when there was none', () => {
    const { read, joined, of } = makeConn();
    joined('#old');

    read(':op!u@h RENAME #old #new');

    expect(of('error')).toEqual([]);
  });
});

describe('a mute follows the renamed channel (#719)', () => {
  const MUTE = ['NOUNREAD', 'NONOTIFY'];

  function mute(networkId: number, channel: string) {
    addRule({
      userId,
      networkId,
      rule: {
        mask: null,
        channels: [channel],
        pattern: null,
        patternKind: 'substr',
        levels: MUTE,
        isExcept: false,
        expiresAt: null,
      },
    });
  }

  it('the rule names the new channel, the compiled set has it, and clients are told', () => {
    const { network, read, joined, of, published } = makeConn();
    joined('#old');
    mute(network.id, '#old');
    // Compiled and cached under the old name, as a line arriving would leave it.
    expect(
      ignoreRulesService.getCompiled(userId, network.id).some((r) => r.matchesChannel('#old')),
    ).toBe(true);

    read(':op!u@h RENAME #old #new');

    expect(listRules({ userId, networkId: network.id }).map((r) => r.channels)).toEqual([['#new']]);
    const compiled = ignoreRulesService.getCompiled(userId, network.id);
    expect(compiled.some((r) => r.matchesChannel('#new'))).toBe(true);
    expect(compiled.some((r) => r.matchesChannel('#old'))).toBe(false);
    // The list, then the rename: the rename's follow-ups read the rules.
    const moved = of('ignore-lists-moved');
    expect(moved).toEqual([expect.objectContaining({ scopes: [network.id] })]);
    expect(published.indexOf(moved[0])).toBeLessThan(published.indexOf(of('buffer-renamed')[0]));
  });

  it('tells no one when no rule named the channel', () => {
    const { read, joined, of } = makeConn();
    joined('#old');

    read(':op!u@h RENAME #old #new');

    expect(of('ignore-lists-moved')).toEqual([]);
  });

  it("a DM mute follows the peer's nick too", () => {
    const { conn, network, of } = makeConn();
    ensureOpen(network.user_id, network.id, 'bob', { kind: 'dm' });
    mute(network.id, 'bob');

    conn.client.emit('nick', { nick: 'bob', new_nick: 'bob_away' });

    expect(listRules({ userId, networkId: network.id }).map((r) => r.channels)).toEqual([
      ['bob_away'],
    ]);
    expect(of('ignore-lists-moved')).toHaveLength(1);
  });
});

describe('a refused rename', () => {
  it('is said in the channel it was about', () => {
    const { read, joined, of } = makeConn();
    joined('#old');

    read(':irc.example.test FAIL RENAME CHANNEL_NAME_IN_USE #old #taken :Channel name in use');

    expect(of('error')).toEqual([
      expect.objectContaining({
        target: '#old',
        text: "Couldn't rename this channel to #taken: Channel name in use (CHANNEL_NAME_IN_USE)",
      }),
    ]);
  });

  it('stays out of any channel when it names one we are not in', () => {
    const { read, joined, of } = makeConn();
    joined('#mine');

    read(':irc.example.test FAIL RENAME CANNOT_RENAME #other #taken :Cannot rename channel');

    expect(of('error').filter((e) => e.target === '#mine')).toEqual([]);
  });
});

describe('asking for the cap', () => {
  it('asks at connect when the app dials for itself', () => {
    const { conn } = makeConn();
    expect(conn.client.request_extra_caps).not.toContain(CHANNEL_RENAME_CAP);
    conn.client.connect = vi.fn<() => void>() as typeof conn.client.connect;

    conn.connect();

    expect(conn.client.request_extra_caps).toContain(CHANNEL_RENAME_CAP);
  });

  it('asks once, however many times it connects', () => {
    const { conn } = makeConn();
    conn.client.connect = vi.fn<() => void>() as typeof conn.client.connect;

    conn.connect();
    conn.connect();

    expect(
      (conn.client.request_extra_caps as string[]).filter((c) => c === CHANNEL_RENAME_CAP),
    ).toHaveLength(1);
  });
});
