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
import { IrcConnection } from './ircConnection.js';
import { BURST_BUDGET_MS, EMPTY_HOLD_MS } from './sendPacer.js';
import type { ReplyClient } from './replyRouter.js';
import { e2eManager } from './e2e/manager.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';

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
      // The umode MODE, the AWAY, then #a's three requests, each waiting its
      // turn.
      expect(lines).toHaveLength(5);
      while (lines.at(-1) !== 'MODE #a') vi.advanceTimersByTime(2000);
      expect(lines.slice(-3)).toEqual(['NAMES #a', 'TOPIC #a', 'MODE #a']);
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

  it('a restore step gives its slot back after the cap, its requests still going later', () => {
    process.env.LURKER_RESTORE_STEP_SLOT_CAP_MS = '100';
    process.env.LURKER_RESTORE_QUIET_MS = '10000';
    try {
      const { conn, lines } = backlog({ join: ['#a', '#b'] });
      const priv = conn as unknown as {
        onEnginePhase(phase: string, info: Record<string, unknown>): void;
        restoreStep: { key: string } | null;
        restoreQuiet: Map<string, { until: number }>;
      };
      priv.onEnginePhase('restored', {});
      expect(priv.restoreStep?.key).toBe('#a');
      // #a's requests wait behind the budget; the cap moves the walk on.
      vi.advanceTimersByTime(100);
      expect(lines).not.toContain('NAMES #a');
      expect(priv.restoreStep?.key).toBe('#b');
      // They still go, and their replies are the restore's: the quiet window
      // moves with the last of them.
      while (lines.at(-1) !== 'MODE #a') vi.advanceTimersByTime(2000);
      // Refreshed at that send (the window set when the restore began, 10 s
      // from then, is long past).
      expect(priv.restoreQuiet.get('#a')?.until).toBeGreaterThan(Date.now() + 9_000);
      conn.dispose();
    } finally {
      delete process.env.LURKER_RESTORE_STEP_SLOT_CAP_MS;
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
    // about the old nick and get a 502.
    const { conn, lines } = backlog();
    (conn as unknown as { requestOwnModes(): void }).requestOwnModes();
    (conn as unknown as { currentNick: string }).currentNick = 'bob';
    vi.advanceTimersByTime(2000);
    expect(lines.at(-1)).toBe('MODE bob');
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
