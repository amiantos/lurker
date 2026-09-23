// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../../db/users.js';
import type { Network } from '../../db/networks.js';
import type { VerbContext } from '../verbRegistry.js';
import { parseModeSpec } from '../../../shared/channelModes.js';
import type { ModeListResult } from '../modeList.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-verbs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../../db/users.js').createUser;
let createNetwork: typeof import('../../db/networks.js').createNetwork;
let insertMessage: typeof import('../../db/messages.js').insertMessage;
let callVerb: typeof import('../verbRegistry.js').callVerb;
let ircManager: typeof import('../ircManager.js').default;
let setChannelConfig: typeof import('../../db/e2e.js').setChannelConfig;

let owner: User;
let intruder: User;
let net: Network;
let otherNet: Network;

beforeAll(async () => {
  ({ createUser } = await import('../../db/users.js'));
  ({ createNetwork } = await import('../../db/networks.js'));
  ({ insertMessage } = await import('../../db/messages.js'));
  // Importing the verbs aggregator triggers registration as a side effect.
  await import('./index.js');
  ({ callVerb } = await import('../verbRegistry.js'));
  ircManager = (await import('../ircManager.js')).default;
  ({ setChannelConfig } = await import('../../db/e2e.js'));

  owner = createUser('verbs-owner');
  intruder = createUser('verbs-intruder');
  net = createNetwork(owner.id, {
    name: 'libera',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'owner',
  }) as Network;
  otherNet = createNetwork(intruder.id, {
    name: 'oftc',
    host: 'h',
    port: 6697,
    tls: true,
    nick: 'intruder',
  }) as Network;

  const t = new Date().toISOString();
  insertMessage({
    networkId: net.id,
    target: '#chan',
    time: t,
    type: 'message',
    nick: 'alice',
    text: 'hello world',
    self: false,
  });
  insertMessage({
    networkId: net.id,
    target: '#chan',
    time: t,
    type: 'message',
    nick: 'bob',
    text: 'second message',
    self: false,
  });
  insertMessage({
    networkId: net.id,
    target: '#chan',
    time: t,
    type: 'message',
    nick: 'alice',
    text: 'deployment ready',
    self: false,
  });
  insertMessage({
    networkId: net.id,
    target: 'bob',
    time: t,
    type: 'message',
    nick: 'bob',
    text: 'private msg',
    self: false,
  });
  insertMessage({
    networkId: net.id,
    target: ':server:libera',
    time: t,
    type: 'notice',
    nick: null,
    text: 'motd',
    self: false,
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const rwCtx = (userId: number): VerbContext => ({ userId, scope: 'read-write', transport: 'ws' });
const rCtx = (userId: number): VerbContext => ({ userId, scope: 'read', transport: 'ws' });

describe('list_networks', () => {
  it("returns the caller's networks with connected=false when no live connection", () => {
    const result = callVerb('list_networks', rCtx(owner.id), {}) as Array<{
      id: number;
      name: string;
      connected: boolean;
      nick: string;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: net.id,
      name: 'libera',
      connected: false,
      nick: 'owner',
    });
  });

  it("is user-scoped — never leaks another user's networks", () => {
    const result = callVerb('list_networks', rCtx(intruder.id), {}) as Array<{ id: number }>;
    expect(result.map((n) => n.id)).toEqual([otherNet.id]);
  });

  // A netsplit collision SAVEs us to our UID. irc-framework refuses to store a
  // digit-leading nick, so its copy keeps our OLD nick — which is now free. If a
  // stranger takes it and renames, the framework matches `user.nick === event
  // .nick` and writes THEIR new nick into our copy. So during the window it is
  // not merely stale, it names someone else; only currentNick is us.
  it('reports our own nick during a collision, not the framework copy', () => {
    const conn = {
      state: 'connected',
      currentNick: '042AAEL37',
      client: { user: { nick: 'mallory' } }, // hijacked by a stranger's rename
    };
    ircManager.connectionsForUser(owner.id).set(net.id, conn as never);
    try {
      const result = callVerb('list_networks', rCtx(owner.id), {}) as Array<{ nick: string }>;
      expect(result[0].nick).toBe('042AAEL37');
    } finally {
      ircManager.connectionsForUser(owner.id).delete(net.id);
    }
  });
});

// ⚠⚠ #528 was public and minted `=nick` DCC buffers as kind 'dm' — it predates
// the 'dcc' kind. An install that ever ran it has such rows, and filtering on
// kind alone handed them to MCP (list_buffers) and to bouncer clients (playback
// and CHATHISTORY TARGETS, both fed by these queries).
describe('legacy =nick rows kinded as dm', () => {
  it('are hidden from list_buffers and CHATHISTORY TARGETS by shape, not just kind', async () => {
    const { ensureExists } = await import('../../db/buffers.js');
    const { listActiveTargetsInWindow } = await import('../../db/messages.js');
    const { default: db } = await import('../../db/index.js');
    ensureExists(owner.id, net.id, '=legacy', { kind: 'dm' }); // what #528 left behind
    insertMessage({
      networkId: net.id,
      target: '=legacy',
      nick: 'legacy',
      text: 'from an old build',
      type: 'message',
      time: new Date().toISOString(),
    } as never);
    try {
      const listed = callVerb('list_buffers', rCtx(owner.id), {}) as Array<{ target: string }>;
      expect(listed.map((b) => b.target)).not.toContain('=legacy');
      const targets = listActiveTargetsInWindow(
        net.id,
        '2000-01-01T00:00:00Z',
        '2100-01-01T00:00:00Z',
        50,
      );
      expect(targets.map((t) => t.target)).not.toContain('=legacy');
      // …while an ordinary DM still shows, so the filter isn't hiding everything.
      expect(listed.map((b) => b.target)).toContain('bob');
    } finally {
      db.prepare("DELETE FROM buffers WHERE target = '=legacy'").run();
    }
  });
});

describe('list_buffers', () => {
  it("returns the caller's buffers and excludes :server:* pseudo-buffers", () => {
    const result = callVerb('list_buffers', rCtx(owner.id), {}) as Array<{
      target: string;
      kind: string;
    }>;
    const targets = result.map((b) => b.target).toSorted();
    expect(targets).toEqual(['#chan', 'bob']);
    expect(result.find((b) => b.target === '#chan')!.kind).toBe('channel');
    expect(result.find((b) => b.target === 'bob')!.kind).toBe('dm');
  });

  it("honors the networkId filter and rejects another user's networkId at the boundary", () => {
    const only = callVerb('list_buffers', rCtx(owner.id), { networkId: net.id }) as Array<{
      networkId: number;
    }>;
    expect(only.every((b) => b.networkId === net.id)).toBe(true);
    expect(() => callVerb('list_buffers', rCtx(owner.id), { networkId: otherNet.id })).toThrow(
      /unknown network/,
    );
  });
});

describe('recent_messages', () => {
  it('returns oldest-first with hasOlder=false when buffer has fewer rows than limit', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id,
      target: '#chan',
      limit: 10,
    }) as { messages: Array<{ text: string }>; hasOlder: boolean };
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].text).toBe('hello world');
    expect(result.messages[2].text).toBe('deployment ready');
    expect(result.hasOlder).toBe(false);
  });

  it('hasOlder=true when more rows exist before the window', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id,
      target: '#chan',
      limit: 1,
    }) as { messages: Array<{ text: string }>; hasOlder: boolean };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('deployment ready');
    expect(result.hasOlder).toBe(true);
  });

  it('decorates each message with the dm/matched/notify flags', () => {
    const result = callVerb('recent_messages', rCtx(owner.id), {
      networkId: net.id,
      target: 'bob',
      limit: 10,
    }) as { messages: Array<Record<string, unknown>> };
    expect(result.messages[0]).toHaveProperty('dm', true);
    expect(result.messages[0]).toHaveProperty('notify');
  });

  it("rejects another user's networkId at the boundary", () => {
    expect(() =>
      callVerb('recent_messages', rCtx(owner.id), {
        networkId: otherNet.id,
        target: '#chan',
        limit: 5,
      }),
    ).toThrow(/unknown network/);
  });

  it('throws invalid_input when networkId is omitted (registry-level required check)', () => {
    let caughtErr: unknown;
    try {
      callVerb('recent_messages', rCtx(owner.id), { target: '#chan' });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/networkId/);
  });

  it('throws invalid_input when target is empty after trim', () => {
    let caughtErr: unknown;
    try {
      callVerb('recent_messages', rCtx(owner.id), { networkId: net.id, target: '   ' });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/target/);
  });
});

describe('search_messages', () => {
  it('matches against FTS index, decorates results, scopes to the caller', () => {
    const result = callVerb('search_messages', rCtx(owner.id), { query: 'deployment' }) as {
      messages: Array<{ text: string; networkId: number }>;
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].text).toBe('deployment ready');
    // Caller's network only.
    expect(result.messages[0].networkId).toBe(net.id);
  });

  it('returns empty when nothing matches', () => {
    const result = callVerb('search_messages', rCtx(owner.id), { query: 'xyzzy-no-such-term' }) as {
      messages: unknown[];
    };
    expect(result.messages).toEqual([]);
  });

  // Regression for #91: the inline `from:nick` / `in:#chan` / `on:network`
  // syntax sends a filter-only payload (no `query`). The schema used to mark
  // `query` required, which rejected these as invalid_input and silently hung
  // the modal — the handler and DB layer have always tolerated a missing query
  // as long as at least one structured filter is present.
  it('accepts filter-only searches with no free-text query', () => {
    const result = callVerb('search_messages', rCtx(owner.id), { nick: 'alice' }) as {
      messages: Array<{ text: string }>;
    };
    // Pin to message text, not nick — `m.nick = ? COLLATE NOCASE` would still
    // match if the seed casing ever changed, but a nick-equality assertion
    // wouldn't.
    expect(result.messages.map((m) => m.text).toSorted()).toEqual([
      'deployment ready',
      'hello world',
    ]);
  });

  it('reports hasMore=false when total matches equal the requested limit exactly', () => {
    // Seed a fresh user + network so the message count is deterministic.
    const u = createUser('search-limit-edge');
    const n = createNetwork(u.id, {
      name: 'l',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'u',
    }) as Network;
    const t = new Date().toISOString();
    for (let i = 0; i < 3; i += 1) {
      insertMessage({
        networkId: n.id,
        target: '#c',
        time: t,
        type: 'message',
        nick: 'u',
        text: `needle-${i}`,
        self: false,
      });
    }
    const res = callVerb('search_messages', rCtx(u.id), { query: 'needle', limit: 3 }) as {
      messages: unknown[];
      hasMore: boolean;
    };
    expect(res.messages).toHaveLength(3);
    // The pre-fix heuristic (length === limit) would report true here.
    expect(res.hasMore).toBe(false);
  });

  it('reports hasMore=true when there is at least one extra match beyond the limit', () => {
    const u = createUser('search-limit-overflow');
    const n = createNetwork(u.id, {
      name: 'l',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'u',
    }) as Network;
    const t = new Date().toISOString();
    for (let i = 0; i < 5; i += 1) {
      insertMessage({
        networkId: n.id,
        target: '#c',
        time: t,
        type: 'message',
        nick: 'u',
        text: `morsel-${i}`,
        self: false,
      });
    }
    const res = callVerb('search_messages', rCtx(u.id), { query: 'morsel', limit: 3 }) as {
      messages: unknown[];
      hasMore: boolean;
    };
    expect(res.messages).toHaveLength(3);
    expect(res.hasMore).toBe(true);
  });
});

describe('get_nick_note / set_nick_note', () => {
  it('get returns an empty note when none is set; set writes and round-trips', () => {
    const empty = callVerb('get_nick_note', rCtx(owner.id), {
      networkId: net.id,
      nick: 'alice',
    }) as { note: string; updatedAt: string | null };
    expect(empty.note).toBe('');
    expect(empty.updatedAt).toBeNull();
    const set = callVerb('set_nick_note', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'alice',
      note: 'works at Acme',
    }) as { note: string; updatedAt: string | null };
    expect(set.note).toBe('works at Acme');
    expect(set.updatedAt).not.toBeNull();
    const got = callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: 'alice' }) as {
      note: string;
    };
    expect(got.note).toBe('works at Acme');
  });

  it('set with empty string deletes the note', () => {
    callVerb('set_nick_note', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'carol',
      note: 'to delete',
    });
    callVerb('set_nick_note', rwCtx(owner.id), { networkId: net.id, nick: 'carol', note: '' });
    const got = callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: 'carol' }) as {
      note: string;
    };
    expect(got.note).toBe('');
  });

  it('set_nick_note caps body at 4096 chars', () => {
    const long = 'x'.repeat(5000);
    const result = callVerb('set_nick_note', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'dave',
      note: long,
    }) as { note: string };
    expect(result.note.length).toBe(4096);
  });

  it('set_nick_note rejected when caller has read-only scope', () => {
    expect(() =>
      callVerb('set_nick_note', rCtx(owner.id), {
        networkId: net.id,
        nick: 'eve',
        note: 'denied',
      }),
    ).toThrow(/scope insufficient/);
  });

  it('set_nick_note throws invalid_input on empty/whitespace nick (not silent success)', () => {
    let caughtErr: unknown;
    try {
      callVerb('set_nick_note', rwCtx(owner.id), {
        networkId: net.id,
        nick: '   ',
        note: 'orphan',
      });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/nick/);
  });

  it('get_nick_note throws invalid_input on empty nick', () => {
    let caughtErr: unknown;
    try {
      callVerb('get_nick_note', rCtx(owner.id), { networkId: net.id, nick: '' });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
  });
});

describe('send_message / send_action', () => {
  it('returns ok=false, error=not-connected when no live IRC connection', () => {
    const result = callVerb('send_message', rwCtx(owner.id), {
      networkId: net.id,
      target: '#chan',
      text: 'hi',
    });
    expect(result).toEqual({ ok: false, error: 'not-connected' });
  });

  it('send_action shares the same error shape', () => {
    const result = callVerb('send_action', rwCtx(owner.id), {
      networkId: net.id,
      target: '#chan',
      text: 'waves',
    });
    expect(result).toEqual({ ok: false, error: 'not-connected' });
  });

  it('send_notice shares the same error shape', () => {
    const result = callVerb('send_notice', rwCtx(owner.id), {
      networkId: net.id,
      target: '#chan',
      text: 'heads up',
    });
    expect(result).toEqual({ ok: false, error: 'not-connected' });
  });

  it('send_notice is rejected for read-only scope', () => {
    expect(() =>
      callVerb('send_notice', rCtx(owner.id), {
        networkId: net.id,
        target: '#chan',
        text: 'heads up',
      }),
    ).toThrow(/scope insufficient/);
  });

  it('send_notice rejects empty target or text', () => {
    expect(
      callVerb('send_notice', rwCtx(owner.id), {
        networkId: net.id,
        target: '',
        text: 'hi',
      }),
    ).toEqual({ ok: false, error: 'empty-target-or-text' });
  });

  it('send_message is rejected for read-only scope', () => {
    expect(() =>
      callVerb('send_message', rCtx(owner.id), {
        networkId: net.id,
        target: '#chan',
        text: 'hi',
      }),
    ).toThrow(/scope insufficient/);
  });

  it('rejects empty target or text without round-tripping ircManager', () => {
    expect(
      callVerb('send_message', rwCtx(owner.id), {
        networkId: net.id,
        target: '',
        text: 'hi',
      }),
    ).toEqual({ ok: false, error: 'empty-target-or-text' });
    expect(
      callVerb('send_message', rwCtx(owner.id), {
        networkId: net.id,
        target: '#chan',
        text: '',
      }),
    ).toEqual({ ok: false, error: 'empty-target-or-text' });
  });
});

describe('set_relay_bot', () => {
  it('marks a nick (persisting it NOCASE) and then clears it', async () => {
    const { getRelayBot } = await import('../../db/relayBots.js');
    const marked = callVerb('set_relay_bot', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'RelayBot',
      marked: true,
      pattern: '',
    });
    expect(marked).toMatchObject({
      networkId: net.id,
      nick: 'RelayBot',
      marked: true,
      pattern: '',
    });
    // Stored, and resolvable regardless of case.
    expect(getRelayBot({ userId: owner.id, networkId: net.id, nick: 'relaybot' })).toMatchObject({
      nick: 'RelayBot',
      pattern: '',
    });

    const cleared = callVerb('set_relay_bot', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'relaybot',
      marked: false,
      pattern: '',
    });
    expect(cleared).toMatchObject({ marked: false, pattern: '' });
    expect(getRelayBot({ userId: owner.id, networkId: net.id, nick: 'RelayBot' })).toBeNull();
  });

  it('stores and round-trips a custom envelope template', async () => {
    const { getRelayBot } = await import('../../db/relayBots.js');
    const saved = callVerb('set_relay_bot', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'bridge',
      marked: true,
      pattern: '<{nick}> {message}',
    });
    expect(saved).toMatchObject({ marked: true, pattern: '<{nick}> {message}' });
    expect(getRelayBot({ userId: owner.id, networkId: net.id, nick: 'bridge' })?.pattern).toBe(
      '<{nick}> {message}',
    );
  });

  it('echoes the canonical stored casing when re-marking under a different case', () => {
    callVerb('set_relay_bot', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'CamelBot',
      marked: true,
      pattern: '',
    });
    // NOCASE primary key keeps the first-inserted 'CamelBot'; the response echoes
    // that, not the 'camelbot' just passed in, so the UI shows consistent casing.
    const out = callVerb('set_relay_bot', rwCtx(owner.id), {
      networkId: net.id,
      nick: 'camelbot',
      marked: true,
      pattern: 'x',
    });
    expect(out).toMatchObject({ nick: 'CamelBot', marked: true, pattern: 'x' });
  });

  it('throws unknown_network for a network the caller does not own', () => {
    let code: string | undefined;
    try {
      callVerb('set_relay_bot', rwCtx(owner.id), {
        networkId: otherNet.id,
        nick: 'x',
        marked: true,
        pattern: '',
      });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('unknown_network');
  });

  it('is rejected for read-only scope', () => {
    expect(() =>
      callVerb('set_relay_bot', rCtx(owner.id), {
        networkId: net.id,
        nick: 'x',
        marked: true,
        pattern: '',
      }),
    ).toThrow(/scope insufficient/);
  });
});

// The agent-control verbs. The connection-bound ones are exercised against a
// stub IrcConnection injected into the shared ircManager singleton — the same
// seam wsHub.test.ts uses — because the assertion that matters for most of
// them is the exact IRC line that reaches the wire, and a not-connected-only
// test would pass just as happily with the arguments swapped.
// rfc1459 casefold: ASCII case plus the []\~ ↔ {}|^ equivalences. The stub
// connection below mirrors production shape — `channels` keyed by the
// legacy-lowercased WIRE name, resolution through a fold-aware channelState —
// so a verb that regressed to a raw `channels.get(name.toLowerCase())` probe
// fails the fold-variant cases rather than quietly passing.
const fold = (s: string) =>
  s
    .toLowerCase()
    .replaceAll('[', '{')
    .replaceAll(']', '}')
    .replaceAll('\\', '|')
    .replaceAll('~', '^');

const member = (nick: string) => [nick.toLowerCase(), { nick, modes: ['o'], away: false }];

describe('agent control verbs', () => {
  type Chan = { name: string; topic: string | null; members: Map<string, unknown> };

  function stubConn(networkId: number, channels: Chan[] = [], state = 'connected') {
    const map = new Map(channels.map((c) => [c.name.toLowerCase(), c]));
    const sent: string[] = [];
    const joins: Array<[string, string | undefined]> = [];
    const parts: Array<[string, string | undefined]> = [];
    return {
      sent,
      joins,
      parts,
      // Write verbs gate on this: an IrcConnection outlives its socket for the
      // whole reconnect backoff, and irc-framework silently DROPS writes while
      // it is down.
      state,
      network: { id: networkId },
      channels: map,
      raw: (line: string) => sent.push(line),
      serverTarget: () => `:server:${networkId}`,
      channelState: (name: string) => {
        for (const ch of map.values()) if (fold(ch.name) === fold(name)) return ch;
        return undefined;
      },
      isChannelJoined: (name: string) => {
        for (const ch of map.values()) if (fold(ch.name) === fold(name)) return true;
        return false;
      },
      join: (name: string, key?: string) => joins.push([name, key]),
      part: (name: string, reason?: string) => parts.push([name, reason]),
      stashJoinKey: () => {},
      // solanum's shape: q is a quiet list, MODES=4.
      modeSpec: () =>
        parseModeSpec({
          CHANMODES: ['eIbq', 'k', 'flj', 'CFLMPQRSTcgimnprstuz'],
          PREFIX: [
            { mode: 'o', symbol: '@' },
            { mode: 'v', symbol: '+' },
          ],
          MODES: '4',
        }),
      fetchModeList: (_channel: string, _letter: string): Promise<ModeListResult> =>
        Promise.resolve({ ok: true, entries: [] }),
    };
  }

  type Conn = ReturnType<typeof ircManager.listConnections>[number];
  function live(channels: Chan[] = [], state = 'connected') {
    const conn = stubConn(net.id, channels, state);
    ircManager.connectionsForUser(owner.id).set(net.id, conn as unknown as Conn);
    return conn;
  }

  // A lingering live connection would poison the sibling "offline" cases here
  // and the connected=false expectation in the list_networks suite.
  afterEach(() => ircManager.connectionsForUser(owner.id).clear());

  describe('send_raw', () => {
    it('sends the line verbatim and names the server buffer to read replies from', () => {
      const conn = live();
      // The advertised follow-up has to be actionable: recent_messages
      // REQUIRES a target and list_buffers filters the server buffer out, so
      // the literal is the only way an agent can ever read a WHOIS reply.
      expect(
        callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'MODE #x +o a' }),
      ).toEqual({ ok: true, serverBuffer: `:server:${net.id}` });
      expect(conn.sent).toEqual(['MODE #x +o a']);
      expect(
        callVerb('recent_messages', rCtx(owner.id), {
          networkId: net.id,
          target: `:server:${net.id}`,
        }),
      ).toMatchObject({ messages: expect.any(Array) });
    });

    it('validates the line, and checks scope + ownership', () => {
      expect(callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: '   ' })).toEqual({
        ok: false,
        error: 'empty-line',
      });
      expect(
        callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'FOO\r\nBAR' }),
      ).toEqual({ ok: false, error: 'line-must-be-single-line' });
      expect(
        callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'WHOIS bob' }),
      ).toEqual({ ok: false, error: 'not-connected' });
      expect(() =>
        callVerb('send_raw', rwCtx(owner.id), { networkId: otherNet.id, line: 'WHOIS bob' }),
      ).toThrow(/unknown network/);
      expect(() => callVerb('send_raw', rCtx(owner.id), { networkId: net.id, line: 'X' })).toThrow(
        /scope insufficient/,
      );
    });
  });

  describe('set_nick', () => {
    it('sends NICK', () => {
      const conn = live();
      expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'newnick' })).toEqual(
        {
          ok: true,
        },
      );
      expect(conn.sent).toEqual(['NICK newnick']);
    });

    it('rejects whitespace, and reports not-connected otherwise', () => {
      expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'a b' })).toEqual({
        ok: false,
        error: 'nick-must-be-single-token',
      });
      expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'newnick' })).toEqual(
        {
          ok: false,
          error: 'not-connected',
        },
      );
    });
  });

  describe('whois', () => {
    it('sends WHOIS and returns the server buffer target', () => {
      const conn = live();
      expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'bob' })).toMatchObject({
        ok: true,
        serverBuffer: `:server:${net.id}`,
      });
      expect(conn.sent).toEqual(['WHOIS bob']);
    });

    // ⚠ The lookup is a RAW line, which bypasses every `=` guard in ircManager,
    // so a `=bob` DCC buffer target handed to this verb put `WHOIS =bob` on the
    // wire. It means bob — the web client's whois store normalizes the same way.
    it('looks up the peer behind a =nick DCC target, never the buffer name', () => {
      const conn = live();
      callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: '=bob' });
      expect(conn.sent).toEqual(['WHOIS bob']);
    });

    it('refuses a bare = rather than sending WHOIS =', () => {
      const conn = live();
      expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: '=' })).toEqual({
        ok: false,
        error: 'empty-nick',
      });
      expect(conn.sent).toEqual([]);
    });

    it('validates the nick, and reports not-connected otherwise', () => {
      expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'a b' })).toEqual({
        ok: false,
        error: 'nick-must-be-single-token',
      });
      expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'bob' })).toMatchObject({
        ok: false,
        error: 'not-connected',
      });
    });
  });

  describe('join_channel / part_channel', () => {
    it('passes the channel and key through to the connection', () => {
      const conn = live();
      expect(
        callVerb('join_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x', key: 'k' }),
      ).toEqual({ ok: true });
      expect(conn.joins).toEqual([['#x', 'k']]);
      expect(
        callVerb('part_channel', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          reason: 'bye',
        }),
      ).toEqual({ ok: true });
      expect(conn.parts).toEqual([['#x', 'bye']]);
    });

    it('rejects a channel that is not a single token', () => {
      // conn.raw() strips CR/LF, so "#x\r\nfoo" would otherwise become a
      // silent { ok: true } against a channel the caller never named.
      for (const verb of ['join_channel', 'part_channel']) {
        expect(callVerb(verb, rwCtx(owner.id), { networkId: net.id, channel: ' ' })).toEqual({
          ok: false,
          error: 'empty-channel',
        });
        expect(
          callVerb(verb, rwCtx(owner.id), { networkId: net.id, channel: '#x\r\nfoo' }),
        ).toEqual({
          ok: false,
          error: 'channel-must-be-single-token',
        });
      }
    });

    it('reports not-connected with no live connection', () => {
      expect(
        callVerb('join_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x' }),
      ).toEqual({ ok: false, error: 'not-connected' });
      expect(
        callVerb('part_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x' }),
      ).toEqual({ ok: false, error: 'not-connected' });
    });
  });

  describe('set_away', () => {
    it('is user-wide, reports state, and needs no connection', () => {
      expect(callVerb('set_away', rwCtx(owner.id), { message: 'brb' })).toEqual({
        ok: true,
        away: true,
      });
      expect(callVerb('set_away', rwCtx(owner.id), {})).toEqual({ ok: true, away: false });
    });
  });

  describe('get_topic / set_topic', () => {
    it('reads the topic, resolving a fold-variant spelling of the channel', () => {
      live([{ name: '#foo[bar]', topic: 'the topic', members: new Map() }]);
      expect(
        callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#foo[bar]' }),
      ).toEqual({ ok: true, channel: '#foo[bar]', topic: 'the topic' });
      // Same channel under rfc1459 — a raw lowercase map probe misses it (#707).
      expect(
        callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#foo{bar}' }),
      ).toEqual({ ok: true, channel: '#foo[bar]', topic: 'the topic' });
      expect(
        callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#elsewhere' }),
      ).toEqual({ ok: false, error: 'not-in-channel' });
    });

    it('reports an unset topic as null', () => {
      live([{ name: '#x', topic: null, members: new Map() }]);
      expect(callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#x' })).toEqual({
        ok: true,
        channel: '#x',
        topic: null,
      });
    });

    it('sets the topic, and clears it only on an explicit empty string', () => {
      const conn = live();
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'hi' }),
      ).toEqual({ ok: true });
      expect(conn.sent).toEqual(['TOPIC #x :hi']);
      // An OMITTED topic used to default to '' and send this same clearing
      // line, so a forgotten argument wiped the channel topic. It is now
      // required, and clearing has to be spelled out.
      expect(() =>
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x' }),
      ).toThrow(/missing required field: topic/);
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: '' }),
      ).toEqual({ ok: true });
      expect(conn.sent).toEqual(['TOPIC #x :hi', 'TOPIC #x :']);
    });

    it('rejects a multi-line topic and a malformed channel', () => {
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'a\nb' }),
      ).toEqual({ ok: false, error: 'topic-must-be-single-line' });
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x y', topic: 'a' }),
      ).toEqual({ ok: false, error: 'channel-must-be-single-token' });
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'hi' }),
      ).toEqual({ ok: false, error: 'not-connected' });
    });
  });

  describe('get_mode_list', () => {
    it("returns the list's entries under the channel's own spelling", async () => {
      const conn = live([{ name: '#foo[bar]', topic: null, members: new Map() }]);
      const asked: string[] = [];
      conn.fetchModeList = (channel, letter) => {
        asked.push(`${channel} ${letter}`);
        return Promise.resolve({
          ok: true,
          entries: [{ mask: '*!*@bad', setBy: 'op', setAt: '2023-11-14T22:13:20.000Z' }],
        });
      };
      await expect(
        callVerb('get_mode_list', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#foo{bar}',
          letter: 'b',
        }),
      ).resolves.toEqual({
        ok: true,
        channel: '#foo[bar]',
        letter: 'b',
        entries: [{ mask: '*!*@bad', setBy: 'op', setAt: '2023-11-14T22:13:20.000Z' }],
      });
      expect(asked).toEqual(['#foo{bar} b']);
    });

    it("passes the server's refusal through", async () => {
      const conn = live();
      conn.fetchModeList = () =>
        Promise.resolve({ ok: false, error: 'refused', numeric: '482', text: 'not op' });
      await expect(
        callVerb('get_mode_list', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          letter: 'e',
        }),
      ).resolves.toEqual({ ok: false, error: 'refused', numeric: '482', text: 'not op' });
    });

    it('checks the letter and the connection before asking', async () => {
      live();
      await expect(
        callVerb('get_mode_list', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          letter: 'bb',
        }),
      ).resolves.toEqual({ ok: false, error: 'letter-must-be-one-mode-letter' });
      ircManager.connectionsForUser(owner.id).clear();
      await expect(
        callVerb('get_mode_list', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          letter: 'b',
        }),
      ).resolves.toEqual({ ok: false, error: 'not-connected' });
    });
  });

  describe('set_channel_modes', () => {
    const set = (changes: unknown[], channel = '#x') =>
      callVerb('set_channel_modes', rwCtx(owner.id), { networkId: net.id, channel, changes });

    it('batches the changes into MODE lines at the network MODES', () => {
      const conn = live();
      expect(
        set([
          { sign: '+', letter: 'm' },
          { sign: '+', letter: 'l', param: '50' },
          { sign: '-', letter: 'l' },
          { sign: '+', letter: 'b', param: 'a!*@*' },
          { sign: '+', letter: 'b', param: 'b!*@*' },
          { sign: '+', letter: 'b', param: 'c!*@*' },
          { sign: '+', letter: 'b', param: 'd!*@*' },
        ]),
      ).toEqual({ ok: true, lines: 2 });
      // MODES=4 counts only the changes that carry a param: +l and three bans.
      expect(conn.sent).toEqual(['MODE #x +ml-l+bbb 50 a!*@* b!*@* c!*@*', 'MODE #x +b d!*@*']);
    });

    it('checks every change against the network before sending any', () => {
      const conn = live();
      expect(
        set([
          { sign: '+', letter: 'm' },
          { sign: '+', letter: 'Y' },
        ]),
      ).toEqual({
        ok: false,
        error: 'unknown-mode:Y',
      });
      expect(set([{ sign: '+', letter: 'l' }])).toEqual({ ok: false, error: 'param-required:l' });
      expect(set([{ sign: '-', letter: 'l', param: '5' }])).toEqual({
        ok: false,
        error: 'param-not-taken:-l',
      });
      expect(set([{ sign: '+', letter: 'k', param: 'two words' }])).toEqual({
        ok: false,
        error: 'param-malformed:k',
      });
      // A leading ':' would make it the trailing parameter.
      expect(set([{ sign: '+', letter: 'b', param: ':x' }])).toEqual({
        ok: false,
        error: 'param-malformed:b',
      });
      expect(set([{ sign: '*', letter: 'm' }])).toEqual({
        ok: false,
        error: 'sign-must-be-plus-or-minus',
      });
      expect(set([])).toEqual({ ok: false, error: 'no-changes' });
      expect(conn.sent).toEqual([]);
    });

    it('fills a bare -k with the stored key, or * without one', async () => {
      const { ensureOpen, setChannelKey } = await import('../../db/buffers.js');
      ensureOpen(owner.id, net.id, '#keyed', { kind: 'channel', autojoin: true });
      setChannelKey(owner.id, net.id, '#keyed', 'hunter2');
      const conn = live([{ name: '#keyed', topic: null, members: new Map() }]);
      expect(set([{ sign: '-', letter: 'k' }], '#keyed')).toEqual({ ok: true, lines: 1 });
      expect(set([{ sign: '-', letter: 'k' }], '#unkeyed')).toEqual({ ok: true, lines: 1 });
      expect(conn.sent).toEqual(['MODE #keyed -k hunter2', 'MODE #unkeyed -k *']);
    });

    it('refuses when the network is down', () => {
      expect(set([{ sign: '+', letter: 'm' }])).toEqual({ ok: false, error: 'not-connected' });
    });
  });

  describe('list_members', () => {
    const chanOf = (nicks: string[]) => ({
      name: '#big',
      topic: null,
      members: new Map(nicks.map((n) => member(n)) as Array<[string, unknown]>),
    });

    it('returns members sorted by nick', () => {
      live([chanOf(['carol', 'alice', 'bob'])]);
      expect(
        callVerb('list_members', rCtx(owner.id), { networkId: net.id, channel: '#big' }),
      ).toEqual({
        ok: true,
        channel: '#big',
        count: 3,
        truncated: false,
        members: [
          { nick: 'alice', modes: ['o'], away: false },
          { nick: 'bob', modes: ['o'], away: false },
          { nick: 'carol', modes: ['o'], away: false },
        ],
      });
    });

    it('caps the page but still reports the true total', () => {
      // The answer goes straight into a model's context, so a 5k-nick channel
      // must not be able to flood it — and the cap must stay visible.
      const nicks = Array.from({ length: 300 }, (_, i) => `nick${String(i).padStart(3, '0')}`);
      live([chanOf(nicks)]);
      const capped = callVerb('list_members', rCtx(owner.id), {
        networkId: net.id,
        channel: '#big',
        limit: 10,
      }) as { count: number; truncated: boolean; members: Array<{ nick: string }> };
      expect(capped.count).toBe(300);
      expect(capped.truncated).toBe(true);
      expect(capped.members).toHaveLength(10);
      expect(capped.members[0].nick).toBe('nick000');

      // Default cap applies with no limit given.
      const defaulted = callVerb('list_members', rCtx(owner.id), {
        networkId: net.id,
        channel: '#big',
      }) as { count: number; truncated: boolean; members: unknown[] };
      expect(defaulted.count).toBe(300);
      expect(defaulted.members).toHaveLength(200);
      expect(defaulted.truncated).toBe(true);
    });

    it('reports not-in-channel and not-connected', () => {
      live([chanOf(['alice'])]);
      expect(
        callVerb('list_members', rCtx(owner.id), { networkId: net.id, channel: '#other' }),
      ).toEqual({ ok: false, error: 'not-in-channel' });
      ircManager.connectionsForUser(owner.id).clear();
      expect(
        callVerb('list_members', rCtx(owner.id), { networkId: net.id, channel: '#big' }),
      ).toEqual({ ok: false, error: 'not-connected' });
    });
  });

  describe('connect_network / disconnect_network', () => {
    it('enforces read-write scope and network ownership', () => {
      // Only the registry guards are asserted for connect — they throw before
      // the handler runs, and actually invoking startNetwork would open a
      // real socket.
      expect(() => callVerb('connect_network', rCtx(owner.id), { networkId: net.id })).toThrow(
        /scope insufficient/,
      );
      expect(() =>
        callVerb('connect_network', rwCtx(owner.id), { networkId: otherNet.id }),
      ).toThrow(/unknown network/);
    });

    it('disconnect is always ok, and a no-op when offline', () => {
      expect(callVerb('disconnect_network', rwCtx(owner.id), { networkId: net.id })).toEqual({
        ok: true,
      });
    });
  });
  // The reconnect-backoff case: the connection OBJECT is still in the manager's
  // map, so the old `getConnection() !== null` check said "connected" and the
  // verb answered ok — while irc-framework dropped the line on the floor. An
  // agent would then poll recent_messages forever for a reply that can never
  // arrive.
  describe('a connection whose socket is down', () => {
    it('reports not-connected from every write verb, and sends nothing', () => {
      const conn = live([{ name: '#x', topic: 't', members: new Map() }], 'disconnected');
      const offline = { ok: false, error: 'not-connected' };
      expect(callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'PING x' })).toEqual(
        offline,
      );
      expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'n' })).toEqual(
        offline,
      );
      expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'bob' })).toEqual(
        offline,
      );
      expect(
        callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'hi' }),
      ).toEqual(offline);
      expect(
        callVerb('join_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x' }),
      ).toEqual(offline);
      expect(
        callVerb('part_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x' }),
      ).toEqual(offline);
      expect(conn.sent).toEqual([]);
      expect(conn.joins).toEqual([]);
      expect(conn.parts).toEqual([]);
    });

    it('still answers reads from last-known state', () => {
      // Deliberately NOT gated: stale membership is not a lie, and refusing
      // mid-reconnect would be strictly less useful.
      live([{ name: '#x', topic: 't', members: new Map() }], 'disconnected');
      expect(callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#x' })).toEqual({
        ok: true,
        channel: '#x',
        topic: 't',
      });
    });
  });

  // CR/LF in these reaches irc-framework's own client.join/part/quit/raw, which
  // serialise and write the line VERBATIM — unlike IrcConnection.raw(), nothing
  // strips it, so an embedded newline really is a second injected command.
  describe('parameters that bypass the CR/LF stripper', () => {
    it('rejects an injected channel key', () => {
      const conn = live();
      expect(
        callVerb('join_channel', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          key: 'k\r\nOPER admin hunter2',
        }),
      ).toEqual({ ok: false, error: 'key-must-be-single-token' });
      expect(conn.joins).toEqual([]);
    });

    it('rejects an injected part reason', () => {
      const conn = live();
      expect(
        callVerb('part_channel', rwCtx(owner.id), {
          networkId: net.id,
          channel: '#x',
          reason: 'bye\r\nJOIN #evil',
        }),
      ).toEqual({ ok: false, error: 'reason-must-be-single-line' });
      expect(conn.parts).toEqual([]);
    });

    it('rejects an injected quit reason', () => {
      expect(
        callVerb('disconnect_network', rwCtx(owner.id), {
          networkId: net.id,
          reason: 'bye\r\nJOIN #evil',
        }),
      ).toEqual({ ok: false, error: 'reason-must-be-single-line' });
    });

    it('rejects an injected away message', () => {
      // set_away is user-wide, so this would have gone out on EVERY connected
      // network at once.
      expect(callVerb('set_away', rwCtx(owner.id), { message: 'brb\r\nJOIN #evil' })).toEqual({
        ok: false,
        error: 'message-must-be-single-line',
      });
    });
  });
  // send_raw is the escape hatch, so it is the one verb that can put cleartext
  // on a channel the user believes is encrypted — ircManager.send encrypts and
  // refuses to fall through on failure, conn.raw() does neither. There is also
  // no local echo on this path, so the leak would be silent at BOTH ends. A
  // sentence in the tool description is not an enforcement mechanism for a
  // confidentiality property.
  describe('send_raw on an E2E channel', () => {
    it('refuses a PRIVMSG and names the verb that encrypts', () => {
      setChannelConfig(owner.id, net.id, {
        channel: '#secret',
        enabled: true,
        mode: 'normal',
      });
      const conn = live();
      expect(
        callVerb('send_raw', rwCtx(owner.id), {
          networkId: net.id,
          line: 'PRIVMSG #secret :the passphrase is hunter2',
        }),
      ).toEqual({ ok: false, error: 'e2e-channel-use-send-message' });
      expect(conn.sent).toEqual([]);

      // Case-insensitive on the command, and the extra-whitespace form still
      // resolves to the same target.
      expect(
        callVerb('send_raw', rwCtx(owner.id), {
          networkId: net.id,
          line: 'privmsg   #secret   :hi',
        }),
      ).toEqual({ ok: false, error: 'e2e-channel-use-send-message' });
      expect(conn.sent).toEqual([]);
    });

    it('still allows non-PRIVMSG commands and other channels', () => {
      setChannelConfig(owner.id, net.id, {
        channel: '#secret',
        enabled: true,
        mode: 'normal',
      });
      const conn = live();
      // Moderating an E2E channel is not a leak.
      expect(
        callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'MODE #secret +o bob' }),
      ).toMatchObject({ ok: true });
      // A channel with no E2E config is unaffected.
      expect(
        callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'PRIVMSG #open :hi' }),
      ).toMatchObject({ ok: true });
      expect(conn.sent).toEqual(['MODE #secret +o bob', 'PRIVMSG #open :hi']);
    });
  });
});
