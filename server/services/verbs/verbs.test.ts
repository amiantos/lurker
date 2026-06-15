// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { User } from '../../db/users.js';
import type { Network } from '../../db/networks.js';
import type { VerbContext } from '../verbRegistry.js';
import type { ContactRecord } from '../../db/contacts.js';

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

describe('set_contact', () => {
  it('creates a contact, trimming the name and flagging exactly one primary', () => {
    const saved = callVerb('set_contact', rwCtx(owner.id), {
      displayName: '  Alice  ',
      notifyOnline: true,
      targets: [{ networkId: net.id, nick: 'alice_irc' }],
    }) as ContactRecord;
    expect(saved.id).toEqual(expect.any(Number));
    expect(saved.displayName).toBe('Alice');
    expect(saved.notifyOnline).toBe(true);
    expect(saved.targets).toEqual([{ networkId: net.id, nick: 'alice_irc', isPrimary: true }]);
  });

  it('allows multiple nicks on one network, dedupes exact repeats, honors the flagged primary', () => {
    const saved = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Multi',
      notifyOnline: false,
      targets: [
        { networkId: net.id, nick: 'm_one' },
        { networkId: net.id, nick: 'm_one' }, // exact dupe → dropped
        { networkId: net.id, nick: 'm_two', isPrimary: true },
      ],
    }) as ContactRecord;
    expect(saved.targets.map((t) => t.nick).toSorted()).toEqual(['m_one', 'm_two']);
    const primary = saved.targets.filter((t) => t.isPrimary);
    expect(primary).toEqual([{ networkId: net.id, nick: 'm_two', isPrimary: true }]);
  });

  it("filters out targets on networks the caller doesn't own", () => {
    const saved = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Filtered',
      notifyOnline: false,
      targets: [
        { networkId: net.id, nick: 'keep_me' },
        { networkId: otherNet.id, nick: 'drop_me' }, // intruder's network
      ],
    }) as ContactRecord;
    expect(saved.targets).toEqual([{ networkId: net.id, nick: 'keep_me', isPrimary: true }]);
  });

  it('keeps a (network, nick) mapped to at most one contact', () => {
    callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'First Owner',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'shared_x' }],
    });
    const second = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Second Owner',
      notifyOnline: false,
      targets: [
        { networkId: net.id, nick: 'shared_x' }, // already owned → dropped
        { networkId: net.id, nick: 'c2_only' },
      ],
    }) as ContactRecord;
    expect(second.targets).toEqual([{ networkId: net.id, nick: 'c2_only', isPrimary: true }]);
  });

  it('edits an existing contact: new name, notify flag, and replaced targets', () => {
    const created = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Before',
      notifyOnline: true,
      targets: [{ networkId: net.id, nick: 'e_first' }],
    }) as ContactRecord;
    const edited = callVerb('set_contact', rwCtx(owner.id), {
      contactId: created.id,
      displayName: 'After',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'e_second' }],
    }) as ContactRecord;
    expect(edited.id).toBe(created.id);
    expect(edited.displayName).toBe('After');
    expect(edited.notifyOnline).toBe(false);
    expect(edited.targets).toEqual([{ networkId: net.id, nick: 'e_second', isPrimary: true }]);
  });

  it("throws not_found when editing a contact the caller doesn't own", () => {
    const created = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Owned',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'owned_nick' }],
    }) as ContactRecord;
    let caughtErr: unknown;
    try {
      callVerb('set_contact', rwCtx(intruder.id), {
        contactId: created.id,
        displayName: 'Hijacked',
        notifyOnline: false,
        targets: [{ networkId: otherNet.id, nick: 'x' }],
      });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('not_found');
  });

  it('throws invalid_input on empty/whitespace displayName', () => {
    let caughtErr: unknown;
    try {
      callVerb('set_contact', rwCtx(owner.id), {
        displayName: '   ',
        notifyOnline: false,
        targets: [{ networkId: net.id, nick: 'whatever' }],
      });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/displayName/);
  });

  it('is rejected for read-only scope', () => {
    expect(() =>
      callVerb('set_contact', rCtx(owner.id), {
        displayName: 'Nope',
        notifyOnline: false,
        targets: [{ networkId: net.id, nick: 'nope' }],
      }),
    ).toThrow(/scope insufficient/);
  });
});

describe('delete_contact', () => {
  it('deletes an owned contact and is idempotent-by-not_found afterwards', () => {
    const created = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Doomed',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'del_target' }],
    }) as ContactRecord;
    expect(callVerb('delete_contact', rwCtx(owner.id), { contactId: created.id })).toEqual({
      contactId: created.id,
      deleted: true,
    });
    // A second delete now misses — the row (and its targets) is gone.
    let caughtErr: unknown;
    try {
      callVerb('delete_contact', rwCtx(owner.id), { contactId: created.id });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('not_found');
  });

  it('throws not_found for an unknown contactId', () => {
    expect(() => callVerb('delete_contact', rwCtx(owner.id), { contactId: 999999 })).toThrow(
      /contact not found/,
    );
  });

  it("throws not_found when deleting another user's contact", () => {
    const created = callVerb('set_contact', rwCtx(owner.id), {
      displayName: 'Owner Only',
      notifyOnline: false,
      targets: [{ networkId: net.id, nick: 'owner_only' }],
    }) as ContactRecord;
    let caughtErr: unknown;
    try {
      callVerb('delete_contact', rwCtx(intruder.id), { contactId: created.id });
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('not_found');
  });

  it('is rejected for read-only scope', () => {
    expect(() => callVerb('delete_contact', rCtx(owner.id), { contactId: 1 })).toThrow(
      /scope insufficient/,
    );
  });

  it('throws invalid_input when contactId is omitted', () => {
    let caughtErr: unknown;
    try {
      callVerb('delete_contact', rwCtx(owner.id), {});
    } catch (err) {
      caughtErr = err;
    }
    expect((caughtErr as { code?: string }).code).toBe('invalid_input');
    expect((caughtErr as Error).message).toMatch(/contactId/);
  });
});
