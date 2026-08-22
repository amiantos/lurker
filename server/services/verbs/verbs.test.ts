// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../../db/users.js';
import type { Network } from '../../db/networks.js';
import type { VerbContext } from '../verbRegistry.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-verbs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../../db/users.js').createUser;
let createNetwork: typeof import('../../db/networks.js').createNetwork;
let insertMessage: typeof import('../../db/messages.js').insertMessage;
let callVerb: typeof import('../verbRegistry.js').callVerb;

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

// The agent-control verbs (send_raw, join/part, nick, away, members). With no
// live IRC connection in the test harness, the connection-bound ones resolve to
// not-connected — so these cover input validation, scope, ownership, and the
// user-wide set_away path (which needs no connection).
describe('agent control verbs', () => {
  it('send_raw: validates line, checks scope + ownership, no-connection path', () => {
    expect(callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: '   ' })).toEqual({
      ok: false,
      error: 'empty-line',
    });
    expect(
      callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'FOO\r\nBAR' }),
    ).toEqual({ ok: false, error: 'line-must-be-single-line' });
    expect(callVerb('send_raw', rwCtx(owner.id), { networkId: net.id, line: 'WHOIS bob' })).toEqual(
      { ok: false, error: 'not-connected' },
    );
    expect(() =>
      callVerb('send_raw', rwCtx(owner.id), { networkId: otherNet.id, line: 'WHOIS bob' }),
    ).toThrow(/unknown network/);
    expect(() => callVerb('send_raw', rCtx(owner.id), { networkId: net.id, line: 'X' })).toThrow(
      /scope insufficient/,
    );
  });

  it('join_channel / part_channel: validate + not-connected', () => {
    expect(callVerb('join_channel', rwCtx(owner.id), { networkId: net.id, channel: ' ' })).toEqual({
      ok: false,
      error: 'empty-channel',
    });
    expect(
      callVerb('join_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x', key: 'k' }),
    ).toEqual({ ok: false, error: 'not-connected' });
    expect(callVerb('part_channel', rwCtx(owner.id), { networkId: net.id, channel: '#x' })).toEqual(
      { ok: false, error: 'not-connected' },
    );
  });

  it('set_nick: rejects whitespace, not-connected otherwise', () => {
    expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'a b' })).toEqual({
      ok: false,
      error: 'nick-must-be-single-token',
    });
    expect(callVerb('set_nick', rwCtx(owner.id), { networkId: net.id, nick: 'newnick' })).toEqual({
      ok: false,
      error: 'not-connected',
    });
  });

  it('set_away: user-wide, reports state, needs no connection', () => {
    expect(callVerb('set_away', rwCtx(owner.id), { message: 'brb' })).toEqual({
      ok: true,
      away: true,
    });
    expect(callVerb('set_away', rwCtx(owner.id), {})).toEqual({ ok: true, away: false });
  });

  it('list_members: read scope, not-connected without a live channel', () => {
    expect(
      callVerb('list_members', rCtx(owner.id), { networkId: net.id, channel: '#chan' }),
    ).toEqual({ ok: false, error: 'not-connected' });
  });
});

// The second batch of agent-control verbs (whois, connect/disconnect, topic,
// dcc). Again, no live connection in the harness — cover validation, scope,
// ownership, and the not-connected paths.
describe('agent control verbs — batch 2', () => {
  it('whois: validates nick, not-connected otherwise', () => {
    expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'a b' })).toEqual({
      ok: false,
      error: 'nick-must-be-single-token',
    });
    expect(callVerb('whois', rwCtx(owner.id), { networkId: net.id, nick: 'bob' })).toMatchObject({
      ok: false,
      error: 'not-connected',
    });
  });

  it('connect_network: read-write + ownership guards (no live start in tests)', () => {
    // Only assert the registry guards, which throw before the handler runs —
    // actually invoking startNetwork would spin up a real connection attempt.
    expect(() => callVerb('connect_network', rCtx(owner.id), { networkId: net.id })).toThrow(
      /scope insufficient/,
    );
    expect(() => callVerb('connect_network', rwCtx(owner.id), { networkId: otherNet.id })).toThrow(
      /unknown network/,
    );
  });

  it('disconnect_network: always ok (no-op when offline)', () => {
    expect(callVerb('disconnect_network', rwCtx(owner.id), { networkId: net.id })).toEqual({
      ok: true,
    });
  });

  it('get_topic / set_topic: validation + not-connected', () => {
    expect(callVerb('get_topic', rCtx(owner.id), { networkId: net.id, channel: '#x' })).toEqual({
      ok: false,
      error: 'not-connected',
    });
    expect(
      callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'a\nb' }),
    ).toEqual({ ok: false, error: 'topic-must-be-single-line' });
    expect(
      callVerb('set_topic', rwCtx(owner.id), { networkId: net.id, channel: '#x', topic: 'hi' }),
    ).toEqual({ ok: false, error: 'not-connected' });
  });
});
