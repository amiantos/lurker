// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven tests for IRCv3 draft/chathistory: CHATHISTORY BEFORE/AFTER/
// LATEST/BETWEEN/AROUND/TARGETS over the message store. See bouncerHarness.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-bouncer-chathistory');

let harnessMod: typeof import('../test-utils/bouncerHarness.js');
let bouncerMod: typeof import('./bouncer.js');
let insertMessage: typeof import('../db/messages.js').insertMessage;
let addReaction: typeof import('../db/reactions.js').addReaction;
let removeReaction: typeof import('../db/reactions.js').removeReaction;
let db: typeof import('../db/index.js').default;
let harness: import('../test-utils/bouncerHarness.js').Harness;

beforeAll(async () => {
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  harnessMod = await import('../test-utils/bouncerHarness.js');
  bouncerMod = await import('./bouncer.js');
  ({ insertMessage } = await import('../db/messages.js'));
  ({ addReaction, removeReaction } = await import('../db/reactions.js'));
  db = (await import('../db/index.js')).default;
  harness = await harnessMod.startHarness();
});

afterAll(() => {
  harness.stop();
  ctx.cleanup();
});

beforeEach(() => {
  bouncerMod.resetAuthThrottle();
});

const NUL = String.fromCharCode(0);
function saslPlain(authcid: string, passwd: string): string {
  return Buffer.from(['', authcid, passwd].join(NUL), 'utf8').toString('base64');
}

type Client = Awaited<ReturnType<import('../test-utils/bouncerHarness.js').Harness['connect']>>;

const HISTORY_CAPS = 'sasl batch server-time message-tags draft/chathistory';

// Bind a single-network account (auto-binds without bouncer-networks) with the
// history-relevant caps negotiated.
async function attachBound(
  c: Client,
  acct: { user: { username: string }; password: string },
  caps = HISTORY_CAPS,
): Promise<void> {
  c.send('CAP LS 302');
  await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
  c.send('NICK client');
  c.send('USER client 0 * :client');
  c.send(`CAP REQ :${caps}`);
  await c.waitFor((l) => l.includes('ACK'));
  c.send('AUTHENTICATE PLAIN');
  await c.waitFor((l) => l === 'AUTHENTICATE +');
  c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
  await c.waitForCommand('903');
  c.send('CAP END');
  await c.waitForCommand('422');
}

function seedMessages(networkId: number, target: string, n: number): number[] {
  const ids: number[] = [];
  for (let i = 1; i <= n; i++) {
    ids.push(
      Number(
        insertMessage({
          networkId,
          target,
          time: `2023-05-23T06:00:0${i}.000Z`,
          type: 'message',
          nick: 'bob',
          userhost: 'bob!u@h',
          text: `msg${i}`,
          self: false,
        }).id,
      ),
    );
  }
  return ids;
}

// Collect the BOUNCER... err, chathistory batch lines between BATCH +/- for a ref.
function batchBodies(lines: string[], ref: string): string[] {
  return lines.filter((l) => l.includes(`@batch=${ref}`) || l.includes(`;batch=${ref}`));
}

describe('CHATHISTORY advertisement', () => {
  it('advertises CHATHISTORY + MSGREFTYPES in ISUPPORT when the cap is negotiated', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch1' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('CHATHISTORY='));
    expect(isupport).toBeTruthy();
    expect(isupport).toContain('CHATHISTORY=1000');
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    c.close();
  });
});

describe('attach playback', () => {
  // A joined channel and a DM, both with history.
  async function attachWithHistory(nick: string, caps: string): Promise<Client> {
    const acct = harnessMod.seedAccount({ nick });
    acct.upstream.addChannel('#room', { members: [nick, 'bob'] });
    seedMessages(acct.network.id, '#room', 2);
    seedMessages(acct.network.id, 'bob', 1);
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    // Playback goes out in the same pass as the 422, so the PONG comes after it.
    c.send('PING sync');
    await c.waitForCommand('PONG');
    return c;
  }

  it('sends none to a client that negotiated draft/chathistory', async () => {
    // soju skips it too (downstream.go:1841): the client fetches its own
    // history, so a replay shows every line twice.
    const c = await attachWithHistory('ap1', HISTORY_CAPS);
    expect(c.lines.some((l) => l.includes('JOIN #room'))).toBe(true);
    expect(c.lines.filter((l) => l.includes(' PRIVMSG '))).toEqual([]);
    c.close();
  });

  it('still replays channels and DMs to a client without it', async () => {
    const c = await attachWithHistory('ap2', 'sasl batch server-time message-tags');
    expect(c.lines.some((l) => l.includes('PRIVMSG #room :msg2'))).toBe(true);
    expect(c.lines.some((l) => l.includes('PRIVMSG ap2 :msg1'))).toBe(true);
    c.close();
  });

  it("carries the network's msgid to a client with message-tags", async () => {
    const acct = harnessMod.seedAccount({ nick: 'ap3' });
    acct.upstream.addChannel('#room', { members: ['ap3', 'bob'] });
    insertMessage({
      networkId: acct.network.id,
      target: '#room',
      time: '2023-05-23T06:00:01.000Z',
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: 'played back',
      self: false,
      msgid: 'upstream-pb-1',
    });
    const c = await harness.connect();
    await attachBound(c, acct, 'sasl batch server-time message-tags');
    c.send('PING sync');
    await c.waitForCommand('PONG');
    const line = c.lines.find((l) => l.includes('PRIVMSG #room :played back'));
    expect(line).toContain(';msgid=upstream-pb-1 :bob!u@h');
    c.close();
  });
});

describe('CHATHISTORY LATEST', () => {
  it('returns the newest messages oldest-first, in a chathistory batch with time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch2' });
    seedMessages(acct.network.id, '#room', 3);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #room * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    expect(open).toContain('chathistory #room');
    const m1 = await c.waitFor((l) => l.includes('PRIVMSG #room :msg1'));
    expect(m1).toContain('time=2023-05-23T06:00:01.000Z');
    expect(m1).toContain(`batch=${ref}`);
    await c.waitFor((l) => l.includes('msg3'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('CHATHISTORY msgids', () => {
  const BACKSLASH = String.fromCharCode(92);
  const NEWLINE = String.fromCharCode(10);

  // One stored message in #tagged, then the batch CHATHISTORY returns for it.
  async function historyOf(
    nick: string,
    row: Partial<Parameters<typeof insertMessage>[0]>,
    caps = HISTORY_CAPS,
  ): Promise<string[]> {
    const acct = harnessMod.seedAccount({ nick });
    insertMessage({
      networkId: acct.network.id,
      target: '#tagged',
      time: '2023-05-23T06:00:01.000Z',
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: 'tagged msg',
      self: false,
      ...row,
    });
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    c.send('CHATHISTORY LATEST #tagged * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    return batchBodies(c.lines, ref);
  }

  it("carries the network's msgid, not Lurker's row id", async () => {
    // The spec wants the msgid "as originally sent by the IRC server", the one a
    // client saw on the line live. A row id was a second id for the same message.
    const lines = await historyOf('mid1', { msgid: 'upstream-uuid-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(';msgid=upstream-uuid-1 :bob!u@h PRIVMSG #tagged :tagged msg');
  });

  it('carries no msgid for a message the network gave none', async () => {
    const lines = await historyOf('mid2', {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });

  it('escapes the msgid as a tag value', async () => {
    const lines = await historyOf('mid3', { msgid: `a;b c${BACKSLASH}d` });
    const escaped = `a${BACKSLASH}:b${BACKSLASH}sc${BACKSLASH}${BACKSLASH}d`;
    expect(lines[0]).toContain(`;msgid=${escaped} :bob!u@h PRIVMSG`);
  });

  it('puts the msgid on the first line of a multiline message, and sends no blank lines', async () => {
    // As the live multiline fallback does: halloy drops a later line that
    // repeats an id as a duplicate.
    const text = ['one', 'two', '', 'three'].join(NEWLINE);
    const lines = await historyOf('mid4', { msgid: 'ml-1', text });
    expect(lines.map((l) => l.slice(l.indexOf(' :bob!u@h ')))).toEqual([
      ' :bob!u@h PRIVMSG #tagged :one',
      ' :bob!u@h PRIVMSG #tagged :two',
      ' :bob!u@h PRIVMSG #tagged :three',
    ]);
    expect(lines[0]).toContain('msgid=ml-1');
    expect(lines.slice(1).some((l) => l.includes('msgid='))).toBe(false);
  });

  it('carries no msgid for a decrypted E2E message', async () => {
    // Its msgid names the ciphertext line, which the client got live under that
    // id. halloy would take this readable copy as a duplicate of that one.
    const lines = await historyOf('mid5', { msgid: 'cipher-1', extra: { e2e: true } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });

  it('carries no msgid to a client without message-tags', async () => {
    const lines = await historyOf(
      'mid6',
      { msgid: 'upstream-uuid-6' },
      'sasl batch server-time draft/chathistory',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('msgid=');
  });
});

describe('CHATHISTORY BEFORE / AFTER (timestamp, exclusive)', () => {
  it('BEFORE excludes messages at or after the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch3' });
    seedMessages(acct.network.id, '#r', 4); // at :01 :02 :03 :04
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY BEFORE #r timestamp=2023-05-23T06:00:03.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    await c.waitFor((l) => l.includes('msg1'));
    await c.waitFor((l) => l.includes('msg2'));
    await c.waitFor((l) => l.includes('BATCH -'));
    // msg3 (at the bound) and msg4 must NOT appear.
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg3'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg4'))).toBe(false);
  });

  it('AFTER excludes messages at or before the timestamp', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch4' });
    seedMessages(acct.network.id, '#r', 4);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY AFTER #r timestamp=2023-05-23T06:00:02.000Z 100');
    await c.waitFor((l) => l.includes('BATCH +'));
    await c.waitFor((l) => l.includes('msg3'));
    await c.waitFor((l) => l.includes('msg4'));
    await c.waitFor((l) => l.includes('BATCH -'));
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg1'))).toBe(false);
    expect(c.lines.some((l) => l.includes('PRIVMSG #r :msg2'))).toBe(false);
  });

  it('a netsplit of joins does not truncate the batch (limit counts real messages)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chns' });
    seedMessages(acct.network.id, '#split', 1); // one real message at :01
    // Then a flood of joins (non-replayable) at :02..:09.
    for (let i = 2; i <= 9; i++) {
      insertMessage({
        networkId: acct.network.id,
        target: '#split',
        time: `2023-05-23T06:00:0${i}.000Z`,
        type: 'join',
        nick: `joiner${i}`,
        self: false,
      });
    }
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #split * 3');
    await c.waitFor((l) => l.includes('BATCH +'));
    // The real message is returned even though the newest rows are all joins.
    const line = await c.waitFor((l) => l.includes('PRIVMSG #split :msg1'));
    expect(line).toContain('PRIVMSG #split :msg1');
    await c.waitFor((l) => l.includes('BATCH -'));
  });
});

describe('CHATHISTORY msgid rejected', () => {
  it('rejects a msgid selector (timestamp-only, MSGREFTYPES=timestamp)', async () => {
    const acct = harnessMod.seedAccount({ nick: 'chm' });
    const c = await harness.connect();
    await attachBound(c, acct);
    const isupport = c.lines.find((l) => l.includes('MSGREFTYPES'));
    expect(isupport).toContain('MSGREFTYPES=timestamp');
    expect(isupport).not.toContain('msgid');
    c.send('CHATHISTORY BEFORE #r msgid=5 100');
    const fail = await c.waitForCommand('FAIL');
    // A well-formed selector of a type we don't implement gets the spec's
    // dedicated code, NOT INVALID_PARAMS — the client's syntax was fine, the
    // reftype isn't offered, and only INVALID_MSGREFTYPE says so.
    //
    // Asserted as a full param sequence, not substrings: the spec layout is
    // `<command> <target> [context]`, and a substring check would happily pass
    // while the target was missing and the client mistook `msgid=5` for a
    // buffer name.
    expect(fail).toContain('FAIL CHATHISTORY INVALID_MSGREFTYPE BEFORE #r msgid=5 :');
    expect(fail).toContain('Unsupported message reference type');
    c.close();
  });
});

describe('CHATHISTORY TARGETS', () => {
  it('lists active buffers with their last-activity time', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch6' });
    seedMessages(acct.network.id, '#alpha', 2);
    seedMessages(acct.network.id, '#beta', 1);
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send(
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100',
    );
    const open = await c.waitFor((l) => l.includes('draft/chathistory-targets'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const alpha = await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #alpha'));
    // The target line carries the buffer's last-activity server-time.
    expect(alpha).toContain('2023-05-23T06:00:02.000Z');
    expect(alpha).toContain(`@batch=${ref}`);
    await c.waitFor((l) => l.includes('CHATHISTORY TARGETS #beta'));
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
  });
});

describe('CHATHISTORY errors', () => {
  it('rejects a limit over the advertised maximum', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch7' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #r * 99999');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid limit');
    c.close();
  });

  it('rejects a malformed bound', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch8' });
    const c = await harness.connect();
    await attachBound(c, acct);
    // A SUPPORTED reftype carrying an unparseable value — that's a syntax error
    // the client can fix, so it stays INVALID_PARAMS. (Deliberately not a
    // `msgid=` selector: that's an unsupported reftype, covered above.)
    c.send('CHATHISTORY BEFORE #r timestamp=notatimestamp 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_PARAMS');
    expect(fail).toContain('Invalid first bound');
    c.close();
  });

  it('refuses CHATHISTORY on a control (unbound) connection', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch9' });
    harnessMod.seedNetwork(acct.user, { networkName: 'second', nick: 'ch9b' });
    const c = await harness.connect();
    // Control mode: bouncer-networks cap, no network selector.
    c.send('CAP LS 302');
    await c.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    c.send('NICK client');
    c.send('USER client 0 * :client');
    c.send('CAP REQ :sasl draft/chathistory soju.im/bouncer-networks');
    await c.waitFor((l) => l.includes('ACK'));
    c.send('AUTHENTICATE PLAIN');
    await c.waitFor((l) => l === 'AUTHENTICATE +');
    c.send(`AUTHENTICATE ${saslPlain(acct.user.username, acct.password)}`);
    await c.waitForCommand('903');
    c.send('CAP END');
    await c.waitForCommand('422');
    c.send('CHATHISTORY LATEST #r * 100');
    const fail = await c.waitForCommand('FAIL');
    expect(fail).toContain('INVALID_TARGET');
    c.close();
  });

  it('returns an empty batch (not a FAIL) when there is no history', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ch10' });
    const c = await harness.connect();
    await attachBound(c, acct);
    c.send('CHATHISTORY LATEST #empty * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +') && l.includes('chathistory'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    const close = await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    expect(close).toBeTruthy();
    expect(batchBodies(c.lines, ref)).toHaveLength(0);
  });
});

describe('draft/event-playback', () => {
  const EVENT_CAPS = `${HISTORY_CAPS} draft/event-playback`;
  const at = (s: number) => `2023-05-23T06:00:${String(s).padStart(2, '0')}.000Z`;

  // Rows in `target`, one second apart from :01, then the lines one CHATHISTORY
  // command returns for them.
  async function history(
    nick: string,
    target: string,
    rows: Array<Partial<Parameters<typeof insertMessage>[0]>>,
    command: string,
    caps = EVENT_CAPS,
  ): Promise<{ lines: string[]; ref: string }> {
    const acct = harnessMod.seedAccount({ nick });
    rows.forEach((row, i) =>
      insertMessage({
        networkId: acct.network.id,
        target,
        time: at(i + 1),
        type: 'message',
        nick: 'bob',
        self: false,
        ...row,
      } as Parameters<typeof insertMessage>[0]),
    );
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    c.send(command);
    const open = await c.waitFor((l) => l.includes('BATCH +'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    return { lines: batchBodies(c.lines, ref), ref };
  }

  const EVENTS: Array<Partial<Parameters<typeof insertMessage>[0]>> = [
    { type: 'message', nick: 'bob', userhost: 'bob!u@h', text: 'hi' },
    { type: 'join', nick: 'alice', userhost: 'alice!a@h', extra: { account: 'alice' } },
    { type: 'part', nick: 'alice', userhost: 'alice!a@h', text: 'bye now' },
    { type: 'quit', nick: 'carol', userhost: 'carol!c@h', text: 'Quit: gone' },
    { type: 'nick', nick: 'dave', userhost: 'dave!d@h', extra: { newNick: 'david' } },
    { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'spam', extra: { kicked: 'eve' } },
    { type: 'mode', nick: 'op', text: '+o bob', extra: { modes: [] } },
    { type: 'topic', nick: 'op', text: 'new topic' },
  ];

  it('is offered', async () => {
    const c = await harness.connect();
    c.send('CAP LS 302');
    const ls = await c.waitFor((l) => l.includes(' LS '));
    expect(ls).toContain('draft/event-playback');
    c.close();
  });

  it('replays joins, parts, quits, nick changes, kicks, and mode and topic changes', async () => {
    // With extended-join, which a plain JOIN must still go out as.
    const { lines, ref } = await history(
      'ep1',
      '#ev',
      EVENTS,
      'CHATHISTORY LATEST #ev * 100',
      `${EVENT_CAPS} extended-join`,
    );
    const tag = (s: number) => `@batch=${ref};time=${at(s)} `;
    expect(lines).toEqual([
      `${tag(1)}:bob!u@h PRIVMSG #ev :hi`,
      // Plain: the realname an extended JOIN carries isn't stored.
      `${tag(2)}:alice!a@h JOIN #ev`,
      `${tag(3)}:alice!a@h PART #ev :bye now`,
      `${tag(4)}:carol!c@h QUIT :Quit: gone`,
      `${tag(5)}:dave!d@h NICK david`,
      `${tag(6)}:op!o@h KICK #ev eve :spam`,
      // Mode and topic rows store no mask, so the setter goes out bare.
      `${tag(7)}:op MODE #ev +o bob`,
      `${tag(8)}:op TOPIC #ev :new topic`,
    ]);
  });

  it('leaves off an empty reason, but keeps a cleared topic', async () => {
    const { lines } = await history(
      'ep10',
      '#ev',
      [
        { type: 'part', nick: 'alice', userhost: 'alice!a@h', text: null },
        { type: 'quit', nick: 'carol', userhost: 'carol!c@h', text: '' },
        { type: 'kick', nick: 'op', userhost: 'op!o@h', text: null, extra: { kicked: 'eve' } },
        { type: 'topic', nick: 'op', text: '' },
      ],
      'CHATHISTORY LATEST #ev * 100',
    );
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([
      ':alice!a@h PART #ev',
      ':carol!c@h QUIT',
      ':op!o@h KICK #ev eve',
      ':op TOPIC #ev :',
    ]);
  });

  it('replays only messages to a client that did not ask', async () => {
    const { lines } = await history(
      'ep2',
      '#ev',
      EVENTS,
      'CHATHISTORY LATEST #ev * 100',
      HISTORY_CAPS,
    );
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([':bob!u@h PRIVMSG #ev :hi']);
  });

  it('leaves out host changes and invites, which soju replays neither of', async () => {
    const { lines } = await history(
      'ep3',
      '#ev',
      [
        { type: 'join', nick: 'alice', userhost: 'alice!a@h' },
        { type: 'chghost', nick: 'alice', userhost: 'alice!a@h', extra: { newHost: 'h2' } },
        { type: 'invite', nick: 'op', extra: { invited: 'frank' } },
      ],
      // The newest rows are the ones left out, so they mustn't use up the limit.
      'CHATHISTORY LATEST #ev * 1',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(':alice!a@h JOIN #ev');
  });

  it('counts events toward the limit', async () => {
    const { lines } = await history('ep4', '#ev', EVENTS, 'CHATHISTORY LATEST #ev * 3');
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['KICK', 'MODE', 'TOPIC']);
  });

  // goguma applies every replayed line to its live state: an old PART from its
  // own nick marks the channel as left, an old NICK from it renames us.
  it('leaves out events naming our current nick, before the limit is applied', async () => {
    const { lines } = await history(
      'ep5',
      '#ev',
      [
        { type: 'join', nick: 'zed', userhost: 'zed!z@h' },
        { type: 'kick', nick: 'EP5', userhost: 'EP5!e@h', text: 'bye', extra: { kicked: 'zed' } },
        { type: 'join', nick: 'Ep5', userhost: 'Ep5!e@h' },
        { type: 'part', nick: 'ep5', userhost: 'ep5!e@h', text: 'later' },
        { type: 'nick', nick: 'EP5', userhost: 'EP5!e@h', extra: { newNick: 'ep5_' } },
        { type: 'quit', nick: 'ep5', userhost: 'ep5!e@h', text: 'bye' },
        { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'out', extra: { kicked: 'eP5' } },
      ],
      'CHATHISTORY LATEST #ev * 2',
    );
    // Our kick of someone else still goes, and nothing else fills the limit.
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([
      ':zed!z@h JOIN #ev',
      ':EP5!e@h KICK #ev zed :bye',
    ]);
  });

  // goguma compares nicks under the network's CASEMAPPING, so the filter does.
  it("compares our nick under the network's casemapping", async () => {
    const { default: db } = await import('../db/index.js');
    const { invalidateCasemappingCache } = await import('../db/buffers.js');
    type Row = Partial<Parameters<typeof insertMessage>[0]>;
    const replayed = async (nick: string, casemapping: string, rows: Row[]) => {
      const acct = harnessMod.seedAccount({ nick });
      db.prepare('UPDATE networks SET casemapping = ? WHERE id = ?').run(
        casemapping,
        acct.network.id,
      );
      invalidateCasemappingCache(acct.network.id);
      rows.forEach((row, i) =>
        insertMessage({
          networkId: acct.network.id,
          target: '#ev',
          time: at(i + 1),
          self: false,
          ...row,
        } as Parameters<typeof insertMessage>[0]),
      );
      const c = await harness.connect();
      await attachBound(c, acct, EVENT_CAPS);
      c.send('CHATHISTORY LATEST #ev * 100');
      const open = await c.waitFor((l) => l.includes('BATCH +'));
      const ref = open.split('BATCH +')[1].split(' ')[0];
      await c.waitFor((l) => l.includes(`BATCH -${ref}`));
      c.close();
      return batchBodies(c.lines, ref).map((l) => l.split(' ')[2] + ' ' + l.split(' ')[1]);
    };
    const brackets: Row[] = [
      { type: 'join', nick: 'Ep{11}^', userhost: 'Ep{11}^!e@h' },
      { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'out', extra: { kicked: 'EP[11]~' } },
      { type: 'join', nick: 'zed', userhost: 'zed!z@h' },
    ];
    // rfc1459: [ ] \ ^ are the capitals of { } | ~.
    expect(await replayed('ep[11]~', 'rfc1459', brackets)).toEqual(['JOIN :zed!z@h']);
    // ascii: they're different characters, so both lines are someone else's.
    expect(await replayed('ep[11]^', 'ascii', brackets)).toEqual([
      'JOIN :Ep{11}^!e@h',
      'KICK :op!o@h',
      'JOIN :zed!z@h',
    ]);
    const unicode: Row[] = [
      { type: 'join', nick: 'ÄLICE', userhost: 'ÄLICE!a@h' },
      { type: 'kick', nick: 'op', userhost: 'op!o@h', text: 'out', extra: { kicked: 'ÄLiCe' } },
      { type: 'join', nick: 'zed', userhost: 'zed!z@h' },
    ];
    // rfc7613 folds Unicode: Ä is the capital of ä.
    expect(await replayed('älice', 'rfc7613', unicode)).toEqual(['JOIN :zed!z@h']);
    // ascii folds only A-Z.
    expect(await replayed('älice', 'ascii', unicode)).toEqual([
      'JOIN :ÄLICE!a@h',
      'KICK :op!o@h',
      'JOIN :zed!z@h',
    ]);
  });

  it('names the server as the source of a mode it set, whatever its name', async () => {
    const { lines } = await history(
      'ep6',
      '#ev',
      [
        { type: 'mode', nick: 'irc.example.net', text: '+nt', extra: { modes: [] } },
        { type: 'mode', nick: 'localhost', text: '+s', extra: { modes: [] } },
      ],
      'CHATHISTORY LATEST #ev * 100',
    );
    expect(lines.map((l) => l.slice(l.indexOf(' :') + 1))).toEqual([
      ':irc.example.net MODE #ev +nt',
      ':localhost MODE #ev +s',
    ]);
  });

  it('lists a buffer with only events among TARGETS, for a client that asked', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    const rows = [{ type: 'join', nick: 'alice', userhost: 'alice!a@h' }];
    const withEvents = await history('ep7', '#joinsonly', rows, window);
    expect(withEvents.lines.some((l) => l.includes('TARGETS #joinsonly'))).toBe(true);
    const without = await history('ep8', '#joinsonly', rows, window, HISTORY_CAPS);
    expect(without.lines.some((l) => l.includes('TARGETS #joinsonly'))).toBe(false);
  });

  it("keeps a buffer's joins from using up its attach playback", async () => {
    const acct = harnessMod.seedAccount({ nick: 'ep9' });
    acct.upstream.addChannel('#busy', { members: ['ep9', 'bob'] });
    seedMessages(acct.network.id, '#busy', 2);
    for (let s = 3; s <= 6; s++) {
      insertMessage({
        networkId: acct.network.id,
        target: '#busy',
        time: at(s),
        type: 'join',
        nick: `joiner${s}`,
        self: false,
      });
    }
    process.env.LURKER_BOUNCER_PLAYBACK = '2';
    try {
      const c = await harness.connect();
      await attachBound(c, acct, 'sasl batch server-time message-tags draft/event-playback');
      c.send('PING sync');
      await c.waitForCommand('PONG');
      expect(c.lines.filter((l) => l.includes('PRIVMSG #busy'))).toHaveLength(2);
      // Attach playback never replays events, even to a client that asked.
      expect(c.lines.some((l) => l.includes('joiner'))).toBe(false);
      c.close();
    } finally {
      delete process.env.LURKER_BOUNCER_PLAYBACK;
    }
  });
});

// #991: history carries what a reply and a reaction were on the wire. A reply
// line gets its +reply tags back; a reaction comes back as the TAGMSG that made
// it, in time order among the lines, to the clients soju sends them to.
describe('replies and reactions in history', () => {
  const REACT_CAPS = `${HISTORY_CAPS} draft/event-playback`;
  const at = (s: number) => `2023-05-23T06:00:${String(s).padStart(2, '0')}.000Z`;
  type Row = Partial<Parameters<typeof insertMessage>[0]>;
  type Reaction = {
    on: number;
    nick: string;
    value: string;
    time: number;
    self?: boolean;
    // Taken back at this second (#1009).
    removed?: number;
  };

  // Rows in `target` at the given seconds, reactions on them, then the lines one
  // command's batch returns.
  async function history(
    nick: string,
    target: string,
    rows: Array<Row & { s: number }>,
    reactions: Reaction[],
    command: string,
    caps = REACT_CAPS,
  ): Promise<{ lines: string[]; ref: string }> {
    const acct = harnessMod.seedAccount({ nick });
    const ids = rows.map(({ s, ...row }) =>
      Number(
        insertMessage({
          networkId: acct.network.id,
          target,
          time: at(s),
          type: 'message',
          nick: 'bob',
          userhost: 'bob!u@h',
          self: false,
          ...row,
        } as Parameters<typeof insertMessage>[0]).id,
      ),
    );
    for (const r of reactions) {
      addReaction({
        messageId: ids[r.on],
        networkId: acct.network.id,
        nick: r.nick,
        userhost: `${r.nick}!${r.nick[0]}@h`,
        value: r.value,
        self: !!r.self,
        toSelf: false,
        time: at(r.time),
      });
      if (r.removed !== undefined) {
        removeReaction(ids[r.on], r.nick, r.value, !!r.self, at(r.removed));
      }
    }
    const c = await harness.connect();
    await attachBound(c, acct, caps);
    c.send(command);
    const open = await c.waitFor((l) => l.includes('BATCH +'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    return { lines: batchBodies(c.lines, ref), ref };
  }

  const reply = (msgid: string) => `+draft/reply=${msgid};+reply=${msgid}`;

  it('tags a replayed reply with the msgid it answers', async () => {
    const { lines, ref } = await history(
      'rr1',
      '#r',
      [
        { s: 1, msgid: 'p1', text: 'which branch?' },
        {
          s: 2,
          msgid: 'r1',
          text: 'the release one',
          nick: 'carol',
          userhost: 'carol!c@h',
          replyMsgid: 'p1',
        },
      ],
      [],
      'CHATHISTORY LATEST #r * 100',
      HISTORY_CAPS,
    );
    expect(lines).toEqual([
      `@batch=${ref};time=${at(1)};msgid=p1 :bob!u@h PRIVMSG #r :which branch?`,
      `@batch=${ref};time=${at(2)};msgid=r1;${reply('p1')} :carol!c@h PRIVMSG #r :the release one`,
    ]);
  });

  it('tags only the first line of a multiline reply, and nothing without message-tags', async () => {
    const rows = [{ s: 1, msgid: 'r1', text: 'one\ntwo', replyMsgid: 'p1' }];
    const tagged = await history(
      'rr2',
      '#r',
      rows,
      [],
      'CHATHISTORY LATEST #r * 100',
      HISTORY_CAPS,
    );
    expect(tagged.lines).toHaveLength(2);
    expect(tagged.lines[0]).toContain(reply('p1'));
    expect(tagged.lines[1]).not.toContain('reply=');
    const plain = await history(
      'rr3',
      '#r',
      rows,
      [],
      'CHATHISTORY LATEST #r * 100',
      'sasl batch server-time draft/chathistory',
    );
    expect(plain.lines.some((l) => l.includes('reply='))).toBe(false);
  });

  it('tags a reply in attach playback too', async () => {
    const acct = harnessMod.seedAccount({ nick: 'rr4' });
    acct.upstream.addChannel('#att', { members: ['rr4', 'bob'] });
    insertMessage({
      networkId: acct.network.id,
      target: '#att',
      time: at(1),
      type: 'message',
      nick: 'bob',
      userhost: 'bob!u@h',
      text: 'sure',
      self: false,
      replyMsgid: 'p1',
    });
    const c = await harness.connect();
    await attachBound(c, acct, 'sasl batch server-time message-tags');
    c.send('PING sync');
    await c.waitForCommand('PONG');
    expect(c.lines.find((l) => l.includes('PRIVMSG #att :sure'))).toContain(reply('p1'));
    c.close();
  });

  it('replays a reaction as its TAGMSG, at its own time among the lines', async () => {
    const { lines, ref } = await history(
      'rx1',
      '#x',
      [
        { s: 1, msgid: 'p1', text: 'which branch?' },
        { s: 2, msgid: 'p2', text: 'anyone?' },
        { s: 4, msgid: 'p3', text: 'ok' },
      ],
      // On the first line, made after the second: it sits at :03, not beside
      // the line it's on. A second one at :02 sorts after the line at :02.
      [
        { on: 0, nick: 'alice', value: '👍', time: 3 },
        { on: 1, nick: 'carol', value: 'same', time: 2 },
      ],
      'CHATHISTORY LATEST #x * 100',
    );
    const tag = (s: number) => `@batch=${ref};time=${at(s)}`;
    expect(lines).toEqual([
      `${tag(1)};msgid=p1 :bob!u@h PRIVMSG #x :which branch?`,
      `${tag(2)};msgid=p2 :bob!u@h PRIVMSG #x :anyone?`,
      `${tag(2)};+draft/react=same;${reply('p2')} :carol!c@h TAGMSG #x`,
      `${tag(3)};+draft/react=👍;${reply('p1')} :alice!a@h TAGMSG #x`,
      `${tag(4)};msgid=p3 :bob!u@h PRIVMSG #x :ok`,
    ]);
  });

  // halloy pages on the times a batch holds, reactions included, so a reaction
  // counts toward the limit and the next page starts where this one ended.
  it('counts reactions toward the limit, and pages on without a gap', async () => {
    const rows = [
      { s: 1, msgid: 'p1', text: 'one' },
      { s: 2, msgid: 'p2', text: 'two' },
      { s: 4, msgid: 'p3', text: 'four' },
    ];
    const reactions = [{ on: 0, nick: 'alice', value: '👍', time: 3 }];
    const latest = await history('rx2', '#x', rows, reactions, 'CHATHISTORY LATEST #x * 2');
    expect(latest.lines.map((l) => l.split(' ').slice(1).join(' '))).toEqual([
      ':alice!a@h TAGMSG #x',
      ':bob!u@h PRIVMSG #x :four',
    ]);
    const before = await history(
      'rx3',
      '#x',
      rows,
      reactions,
      `CHATHISTORY BEFORE #x timestamp=${at(3)} 2`,
    );
    expect(before.lines.map((l) => l.split(' :').pop())).toEqual(['one', 'two']);
    const after = await history(
      'rx4',
      '#x',
      rows,
      reactions,
      `CHATHISTORY AFTER #x timestamp=${at(2)} 1`,
    );
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]).toContain('TAGMSG #x');
  });

  // soju's rule: only an event-playback client gets them, and a TAGMSG never
  // reaches a client without message-tags. Neither counts them.
  it('replays no reactions to a client without event-playback or message-tags', async () => {
    const rows = [
      { s: 1, msgid: 'p1', text: 'one' },
      { s: 2, msgid: 'p2', text: 'two' },
    ];
    const reactions = [{ on: 0, nick: 'alice', value: '👍', time: 3 }];
    for (const [nick, caps] of [
      ['rx5', HISTORY_CAPS],
      ['rx6', 'sasl batch server-time draft/chathistory draft/event-playback'],
    ]) {
      const { lines } = await history(
        nick,
        '#x',
        rows,
        reactions,
        'CHATHISTORY LATEST #x * 2',
        caps,
      );
      expect({ caps, lines: lines.map((l) => l.split(' :').pop()) }).toEqual({
        caps,
        lines: ['one', 'two'],
      });
    }
  });

  it('addresses our own reaction in a DM as our own line, only to a client that takes those', async () => {
    const rows = [{ s: 1, msgid: 'p1', text: 'hi', nick: 'bob', userhost: 'bob!u@h' }];
    const reactions = [{ on: 0, nick: 'rx7', value: '👋', time: 2, self: true }];
    const withEcho = await history(
      'rx7',
      'bob',
      rows,
      reactions,
      'CHATHISTORY LATEST bob * 10',
      `${REACT_CAPS} echo-message`,
    );
    expect(withEcho.lines[1]).toContain(`${reply('p1')} :rx7!r@h TAGMSG bob`);
    const without = await history(
      'rx8',
      'bob',
      rows,
      [{ ...reactions[0], nick: 'rx8' }],
      'CHATHISTORY LATEST bob * 10',
    );
    expect(without.lines.some((l) => l.includes('TAGMSG'))).toBe(false);
  });

  it('lists a buffer whose only news is a reaction among TARGETS, for a client that takes them', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T06:00:02.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    const rows = [{ s: 1, msgid: 'p1', text: 'old line' }];
    const reactions = [{ on: 0, nick: 'alice', value: '👍', time: 5 }];
    const taker = await history('rx9', '#quiet', rows, reactions, window);
    expect(taker.lines.find((l) => l.includes('TARGETS #quiet'))).toContain(
      `TARGETS #quiet ${at(5)}`,
    );
    const other = await history('rx10', '#quiet', rows, reactions, window, HISTORY_CAPS);
    expect(other.lines.some((l) => l.includes('TARGETS #quiet'))).toBe(false);
  });

  // A client that takes no self-messages is sent none of our DM lines, so
  // they, our reactions and reactions on our lines stay out of the window
  // itself: a batch short of its limit reads as the start of history.
  it('fills the limit without our own DM lines, for a client that takes none', async () => {
    const rows = [
      { s: 1, msgid: 'a', text: 'first' },
      { s: 2, msgid: 'm', text: 'mine', nick: 'sx1', userhost: 'sx1!s@h', self: true },
      { s: 3, msgid: 'b', text: 'second' },
    ];
    const reactions = [
      { on: 1, nick: 'bob', value: '👍', time: 4 },
      { on: 0, nick: 'sx1', value: '👀', time: 5, self: true },
    ];
    const { lines } = await history('sx1', 'bob', rows, reactions, 'CHATHISTORY LATEST bob * 2');
    expect(lines.map((l) => l.split(' :').pop())).toEqual(['first', 'second']);
    // With echo-message they're ours to replay, and in the window.
    const echo = await history(
      'sx2',
      'bob',
      rows.map((r) => (r.self ? { ...r, nick: 'sx2', userhost: 'sx2!s@h' } : r)),
      [reactions[0], { ...reactions[1], nick: 'sx2' }],
      'CHATHISTORY LATEST bob * 2',
      `${REACT_CAPS} echo-message`,
    );
    expect(echo.lines.map((l) => l.split(' ')[1])).toEqual([':bob!b@h', ':sx2!s@h']);
    expect(echo.lines.every((l) => l.includes('TAGMSG'))).toBe(true);
  });

  // History replays a decrypted E2E line without a msgid, so nothing may name
  // it: no reply tag on an E2E reply, no reaction on an E2E line.
  it('names no E2E line: no reply tag, no reaction', async () => {
    const { lines } = await history(
      'e2x',
      '#sec',
      [
        { s: 1, msgid: 'c1', text: 'secret', extra: { e2e: true } },
        { s: 2, msgid: 'c2', text: 'reply', extra: { e2e: true }, replyMsgid: 'c1' },
        { s: 3, msgid: 'p3', text: 'plain' },
      ],
      [{ on: 0, nick: 'alice', value: '👍', time: 4 }],
      'CHATHISTORY LATEST #sec * 100',
    );
    expect(lines.map((l) => l.split(' :').pop())).toEqual(['secret', 'reply', 'plain']);
    expect(lines.some((l) => l.includes('reply=') || l.includes('TAGMSG'))).toBe(false);
  });

  // Only on a line the window replays: a reaction on a mirrored copy (or a
  // line without text) would be an orphan the client can't place.
  it('replays no reaction on a line the window leaves out', async () => {
    const { lines } = await history(
      'rp1',
      '#m',
      [
        { s: 1, msgid: 'm1', text: 'mirrored copy', type: 'notice', mirrored: true },
        { s: 2, msgid: 'p2', text: 'real' },
      ],
      [{ on: 0, nick: 'alice', value: '👍', time: 3 }],
      'CHATHISTORY LATEST #m * 100',
    );
    expect(lines.map((l) => l.split(' :').pop())).toEqual(['real']);
  });

  // `extra` is data from the network: a malformed one mustn't throw the window,
  // and a stray replyMsgid in it mustn't become a reply tag.
  it('survives a malformed extra, and takes no reply tag from one', async () => {
    const acct = harnessMod.seedAccount({ nick: 'ex1' });
    const line = (s: number, msgid: string, text: string) =>
      Number(
        insertMessage({
          networkId: acct.network.id,
          target: '#ex',
          time: at(s),
          type: 'message',
          nick: 'bob',
          userhost: 'bob!u@h',
          text,
          self: false,
          msgid,
        }).id,
      );
    const broken = line(1, 'p1', 'broken extra');
    const forged = line(2, 'p2', 'not a reply');
    db.prepare(`UPDATE messages SET extra = '{bad' WHERE id = ?`).run(broken);
    db.prepare(`UPDATE messages SET extra = ? WHERE id = ?`).run(
      JSON.stringify({ replyMsgid: 'p1' }),
      forged,
    );
    addReaction({
      messageId: broken,
      networkId: acct.network.id,
      nick: 'alice',
      userhost: 'alice!a@h',
      value: '👍',
      self: false,
      toSelf: false,
      time: at(3),
    });
    const c = await harness.connect();
    await attachBound(c, acct, REACT_CAPS);
    c.send('CHATHISTORY LATEST #ex * 100');
    const open = await c.waitFor((l) => l.includes('BATCH +'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.send(
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100',
    );
    await c.waitFor((l) => l.includes('TARGETS #ex'));
    c.close();
    const lines = batchBodies(c.lines, ref);
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['PRIVMSG', 'PRIVMSG', 'TAGMSG']);
    expect(lines[1]).not.toContain('reply=');
  });

  // Only an edited archive could store a reaction whose line is on another
  // network; TARGETS for the reaction's network mustn't list that buffer. (The
  // other network is a second account's here: a second network on this one
  // would stop the client auto-binding, and the join doesn't care whose it is.)
  it('lists no buffer from another network for a mismatched reaction', async () => {
    const acct = harnessMod.seedAccount({ nick: 'nm1' });
    const other = harnessMod.seedAccount({ nick: 'nm2' }).network;
    const elsewhere = Number(
      insertMessage({
        networkId: other.id,
        target: '#elsewhere',
        time: at(1),
        type: 'message',
        nick: 'bob',
        userhost: 'bob!u@h',
        text: 'on the other network',
        self: false,
        msgid: 'o1',
      }).id,
    );
    addReaction({
      messageId: elsewhere,
      networkId: acct.network.id,
      nick: 'alice',
      userhost: 'alice!a@h',
      value: '👍',
      self: false,
      toSelf: false,
      time: at(2),
    });
    const c = await harness.connect();
    await attachBound(c, acct, REACT_CAPS);
    c.send(
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100',
    );
    const open = await c.waitFor((l) => l.includes('BATCH +'));
    const ref = open.split('BATCH +')[1].split(' ')[0];
    await c.waitFor((l) => l.includes(`BATCH -${ref}`));
    c.close();
    expect(batchBodies(c.lines, ref).some((l) => l.includes('#elsewhere'))).toBe(false);
  });

  it('lists in TARGETS only reaction news a window would replay', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T06:00:02.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    // Our reaction in a DM: news to a client that takes self-messages only.
    const dm = [{ s: 1, msgid: 'p1', text: 'hi' }];
    const mine = [{ on: 0, nick: 'tg1', value: '👍', time: 5, self: true }];
    const noSelf = await history('tg1', 'bob', dm, mine, window);
    expect(noSelf.lines.some((l) => l.includes('TARGETS bob'))).toBe(false);
    const withSelf = await history(
      'tg2',
      'bob',
      dm,
      [{ ...mine[0], nick: 'tg2' }],
      window,
      `${REACT_CAPS} echo-message`,
    );
    expect(withSelf.lines.some((l) => l.includes('TARGETS bob'))).toBe(true);
    // A reaction on an E2E line is no one's news.
    const e2e = await history(
      'tg3',
      '#sec',
      [{ s: 1, msgid: 'c1', text: 'secret', extra: { e2e: true } }],
      [{ on: 0, nick: 'alice', value: '👍', time: 5 }],
      window,
    );
    expect(e2e.lines.some((l) => l.includes('TARGETS #sec'))).toBe(false);
  });

  // TARGETS lists a buffer, at a time, only for lines its window delivers: not
  // our own DM lines to a client that takes none, and never our lines to
  // services (they carry credentials). With and without reactions in play.
  it('lists no buffer or time in TARGETS for our lines a window leaves out', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T00:00:00.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    const listed = (lines: string[], target: string) =>
      lines
        .find((l) => l.includes(`TARGETS ${target} `))
        ?.split(' ')
        .pop() ?? null;
    for (const caps of [HISTORY_CAPS, REACT_CAPS]) {
      const tag = caps === REACT_CAPS ? 'r' : 'm';
      // A DM holding only our own line.
      const mine = (nick: string) => [
        { s: 1, msgid: 'p1', text: 'hi', nick, userhost: `${nick}!s@h`, self: true },
      ];
      const noSelf = await history(`ts1${tag}`, 'bob', mine(`ts1${tag}`), [], window, caps);
      expect({ caps, listed: listed(noSelf.lines, 'bob') }).toEqual({ caps, listed: null });
      const echo = await history(
        `ts2${tag}`,
        'bob',
        mine(`ts2${tag}`),
        [],
        window,
        `${caps} echo-message`,
      );
      expect({ caps, listed: listed(echo.lines, 'bob') }).toEqual({ caps, listed: at(1) });
      // NickServ: our IDENTIFY never counts, even with echo-message; its reply does.
      const services = await history(
        `ts3${tag}`,
        'NickServ',
        [
          {
            s: 1,
            msgid: 'n1',
            text: 'IDENTIFY hunter2',
            nick: `ts3${tag}`,
            userhost: `ts3${tag}!s@h`,
            self: true,
          },
          { s: 2, msgid: 'n2', text: 'You are now identified.', nick: 'NickServ' },
          { s: 3, msgid: 'n3', text: 'thanks', nick: `ts3${tag}`, self: true },
        ],
        [],
        window,
        `${caps} echo-message`,
      );
      expect({ caps, listed: listed(services.lines, 'NickServ') }).toEqual({
        caps,
        listed: at(2),
      });
    }
  });

  // #1009: a reaction taken back is replayed as the unreact that took it back,
  // at its own time — so a client that was away when it happened hears it.
  it('replays an unreact at the time it was taken back', async () => {
    const rows = [
      { s: 1, msgid: 'p1', text: 'which branch?' },
      { s: 3, msgid: 'p2', text: 'ok' },
    ];
    const reactions = [
      { on: 0, nick: 'alice', value: '👍', time: 2, removed: 4 },
      { on: 0, nick: 'carol', value: '🎉', time: 5 },
    ];
    const { lines, ref } = await history(
      'ur1',
      '#u',
      rows,
      reactions,
      'CHATHISTORY LATEST #u * 100',
    );
    const tag = (s: number) => `@batch=${ref};time=${at(s)}`;
    expect(lines).toEqual([
      `${tag(1)};msgid=p1 :bob!u@h PRIVMSG #u :which branch?`,
      `${tag(2)};+draft/react=👍;${reply('p1')} :alice!a@h TAGMSG #u`,
      `${tag(3)};msgid=p2 :bob!u@h PRIVMSG #u :ok`,
      `${tag(4)};+draft/unreact=👍;${reply('p1')} :alice!a@h TAGMSG #u`,
      `${tag(5)};+draft/react=🎉;${reply('p1')} :carol!c@h TAGMSG #u`,
    ]);
    // A page after the react still carries the unreact, and counts it.
    const after = await history(
      'ur2',
      '#u',
      rows,
      reactions,
      `CHATHISTORY AFTER #u timestamp=${at(3)} 1`,
    );
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]).toContain('+draft/unreact=👍');
    // A react and its unreact in the same millisecond: the react first.
    const same = await history(
      'ur3',
      '#u',
      [{ s: 1, msgid: 'p1', text: 'hi' }],
      [{ on: 0, nick: 'alice', value: '👍', time: 2, removed: 2 }],
      'CHATHISTORY LATEST #u * 100',
    );
    expect(same.lines.map((l) => l.includes('+draft/unreact'))).toEqual([false, false, true]);
  });

  it('lists a buffer whose only news is an unreact among TARGETS', async () => {
    const window =
      'CHATHISTORY TARGETS timestamp=2023-05-23T06:00:05.000Z timestamp=2023-05-24T00:00:00.000Z 100';
    const { lines } = await history(
      'ur4',
      '#quiet2',
      [{ s: 1, msgid: 'p1', text: 'old line' }],
      [{ on: 0, nick: 'alice', value: '👍', time: 2, removed: 7 }],
      window,
    );
    expect(lines.find((l) => l.includes('TARGETS #quiet2'))).toContain(`TARGETS #quiet2 ${at(7)}`);
  });

  it('keeps reactions out of attach playback, as soju does', async () => {
    const acct = harnessMod.seedAccount({ nick: 'rx11' });
    acct.upstream.addChannel('#att', { members: ['rx11', 'bob'] });
    const id = Number(
      insertMessage({
        networkId: acct.network.id,
        target: '#att',
        time: at(1),
        type: 'message',
        nick: 'bob',
        userhost: 'bob!u@h',
        text: 'hi',
        self: false,
        msgid: 'p1',
      }).id,
    );
    addReaction({
      messageId: id,
      networkId: acct.network.id,
      nick: 'alice',
      value: '👍',
      self: false,
      toSelf: false,
      time: at(2),
    });
    const c = await harness.connect();
    await attachBound(c, acct, 'sasl batch server-time message-tags draft/event-playback');
    c.send('PING sync');
    await c.waitForCommand('PONG');
    expect(c.lines.some((l) => l.includes('PRIVMSG #att :hi'))).toBe(true);
    expect(c.lines.some((l) => l.includes('TAGMSG'))).toBe(false);
    c.close();
  });
});
