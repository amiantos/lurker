// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine-backed transport under a real irc-framework Client, against a real
// engine and a real (fake) ircd — no IrcConnection, no database. What this pins
// is the RESTORE: a brand-new Client attached to a socket some other Client
// registered comes up on the live nick with the live caps, in the live channels,
// with the backlog delivered after the replay, and the network sees nothing.

// MUST be first: the engine link reads this instance's id from the database
// (it namespaces every connection id), so importing it opens one.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import IRC from 'irc-framework';
import type { Client, ConnectOptions } from 'irc-framework';
import { EngineServer } from '../engine/server.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { EngineLink } from './engineLink.js';
import { until as poll } from '../test-utils/until.js';
import {
  ENGINE_CLOSE,
  EngineTransport,
  engineCloseCode,
  sanitizeReplay,
} from './engineTransport.js';
import type { EnginePhase, EnginePhaseInfo } from './engineTransport.js';

const SECRET = 'transport-secret';

let ircd: FakeIrcd;
let engine: EngineServer;
let enginePort: number;
const links: EngineLink[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  engine = new EngineServer({
    secret: SECRET,
    bufferBytes: 4096,
    bufferTotalBytes: 64 * 1024,
    version: 'test',
    log: () => {},
  });
  enginePort = (await engine.listen(0, '127.0.0.1')).port;
});

afterAll(async () => {
  await engine.shutdown('tests done', 500);
  await ircd.close();
});

afterEach(() => {
  for (const c of clients.splice(0)) {
    try {
      c.connection.end();
    } catch {
      /* already gone */
    }
  }
  for (const l of links.splice(0)) l.stop();
});

function newLink(secret = SECRET, port = enginePort): EngineLink {
  // Long heartbeat: a full-suite CI run starves the event loop enough that a
  // 15 s beat could otherwise drop a healthy idle link mid-test.
  const l = new EngineLink({
    host: '127.0.0.1',
    port,
    secret,
    retryBaseMs: 100,
    heartbeatMs: 600_000,
    log: () => {},
  });
  links.push(l);
  return l;
}

interface Timeline {
  events: string[];
  phases: Array<{ phase: EnginePhase; info: EnginePhaseInfo }>;
  closes: unknown[];
  transport: EngineTransport | null;
}

let counter = 0;

// A Client through the engine, with everything it sees written to a timeline.
function makeClient(link: EngineLink, id: string, nick: string, opts: { timeoutMs?: number } = {}) {
  const t: Timeline = { events: [], phases: [], closes: [], transport: null };
  const client = new IRC.Client();
  clients.push(client);
  client.requestCap('message-tags');
  client.requestCap('batch');
  client.on('registered', (e) => t.events.push(`registered:${e.nick}`));
  client.on('join', (e) => t.events.push(`join:${e.nick}:${e.channel}`));
  client.on('nick', (e) => t.events.push(`nick:${e.nick}>${e.new_nick}`));
  client.on('privmsg', (e) => t.events.push(`privmsg:${e.target}:${e.message}`));
  client.on('topic', (e) => t.events.push(`topic:${e.channel}:${e.topic}`));
  client.on('socket close', (err) => {
    t.events.push(`socket close:${engineCloseCode(err) ?? (err ? 'error' : 'clean')}`);
    t.closes.push(err);
  });
  client.connect({
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    username: nick,
    gecos: 'transport test',
    auto_reconnect: false,
    version: false,
    transport: EngineTransport,
    engineConnId: id,
    engineLink: link,
    engineConnectTimeoutMs: opts.timeoutMs ?? 3000,
    engineHooks: {
      onTransport: (tr: unknown) => {
        t.transport = tr as EngineTransport;
      },
      onPhase: (phase: string, info: Record<string, unknown>) => {
        t.events.push(`phase:${phase}`);
        t.phases.push({ phase: phase as EnginePhase, info: info as EnginePhaseInfo });
      },
    },
  } as ConnectOptions);
  return { client, t };
}

// Poll for a condition; on timeout, say which one and show the timeline so a
// failure reads as "never saw X after [...]" rather than a bare 5000ms.
const until = (pred: () => boolean, what: string, dump?: () => unknown, ms = 4000) =>
  poll(pred, ms, what, () => `timeline: ${JSON.stringify(dump?.() ?? null)}`);

describe('EngineTransport', () => {
  it('dials fresh through the engine and registers like a socket would', async () => {
    const link = newLink();
    const id = `t:${++counter}`;
    const { client, t } = makeClient(link, id, 'fresh');
    await until(
      () => t.events.includes('registered:fresh'),
      't.events.includes("registered:fresh")',
      () => t.events,
    );
    expect(t.phases.map((p) => p.phase)).toEqual(['dialing']);
    // ISUPPORT (005) lands between 001 and end-of-registration; poll rather than
    // read synchronously, so a slow run doesn't catch it pre-005.
    await until(
      () => client.network.options.NETWORK === 'FakeNet',
      'NETWORK from ISUPPORT',
      () => client.network.options,
    );
    expect(ircd.registrations.filter((r) => r.nick === 'fresh')).toHaveLength(1);
  });

  it('restores a new Client onto a socket a dead process registered', async () => {
    const id = `t:${++counter}`;
    const linkA = newLink();
    const a = makeClient(linkA, id, 'orig');
    await until(
      () => a.t.events.includes('registered:orig'),
      'a.t.events.includes("registered:orig")',
      () => a.t.events,
    );
    a.client.join('#one');
    a.client.join('#two');
    await until(
      () => a.t.events.includes('join:orig:#two'),
      'a.t.events.includes("join:orig:#two")',
      () => a.t.events,
    );
    a.client.changeNick('moved');
    await until(
      () => a.t.events.includes('nick:orig>moved'),
      'a.t.events.includes("nick:orig>moved")',
      () => a.t.events,
    );
    a.client.part('#one');
    await until(
      () => ircd.client('moved')!.channels.size === 1,
      'ircd.client("moved")!.channels.size === 1',
      undefined,
    );
    const capsA = [...a.client.network.cap.enabled].toSorted();
    expect(capsA.length).toBeGreaterThan(0);
    const sentBefore = ircd.client('moved')!.sent.length;

    // Process A dies: link destroyed, no detach, no QUIT.
    linkA.simulateLoss();
    await until(
      () => a.t.events.some((e) => e.startsWith('socket close:')),
      'a.t.events.some((e) => e.startsWith("socket close:"))',
      () => a.t.events,
    );
    expect(a.t.events.at(-1)).toBe(`socket close:${ENGINE_CLOSE.LINK_LOST}`);
    linkA.stop();

    ircd.say('peer', '#two', 'while away 1');
    ircd.say('peer', 'moved', 'dm while away');
    ircd.setTopic('peer', '#two', 'set while away');
    ircd.say('peer', '#two', 'while away 2');

    // Process B: a fresh Client, configured with the STALE nick.
    const linkB = newLink();
    const b = makeClient(linkB, id, 'orig');
    await until(
      () => b.t.events.includes('phase:live'),
      'b.t.events.includes("phase:live")',
      () => b.t.events,
    );

    // Registered from the replay, on the live nick, same caps, same ISUPPORT.
    expect(b.client.user.nick).toBe('moved');
    expect([...b.client.network.cap.enabled].toSorted()).toEqual(capsA);
    expect(b.client.network.options.NETWORK).toBe('FakeNet');
    expect(b.client.network.options.CASEMAPPING).toBe('ascii');

    const attached = b.t.phases.find((p) => p.phase === 'attached')!;
    expect(attached.info.nick).toBe('moved');
    expect(attached.info.channels).toEqual(['#two']);
    const restored = b.t.phases.find((p) => p.phase === 'restored')!;
    expect(restored.info.swallowed!.map((l) => l.split(' ')[0])).toEqual([
      'CAP',
      'NICK',
      'USER',
      'CAP',
      'CAP',
    ]);

    // Timeline: the replay (registered, nick, join) inside attached..restored;
    // the backlog after restored, in order; then live.
    const ev = b.t.events;
    const idx = (s: string) => ev.indexOf(s);
    expect(idx('phase:attached')).toBeLessThan(idx('registered:orig'));
    expect(idx('registered:orig')).toBeLessThan(idx('nick:orig>moved'));
    expect(idx('nick:orig>moved')).toBeLessThan(idx('join:moved:#two'));
    expect(idx('join:moved:#two')).toBeLessThan(idx('phase:restored'));
    const backlog = ev.filter((e) => e.startsWith('privmsg:') || e.startsWith('topic:'));
    expect(backlog).toEqual([
      'privmsg:#two:while away 1',
      'privmsg:moved:dm while away',
      'topic:#two:set while away',
      'privmsg:#two:while away 2',
    ]);
    expect(idx('phase:restored')).toBeLessThan(idx(backlog[0]));
    expect(idx(backlog.at(-1)!)).toBeLessThan(idx('phase:live'));
    expect(ev.filter((e) => e === 'phase:dialing')).toHaveLength(0);

    // The network saw one registration and, since the kill, nothing but the
    // NAMES/MODE the new Client asked for on its synthesised JOIN — no NICK,
    // no USER, no CAP.
    expect(ircd.registrations.filter((r) => r.nick === 'orig')).toHaveLength(1);
    const since = ircd.client('moved')!.sent.slice(sentBefore);
    expect(since.some((l) => /^(NICK|USER|CAP) /.test(l))).toBe(false);

    // And it still works as a client: outbound goes to the wire.
    b.client.say('#two', 'back');
    // (irc-framework omits the colon when the text has no spaces.)
    await ircd.waitForLine((l) => /^PRIVMSG #two :?back$/.test(l));
  }, 20000);

  it('reports a takeover to the old process without a socket close', async () => {
    const id = `t:${++counter}`;
    const a = makeClient(newLink(), id, 'shared');
    await until(
      () => a.t.events.includes('registered:shared'),
      'a registered',
      () => a.t.events,
    );
    // Wait until the engine actually holds a's session before contesting it, so
    // b takes it over rather than fresh-dialing a socket a hasn't finished — or,
    // under load, has momentarily lost.
    await until(
      () => engine.held().includes(id),
      'engine holds a',
      () => engine.held(),
    );
    const b = makeClient(newLink(), id, 'shared');
    await until(
      () => a.t.events.some((e) => e.startsWith('socket close:')),
      'a hears the takeover',
      () => ({ a: a.t.events, b: b.t.events }),
    );
    expect(a.t.events.at(-1)).toBe(`socket close:${ENGINE_CLOSE.TAKEN_OVER}`);
    expect(ircd.client('shared')).toBeDefined();
    expect(engine.held()).toContain(id);
  });

  it('detach() leaves the socket in the engine and ends cleanly for irc-framework', async () => {
    const id = `t:${++counter}`;
    const a = makeClient(newLink(), id, 'leaver');
    await until(
      () => a.t.events.includes('registered:leaver'),
      'a.t.events.includes("registered:leaver")',
      () => a.t.events,
    );
    a.t.transport!.detach();
    await until(
      () => a.t.events.some((e) => e.startsWith('socket close:')),
      'a.t.events.some((e) => e.startsWith("socket close:"))',
      () => a.t.events,
    );
    expect(a.t.events.at(-1)).toBe(`socket close:${ENGINE_CLOSE.DETACHED}`);
    // The engine processes {op:'detach'} async over the link, so poll rather
    // than read synchronously right after the local close event.
    await until(
      () => engine.held().includes(id),
      'engine holds after detach',
      () => engine.held(),
    );
    expect(ircd.client('leaver')).toBeDefined();
    // close() after detach must not reach the engine.
    a.client.connection.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.held()).toContain(id);
    // The next process finds it.
    const b = makeClient(newLink(), id, 'leaver');
    await until(
      () => b.t.events.includes('phase:live'),
      'b.t.events.includes("phase:live")',
      () => b.t.events,
    );
    expect(b.client.user.nick).toBe('leaver');
  });

  it('a gap arrives after the replay and before the surviving backlog', async () => {
    const id = `t:${++counter}`;
    const linkA = newLink();
    const a = makeClient(linkA, id, 'gapper');
    await until(
      () => a.t.events.includes('registered:gapper'),
      'a.t.events.includes("registered:gapper")',
      () => a.t.events,
    );
    linkA.simulateLoss();
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 100; i++) ircd.say('peer', 'gapper', `line ${i} ${'x'.repeat(50)}`);
    await new Promise((r) => setTimeout(r, 50));
    const b = makeClient(newLink(), id, 'gapper');
    await until(
      () => b.t.events.includes('phase:live'),
      'b.t.events.includes("phase:live")',
      () => b.t.events,
    );
    const ev = b.t.events;
    expect(ev.indexOf('phase:restored')).toBeLessThan(ev.indexOf('phase:gap'));
    expect(ev.indexOf('phase:gap')).toBeLessThan(ev.findIndex((e) => e.startsWith('privmsg:')));
    expect(ev.filter((e) => e.startsWith('privmsg:')).at(-1)).toMatch(/line 99 /);
  }, 20000);

  it('fails with UNREACHABLE when no engine answers, and REFUSED on a bad secret', async () => {
    const dead = newLink(SECRET, 1);
    const a = makeClient(dead, `t:${++counter}`, 'nobody', { timeoutMs: 300 });
    await until(
      () => a.t.events.some((e) => e.startsWith('socket close:')),
      'a.t.events.some((e) => e.startsWith("socket close:"))',
      () => a.t.events,
      3000,
    );
    expect(a.t.events.at(-1)).toBe(`socket close:${ENGINE_CLOSE.UNREACHABLE}`);

    const wrong = newLink('not-the-secret');
    const b = makeClient(wrong, `t:${++counter}`, 'nobody2', { timeoutMs: 2000 });
    await until(
      () => b.t.events.some((e) => e.startsWith('socket close:')),
      'b.t.events.some((e) => e.startsWith("socket close:"))',
      () => b.t.events,
      3000,
    );
    expect(b.t.events.at(-1)).toBe(`socket close:${ENGINE_CLOSE.REFUSED}`);
    expect(wrong.state).toBe('refused');
  }, 20000);
});

describe('sanitizeReplay', () => {
  it('drops the SASL exchange and the sasl cap, keeps everything else verbatim', () => {
    const replay = [
      ':irc.x CAP * LS * :sasl=PLAIN,EXTERNAL multi-prefix',
      ':irc.x CAP * LS :server-time',
      ':irc.x CAP me ACK :sasl multi-prefix server-time',
      'AUTHENTICATE +',
      ':irc.x 900 me me!u@h acct :You are now logged in as acct',
      ':irc.x 903 me :SASL authentication successful',
      ':irc.x 001 me :Welcome',
      ':irc.x CAP me ACK :sasl',
    ];
    expect(sanitizeReplay(replay)).toEqual([
      ':irc.x CAP * LS * :multi-prefix',
      ':irc.x CAP * LS :server-time',
      ':irc.x CAP me ACK :multi-prefix server-time',
      ':irc.x 001 me :Welcome',
    ]);
  });
});

describe('engine answers to a bad CONNECT', () => {
  it('surface as a failed dial, not a Client stuck in connecting', async () => {
    const l = newLink();
    const id = `t:${++counter}`;
    const { t } = makeClient(l, id, 'badport');
    // Reach in and make the next CONNECT invalid.
    (t.transport as unknown as { options: { port: number } }).options.port = 70000;
    await until(
      () => t.events.some((e) => e.startsWith('socket close:')),
      'a failed dial',
      () => t.events,
    );
    expect(String((t.closes[0] as Error)?.message)).toMatch(/invalid port/);
  });
});
