// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven end-to-end tests for the bouncer: a real TCP client attaches to
// the real listener against a fake upstream. See test-utils/bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-integration');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  harness = await harnessMod.startHarness();
});

afterAll(() => {
  harness.stop();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

describe('PASS login (ZNC-compat floor)', () => {
  it('attaches with PASS user:secret and replays a welcome burst', async () => {
    const acct = harnessMod.seedAccount({ nick: 'welcomer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    const welcome = await c.waitForCommand('001');
    expect(welcome).toContain('001');
    // Nick moves onto the live upstream nick, then MOTD-missing closes the burst.
    await c.waitFor((l) => l.includes('NICK') && l.includes('welcomer'));
    await c.waitForCommand('422');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });

  it('rejects a bad password with 464 and no attach', async () => {
    const acct = harnessMod.seedAccount();
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:wrongpassword`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('464');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('accepts a read-write API token as the secret', async () => {
    const acct = harnessMod.seedAccount({ nick: 'tokuser' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.token}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });
});

// #892. The attach burst replays the network's own 001–005, saved at
// registration exactly as they came off the wire. Per-delivery tags on them are
// stale by the time a client attaches, so, like ZNC, the replay keeps at most
// `time`, and only for a server-time client. The numeric still has to be
// pointed at the nick the client asked for.
describe('replayed registration burst', () => {
  const TIME = '2026-09-06T05:04:37.800Z';

  function seedTaggedBurst(acct: import('../test-utils/bouncerHarness.js').HarnessAccount): void {
    const nick = acct.upstream.currentNick;
    acct.upstream.registrationLines = [
      `@time=${TIME};msgid=w1 :irc.example.test 001 ${nick} :Welcome to the Example IRC Network`,
      `@time=${TIME};msgid=w5 :irc.example.test 005 ${nick} CHANTYPES=# PREFIX=(ov)@+ :are supported by this server`,
    ];
  }

  it('keeps only the time tag for a message-tags client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'livetags' });
    seedTaggedBurst(acct);
    const c = await harness.connect();
    c.send('CAP LS 302');
    c.send('CAP REQ :message-tags server-time');
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP END');
    await c.waitForCommand('422');
    expect(await c.waitForCommand('001')).toBe(
      `@time=${TIME} :irc.example.test 001 client :Welcome to the Example IRC Network`,
    );
  });

  it('strips the tags for a client that requested no caps', async () => {
    const acct = harnessMod.seedAccount({ nick: 'livenick' });
    seedTaggedBurst(acct);
    const c = await harness.connect();
    // The reporter's exchange: list the caps, request none.
    c.send('CAP LS 302');
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP END');
    await c.waitForCommand('422');
    expect(c.lines.filter((l) => l.startsWith('@'))).toEqual([]);
    expect(await c.waitForCommand('001')).toBe(
      ':irc.example.test 001 client :Welcome to the Example IRC Network',
    );
    expect(await c.waitForCommand('005')).toBe(
      ':irc.example.test 005 client CHANTYPES=# PREFIX=(ov)@+ :are supported by this server',
    );
  });

  it('keeps the time tag for a server-time client, and rewrites the nick past it', async () => {
    const acct = harnessMod.seedAccount({ nick: 'livetime' });
    seedTaggedBurst(acct);
    const c = await harness.connect();
    c.send('CAP LS 302');
    c.send('CAP REQ :server-time');
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP END');
    await c.waitForCommand('422');
    expect(await c.waitForCommand('001')).toBe(
      `@time=${TIME} :irc.example.test 001 client :Welcome to the Example IRC Network`,
    );
  });
});

function saslPlain(authcid: string, passwd: string, authzid = ''): string {
  const NUL = String.fromCharCode(0);
  return Buffer.from([authzid, authcid, passwd].join(NUL), 'utf8').toString('base64');
}

describe('SASL PLAIN', () => {
  it('advertises sasl=PLAIN under CAP 302 and bare sasl otherwise', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    const ls302 = await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls302).toContain('sasl=PLAIN');
    c.close();

    const c2 = await harness.connect();
    c2.send('CAP LS');
    const ls = await c2.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    expect(ls).toContain('sasl');
    expect(ls).not.toContain('sasl=');
    c2.close();
  });

  it('authenticates via SASL PLAIN and attaches', async () => {
    const acct = harnessMod.seedAccount({ nick: 'saslnick' });
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK') && l.includes('sasl'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('001');
    expect(harnessMod.attachedFor(acct)).toBe(1);
  });

  it('reads the network from the SASL authcid', async () => {
    const acct = harnessMod.seedAccount({ nick: 'net1', networkName: 'primary' });
    const second = harnessMod.seedNetwork(acct.user, { networkName: 'secondary', nick: 'net2' });
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(`${acct.user.username}/secondary`, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('001');
    // Attached to the network named in the authcid, not the first one.
    expect(harnessMod.attachedFor(acct)).toBe(0);
    expect(bouncerMod.attachedSessionCount(acct.user.id, second.network.id)).toBe(1);
  });

  it('rejects a bad SASL password with 904 and does not attach', async () => {
    const acct = harnessMod.seedAccount();
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, 'wrongpassword')}`);
    await c.waitForCommand('904');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('rejects a paused account at SASL time (before signaling 903)', async () => {
    const acct = harnessMod.seedAccount();
    const { setUserPaused } = await import('../db/users.js');
    setUserPaused(acct.user.id, true);
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    const line = await c.waitForCommand('904');
    expect(line).toContain('paused');
    expect(harnessMod.attachedFor(acct)).toBe(0);
  });

  it('offers the mechanism list (908) for an unknown SASL mechanism', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE SCRAM-SHA-256');
    const list = await c.waitForCommand('908');
    expect(list).toContain('PLAIN');
    await c.waitForCommand('904');
    c.close();
  });

  it('handles a client-aborted exchange (906)', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send('AUTHENTICATE *');
    const line = await c.waitForCommand('906');
    expect(line).toContain('aborted');
    c.close();
  });

  it('rejects an over-long multi-chunk SASL response (904)', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('CAP REQ :sasl');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    // 8 KiB cap ÷ 400 per chunk → ~21 full chunks trips it.
    const chunk = 'A'.repeat(400);
    for (let i = 0; i < 25; i++) c.send(`AUTHENTICATE ${chunk}`);
    const line = await c.waitForCommand('904');
    expect(line).toContain('too long');
    c.close();
  });

  it('rejects AUTHENTICATE before the sasl cap is requested', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('AUTHENTICATE PLAIN');
    const line = await c.waitForCommand('904');
    expect(line).toContain('sasl capability');
    c.close();
  });
});

describe('live relay', () => {
  it('relays an upstream PRIVMSG to the attached client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'relayer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    acct.upstream.pushUpstream(':bob!b@h PRIVMSG #chan :hello there');
    const line = await c.waitFor((l) => l.includes('PRIVMSG #chan'));
    expect(line).toBe(':bob!b@h PRIVMSG #chan :hello there');
  });

  it('relays a client TAGMSG with its client-only typing tag to the upstream', async () => {
    const acct = harnessMod.seedAccount({ nick: 'typer' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('@+typing=active TAGMSG #chan');
    // PING is handled locally and in-order after TAGMSG, so a PONG proves the
    // TAGMSG was already processed and relayed.
    c.send('PING sync');
    await c.waitFor((l) => l.includes('PONG'));
    expect(acct.upstream.rawSent).toContain('@+typing=active TAGMSG #chan');
  });

  it('strips client-only tags when the upstream lacks message-tags', async () => {
    const acct = harnessMod.seedAccount({ nick: 'plainnet' });
    acct.upstream.messageTags = false;
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('@+typing=active TAGMSG #chan');
    c.send('PING sync');
    await c.waitFor((l) => l.includes('PONG'));
    // The bare command still forwards; the tag prefix is dropped so a non-IRCv3
    // server doesn't parse `@+typing=active` as the command.
    expect(acct.upstream.rawSent).toContain('TAGMSG #chan');
    expect(acct.upstream.rawSent.some((l) => l.includes('+typing'))).toBe(false);
  });

  // #809. ircManager now refuses a write on a network in reconnect backoff rather
  // than persisting a message that never reaches IRC. The bouncer ignored the
  // boolean, so for a BYOC client the line simply evaporated — no error, no echo,
  // nothing. It has to say so, because unlike the web composer there is no toast.
  it('tells the client when the upstream is not writable, and sends nothing', async () => {
    const acct = harnessMod.seedAccount({ nick: 'downstream' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    acct.upstream.state = 'reconnecting';
    c.send('PRIVMSG #chan :are you there');
    const notice = await c.waitFor((l) => l.includes('NOTICE') && l.includes('not sent'));
    expect(notice).toContain('reconnecting');
    // ⚠ And nothing left for the network. registerEcho is skipped too, so the
    // keys don't sit in the pending list waiting to time out.
    expect(acct.upstream.rawSent.some((l) => l.includes('are you there'))).toBe(false);
  });

  it('never forwards a post-registration AUTHENTICATE to the upstream', async () => {
    const acct = harnessMod.seedAccount({ nick: 'noauth' });
    const c = await harness.connect();
    c.send(`PASS ${acct.user.username}:${acct.password}`);
    c.send('NICK client');
    c.send('USER client 0 * :client');
    await c.waitForCommand('422');
    c.send('AUTHENTICATE OHNOACREDENTIAL');
    await c.waitForCommand('904');
    // The credential-bearing line must not have reached the real network.
    expect(acct.upstream.rawSent.some((l) => l.includes('AUTHENTICATE'))).toBe(false);
  });
});

// Helpers for the cap tests below.
type Account = import('../test-utils/bouncerHarness.js').HarnessAccount;
type Client = import('../test-utils/bouncerHarness.js').BouncerClient;
let syncs = 0;

// Lines reach a client in the order they were written, so once the PONG to a
// fresh PING arrives, everything written before it has arrived too.
async function sync(c: Client): Promise<void> {
  const token = `sync-${++syncs}`;
  c.send(`PING ${token}`);
  await c.waitFor((l) => l.includes('PONG') && l.endsWith(`:${token}`));
}

// Register with `ls` (CAP LS 302 by default) and `caps` requested, and return
// once the attach burst is through, so it can't land in what relay() returns.
async function attach(acct: Account, caps: string[] = [], ls = 'CAP LS 302'): Promise<Client> {
  const c = await harness.connect();
  c.send(ls);
  if (caps.length > 0) c.send(`CAP REQ :${caps.join(' ')}`);
  c.send(`PASS ${acct.user.username}:${acct.password}`);
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send('CAP END');
  await sync(c);
  return c;
}

// Push `lines` from the network, then a sentinel, and return what the client
// got in between. Anything filtered out never arrives before the sentinel.
async function relay(acct: Account, c: Client, lines: string[]): Promise<string[]> {
  const from = c.lines.length;
  const sentinel = `sentinel-${++syncs}`;
  for (const line of lines) acct.upstream.pushUpstream(line);
  acct.upstream.pushUpstream(`:bot!b@h PRIVMSG #chan :${sentinel}`);
  await c.waitFor((l) => l.endsWith(`:${sentinel}`));
  return c.lines.slice(from).filter((l) => !l.endsWith(`:${sentinel}`));
}

// The cap names in a CAP LS / LIST / NEW / DEL line, without values.
function capsIn(line: string): string[] {
  return line
    .slice(line.lastIndexOf(':') + 1)
    .split(' ')
    .filter(Boolean)
    .map((cap) => cap.split('=')[0]);
}

// #926. The network talks to Lurker with the caps Lurker negotiated upstream,
// and the relay used to pass what it sent straight on. A client now gets only
// what it negotiated itself: soju's SendMessage and ZNC's PutClient rules.
describe("relayed lines follow the client's caps", () => {
  it('sends no AWAY to a client that asked only for echo-message', async () => {
    const acct = harnessMod.seedAccount({ nick: 'slakker' });
    const c = await attach(acct, ['echo-message']);
    // The reporter's lines, plus one going away rather than coming back.
    const got = await relay(acct, c, [
      ':meidam!meidam@FXNet.qylxi4wx.cagf6i3v.yehsgrdh.fx AWAY',
      ':Dark77!Dark77@outofspace.1337 AWAY',
      ':okawari!okawari@FXNet.oiri6mtj.nqjxkq3z.m7abhdem.fx AWAY',
      ':alice!a@h AWAY :lunch',
    ]);
    expect(got).toEqual([]);
  });

  it('trims extended-join, multi-prefix and userhost-in-names from relayed lines', async () => {
    const acct = harnessMod.seedAccount({ nick: 'trimmer' });
    const c = await attach(acct);
    const got = await relay(acct, c, [
      ':alice!a@h JOIN #chan alice :Alice A',
      ':irc.example.test 353 trimmer = #chan :@+alice!a@h bob!b@h',
      ':irc.example.test 366 trimmer #chan :End of /NAMES list.',
      ':irc.example.test 352 trimmer #chan a h irc.example.test alice H@+ :0 Alice A',
    ]);
    expect(got).toEqual([
      ':alice!a@h JOIN #chan',
      ':irc.example.test 353 trimmer = #chan :@alice bob',
      ':irc.example.test 366 trimmer #chan :End of /NAMES list.',
      ':irc.example.test 352 trimmer #chan a h irc.example.test alice H@ :0 Alice A',
    ]);
  });

  it('drops ACCOUNT and invites for other people, but not an invite for us', async () => {
    const acct = harnessMod.seedAccount({ nick: 'invitee' });
    const c = await attach(acct);
    const got = await relay(acct, c, [
      ':alice!a@h ACCOUNT alice',
      ':op!o@h INVITE someone #chan',
      ':op!o@h INVITE invitee #chan',
    ]);
    expect(got).toEqual([':op!o@h INVITE invitee #chan']);
  });

  it("sends another user's host change as the QUIT, JOIN and MODE a network would", async () => {
    const acct = harnessMod.seedAccount({ nick: 'watcher' });
    acct.upstream.addChannel('#ops', { members: ['watcher', '@alice'] });
    acct.upstream.addChannel('#lounge', { members: ['watcher', 'alice'] });
    const c = await attach(acct, ['server-time']);
    const TIME = '2026-09-12T19:33:25.000Z';
    const got = await relay(acct, c, [
      `@time=${TIME};msgid=h1 :alice!old@old.host CHGHOST new new.host`,
      // Our own change gets no fallback: the network reports it with a 396.
      ':watcher!w@fake.host CHGHOST w cloak/watcher',
    ]);
    expect(got).toEqual([
      `@time=${TIME} :alice!old@old.host QUIT :Changing hostname`,
      `@time=${TIME} :alice!new@new.host JOIN #ops`,
      `@time=${TIME} :lurker.bouncer MODE #ops +o alice`,
      `@time=${TIME} :alice!new@new.host JOIN #lounge`,
    ]);
  });

  it('opens a network batch only for a client that negotiated batch', async () => {
    const netsplit = [
      ':irc.example.test BATCH +ns netsplit a.example.test b.example.test',
      '@batch=ns :carol!c@h QUIT :a.example.test b.example.test',
      ':irc.example.test BATCH -ns',
    ];
    const tagsOnly = harnessMod.seedAccount({ nick: 'tagsonly' });
    const c1 = await attach(tagsOnly, ['message-tags']);
    expect(await relay(tagsOnly, c1, netsplit)).toEqual([
      ':carol!c@h QUIT :a.example.test b.example.test',
    ]);

    const batched = harnessMod.seedAccount({ nick: 'batched' });
    const c2 = await attach(batched, ['message-tags', 'batch']);
    expect(await relay(batched, c2, netsplit)).toEqual(netsplit);
  });

  it('unwraps a multiline batch for a client, which never has draft/multiline', async () => {
    const acct = harnessMod.seedAccount({ nick: 'reader' });
    const c = await attach(acct, ['message-tags', 'batch']);
    const got = await relay(acct, c, [
      '@msgid=ml1;account=bob :bob!b@h BATCH +ml draft/multiline #chan',
      '@batch=ml :bob!b@h PRIVMSG #chan hello',
      '@batch=ml :bob!b@h PRIVMSG #chan :',
      '@batch=ml :bob!b@h PRIVMSG #chan :how is ',
      '@batch=ml;draft/multiline-concat :bob!b@h PRIVMSG #chan :everyone?',
      ':irc.example.test BATCH -ml',
    ]);
    expect(got).toEqual([
      '@msgid=ml1;account=bob :bob!b@h PRIVMSG #chan hello',
      '@account=bob :bob!b@h PRIVMSG #chan :how is ',
      '@account=bob :bob!b@h PRIVMSG #chan :everyone?',
    ]);
  });

  it("keeps the network's time on unwrapped multiline lines for a server-time client", async () => {
    const acct = harnessMod.seedAccount({ nick: 'timely' });
    const c = await attach(acct, ['server-time']);
    const TIME = '2026-09-12T08:00:00.000Z';
    const got = await relay(acct, c, [
      `@time=${TIME};msgid=ml2 :bob!b@h BATCH +ml2 draft/multiline #chan`,
      '@batch=ml2 :bob!b@h PRIVMSG #chan :first',
      '@batch=ml2 :bob!b@h PRIVMSG #chan :second',
      ':irc.example.test BATCH -ml2',
    ]);
    expect(got).toEqual([
      `@time=${TIME} :bob!b@h PRIVMSG #chan :first`,
      `@time=${TIME} :bob!b@h PRIVMSG #chan :second`,
    ]);
  });
});

// soju's pass-through caps: offered while the bound network has them, so a
// client that supports away-notify, extended-join and the rest gets those lines,
// and a client on a network without them is told so with CAP DEL.
describe('pass-through caps follow the bound network', () => {
  const PASSTHROUGH = [
    'away-notify',
    'account-notify',
    'account-tag',
    'chghost',
    'extended-join',
    'multi-prefix',
    'userhost-in-names',
  ];

  it('lists them for CAP LS 302 before registration, and not for a plain CAP LS', async () => {
    const c302 = await harness.connect();
    c302.send('CAP LS 302');
    const offered = capsIn(await c302.waitFor((l) => l.includes(' LS ')));
    for (const cap of [...PASSTHROUGH, 'cap-notify', 'invite-notify']) {
      expect(offered).toContain(cap);
    }
    c302.close();

    const c301 = await harness.connect();
    c301.send('CAP LS');
    const plain = capsIn(await c301.waitFor((l) => l.includes(' LS ')));
    expect(plain).toContain('invite-notify');
    expect(plain).not.toContain('away-notify');
    c301.close();
  });

  it('delivers what a client asked for when the network has it', async () => {
    const acct = harnessMod.seedAccount({ nick: 'capable' });
    const c = await attach(acct, ['away-notify', 'account-notify', 'extended-join']);
    const lines = [
      ':alice!a@h AWAY :lunch',
      ':alice!a@h ACCOUNT alice',
      ':alice!a@h JOIN #chan alice :Alice A',
    ];
    expect(await relay(acct, c, lines)).toEqual(lines);
  });

  it('takes back what the network lacks with CAP DEL, before the welcome', async () => {
    const acct = harnessMod.seedAccount({ nick: 'sparse' });
    acct.upstream.client.network.cap.enabled = ['message-tags', 'server-time'];
    const c = await attach(acct, ['away-notify', 'server-time']);
    const del = c.lines.findIndex((l) => harnessMod.commandOf(l) === 'CAP' && l.includes(' DEL '));
    const welcome = c.lines.findIndex((l) => harnessMod.commandOf(l) === '001');
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(welcome);
    expect(capsIn(c.lines[del])).toEqual(PASSTHROUGH);

    c.send('CAP LIST');
    const list = capsIn(await c.waitFor((l) => l.includes(' LIST ')));
    expect(list).toContain('server-time');
    expect(list).not.toContain('away-notify');
    expect(await relay(acct, c, [':alice!a@h AWAY :lunch'])).toEqual([]);
  });

  it('takes every one back from a control connection, which has no network', async () => {
    const acct = harnessMod.seedAccount({ nick: 'controller' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second' });
    const c = await attach(acct, ['away-notify']);
    const del = c.lines.find((l) => harnessMod.commandOf(l) === 'CAP' && l.includes(' DEL '));
    expect(del && capsIn(del)).toEqual(PASSTHROUGH);
  });

  it('offers them with CAP NEW once a connecting network connects', async () => {
    const acct = harnessMod.seedAccount({ nick: 'latecomer' });
    acct.upstream.state = 'connecting';
    const c = await attach(acct, ['away-notify']);
    expect(c.lines.some((l) => l.includes(' DEL ') && l.includes('away-notify'))).toBe(true);

    acct.upstream.state = 'connected';
    harnessMod.emitNetworkState(acct.user.id, acct.network.id, 'connected');
    const added = await c.waitFor((l) => harnessMod.commandOf(l) === 'CAP' && l.includes(' NEW '));
    expect(capsIn(added)).toEqual(PASSTHROUGH);
    c.send('CAP REQ :away-notify');
    // Not waitFor(ACK): the ACK from registration is already there to match.
    await sync(c);
    expect(c.lines.filter((l) => l.includes(' ACK ') && l.includes('away-notify'))).toHaveLength(2);
    expect(await relay(acct, c, [':alice!a@h AWAY :lunch'])).toEqual([':alice!a@h AWAY :lunch']);
  });

  it('offers a cap the network grants after registration', async () => {
    const acct = harnessMod.seedAccount({ nick: 'grantee' });
    acct.upstream.client.network.cap.enabled = ['server-time'];
    const c = await attach(acct, ['server-time']);
    acct.upstream.client.network.cap.enabled = ['server-time', 'away-notify'];
    acct.upstream.client.emit('cap ack', { command: 'ACK', capabilities: { 'away-notify': '' } });
    const added = await c.waitFor((l) => harnessMod.commandOf(l) === 'CAP' && l.includes(' NEW '));
    expect(capsIn(added)).toEqual(['away-notify']);
  });

  it('lets a pre-302 client ask for them once it has registered', async () => {
    const acct = harnessMod.seedAccount({ nick: 'oldclient' });
    const c = await attach(acct, [], 'CAP LS');
    c.send('CAP LS');
    const offered = capsIn(await c.waitFor((l) => l.includes(' LS ') && l.includes('away-notify')));
    expect(offered).toContain('extended-join');
    c.send('CAP REQ :away-notify');
    await c.waitFor((l) => l.includes(' ACK ') && l.includes('away-notify'));
  });

  it('keeps cap-notify on once CAP LS 302 turned it on', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    c.send('CAP REQ :-cap-notify');
    expect(await c.waitFor((l) => l.includes(' NAK '))).toContain('-cap-notify');
    c.close();
  });

  it('sends CHGHOST itself to a chghost client, with no fallback', async () => {
    const acct = harnessMod.seedAccount({ nick: 'hostwatch' });
    acct.upstream.addChannel('#ops', { members: ['hostwatch', '@alice'] });
    const c = await attach(acct, ['chghost']);
    const change = ':alice!old@old.host CHGHOST new new.host';
    expect(await relay(acct, c, [change])).toEqual([change]);
  });

  it('replays channels with an extended JOIN, every prefix and hostmasks, trimmed per client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'replayer' });
    const room = acct.upstream.addChannel('#room', { members: ['replayer', '@carol'] });
    room.members.set('replayer', { nick: 'replayer', modes: [], account: 'replayacct' });
    room.members.set('carol', { nick: 'carol', modes: ['o', 'v'], user: 'c', host: 'carol.host' });

    const full = await attach(acct, ['extended-join', 'multi-prefix', 'userhost-in-names']);
    expect(full.lines).toContain(':replayer!replayer@fake.host JOIN #room replayacct :replayer');
    expect(full.lines).toContain(
      ':lurker.bouncer 353 replayer = #room :replayer @+carol!c@carol.host',
    );

    const plain = await attach(acct);
    expect(plain.lines).toContain(':replayer!replayer@fake.host JOIN #room');
    expect(plain.lines).toContain(':lurker.bouncer 353 replayer = #room :replayer @carol');
  });

  it('stamps a time on relayed lines that arrive without one, for a server-time client', async () => {
    const acct = harnessMod.seedAccount({ nick: 'stamped' });
    const c = await attach(acct, ['server-time']);
    const [line] = await relay(acct, c, [':alice!a@h PRIVMSG #chan :no time on this']);
    expect(line).toMatch(/^@time=[0-9-]+T[0-9:.]+Z :alice!a@h PRIVMSG #chan :no time on this$/);
  });
});
