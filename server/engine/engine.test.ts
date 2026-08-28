// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine against a real socket on both sides: a fake ircd upstream and a
// bare frame-level link standing in for the app. Every claim in
// IRC_ENGINE_PLAN.md §5.1 has a case here.

import net from 'node:net';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { EngineServer } from './server.js';
import { PROTOCOL_MAJOR } from './protocol.js';
import type { EngineToApp } from './protocol.js';
import { MAX_BURST_BYTES } from './upstream.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { TestLink, TEST_INSTANCE } from '../test-utils/engineLink.js';
import { createIdentdServer } from '../services/identd.js';
import { until } from '../test-utils/until.js';

const SECRET = 'spike-secret';
type Attached = Extract<EngineToApp, { op: 'attached' }>;

let ircd: FakeIrcd;
let engine: EngineServer;
let enginePort: number;
const links: TestLink[] = [];

beforeAll(async () => {
  ircd = await FakeIrcd.start();
  engine = new EngineServer({
    secret: SECRET,
    // Small on purpose so the overflow case is cheap to reach.
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
  for (const l of links.splice(0)) l.kill();
});

// `startedAt` is the app process's generation; the engine reads a missing one
// as 0, which the ordinary tests are happy with — only the newest-wins cases
// pass an explicit pair.
async function link(startedAt?: number): Promise<TestLink> {
  const l = await TestLink.connect(enginePort, SECRET, { startedAt });
  links.push(l);
  return l;
}

let counter = 0;
function connectFrame(
  id: string,
  extra: Partial<{ tls: boolean; rejectUnauthorized: boolean; ident: string; port: number }> = {},
) {
  return {
    op: 'connect' as const,
    id,
    host: '127.0.0.1',
    port: extra.port ?? ircd.port,
    tls: extra.tls ?? false,
    rejectUnauthorized: extra.rejectUnauthorized ?? false,
    ...(extra.ident ? { ident: extra.ident } : {}),
  };
}

// Dial through the engine and register on the fake ircd with plain NICK/USER.
async function register(l: TestLink, id: string, nick: string): Promise<void> {
  l.send(connectFrame(id));
  await l.waitFor((f) => f.op === 'open' && f.id === id);
  l.send({ op: 'write', id, line: `NICK ${nick}` });
  l.send({ op: 'write', id, line: `USER ${nick} 0 * :${nick}` });
  await l.waitForLine(id, / 376 /);
}

// A close the app asked for is never answered with `closed` (the app's
// transport ends its own side as it asks); "it worked" is the socket being gone.
const gone = (srv: EngineServer, id: string) =>
  until(() => !srv.hasConnection(id), 3000, `${id} gone from the engine`);

function ackAll(l: TestLink, id: string): void {
  const last = l.frames.filter((f) => f.op === 'line' && f.id === id).pop() as
    | Extract<EngineToApp, { op: 'line' }>
    | undefined;
  if (last) l.send({ op: 'ack', id, seq: last.seq });
}

describe('hello', () => {
  it('refuses a bad secret and a wrong protocol major, accepts the right pair', async () => {
    const bad = await TestLink.connect(enginePort, 'nope');
    expect(bad.frames[0]).toMatchObject({ op: 'error', message: 'bad secret' });
    await bad.waitForClose();

    const skew = await TestLink.connect(enginePort, SECRET, { protocol: PROTOCOL_MAJOR + 1 });
    expect(skew.frames[0]).toMatchObject({ op: 'error' });
    expect((skew.frames[0] as { message: string }).message).toMatch(/protocol major mismatch/);
    await skew.waitForClose();

    const ok = await link();
    expect(ok.hello).toMatchObject({ op: 'hello', protocol: PROTOCOL_MAJOR, held: [] });
  });

  it('answers a plain HTTP probe on the same port', async () => {
    const s = net.connect(enginePort, '127.0.0.1');
    await once(s, 'connect');
    s.write('GET /healthz HTTP/1.0\r\n\r\n');
    let out = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => (out += d));
    await once(s, 'close');
    expect(out).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(out).toMatch(/"ok":true/);
  });

  it('drops a link that sends garbage', async () => {
    const l = await link();
    l.socket.write('{"op":"' + 'x'.repeat(300 * 1024) + '"}\n');
    await l.waitForClose();
    expect(l.closed).toBe(true);
  });
});

describe('dial and relay', () => {
  it('dials, reports the 4-tuple, relays both ways with increasing seqs', async () => {
    const l = await link();
    const id = `relay:${++counter}`;
    l.send(connectFrame(id));
    expect(await l.waitFor((f) => f.op === 'dialing')).toMatchObject({ id });
    const open = await l.waitFor<Extract<EngineToApp, { op: 'open' }>>((f) => f.op === 'open');
    expect(open.remote.port).toBe(ircd.port);
    expect(open.local.port).toBeGreaterThan(0);
    l.send({ op: 'write', id, line: 'NICK relay1' });
    l.send({ op: 'write', id, line: 'USER relay1 0 * :r' });
    await l.waitForLine(id, / 376 /);
    const seqs = l.frames
      .filter((f): f is Extract<EngineToApp, { op: 'line' }> => f.op === 'line')
      .map((f) => f.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(ircd.registrations.filter((r) => r.nick === 'relay1')).toHaveLength(1);
  });

  it('answers server PINGs itself and never forwards them', async () => {
    const l = await link();
    const id = `ping:${++counter}`;
    await register(l, id, 'pinger');
    ircd.ping('pinger', 'tok-1');
    expect(await ircd.waitForLine((line) => line === 'PONG :tok-1')).toBe('PONG :tok-1');
    // Give a forwarded PING every chance to arrive, then assert it didn't.
    await new Promise((r) => setTimeout(r, 50));
    expect(l.lines(id).some((x) => x.startsWith('PING'))).toBe(false);
  });

  it('reports an unknown id as an error and ends the socket on close', async () => {
    const l = await link();
    l.send({ op: 'write', id: 'nobody', line: 'PING x' });
    expect(await l.waitFor((f) => f.op === 'error')).toMatchObject({ id: 'nobody' });
    const id = `close:${++counter}`;
    await register(l, id, 'closer');
    l.send({ op: 'close', id });
    await gone(engine, id);
    expect(engine.held()).not.toContain(id);
  });
});

describe('attach after the app is gone', () => {
  it('holds the socket, buffers, replays burst + NICKs + JOINs, then drains and goes live', async () => {
    const id = `attach:${++counter}`;
    const a = await link();
    await register(a, id, 'vic');
    a.send({ op: 'write', id, line: 'JOIN #a' });
    await a.waitForLine(id, /JOIN #a/);
    a.send({ op: 'write', id, line: 'JOIN #b' });
    await a.waitForLine(id, /JOIN #b/);
    a.send({ op: 'write', id, line: 'NICK vic2' });
    await a.waitForLine(id, /NICK :vic2/);
    a.send({ op: 'write', id, line: 'PART #a' });
    await a.waitForLine(id, /PART #a/);
    ackAll(a, id);
    const sentBefore = ircd.client('vic2')!.sent.length;

    // The app dies. No QUIT, no detach.
    a.kill();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.held()).toContain(id);

    // Life goes on without it.
    ircd.say('peer', '#b', 'one');
    ircd.say('peer', 'vic2', 'two');
    ircd.setTopic('peer', '#b', 'while away');
    ircd.ping('vic2', 'detached');
    await ircd.waitForLine((line) => line === 'PONG :detached');

    const b = await link();
    expect(b.hello?.held).toContain(id);
    b.send(connectFrame(id));
    const att = await b.waitFor<Attached>((f) => f.op === 'attached');
    expect(att.nick).toBe('vic2');
    expect(att.channels).toEqual(['#b']);
    expect(att.detachedForMs).toBeGreaterThan(0);
    // Burst: 001-005, 251, 375, 372, 376 = 9 lines; then the NICK; then #b.
    expect(att.replay).toHaveLength(11);
    expect(att.replay[0]).toMatch(/ 001 vic /);
    expect(att.replay[8]).toMatch(/ 376 /);
    expect(att.replay[9]).toMatch(/^(@\S+ )?:vic!~vic@fake.host NICK :vic2$/);
    expect(att.replay[10]).toBe(':vic2!~vic@fake.host JOIN #b');

    await b.waitFor((f) => f.op === 'live' && f.id === id);
    const backlog = b.lines(id);
    expect(backlog.map((x) => x.replace(/^@\S+ /, ''))).toEqual([
      ':peer!~peer@peer.fake PRIVMSG #b :one',
      ':peer!~peer@peer.fake PRIVMSG vic2 :two',
      ':peer!~peer@peer.fake TOPIC #b :while away',
    ]);
    // Order on the wire: attached, then the backlog, then live.
    const ops = b.frames.filter((f) => 'id' in f && f.id === id).map((f) => f.op);
    expect(ops).toEqual(['attached', 'line', 'line', 'line', 'live']);
    // Seqs continue from where the old link left off.
    const firstSeq = (b.frames.find((f) => f.op === 'line') as { seq: number }).seq;
    expect(firstSeq).toBeGreaterThan(1);

    // The server saw one registration and not one extra command.
    expect(ircd.registrations.filter((r) => r.nick === 'vic')).toHaveLength(1);
    expect(ircd.client('vic2')!.sent.slice(sentBefore)).toEqual(['PONG :detached']);
  });

  it('ends the burst at 422 when there is no MOTD', async () => {
    const noMotd = await FakeIrcd.start({ motd: false });
    try {
      const id = `motd:${++counter}`;
      const a = await link();
      a.send(connectFrame(id, { port: noMotd.port }));
      await a.waitFor((f) => f.op === 'open');
      a.send({ op: 'write', id, line: 'NICK nomotd' });
      a.send({ op: 'write', id, line: 'USER nomotd 0 * :n' });
      await a.waitForLine(id, / 422 /);
      ackAll(a, id);
      a.kill();
      const b = await link();
      b.send(connectFrame(id, { port: noMotd.port }));
      const att = await b.waitFor<Attached>((f) => f.op === 'attached');
      expect(att.replay.at(-1)).toMatch(/ 422 /);
      expect(att.nick).toBe('nomotd');
      b.send({ op: 'close', id });
      await gone(engine, id);
    } finally {
      await noMotd.close();
    }
  });

  // The sibling of the 422 case: the cap that stops a long MOTD growing the
  // burst forever must not take the terminator with it. Without it the replay
  // opens a MOTD it never closes, and irc-framework only emits 'motd' — the one
  // thing that renders the block, since 372/375/376 are on the app's numeric
  // denylist — on 376/422.
  it('keeps the burst terminator when a long MOTD fills the cap', async () => {
    // ~85 KiB of MOTD against a 64 KiB cap.
    const padLines = 80;
    const bigMotd = await FakeIrcd.start({ motdPadLines: padLines });
    try {
      const id = `bigmotd:${++counter}`;
      const a = await link();
      a.send(connectFrame(id, { port: bigMotd.port }));
      await a.waitFor((f) => f.op === 'open');
      a.send({ op: 'write', id, line: 'NICK bigmotd' });
      a.send({ op: 'write', id, line: 'USER bigmotd 0 * :b' });
      await a.waitForLine(id, / 376 /);
      ackAll(a, id);
      a.kill();
      const b = await link();
      b.send(connectFrame(id, { port: bigMotd.port }));
      const att = await b.waitFor<Attached>((f) => f.op === 'attached');
      // The control: the cap really did engage, so the terminator surviving is
      // not just "everything fit".
      const motd = att.replay.filter((x) => / 372 /.test(x));
      expect(motd.length).toBeGreaterThan(0);
      expect(motd.length).toBeLessThan(padLines + 1);
      expect(att.replay.join('\n').length).toBeGreaterThan(MAX_BURST_BYTES / 2);
      // What survives is a PREFIX, not a subset with the long lines punched
      // out: the pad lines are numbered, and the ones we kept run 0..n-1.
      const kept = motd.map((x) => x.match(/:- (\d{4}) /)?.[1]).filter((x) => x !== undefined);
      expect(kept).toEqual(kept.map((_, i) => String(i).padStart(4, '0')));
      // And the prefix still ends where a consumer expects it to.
      expect(att.replay.at(-1)).toMatch(/ 376 /);
      expect(att.nick).toBe('bigmotd');
      b.send({ op: 'close', id });
      await gone(engine, id);
    } finally {
      await bigMotd.close();
    }
  });

  it('forgets a channel it was kicked from and follows a server-forced nick', async () => {
    const id = `kick:${++counter}`;
    const a = await link();
    await register(a, id, 'kicked');
    a.send({ op: 'write', id, line: 'JOIN #k' });
    await a.waitForLine(id, /JOIN #k/);
    ircd.kick('#k', 'kicked');
    await a.waitForLine(id, /KICK #k kicked/);
    ircd.forceNick('kicked', 'renamed');
    await a.waitForLine(id, /NICK :renamed/);
    ackAll(a, id);
    a.kill();
    const b = await link();
    b.send(connectFrame(id));
    const att = await b.waitFor<Attached>((f) => f.op === 'attached');
    expect(att.channels).toEqual([]);
    expect(att.nick).toBe('renamed');
    expect(att.replay.filter((x) => /JOIN/.test(x))).toHaveLength(0);
  });

  it('newest link wins: the old link is told, not closed', async () => {
    const id = `takeover:${++counter}`;
    const a = await link();
    await register(a, id, 'shared');
    const b = await link();
    b.send(connectFrame(id));
    await b.waitFor((f) => f.op === 'attached');
    expect(await a.waitFor((f) => f.op === 'detached')).toMatchObject({ id, reason: 'taken-over' });
    expect(a.frames.some((f) => f.op === 'closed')).toBe(false);
    ircd.say('peer', 'shared', 'to-b');
    await b.waitForLine(id, /to-b/);
    expect(a.lines(id).some((x) => /to-b/.test(x))).toBe(false);
    // The old link can no longer drive the socket either.
    a.send({ op: 'write', id, line: 'PRIVMSG shared :from-the-dead' });
    expect(await a.waitFor((f) => f.op === 'error' && f.id === id)).toMatchObject({
      message: 'not attached to this connection',
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(ircd.client('shared')!.sent.some((l) => /from-the-dead/.test(l))).toBe(false);
  });

  it('acked lines are not replayed; unacked ones are', async () => {
    const id = `ack:${++counter}`;
    const a = await link();
    await register(a, id, 'acker');
    ackAll(a, id);
    ircd.say('peer', 'acker', 'acked-1');
    const f1 = await a.waitFor<Extract<EngineToApp, { op: 'line' }>>(
      (f) => f.op === 'line' && /acked-1/.test(f.line),
    );
    a.send({ op: 'ack', id, seq: f1.seq });
    ircd.say('peer', 'acker', 'unacked-2');
    await a.waitForLine(id, /unacked-2/);
    await new Promise((r) => setTimeout(r, 20));
    a.kill();
    const b = await link();
    b.send(connectFrame(id));
    await b.waitFor((f) => f.op === 'live');
    expect(b.lines(id).map((x) => x.replace(/^@\S+ /, ''))).toEqual([
      ':peer!~peer@peer.fake PRIVMSG acker :unacked-2',
    ]);
  });

  it('reports a gap when the app stayed away longer than the buffer covers', async () => {
    const id = `gap:${++counter}`;
    const a = await link();
    await register(a, id, 'gappy');
    ackAll(a, id);
    a.kill();
    await new Promise((r) => setTimeout(r, 20));
    // 4096-byte buffer; 100 lines of ~90 bytes.
    for (let i = 0; i < 100; i++) ircd.say('peer', 'gappy', `line ${i} ${'x'.repeat(50)}`);
    await new Promise((r) => setTimeout(r, 80)); // let the writes land
    const b = await link();
    b.send(connectFrame(id));
    await b.waitFor((f) => f.op === 'live');
    const ops = b.frames.filter((f) => 'id' in f && f.id === id).map((f) => f.op);
    expect(ops.slice(0, 2)).toEqual(['attached', 'gap']);
    const gap = b.frames.find((f) => f.op === 'gap') as Extract<EngineToApp, { op: 'gap' }>;
    expect(gap.gap.firstDroppedSeq).toBeGreaterThan(0);
    expect(gap.gap.lastDroppedSeq).toBeGreaterThan(gap.gap.firstDroppedSeq);
    const got = b.lines(id);
    expect(got.length).toBeLessThan(100);
    expect(got.at(-1)).toMatch(/line 99 /);
  });

  it('a socket that died while detached is forgotten; a CONNECT dials afresh', async () => {
    const id = `dead:${++counter}`;
    const a = await link();
    await register(a, id, 'doomed');
    a.kill();
    await new Promise((r) => setTimeout(r, 20));
    ircd.drop('doomed');
    await new Promise((r) => setTimeout(r, 50));
    expect(engine.held()).not.toContain(id);
    const b = await link();
    expect(b.hello?.held).not.toContain(id);
    // A CONNECT now is a fresh dial.
    b.send(connectFrame(id));
    expect(await b.waitFor((f) => f.op === 'dialing' || f.op === 'attached')).toMatchObject({
      op: 'dialing',
    });
  });
});

describe('TLS and identd', () => {
  it('dials TLS upstreams and honours rejectUnauthorized', async () => {
    const secure = await FakeIrcd.start({ tls: true });
    try {
      const l = await link();
      const id = `tls:${++counter}`;
      l.send(connectFrame(id, { port: secure.port, tls: true, rejectUnauthorized: false }));
      await l.waitFor((f) => f.op === 'open' && f.id === id);
      l.send({ op: 'write', id, line: 'NICK tlsy' });
      l.send({ op: 'write', id, line: 'USER tlsy 0 * :t' });
      await l.waitForLine(id, / 001 /);

      const strict = `tls-strict:${++counter}`;
      l.send(connectFrame(strict, { port: secure.port, tls: true, rejectUnauthorized: true }));
      const closed = await l.waitFor<Extract<EngineToApp, { op: 'closed' }>>(
        (f) => f.op === 'closed' && f.id === strict,
      );
      expect(closed.error).toMatch(/self.signed|certificate/i);
    } finally {
      await secure.close();
    }
  });

  it('registers the ident on the raw TCP connect — before the TLS handshake — and releases it on close', async () => {
    process.env.LURKER_IDENTD_ENABLED = '1';
    const identd = createIdentdServer({ graceMs: 50, graceStepMs: 10 });
    await new Promise<void>((r) => identd.listen(0, '127.0.0.1', r));
    const identdPort = (identd.address() as net.AddressInfo).port;
    const query = (line: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const c = net.connect(identdPort, '127.0.0.1', () => c.write(line));
        let out = '';
        c.setEncoding('utf8');
        c.on('data', (d: string) => (out += d));
        c.on('end', () => resolve(out.trim()));
        c.on('error', reject);
      });
    try {
      const l = await link();
      const id = `ident:${++counter}`;
      l.send(connectFrame(id, { ident: 'brad' }));
      const open = await l.waitFor<Extract<EngineToApp, { op: 'open' }>>(
        (f) => f.op === 'open' && f.id === id,
      );
      expect(await query(`${open.local.port}, ${open.remote.port}\r\n`)).toBe(
        `${open.local.port}, ${open.remote.port} : USERID : UNIX : brad`,
      );
      l.send({ op: 'close', id });
      await gone(engine, id);
      expect(await query(`${open.local.port}, ${open.remote.port}\r\n`)).toMatch(/NO-USER/);

      // TLS: the ircd asks :113 the instant it accepts TCP, while the handshake
      // is still in flight — so the entry must exist by then, not after.
      const secure = await FakeIrcd.start({ tls: true });
      try {
        const tid = `ident-tls:${++counter}`;
        l.send(connectFrame(tid, { port: secure.port, tls: true, ident: 'brad' }));
        const topen = await l.waitFor<Extract<EngineToApp, { op: 'open' }>>(
          (f) => f.op === 'open' && f.id === tid,
        );
        expect(await query(`${topen.local.port}, ${topen.remote.port}\r\n`)).toBe(
          `${topen.local.port}, ${topen.remote.port} : USERID : UNIX : brad`,
        );
        l.send({ op: 'close', id: tid });
        await gone(engine, tid);
      } finally {
        await secure.close();
      }
    } finally {
      delete process.env.LURKER_IDENTD_ENABLED;
      identd.close();
    }
  });
});

describe('shutdown', () => {
  it('QUITs every held socket and drops the links', async () => {
    const own = new EngineServer({
      secret: SECRET,
      bufferBytes: 4096,
      bufferTotalBytes: 65536,
      version: 'test',
      log: () => {},
    });
    const port = (await own.listen(0, '127.0.0.1')).port;
    const l = await TestLink.connect(port, SECRET);
    const id = 'bye:1';
    l.send(connectFrame(id));
    await l.waitFor((f) => f.op === 'open');
    l.send({ op: 'write', id, line: 'NICK bye' });
    l.send({ op: 'write', id, line: 'USER bye 0 * :b' });
    await l.waitForLine(id, / 376 /);
    await own.shutdown('engine restarting');
    expect(ircd.client('bye')).toBeUndefined();
    expect(await ircd.waitForLine((line) => line === 'QUIT :engine restarting')).toBeTruthy();
    await l.waitForClose();
    expect(own.held()).toEqual([]);
  });
});

describe('review findings', () => {
  it('refuses a connect with a bad port or bind address without dying', async () => {
    const l = await link();
    const healthy = `healthy:${++counter}`;
    await register(l, healthy, 'healthy');
    l.send({ ...connectFrame(`bad:${++counter}`), port: 70000 });
    expect(await l.waitFor((f) => f.op === 'error')).toMatchObject({
      message: expect.stringMatching(/invalid port/),
    });
    l.send({ ...connectFrame(`bad:${++counter}`), outgoingAddr: 'eth0' });
    expect(await l.waitFor((f) => f.op === 'error' && /outgoingAddr/.test(f.message))).toBeTruthy();
    // Still here, still holding the healthy one, still able to dial.
    expect(engine.held()).toContain(healthy);
    ircd.say('peer', 'healthy', 'alive');
    await l.waitForLine(healthy, /alive/);
  });

  it('follows a nick forced during registration and the channels joined after it', async () => {
    const forcing = await FakeIrcd.start({ burstNickTo: 'forced' });
    try {
      const id = `forced:${++counter}`;
      const a = await link();
      a.send(connectFrame(id, { port: forcing.port }));
      await a.waitFor((f) => f.op === 'open' && f.id === id);
      a.send({ op: 'write', id, line: 'NICK before' });
      a.send({ op: 'write', id, line: 'USER before 0 * :b' });
      await a.waitForLine(id, / 376 /);
      a.send({ op: 'write', id, line: 'JOIN #after' });
      await a.waitForLine(id, /JOIN #after/);
      ackAll(a, id);
      a.kill();
      const b = await link();
      b.send(connectFrame(id, { port: forcing.port }));
      const att = await b.waitFor<Attached>((f) => f.op === 'attached');
      expect(att.nick).toBe('forced');
      expect(att.channels).toEqual(['#after']);
      // The forced NICK is in the burst verbatim, so no synthesised one follows.
      expect(att.replay.filter((x) => / NICK /.test(x))).toEqual([
        expect.stringMatching(/^:before!~before@fake.host NICK :forced$/),
      ]);
      expect(att.replay.at(-1)).toBe(':forced!~before@fake.host JOIN #after');
      b.send({ op: 'close', id });
      await gone(engine, id);
    } finally {
      await forcing.close();
    }
  });

  it('redials afresh, not an error, for a socket whose registration never finished', async () => {
    const id = `half:${++counter}`;
    const a = await link();
    a.send(connectFrame(id));
    await a.waitFor((f) => f.op === 'open' && f.id === id);
    a.send({ op: 'write', id, line: 'NICK half' }); // no USER: never registers
    await new Promise((r) => setTimeout(r, 30));
    // Not a session, so not advertised as one.
    expect(engine.held()).not.toContain(id);
    a.kill();
    const b = await link();
    expect(b.hello?.held).not.toContain(id);
    b.send(connectFrame(id));
    const next = await b.waitFor((f) => 'id' in f && f.id === id);
    expect(next.op).toBe('dialing');
    await b.waitFor((f) => f.op === 'open' && f.id === id);
    b.send({ op: 'write', id, line: 'NICK half2' });
    b.send({ op: 'write', id, line: 'USER half2 0 * :h' });
    await b.waitForLine(id, / 001 half2 /);
    await new Promise((r) => setTimeout(r, 30));
    expect(b.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
    expect(engine.held()).toContain(id);
  });

  it('does not deliver an unacked burst twice — the replay is its delivery', async () => {
    const id = `noack:${++counter}`;
    const a = await link();
    await register(a, id, 'noack'); // deliberately never acked
    a.kill();
    const b = await link();
    b.send(connectFrame(id));
    const att = await b.waitFor<Attached>((f) => f.op === 'attached');
    await b.waitFor((f) => f.op === 'live' && f.id === id);
    expect(att.replay.some((x) => / 001 /.test(x))).toBe(true);
    expect(b.lines(id).some((x) => / 001 /.test(x))).toBe(false);
  });

  it('reports a gap to the next attach, not to the link that already had the lines', async () => {
    const id = `gapwho:${++counter}`;
    const a = await link();
    await register(a, id, 'gapwho');
    ackAll(a, id);
    // Attached but never acking: 100 lines against a 4 KiB buffer.
    for (let i = 0; i < 100; i++) ircd.say('peer', 'gapwho', `line ${i} ${'x'.repeat(50)}`);
    await a.waitForLine(id, /line 99 /);
    expect(a.lines(id).filter((x) => /line \d+ /.test(x))).toHaveLength(100);
    expect(a.frames.some((f) => f.op === 'gap')).toBe(false);
    a.kill();
    const b = await link();
    b.send(connectFrame(id));
    await b.waitFor((f) => f.op === 'live' && f.id === id);
    const ops = b.frames.filter((f) => 'id' in f && f.id === id).map((f) => f.op);
    expect(ops.slice(0, 2)).toEqual(['attached', 'gap']);
  });

  it('a CONNECT right after a close dials afresh instead of attaching to the dying socket', async () => {
    const id = `reclose:${++counter}`;
    const l = await link();
    await register(l, id, 'reclose');
    l.send({ op: 'close', id });
    l.send(connectFrame(id));
    const next = await l.waitForNew(
      (f) => 'id' in f && f.id === id && (f.op === 'dialing' || f.op === 'attached'),
    );
    expect(next.op).toBe('dialing');
    await l.waitForNew((f) => f.op === 'open' && f.id === id);
    l.send({ op: 'write', id, line: 'NICK reclose2' });
    l.send({ op: 'write', id, line: 'USER reclose2 0 * :r' });
    // Wait for the END of the burst, not 001. `held()` reports a session only
    // once it is REGISTERED, and the engine sets that on 376/422 — so asserting
    // anywhere between 001 and 376 is a race, and one that only loses under the
    // event-loop pressure of a full-suite run. The engine sets burstDone before
    // it flushes the line, so seeing 376 here is ordering, not timing.
    await l.waitForLine(id, / 376 reclose2 /);
    expect(engine.held()).toContain(id);
    // The old socket's death was silent for this link.
    expect(l.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
  });

  it('lets any link close a socket nobody claims, and no older process close one a newer one holds', async () => {
    const id = `orphan:${++counter}`;
    const a = await link();
    await register(a, id, 'orphan');
    a.kill();
    await new Promise((r) => setTimeout(r, 30));
    const b = await link();
    b.send({ op: 'close', id });
    await gone(engine, id);
    expect(engine.held()).not.toContain(id);

    // "Someone else" here is an OLDER process: the newer one owns the socket,
    // and a process that was superseded must not end its successor's sessions.
    // (A same-or-newer link closing over a stale claim is the #849 case below.)
    const id2 = `owned:${++counter}`;
    const owner = await link(2000);
    await register(owner, id2, 'owned');
    const stranger = await link(1000);
    stranger.send({ op: 'close', id: id2 });
    expect(await stranger.waitFor((f) => f.op === 'error' && f.id === id2)).toMatchObject({
      message: 'not attached to this connection',
    });
    expect(engine.held()).toContain(id2);
    expect(ircd.client('owned')).toBeDefined();
    expect(owner.frames.some((f) => f.op === 'detached' || f.op === 'closed')).toBe(false);
  });
});

// #849: a close from a link the holder is not newer than ends the socket. The
// rule and the race behind it: server.ts, contest(). Two shapes of "not newer"
// — the dead predecessor link of the same process, and an older process; the
// third, a newer holder refusing, is in 'review findings' above.
describe('a close over a stale claim (#849)', () => {
  it.each([
    ['the same process', 5000, 5000],
    ['an older process', 1000, 2000],
  ])(
    'a close from %s ends a socket the holder still claims',
    async (_what, holderGen, closerGen) => {
      const id = `stale:${++counter}`;
      const nick = `stale${counter}`;
      const holder = await link(holderGen);
      await register(holder, id, nick);
      // The holder is not killed: the point is that its claim is still on the
      // books when the close arrives.
      const closer = await link(closerGen);
      closer.send({ op: 'close', id });
      await gone(engine, id);
      expect(engine.held()).not.toContain(id);
      expect(closer.frames.some((f) => f.op === 'error' && f.id === id)).toBe(false);
      // The stripped holder is told it was taken over — the path that disposes
      // without reconnecting — not that its socket closed, which its transport
      // would read as a network drop and re-dial through the engine.
      expect(await holder.waitFor((f) => f.op === 'detached' && f.id === id)).toMatchObject({
        reason: 'taken-over',
      });
      expect(holder.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
      await until(() => ircd.client(nick) === undefined, 5000, 'ircd saw it go');
    },
  );
});

describe('second review round', () => {
  // A listener that accepts TCP and then says nothing: to a TLS dial that is a
  // handshake that never completes.
  async function tarpit(): Promise<{ port: number; close(): void }> {
    const srv = net.createServer(() => {});
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { port: (srv.address() as net.AddressInfo).port, close: () => srv.close() };
  }

  it('gives up on a dial whose handshake never completes', async () => {
    const own = new EngineServer({
      secret: SECRET,
      bufferBytes: 4096,
      bufferTotalBytes: 65536,
      version: 'test',
      log: () => {},
      dialTimeoutMs: 200,
    });
    const port = (await own.listen(0, '127.0.0.1')).port;
    const pit = await tarpit();
    try {
      const l = await TestLink.connect(port, SECRET);
      const id = 'pit:1';
      l.send(connectFrame(id, { port: pit.port, tls: true }));
      const closed = await l.waitFor<Extract<EngineToApp, { op: 'closed' }>>(
        (f) => f.op === 'closed' && f.id === id,
        3000,
      );
      expect(closed.error).toMatch(/timed out/);
      expect(l.frames.some((f) => f.op === 'open')).toBe(false);
      l.kill();
    } finally {
      pit.close();
      await own.shutdown('done', 200);
    }
  });

  it('a close while still dialing cuts the dial off — no open, no ident, prompt closed', async () => {
    const pit = await tarpit();
    try {
      const l = await link();
      const id = `abort:${++counter}`;
      l.send(connectFrame(id, { port: pit.port, tls: true }));
      await l.waitFor((f) => f.op === 'dialing' && f.id === id);
      l.send({ op: 'close', id });
      await gone(engine, id);
      expect(l.frames.some((f) => f.op === 'open' && f.id === id)).toBe(false);
      expect(l.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
      expect(engine.held()).not.toContain(id);
    } finally {
      pit.close();
    }
  });

  it('a closed orphan never sends its `closed` to the fresh socket that took its id', async () => {
    const id = `orphan-redial:${++counter}`;
    const a = await link();
    await register(a, id, 'orph');
    a.kill();
    await new Promise((r) => setTimeout(r, 30));
    const b = await link();
    b.send({ op: 'close', id }); // reconcile: nobody claims it, so allowed
    b.send(connectFrame(id)); // …and immediately wanted again
    const next = await b.waitFor((f) => 'id' in f && f.id === id);
    expect(next.op).toBe('dialing');
    await b.waitFor((f) => f.op === 'open' && f.id === id);
    b.send({ op: 'write', id, line: 'NICK orph2' });
    b.send({ op: 'write', id, line: 'USER orph2 0 * :o' });
    await b.waitForLine(id, / 001 orph2 /);
    // The old socket has long since FINed; its death must not have been routed
    // to the new one.
    await new Promise((r) => setTimeout(r, 100));
    expect(b.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
    expect(engine.held()).toContain(id);
  });

  it('accepts a late ack from the link that was just taken over', async () => {
    const id = `lateack:${++counter}`;
    const a = await link();
    await register(a, id, 'lateack');
    ackAll(a, id);
    ircd.say('peer', 'lateack', 'in flight');
    const f = await a.waitFor<Extract<EngineToApp, { op: 'line' }>>(
      (x) => x.op === 'line' && /in flight/.test(x.line),
    );
    const b = await link();
    b.send(connectFrame(id));
    await b.waitFor((x) => x.op === 'live' && x.id === id);
    await a.waitFor((x) => x.op === 'detached');
    // The old process persisted the line and now says so. Not refused.
    a.send({ op: 'ack', id, seq: f.seq });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.frames.some((x) => x.op === 'error')).toBe(false);
    b.send({ op: 'list' });
    const listing = await b.waitFor<Extract<EngineToApp, { op: 'listing' }>>(
      (x) => x.op === 'listing',
    );
    expect(listing.connections.find((c) => c.id === id)?.bufferedLines).toBe(0);
  });

  it('binds the address family with the source address (dual-stack hosts)', async () => {
    const l = await link();
    const id = `family:${++counter}`;
    l.send({ ...connectFrame(id), host: 'localhost', outgoingAddr: '127.0.0.1' });
    const open = await l.waitFor<Extract<EngineToApp, { op: 'open' }>>(
      (f) => f.op === 'open' && f.id === id,
    );
    expect(open.local.address).toBe('127.0.0.1');
    expect(open.remote.port).toBe(ircd.port);
    l.send({ op: 'close', id });
    await gone(engine, id);
  });
});

describe('third review round', () => {
  it('advertises to a link only what no other link claims, and answers ping', async () => {
    const id = `heldfor:${++counter}`;
    const a = await link();
    await register(a, id, 'heldfor');
    const b = await link();
    expect(b.hello?.held).not.toContain(id);
    a.kill();
    await new Promise((r) => setTimeout(r, 30));
    const c = await link();
    expect(c.hello?.held).toContain(id);
    c.send({ op: 'ping' });
    await c.waitFor((f) => f.op === 'pong');
  });

  it('an older process cannot steal a session from a newer one', async () => {
    const id = `gen:${++counter}`;
    const older = await link(1000);
    await register(older, id, 'gen');
    const newer = await link(2000);
    newer.send(connectFrame(id));
    await newer.waitFor((f) => f.op === 'live' && f.id === id);
    await older.waitFor((f) => f.op === 'detached' && f.id === id);
    // The older one comes back for it — and is told no.
    older.send(connectFrame(id));
    const answer = await older.waitForNew((f) => 'id' in f && f.id === id);
    expect(answer).toMatchObject({ op: 'detached', reason: 'taken-over' });
    await new Promise((r) => setTimeout(r, 30));
    expect(newer.frames.some((f) => f.op === 'detached')).toBe(false);
    ircd.say('peer', 'gen', 'still yours');
    await newer.waitForLine(id, /still yours/);
  });

  it('a CONNECT with different dial parameters is a new session, not the old socket', async () => {
    const other = await FakeIrcd.start();
    try {
      const id = `redial:${++counter}`;
      const l = await link();
      await register(l, id, 'redial');
      l.send(connectFrame(id, { port: other.port }));
      const next = await l.waitForNew((f) => 'id' in f && f.id === id);
      expect(next.op).toBe('dialing');
      await l.waitForNew((f) => f.op === 'open' && f.id === id);
      l.send({ op: 'write', id, line: 'NICK redial2' });
      l.send({ op: 'write', id, line: 'USER redial2 0 * :r' });
      await other.waitForRegistration('redial2');
      await new Promise((r) => setTimeout(r, 50));
      expect(ircd.client('redial')).toBeUndefined();
      expect(l.frames.some((f) => f.op === 'closed' && f.id === id)).toBe(false);
    } finally {
      await other.close();
    }
  });

  it('flags a session the engine registered while no app was attached', async () => {
    const id = `unattended:${++counter}`;
    const a = await link();
    a.send(connectFrame(id));
    await a.waitFor((f) => f.op === 'open' && f.id === id);
    a.send({ op: 'write', id, line: 'NICK unatt' });
    a.send({ op: 'write', id, line: 'USER unatt 0 * :u' });
    // Die before the ircd answers.
    a.kill();
    await ircd.waitForRegistration('unatt');
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.held()).toContain(id);
    const b = await link();
    b.send(connectFrame(id));
    const att = await b.waitFor<Attached>((f) => f.op === 'attached');
    expect(att.unattended).toBe(true);
    expect(att.channels).toEqual([]);
    // …and one that was attached at registration is not flagged.
    const id2 = `attended:${++counter}`;
    await register(b, id2, 'attd');
    b.kill();
    const c = await link();
    c.send(connectFrame(id2));
    const att2 = await c.waitFor<Attached>((f) => f.op === 'attached' && f.id === id2);
    expect(att2.unattended).toBe(false);
  });
});

describe('orphan reaper', () => {
  it('ends a session no link has claimed for orphanMs', async () => {
    const own = new EngineServer({
      secret: SECRET,
      bufferBytes: 4096,
      bufferTotalBytes: 65536,
      version: 'test',
      log: () => {},
      orphanMs: 200,
    });
    const port = (await own.listen(0, '127.0.0.1')).port;
    try {
      const l = await TestLink.connect(port, SECRET);
      const id = 'orphan-reap:1';
      l.send(connectFrame(id));
      await l.waitFor((f) => f.op === 'open' && f.id === id);
      l.send({ op: 'write', id, line: 'NICK reaped' });
      l.send({ op: 'write', id, line: 'USER reaped 0 * :r' });
      await l.waitForLine(id, / 376 /);
      const record = ircd.client('reaped')!;
      l.kill();
      // The sweep runs every LINK_SILENCE_MS/3 (30 s) in production; drive it
      // directly here rather than wait.
      await new Promise((r) => setTimeout(r, 250));
      (own as unknown as { reapOrphans(): void }).reapOrphans();
      await until(() => !own.held().includes(id), 3000, 'session ended');
      // The QUIT is on the wire; give the ircd its turn to read it.
      await ircd.waitForLine((x) => x.startsWith('QUIT :Lurker: no app returned'));
      expect(record.sent.some((x) => x.startsWith('QUIT :Lurker: no app returned'))).toBe(true);
    } finally {
      await own.shutdown('done', 200);
    }
  });
});

// The failure this partition exists to prevent is IRCCloud's July 2020 log
// exposure: two connection servers minted colliding ids in one id space, and a
// backlog fetch by id returned both users' logs. Lurker's ids are
// `<instance>:<userId>:<networkId>` where the last two are rowids from ONE
// Lurker database, so two Lurker instances on one engine would both mint
// `…:1:1` for unrelated people. `matchesDial` does not save you: two users on
// the same popular network dial the identical host/port/tls.
describe('instance isolation', () => {
  const OTHER = 'test-instance-b';

  it('refuses a hello with no instance at all', async () => {
    const l = await TestLink.open(enginePort);
    links.push(l);
    l.send({
      op: 'hello',
      protocol: PROTOCOL_MAJOR,
      secret: SECRET,
      app: { version: 'no-instance' },
    } as never);
    const f = await l.waitFor((x) => x.op === 'hello' || x.op === 'error');
    expect(f.op).toBe('error');
    expect((f as { message: string }).message).toMatch(/instance/);
  });

  it('does not let another instance attach to, write to, or close a held session', async () => {
    // Same id AND the same dial parameters — the collision matchesDial cannot see.
    const id = `${TEST_INSTANCE}:1:1`;
    const a = await link();
    await register(a, id, 'ownernick');
    a.send({ op: 'write', id, line: 'JOIN #secret' });
    await a.waitForLine(id, /JOIN #secret/);
    ackAll(a, id);
    a.kill();
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.held()).toContain(id);

    const intruder = await TestLink.connect(enginePort, SECRET, { instance: OTHER });
    links.push(intruder);
    // It is not even told the session exists.
    expect(intruder.hello?.held).not.toContain(id);

    // Attaching to it is refused outright — not silently closed and redialed,
    // which would hand the intruder a socket under the owner's id.
    intruder.send(connectFrame(id));
    const err = await intruder.waitFor((f) => f.op === 'error' || f.op === 'attached');
    expect(err.op).toBe('error');
    expect((err as { message: string }).message).toMatch(/another instance/);
    expect(engine.held()).toContain(id);

    // Driving it is refused too — every op, not just attach. waitForNew,
    // because the refusal above is already sitting in `frames`.
    for (const op of ['write', 'ack', 'detach', 'close'] as const) {
      intruder.send(
        op === 'write'
          ? { op, id, line: 'PRIVMSG #secret :hello' }
          : op === 'ack'
            ? { op, id, seq: 1 }
            : { op, id },
      );
      const f = await intruder.waitForNew((x) => x.op === 'error', 3000);
      expect((f as { message: string }).message).toMatch(/another instance/);
    }
    expect(engine.held()).toContain(id);

    // And the owner still gets its own session back, intact.
    const owner = await link();
    expect(owner.hello?.held).toContain(id);
    owner.send(connectFrame(id));
    const att = await owner.waitFor<Attached>((f) => f.op === 'attached');
    expect(att.nick).toBe('ownernick');
    expect(att.channels).toEqual(['#secret']);
    owner.send({ op: 'close', id });
    await gone(engine, id);
  });
});
