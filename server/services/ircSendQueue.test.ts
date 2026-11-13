// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The outbound queue on a connection (#1149): what each timer that waits on a
// reply does when its line waits behind a backlog, and what a line told it was
// sent does when its socket goes. Each case builds a backlog (five short lines
// fill the 10 s budget; the next waits 2 s) and then does the thing.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { IrcConnection, TYPING_FORGET_MS, TYPING_MIN_GAP_MS } from './ircConnection.js';
import { BURST_BUDGET_MS, EMPTY_HOLD_MS } from './sendPacer.js';
import type { ReplyClient } from './replyRouter.js';
import { e2eManager } from './e2e/manager.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import db from '../db/index.js';
import { invalidateCasemappingCache } from '../db/buffers.js';

beforeAll(() => {
  createUser('queue-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

// Pacing is off for the suite (test-utils/setup.ts); this file is about it.
beforeEach(() => {
  process.env.LURKER_SEND_PACING = '1';
  // The queue keeps time on the monotonic clock.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date', 'performance'],
  });
});
afterEach(() => {
  process.env.LURKER_SEND_PACING = '0';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConn(flood_protection = 1): IrcConnection {
  return new IrcConnection({
    network: {
      flood_protection,
      client_cert: null,
      client_key: null,
      proxy_enabled: 0,
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password: null,
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      casemapping: null,
      user_modes: null,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

interface Wire {
  conn: IrcConnection;
  lines: string[];
  published: Array<Record<string, unknown>>;
  /** The connection's registered flag, as a link drop and a 001 set it. */
  registered(on: boolean): void;
}

// A registered connection with its wire captured, and short lines sent to
// fill the 10 s budget, so the next line waits 2 s. `join` names channels we
// are in; our own JOIN sends a line or two, which count toward the budget.
function backlog(
  opts: { state?: string; join?: string[]; peers?: string[]; flood_protection?: number } = {},
): Wire {
  const conn = makeConn(opts.flood_protection);
  conn.state = opts.state ?? 'connected';
  const lines: string[] = [];
  const published: Array<Record<string, unknown>> = [];
  conn.publish = (event: Record<string, unknown>) => {
    published.push(event);
    return undefined;
  };
  const c = conn.client.connection as unknown as {
    connected: boolean;
    registered: number | false;
    transport: unknown;
  };
  c.connected = true;
  c.registered = Date.now();
  c.transport = { writeLine: (line: string) => lines.push(line) };
  if (opts.join) {
    conn.client.user.nick = 'alice';
    for (const channel of opts.join) {
      conn.client.emit('join', { channel, nick: 'alice' });
      for (const peer of opts.peers ?? []) {
        conn.client.emit('join', {
          channel,
          nick: peer,
          ident: peer[0],
          hostname: `${peer[0]}.host`,
        });
      }
    }
  }
  expect(lines.length).toBeLessThanOrEqual(5);
  for (let i = lines.length; i < 5; i++) conn.say('#fill', `line ${i}`);
  expect(lines).toHaveLength(5);
  return {
    conn,
    lines,
    published,
    registered: (on) => {
      c.registered = on ? Date.now() : false;
    },
  };
}

describe('resume on registration', () => {
  it('sends the held lines once the framework has marked the connection registered', () => {
    const { conn, lines, registered } = backlog();
    conn.say('#c', 'held');
    // The link drops before its turn: the line waits for the next
    // registration, which the real 001 path delivers in the framework's
    // order ('all' first, then the listener that sets `registered`).
    registered(false);
    vi.advanceTimersByTime(2000);
    expect(lines).toHaveLength(5);
    // What the framework's own 'registered' listener reads on a 001.
    (conn.client as unknown as { options: unknown }).options = { ping_interval: 0 };
    conn.client.connection.addReadBuffer(':irc.example.test 001 alice :Welcome');
    // The handler's own lag PING went first and is charged: 2 s more.
    expect(lines).not.toContain('PRIVMSG #c :held');
    vi.advanceTimersByTime(2000);
    expect(lines).toContain('PRIVMSG #c :held');
    conn.dispose();
  });
});

describe('what is made at send time', () => {
  it('addresses a REKEY to the nick the peer has when it goes', () => {
    const { conn, lines } = backlog({ join: ['#x'], peers: ['carol'] });
    vi.spyOn(e2eManager, 'takePendingRekeySends').mockReturnValue([
      { channel: '#x', targetHandle: 'c@c.host', body: 'RPEE2E REKEY v=1 c=#x' },
    ]);
    conn.flushE2eRekeys();
    conn.client.emit('nick', { nick: 'carol', new_nick: 'carol2', ident: 'c', hostname: 'c.host' });
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('NOTICE carol2 :\u0001RPEE2E REKEY v=1 c=#x\u0001');
    conn.dispose();
  });

  it('encrypts an E2E message when its turn comes, REKEYs first, and notes each chunk as it goes', () => {
    const { conn, lines } = backlog({ join: ['#x'], peers: ['carol'] });
    vi.spyOn(e2eManager, 'checkOutgoing').mockReturnValue({ kind: 'ok' });
    const prepare = vi.spyOn(e2eManager, 'prepareOutgoing').mockReturnValue(true);
    const encrypt = vi
      .spyOn(e2eManager, 'encryptOutgoing')
      .mockReturnValue({ kind: 'encrypted', lines: ['+RPE2E01 one', '+RPE2E01 two'] });
    vi.spyOn(e2eManager, 'takePendingRekeySends').mockReturnValue([
      { channel: '#x', targetHandle: 'c@c.host', body: 'RPEE2E REKEY v=1 c=#x' },
    ]);
    const sent: string[] = [];
    conn.sayEncrypted('#x', 'secret', { sent: (t) => sent.push(t) });
    expect(prepare).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    // The key is made and the REKEY goes; the chunks are made only after it.
    expect(prepare).toHaveBeenCalledOnce();
    expect(encrypt).not.toHaveBeenCalled();
    expect(lines.slice(5)).toEqual(['NOTICE carol :\u0001RPEE2E REKEY v=1 c=#x\u0001']);
    expect(conn.consumeSentCiphertext('+RPE2E01 one')).toBe(false);
    vi.advanceTimersByTime(2000);
    // Encrypted now, and the first chunk fits at once.
    expect(encrypt).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toBe('PRIVMSG #x :+RPE2E01 one');
    expect(conn.consumeSentCiphertext('+RPE2E01 one')).toBe(true);
    expect(conn.consumeSentCiphertext('+RPE2E01 two')).toBe(false);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #x :+RPE2E01 two');
    expect(conn.consumeSentCiphertext('+RPE2E01 two')).toBe(true);
    expect(sent).toEqual(['secret']);
    conn.dispose();
  });

  it('puts a REKEY dropped with its socket back for the next send', () => {
    const { conn, lines } = backlog({ join: ['#x'], peers: ['carol'] });
    const send = { channel: '#x', targetHandle: 'c@c.host', body: 'RPEE2E REKEY v=1 c=#x' };
    vi.spyOn(e2eManager, 'takePendingRekeySends').mockReturnValue([send]);
    const putBack = vi.spyOn(e2eManager, 'putBackRekeySend').mockImplementation(() => {});
    conn.flushE2eRekeys();
    // Still waiting its turn: the socket dies.
    expect(lines).toHaveLength(5);
    conn.client.emit('close');
    expect(putBack).toHaveBeenCalledWith(1, 1, send);
    conn.dispose();
  });

  it('reports an E2E message not sent when encryption is off by the time it goes', () => {
    const { conn, lines, published } = backlog();
    // Nothing is prepared for a channel that is off: no key made, no REKEY
    // taken for it (review: a rotation while the message waited would have
    // sent REKEYs for a channel the user had turned off).
    const prepare = vi.spyOn(e2eManager, 'prepareOutgoing').mockReturnValue(true);
    const rekeys = vi.spyOn(e2eManager, 'takePendingRekeySends').mockReturnValue([]);
    vi.spyOn(e2eManager, 'encryptOutgoing').mockReturnValue({ kind: 'disabled' });
    conn.sayEncrypted('#x', 'secret');
    vi.advanceTimersByTime(2000);
    expect(lines).toHaveLength(5);
    expect(prepare).not.toHaveBeenCalled();
    expect(rekeys).not.toHaveBeenCalled();
    expect(published.at(-1)).toMatchObject({
      type: 'error',
      target: '#x',
      text: 'not sent (encryption is off): secret',
    });
    conn.dispose();
  });
});

describe('every timer starts at send', () => {
  function client(): ReplyClient & { aborted: string[]; replies: string[] } {
    return {
      aborted: [],
      replies: [],
      replyFromCache() {},
      replyAborted(numeric) {
        this.aborted.push(numeric);
      },
      onReply(command) {
        this.replies.push(command);
      },
    };
  }

  it("a query's timeout, and its claim on replies, count from when it went", () => {
    const { conn, lines } = backlog();
    const asker = client();
    conn.raw('WHOIS bob', asker);
    expect(lines).toHaveLength(5);
    // A 311 for bob before the WHOIS has gone is nobody's: not this query's.
    conn.client.connection.addReadBuffer(':irc.example.test 311 alice bob b b.host * :Bob');
    expect(asker.replies).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('WHOIS bob');
    conn.client.connection.addReadBuffer(':irc.example.test 311 alice bob b b.host * :Bob');
    expect(asker.replies).toEqual(['311']);
    // 30 s of silence from the send, not from the write.
    vi.advanceTimersByTime(29_000);
    expect(asker.aborted).toEqual([]);
    vi.advanceTimersByTime(1001);
    expect(asker.aborted).toEqual(['318']);
    conn.dispose();
  });

  it('a WAIT between connect commands holds from when the line before it went', () => {
    const { conn, lines } = backlog();
    conn.network.connect_commands = 'PRIVMSG NickServ :IDENTIFY pw\nWAIT 5\nJOIN #a';
    conn.runConnectCommands();
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG NickServ :IDENTIFY pw');
    // Only the connect commands wait on it; a line of the user's goes on.
    conn.say('#c', 'meanwhile');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #c :meanwhile');
    vi.advanceTimersByTime(2999);
    expect(lines.at(-1)).toBe('PRIVMSG #c :meanwhile');
    vi.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('JOIN #a');
    conn.dispose();
  });

  it('what the registered handler itself writes is charged, its connect commands ahead of held chat', () => {
    // Our 'registered' handler runs before the framework marks the connection
    // registered, so without its own flag the connect commands it runs would
    // bypass the queue and go uncharged. They go in the high lane, ahead of
    // the chat that was held (sendPacer.ts).
    const { conn, lines, registered } = backlog();
    conn.say('#c', 'held');
    registered(false);
    vi.advanceTimersByTime(2000);
    conn.network.connect_commands = 'PRIVMSG NickServ :IDENTIFY pw\nWAIT 5\nJOIN #a';
    (conn.client as unknown as { options: unknown }).options = { ping_interval: 0 };
    conn.client.connection.addReadBuffer(':irc.example.test 001 alice :Welcome');
    // The handler's lag PING went at once (unpaced, charged); nothing else
    // did: the IDENTIFY queued, in the high lane, ahead of the held chat.
    expect(lines.at(-1)).toMatch(/^PING lurker-lag-/);
    vi.advanceTimersByTime(1999);
    expect(lines).not.toContain('PRIVMSG NickServ :IDENTIFY pw');
    vi.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('PRIVMSG NickServ :IDENTIFY pw');
    // Charged: the held line goes 2 s later, not at once.
    vi.advanceTimersByTime(1999);
    expect(lines).not.toContain('PRIVMSG #c :held');
    vi.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('PRIVMSG #c :held');
    // The JOIN 5 s after the IDENTIFY went.
    vi.advanceTimersByTime(2999);
    expect(lines).not.toContain('JOIN #a');
    vi.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('JOIN #a');
    conn.dispose();
  });

  it('the kept user modes go ahead of the connect commands, under the nick of the moment', () => {
    // #1181: a connect command can still override a kept mode, and a NICK
    // that went first (a regain) doesn't leave the MODE naming the old nick.
    const { conn, lines, registered } = backlog();
    registered(false);
    conn.network.user_modes = '+g';
    conn.network.connect_commands = 'MODE alice -g';
    (conn.client as unknown as { options: unknown }).options = { ping_interval: 0 };
    conn.client.connection.addReadBuffer(':irc.example.test 001 alice :Welcome');
    conn.currentNick = 'alice2';
    vi.advanceTimersByTime(20_000);
    const modes = lines.filter((l) => l.startsWith('MODE '));
    expect(modes).toEqual(['MODE alice2 +g', 'MODE alice -g']);
    conn.dispose();
  });

  it("a restore step's deadline and quiet window count from its last request", () => {
    process.env.LURKER_RESTORE_STEP_DEADLINE_MS = '50';
    process.env.LURKER_RESTORE_QUIET_MS = '10000';
    try {
      const { conn, lines } = backlog({ join: ['#a', '#b'] });
      const priv = conn as unknown as {
        onEnginePhase(phase: string, info: Record<string, unknown>): void;
        restoreStep: { key: string } | null;
        restoreQuiet: Map<string, { until: number }>;
      };
      priv.onEnginePhase('restored', {});
      // The umode MODE goes at once (unpaced); the AWAY waits its turn on the
      // spent budget, and #a's three requests, unpaced themselves, wait behind
      // it in the lane and go with it.
      expect(lines).toHaveLength(6);
      expect(lines.at(-1)).toBe('MODE alice');
      vi.advanceTimersByTime(2000);
      expect(lines.slice(-4)).toEqual(['AWAY', 'NAMES #a', 'TOPIC #a', 'MODE #a']);
      // The deadline has not run from the start of the step: it is #a's still.
      expect(priv.restoreStep?.key).toBe('#a');
      expect(priv.restoreQuiet.get('#a')?.until).toBe(Date.now() + 10_000);
      vi.advanceTimersByTime(50);
      expect(priv.restoreStep?.key).toBe('#b');
      conn.dispose();
    } finally {
      delete process.env.LURKER_RESTORE_STEP_DEADLINE_MS;
      delete process.env.LURKER_RESTORE_QUIET_MS;
    }
  });

  it('a restore step gives its slot back after the cap, and waits for its own requests to go', () => {
    process.env.LURKER_RESTORE_STEP_SLOT_CAP_MS = '100';
    process.env.LURKER_RESTORE_STEP_DEADLINE_MS = '500';
    process.env.LURKER_RESTORE_QUIET_MS = '10000';
    try {
      const { conn, lines } = backlog({ join: ['#a', '#b'] });
      const priv = conn as unknown as {
        onEnginePhase(phase: string, info: Record<string, unknown>): void;
        restoreStep: { key: string } | null;
        restoreSlot: object | null;
        restoreQuiet: Map<string, { until: number }>;
      };
      // A paste ahead of the walk in the queue: six more lines on a spent budget.
      for (let i = 0; i < 6; i++) conn.say('#fill', `paste ${i}`);
      priv.onEnginePhase('restored', {});
      expect(priv.restoreStep?.key).toBe('#a');
      expect(priv.restoreSlot).not.toBeNull();
      // #a's requests wait behind the paste; the cap gives the shared slot
      // back, but the walk stays on #a — a second channel's requests queued
      // now would go with #a's in one burst once the paste cleared.
      vi.advanceTimersByTime(100);
      expect(lines).not.toContain('NAMES #a');
      expect(priv.restoreSlot).toBeNull();
      expect(priv.restoreStep?.key).toBe('#a');
      // The six pasted lines and the AWAY ahead in the low lane, 2 s each;
      // #a's requests go with the AWAY, unpaced.
      vi.advanceTimersByTime(7 * 2000);
      // Nothing of #b's walk yet (its join-time MODE is the join's, not the walk's).
      expect(lines.filter((l) => /^(NAMES|TOPIC) #b$/.test(l))).toEqual([]);
      expect(lines.slice(-3)).toEqual(['NAMES #a', 'TOPIC #a', 'MODE #a']);
      // Their replies are the restore's: the quiet window moves with the last
      // of them (the window set when the restore began, 10 s from then, is past).
      expect(priv.restoreQuiet.get('#a')?.until).toBeGreaterThan(Date.now() + 9_000);
      // Unanswered, the deadline moves the walk on to #b, under a new slot.
      vi.advanceTimersByTime(500);
      expect(priv.restoreStep?.key).toBe('#b');
      expect(priv.restoreSlot).not.toBeNull();
      conn.dispose();
    } finally {
      delete process.env.LURKER_RESTORE_STEP_SLOT_CAP_MS;
      delete process.env.LURKER_RESTORE_STEP_DEADLINE_MS;
      delete process.env.LURKER_RESTORE_QUIET_MS;
    }
  });

  it('a send is attributed a rejection only once it has gone', () => {
    const { conn, lines, published } = backlog();
    conn.say('bob', 'hi');
    expect(conn.recentUserSend('bob')).toBe(false);
    conn.client.emit('irc error', { error: 'cannot_send_to_user', nick: 'bob', reason: 'nope' });
    expect(published.some((e) => e.type === 'error' && e.target === 'bob')).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG bob :hi');
    expect(conn.recentUserSend('bob')).toBe(true);
    conn.client.emit('irc error', { error: 'cannot_send_to_user', nick: 'bob', reason: 'nope' });
    expect(published.some((e) => e.type === 'error' && e.target === 'bob')).toBe(true);
    conn.dispose();
  });

  it('a bare CTCP PING carries the time it went, so the reply reads as a round trip', () => {
    const { conn, lines } = backlog();
    conn.publishEphemeral = () => {};
    const wrote = Date.now();
    conn.sendCtcpRequest('#c', 'bob', 'PING', '');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe(`PRIVMSG bob :\u0001PING ${wrote + 2000}\u0001`);
    conn.dispose();
  });

  it("a command's claim on a 401 is the wire's order, not the queue's", () => {
    const { conn, lines, published } = backlog();
    conn.upsertChannel('#anime');
    conn.say('bob', 'you there?');
    conn.raw('KICK #anime bob');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG bob :you there?');
    // The message went, the kick is still queued: a 401 now answers the message.
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });
    expect(published.some((e) => e.type === 'error' && e.target === '#anime')).toBe(false);
    conn.dispose();
  });
});

describe('units', () => {
  it('sends a draft/multiline batch back to back and charges for it after', () => {
    const { conn, lines } = backlog();
    vi.spyOn(conn, 'multilineLimits').mockReturnValue({ maxBytes: 4096, maxLines: 100 });
    conn.sendMultiline('#c', 'a\nb\nc');
    conn.say('#c', 'after');
    vi.advanceTimersByTime(2000);
    const batch = lines.slice(5);
    expect(batch[0]).toMatch(/^BATCH \+\w+ draft\/multiline #c$/);
    expect(batch.slice(1, 4).map((l) => l.replace(/^@batch=\w+ /, ''))).toEqual([
      'PRIVMSG #c :a',
      'PRIVMSG #c :b',
      'PRIVMSG #c :c',
    ]);
    expect(batch[4]).toMatch(/^BATCH -\w+$/);
    expect(batch).toHaveLength(5);
    // Five lines, 10 s: the line after waits for all of it.
    vi.advanceTimersByTime(9999);
    expect(lines).toHaveLength(10);
    vi.advanceTimersByTime(1);
    expect(lines.at(-1)).toBe('PRIVMSG #c :after');
    conn.dispose();
  });
});

describe('what the user sees', () => {
  it('reports a line dropped with its socket in the buffer it was for', () => {
    const { conn, published } = backlog();
    conn.say('#c', 'going');
    conn.action('bob', 'waves');
    conn.raw('PRIVMSG carol :typed raw');
    conn.client.emit('close');
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ target: '#c', text: 'not sent (connection dropped): going' }),
      expect.objectContaining({ target: 'bob', text: 'not sent (connection dropped): /me waves' }),
      expect.objectContaining({
        target: ':server:1',
        text: 'not sent (connection dropped): PRIVMSG carol :typed raw',
      }),
    ]);
    conn.dispose();
  });

  it('reports a line typed after /disconnect as not sent, rather than writing it behind the QUIT', () => {
    // #1259. The framework drops a line in silence once its QUIT has gone,
    // and the one that squeezes out first reaches a server that has already
    // read the QUIT. Neither arrives; both used to be called sent.
    const { conn, lines, published } = backlog();
    conn.disconnect();
    expect(lines.at(-1)).toMatch(/^QUIT\b/);
    // Both wait behind the budget. The first is refused at its turn and told;
    // the drain stops there, and the second is told once, at the close.
    conn.say('#c', 'late');
    conn.raw('PRIVMSG carol :late raw');
    vi.advanceTimersByTime(2000);
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ target: '#c', text: 'not sent (connection dropped): late' }),
    ]);
    vi.advanceTimersByTime(10_000);
    expect(published.filter((e) => e.type === 'error')).toHaveLength(1);
    conn.client.emit('close');
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ target: '#c', text: 'not sent (connection dropped): late' }),
      expect.objectContaining({
        target: ':server:1',
        text: 'not sent (connection dropped): PRIVMSG carol :late raw',
      }),
    ]);
    expect(lines.filter((l) => l.includes('late'))).toEqual([]);
    conn.dispose();
  });

  it('reports what was still waiting when the app lets go of an engine-held socket', () => {
    // An engine-mode shutdown detaches; the socket lives on in the engine but
    // the queue dies with this process, so its lines are reported, not lost.
    const { conn, published } = backlog();
    conn.say('#c', 'held');
    conn.detach();
    expect(published).toContainEqual(
      expect.objectContaining({
        type: 'error',
        target: '#c',
        text: 'not sent (connection dropped): held',
      }),
    );
    conn.dispose();
  });

  it('reports what was still waiting when the connection is disposed', () => {
    const { conn, published } = backlog();
    conn.say('#c', 'going');
    conn.dispose();
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ target: '#c', text: 'not sent (connection dropped): going' }),
    ]);
  });

  it('publishes the queue depth as it changes, and carries it on the snapshot', () => {
    const { conn, published } = backlog();
    conn.say('#c', 'one');
    conn.say('#c', 'two');
    vi.advanceTimersByTime(1);
    expect(published.at(-1)).toMatchObject({ type: 'send-queue', waiting: 2 });
    expect(conn.snapshot().sendQueueWaiting).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(published.at(-1)).toMatchObject({ type: 'send-queue', waiting: 1 });
    vi.advanceTimersByTime(2000);
    // The last line went; empty is reported once it has stayed empty 2 s, so
    // a walk that sends one line at a time doesn't blink.
    expect(published.at(-1)).toMatchObject({ type: 'send-queue', waiting: 1 });
    vi.advanceTimersByTime(EMPTY_HOLD_MS);
    expect(published.at(-1)).toMatchObject({ type: 'send-queue', waiting: 0 });
    expect(conn.snapshot().sendQueueWaiting).toBe(0);
    conn.dispose();
  });
});

describe('an engine restore', () => {
  it('keeps a held NICK waiting while the transport would swallow it, whatever is written meanwhile', () => {
    // The replayed 001 registers the Client, so ready() is true; what the
    // replayed 005 makes the connection write (the MONITOR seed) must not
    // drain a held NICK into the swallowing transport. What waits behind the
    // NICK waits with it.
    const { conn, lines } = backlog();
    conn.raw('NICK bob', 'user');
    conn.say('#c', 'held');
    (conn as unknown as { restoring: boolean }).restoring = true;
    vi.advanceTimersByTime(2000);
    expect(lines).toHaveLength(5);
    conn.raw('MONITOR + bob', 'lurker');
    vi.advanceTimersByTime(4000);
    expect(lines).toHaveLength(5);
    (conn as unknown as { restoring: boolean }).restoring = false;
    (conn as unknown as { sendPacer: { resume(): void } }).sendPacer.resume();
    expect(lines.slice(5)).toEqual(['NICK bob', 'PRIVMSG #c :held']);
    conn.dispose();
  });

  it('sends what the transport passes during a restore: the replay reconciles with PARTs', () => {
    const { conn, lines } = backlog();
    (conn as unknown as { restoring: boolean }).restoring = true;
    conn.part('#c');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PART #c');
    conn.dispose();
  });
});

describe('lanes', () => {
  it("the autojoin's JOIN goes ahead of chat waiting; a user's /join waits its turn", () => {
    const { conn, lines } = backlog();
    conn.say('#c', 'one');
    conn.join('#auto', undefined, 'high');
    conn.join('#mine');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('JOIN #auto');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #c :one');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('JOIN #mine');
    conn.dispose();
  });

  it('the presence list rebuilt on a re-attach waits behind what the user says', () => {
    const { conn, lines } = backlog();
    (conn as unknown as { monitor: { sync(n: string[], l: number): unknown } }).monitor.sync(
      ['bob'],
      10,
    );
    conn.say('#c', 'hi');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #c :hi');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('MONITOR + bob');
    conn.dispose();
  });

  it("the restore's own MODE asks about the nick we have when it goes", () => {
    // A NICK goes ahead of it (the high lane); built at write it would ask
    // about the old nick and get a 502. Unpaced, it goes at once when nothing
    // is ahead of it, with the nick we have then; behind a NICK waiting on the
    // budget, it goes after it, with the nick that NICK asked for.
    const { conn, lines } = backlog();
    conn.raw('NICK bob');
    (conn as unknown as { requestOwnModes(): void }).requestOwnModes();
    (conn as unknown as { currentNick: string }).currentNick = 'bob';
    expect(lines).toHaveLength(5);
    vi.advanceTimersByTime(2000);
    expect(lines.slice(-2)).toEqual(['NICK bob', 'MODE bob']);
    conn.dispose();
  });

  it('an auto-KEYREQ that never goes says so: no body, or dropped', () => {
    const { conn } = backlog();
    type Thunk = (
      n: string,
      k: string,
      c: string,
      b: () => string | null,
      to: undefined,
      nothingSent: () => void,
    ) => void;
    const send = (conn as unknown as { sendHandshakeThunk: Thunk }).sendHandshakeThunk.bind(conn);
    const said: string[] = [];
    send(
      'carol',
      'KEYREQ',
      '#x',
      () => null,
      undefined,
      () => said.push('no body'),
    );
    vi.advanceTimersByTime(2000);
    expect(said).toEqual(['no body']);
    // Behind the budget again, so it waits, and goes with the socket.
    conn.say('#c', 'one');
    conn.say('#c', 'two');
    send(
      'dave',
      'KEYREQ',
      '#x',
      () => 'RPEE2E KEYREQ v=1',
      undefined,
      () => said.push('dropped'),
    );
    conn.client.emit('close');
    expect(said).toEqual(['no body', 'dropped']);
    conn.dispose();
  });

  it('a NOTICE or a /me never arms an XDCC request; a PRIVMSG does', () => {
    const { conn } = backlog();
    const arm = vi
      .spyOn(conn as unknown as { maybeArmDcc(t: string, x: string): void }, 'maybeArmDcc')
      .mockImplementation(() => {});
    conn.notice('bot', 'xdcc send #5');
    conn.action('bot', 'xdcc send #5');
    vi.advanceTimersByTime(4000);
    expect(arm).not.toHaveBeenCalled();
    conn.say('bot', 'xdcc send #5');
    vi.advanceTimersByTime(2000);
    expect(arm).toHaveBeenCalledWith('bot', 'xdcc send #5');
    conn.dispose();
  });

  it('an auto-KEYREQ goes to the nick its peer has when it goes', () => {
    const { conn, lines } = backlog();
    let nick: string | null = 'carol';
    (
      conn as unknown as {
        sendHandshakeThunk(
          n: string,
          k: string,
          c: string,
          b: () => string,
          to: () => string | null,
        ): void;
      }
    ).sendHandshakeThunk(
      'carol',
      'KEYREQ',
      '#x',
      () => 'RPEE2E KEYREQ v=1',
      () => nick,
    );
    nick = 'carol2';
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('NOTICE carol2 :\x01RPEE2E KEYREQ v=1\x01');
    conn.dispose();
  });

  it("Lurker's own MODE after a join waits behind what the user says", () => {
    const { conn, lines } = backlog();
    conn.client.user.nick = 'alice';
    conn.client.emit('join', { channel: '#x', nick: 'alice' });
    conn.say('#c', 'hi');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #c :hi');
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('MODE #x');
    conn.dispose();
  });
});

describe('handshake replies', () => {
  it('caps the replies waiting, dropping the oldest, and never a REKEY', () => {
    const peers = Array.from({ length: 25 }, (_, i) => `p${i}`);
    const { conn, lines } = backlog({ join: ['#x'], peers });
    for (let i = 0; i < 25; i++)
      conn.sendHandshakeReply(`peer${i}`, `RPEE2E KEYRSP v=1 c=#x n=${i}`);
    vi.spyOn(e2eManager, 'takePendingRekeySends').mockReturnValue(
      peers.map((p) => ({
        channel: '#x',
        targetHandle: `${p[0]}@${p[0]}.host`,
        body: `RPEE2E REKEY v=1 c=#x n=${p}`,
      })),
    );
    conn.flushE2eRekeys();
    vi.advanceTimersByTime(2000 * 60);
    const replies = lines.filter((l) => l.includes('KEYRSP'));
    const rekeys = lines.filter((l) => l.includes('REKEY'));
    expect(replies).toHaveLength(20);
    expect(replies[0]).toContain('peer5 ');
    expect(rekeys).toHaveLength(25);
    conn.dispose();
  });
});

describe('flood protection off (#1193)', () => {
  it('sends a burst at once on a network the user turned it off for, and reports nothing waiting', () => {
    const { conn, lines, published } = backlog({ flood_protection: 0 });
    for (let i = 0; i < 10; i++) conn.say('#c', `burst ${i}`);
    expect(lines).toHaveLength(15);
    expect(lines.at(-1)).toBe('PRIVMSG #c :burst 9');
    vi.advanceTimersByTime(EMPTY_HOLD_MS);
    expect(published.filter((e) => e.type === 'send-queue' && e.waiting !== 0)).toEqual([]);
    conn.dispose();
  });

  it('turned off while lines wait, the edit applies to them at once', () => {
    const { conn, lines } = backlog();
    conn.say('#c', 'waiting');
    conn.say('#c', 'too');
    expect(lines).toHaveLength(5);
    conn.networkEdited({ ...conn.network, flood_protection: 0 });
    expect(lines.slice(-2)).toEqual(['PRIVMSG #c :waiting', 'PRIVMSG #c :too']);
    expect(conn.network.flood_protection).toBe(0);
    // Turned back on, the next burst is paced again. What the backlog was
    // charged before the flip still stands (the server may have counted it),
    // so once that has decayed five go and the sixth waits.
    conn.networkEdited({ ...conn.network, flood_protection: 1 });
    vi.advanceTimersByTime(BURST_BUDGET_MS);
    for (let i = 0; i < 6; i++) conn.say('#c', `again ${i}`);
    expect(lines).toHaveLength(12);
    vi.advanceTimersByTime(2000);
    expect(lines).toHaveLength(13);
    conn.dispose();
  });

  it('an edit that leaves protection as it was changes nothing about a wait', () => {
    const { conn, lines } = backlog();
    conn.say('#c', 'waiting');
    conn.networkEdited({ ...conn.network, flood_protection: 1, nick: 'renamed' });
    expect(lines).toHaveLength(5);
    vi.advanceTimersByTime(2000);
    expect(lines).toHaveLength(6);
    conn.dispose();
  });
});

describe('taking back what waits (#1322)', () => {
  it("/flushq drops the user's waiting messages, marks each not sent, and keeps Lurker's own lines", () => {
    const { conn, lines, published } = backlog();
    conn.say('#c', 'one');
    conn.action('bob', 'waves');
    vi.spyOn(conn, 'multilineLimits').mockReturnValue({ maxBytes: 4096, maxLines: 100 });
    conn.sendMultiline('#c', 'a\nb');
    const replies = (
      conn as unknown as { replies: { send: (asker: 'lurker', line: string) => void } }
    ).replies;
    replies.send('lurker', 'AWAY :gone');
    expect(conn.flushSendQueue()).toBe(3);
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ target: '#c', text: 'not sent (send queue cleared): one' }),
      expect.objectContaining({ target: 'bob', text: 'not sent (send queue cleared): /me waves' }),
      expect.objectContaining({ target: '#c', text: 'not sent (send queue cleared): a\nb' }),
    ]);
    vi.advanceTimersByTime(30_000);
    expect(lines.slice(5)).toEqual(['AWAY :gone']);
    expect(conn.flushSendQueue()).toBe(0);
    conn.dispose();
  });

  it('drops what waits for a channel we are kicked from, and nothing else', () => {
    const { conn, lines, published } = backlog({ join: ['#c', '#d'] });
    conn.say('#C', 'to the channel');
    conn.say('#d', 'elsewhere');
    conn.client.emit('kick', { channel: '#c', nick: 'op', kicked: 'alice', message: 'out' });
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({
        target: '#C',
        text: 'not sent (no longer in the channel): to the channel',
      }),
    ]);
    vi.advanceTimersByTime(30_000);
    expect(lines).toContain('PRIVMSG #d :elsewhere');
    expect(lines).not.toContain('PRIVMSG #C :to the channel');
    conn.dispose();
  });

  it("drops a line to the channel's ops (STATUSMSG) with it", () => {
    const { conn, lines, published } = backlog({ join: ['#c'] });
    conn.say('@#c', 'ops only');
    conn.client.emit('kick', { channel: '#c', nick: 'op', kicked: 'alice', message: 'out' });
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ text: 'not sent (no longer in the channel): ops only' }),
    ]);
    vi.advanceTimersByTime(30_000);
    expect(lines).not.toContain('PRIVMSG @#c :ops only');
    conn.dispose();
  });

  it('drops them on a PART we did not send, too', () => {
    const { conn, lines, published } = backlog({ join: ['#c'] });
    conn.say('#c', 'too late');
    conn.client.emit('part', { channel: '#c', nick: 'alice' });
    expect(published.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ text: 'not sent (no longer in the channel): too late' }),
    ]);
    vi.advanceTimersByTime(30_000);
    expect(lines).not.toContain('PRIVMSG #c :too late');
    conn.dispose();
  });

  it('keeps what waits behind a PART of our own: a /cycle, then a line', () => {
    const { conn, lines, published } = backlog({ join: ['#c'] });
    conn.part('#c');
    conn.join('#c');
    conn.say('#c', 'back');
    // The PART goes at its turn, and its echo comes back before the JOIN's.
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toMatch(/^PART #c/);
    conn.client.emit('part', { channel: '#c', nick: 'alice' });
    expect(published.filter((e) => e.type === 'error')).toEqual([]);
    vi.advanceTimersByTime(30_000);
    expect(lines).toContain('PRIVMSG #c :back');
    conn.dispose();
  });

  it('leaves the queue alone when someone else is kicked', () => {
    const { conn, lines } = backlog({ join: ['#c'], peers: ['bob'] });
    conn.say('#c', 'still going');
    conn.client.emit('kick', { channel: '#c', nick: 'op', kicked: 'bob', message: 'out' });
    vi.advanceTimersByTime(2000);
    expect(lines).toContain('PRIVMSG #c :still going');
    conn.dispose();
  });
});

describe('typing notifications (#1301)', () => {
  // A registered connection that speaks message-tags, in #c and #d, its
  // budget unspent.
  function typist(join = ['#c', '#d']): Wire & { typing(): string[] } {
    const wire = backlog({ join });
    (wire.conn.client as unknown as { network: { cap: { enabled: string[] } } }).network = {
      cap: { enabled: ['message-tags'] },
    };
    vi.advanceTimersByTime(BURST_BUDGET_MS);
    wire.lines.length = 0;
    return { ...wire, typing: () => wire.lines.filter((l) => l.includes('TAGMSG')) };
  }

  it('typing a letter and erasing it, over and over, sends one line and holds nothing up', () => {
    const { conn, lines, typing, published } = typist();
    for (let i = 0; i < 20; i++) {
      conn.sendTyping('#c', 'active');
      conn.sendTyping('#c', 'done');
    }
    expect(typing()).toEqual(['@+typing=active TAGMSG #c']);
    // The message goes at once: nothing waits ahead of it.
    conn.say('#c', 'hello');
    expect(lines.at(-1)).toBe('PRIVMSG #c :hello');
    // The message ended the typing for its readers; no `done` follows it.
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 3);
    expect(typing()).toHaveLength(1);
    expect(published.filter((e) => e.type === 'send-queue' && e.waiting)).toEqual([]);
    conn.dispose();
  });

  it('carries the newest state once the gap has passed, and only that one', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'done');
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'done');
    expect(typing()).toHaveLength(1);
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS - 1);
    expect(typing()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(typing()).toEqual(['@+typing=active TAGMSG #c', '@+typing=done TAGMSG #c']);
    // Nothing further is owed.
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 3);
    expect(typing()).toHaveLength(2);
    conn.dispose();
  });

  it('keeps the gap after a done: typing and erasing at leisure is one line per gap', () => {
    const { conn, lines, typing } = typist();
    // A word, erased a second later, the next begun a tenth of a second
    // after the `done` went: for a minute.
    conn.sendTyping('#c', 'active');
    for (let t = 0; t < 60_000; t += 3100) {
      vi.advanceTimersByTime(1000);
      conn.sendTyping('#c', 'done');
      vi.advanceTimersByTime(2100);
      conn.sendTyping('#c', 'active');
    }
    const sent = typing();
    expect(sent.length).toBeLessThanOrEqual(22);
    // No two closer than the gap would allow in a minute, and the message
    // typed at the end of it goes at once.
    const before = lines.length;
    conn.say('#c', 'one');
    conn.say('#c', 'two');
    conn.say('#c', 'three');
    expect(lines.slice(before)).toEqual([
      'PRIVMSG #c :one',
      'PRIVMSG #c :two',
      'PRIVMSG #c :three',
    ]);
    conn.dispose();
  });

  it('an active right after a done was sent still waits out the gap', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'done');
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS);
    expect(typing()).toHaveLength(2);
    conn.sendTyping('#c', 'active');
    expect(typing()).toHaveLength(2);
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS - 1);
    expect(typing()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(typing()).toHaveLength(3);
    conn.dispose();
  });

  it('never sends a done to a target that was not told we were typing', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'done');
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
    expect(typing()).toEqual([]);
    conn.dispose();
  });

  it('keeps each target to its own gap', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#d', 'active');
    expect(typing()).toEqual(['@+typing=active TAGMSG #c', '@+typing=active TAGMSG #d']);
    conn.dispose();
  });

  it('keeps one target to one gap under every spelling the network folds together', () => {
    // An rfc1459 network: [ ] fold to { }.
    db.prepare('UPDATE networks SET casemapping = ? WHERE id = 1').run('rfc1459');
    invalidateCasemappingCache(1);
    try {
      const { conn, lines, typing } = typist(['#c', '#[x]']);
      conn.sendTyping('#[x]', 'active');
      conn.sendTyping('#{X}', 'paused');
      expect(typing()).toEqual(['@+typing=active TAGMSG #[x]']);
      // And a message under one spelling takes back the typing owed under
      // the other.
      conn.say('#[x]', 'hello');
      vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
      expect(typing()).toHaveLength(1);
      expect(lines.at(-1)).toBe('PRIVMSG #[x] :hello');
      conn.dispose();
    } finally {
      db.prepare('UPDATE networks SET casemapping = NULL WHERE id = 1').run();
      invalidateCasemappingCache(1);
    }
  });

  it('a minute of typing in fits and starts leaves the budget for the message', () => {
    const { conn, lines, typing } = typist();
    // A few keys, a three-second pause, a few more: the web client reports
    // `active` at the first key and `paused` three seconds after the last.
    for (let i = 0; i < 20; i++) {
      conn.sendTyping('#c', 'active');
      vi.advanceTimersByTime(3000);
      conn.sendTyping('#c', 'paused');
      vi.advanceTimersByTime(100);
    }
    // One line per gap at most (as reported: 40 lines in 62 s).
    expect(typing().length).toBeLessThanOrEqual(21);
    const before = lines.length;
    conn.say('#c', 'one');
    conn.say('#c', 'two');
    conn.say('#c', 'three');
    expect(lines.slice(before)).toEqual([
      'PRIVMSG #c :one',
      'PRIVMSG #c :two',
      'PRIVMSG #c :three',
    ]);
    conn.dispose();
  });

  it('behind a backlog, the message takes back the typing queued ahead of it, at no cost', () => {
    const { conn, lines, typing } = typist();
    for (let i = 0; i < 5; i++) conn.say('#fill', `line ${i}`);
    conn.sendTyping('#c', 'active');
    expect(typing()).toEqual([]);
    conn.say('#c', 'hello');
    // The message goes when the first line would have: the typing ahead of
    // it had nothing left to say, and cost nothing.
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('PRIVMSG #c :hello');
    vi.advanceTimersByTime(BURST_BUDGET_MS);
    expect(typing()).toEqual([]);
    conn.dispose();
  });

  it('takes back a line already made, when the message is written while it waits for the clock', () => {
    // A long channel name: its line costs 3 s, so it is made when 2 s would
    // fit and then waits a second more.
    const long = `#${'x'.repeat(90)}`;
    const { conn, lines, typing } = typist(['#c', long]);
    for (let i = 0; i < 5; i++) conn.say('#fill', `line ${i}`);
    conn.sendTyping(long, 'active');
    vi.advanceTimersByTime(2000);
    expect(typing()).toEqual([]);
    conn.say(long, 'hello');
    vi.advanceTimersByTime(BURST_BUDGET_MS);
    expect(typing()).toEqual([]);
    expect(lines.at(-1)).toBe(`PRIVMSG ${long} :hello`);
    conn.dispose();
  });

  it('a burst of reports arriving at once (a stalled event loop) is one line', () => {
    const { conn, typing } = typist();
    for (const state of ['active', 'paused', 'active', 'paused', 'active', 'paused', 'active'])
      conn.sendTyping('nick', state);
    expect(typing()).toEqual(['@+typing=active TAGMSG nick']);
    // The newest report was another `active`: sent when the gap allows, which
    // keeps the reader's six-second indicator alive.
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS);
    expect(typing()).toHaveLength(2);
    conn.dispose();
  });

  it('a done still waiting out its gap is not sent to a channel we have left', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'done');
    conn.client.emit('part', { channel: '#c', nick: 'alice' });
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
    expect(typing()).toEqual(['@+typing=active TAGMSG #c']);
    conn.dispose();
  });

  it('sends nothing, and records nothing as told, while the connection is not registered', () => {
    const { conn, typing, registered } = typist();
    registered(false);
    conn.sendTyping('#c', 'active');
    registered(true);
    // Nobody was told: a `done` now has no news.
    conn.sendTyping('#c', 'done');
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
    expect(typing()).toEqual([]);
    conn.dispose();
  });

  it('a state waiting out its gap is dropped if the link goes meanwhile, not sent into it', () => {
    const { conn, typing, registered } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'paused');
    registered(false);
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS);
    registered(true);
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
    expect(typing()).toEqual(['@+typing=active TAGMSG #c']);
    conn.dispose();
  });

  it('a report the gate refuses takes back the state an earlier report left owed', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c', 'active');
    conn.sendTyping('#c', 'paused');
    // The server refuses our lines to #c; the composer is then emptied.
    conn.unsendableTargets.add('#c');
    conn.sendTyping('#c', 'done');
    conn.unsendableTargets.delete('#c');
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS * 2);
    expect(typing()).toEqual(['@+typing=active TAGMSG #c']);
    conn.dispose();
  });

  it('forgets a target once nothing has been owed it for a while', () => {
    const { conn } = typist();
    const records = () => (conn as unknown as { typingOut: Map<string, unknown> }).typingOut.size;
    conn.sendTyping('#c', 'active');
    conn.say('#c', 'hello');
    conn.sendTyping('#d', 'active');
    conn.sendTyping('#d', 'done');
    expect(records()).toBe(2);
    vi.advanceTimersByTime(TYPING_MIN_GAP_MS + TYPING_FORGET_MS);
    expect(records()).toBe(0);
    conn.dispose();
  });

  it('refuses a target that is not one target', () => {
    const { conn, typing } = typist();
    conn.sendTyping('#c\r\nQUIT', 'active');
    conn.sendTyping('#c #d', 'active');
    conn.sendTyping('#c,#d', 'active');
    conn.sendTyping('#c', 'bogus');
    expect(typing()).toEqual([]);
    conn.dispose();
  });
});
