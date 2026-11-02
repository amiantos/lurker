// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Closing a buffer: what `/close`, the Close Channel menu item and a bouncer
// client's second PART all run (wsHub.closeBuffer).
//
// The claim under test is the PART gate. A close owes the network a PART only
// while we are actually on the channel; for one we already left — parted from
// another client, kicked, or dropped by the server — the PART is answered 442,
// which lands in the server buffer and reaches every attached bouncer client
// (#967). Autojoin comes down either way, so a closed channel never returns on
// the next connect.
//
// Against a real IrcConnection on the fake ircd: whether a PART reached the
// network is the whole question, so the wire is where it is asked.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import {
  getState,
  isAutojoin,
  ensureOpen,
  close as closeRow,
  invalidateCasemappingCache,
} from '../db/buffers.js';
import db from '../db/index.js';
import { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { until } from '../test-utils/until.js';

let ircManager: typeof import('./ircManager.js').default;
let closeBuffer: typeof import('./wsHub.js').closeBuffer;
let ircd: FakeIrcd;
let userId: number;
let seq = 0;

beforeAll(async () => {
  ircManager = (await import('./ircManager.js')).default;
  ({ closeBuffer } = await import('./wsHub.js'));
  ircd = await FakeIrcd.start({});
  userId = createUser('close-buffer').id;
});

afterAll(async () => {
  await ircd.close();
});

function makeNetwork(nick: string): Network {
  return createNetwork(userId, {
    name: `close-${seq++}`,
    host: '127.0.0.1',
    port: ircd.port,
    tls: false,
    nick,
    autoconnect: false,
  })!;
}

/** A connected network whose channel joins have echoed. */
async function connected(nick: string, channels: string[] = []) {
  const network = makeNetwork(nick);
  const conn = ircManager.startNetwork(userId, network.id)!;
  await until(() => conn.state === 'connected', 5000, 'connected');
  for (const chan of channels) {
    ircManager.joinChannel(userId, network.id, chan);
    await until(() => conn.isChannelJoined(chan), 5000, `joined ${chan}`);
  }
  return { network, conn };
}

/** Every line this network's connection put on the wire. */
function sentTo(nick: string): string[] {
  const client = ircd.clients.filter((c) => c.nick === nick).at(-1);
  if (!client) throw new Error(`no ${nick} on the fake ircd`);
  return client.sent;
}

/** Every PART on the wire, tag block and all — the filter has to see what the
 *  code under test sees, or a tagged line silently counts as no PART at all. */
function partsSent(nick: string): string[] {
  return sentTo(nick).filter((line) => /^\s*(?:@\S+\s+)?PART\s/i.test(line));
}

/**
 * Wait until the ircd has a line the connection wrote AFTER the one under
 * test. The socket is written in order, so the probe arriving is proof that
 * anything the close would have sent is already in the ircd's log — which a
 * bare assertion right after a synchronous close is not, since the write it is
 * denying would still be in flight.
 */
async function probe(conn: { raw(line: string): void }, nick: string, tag: string) {
  conn.raw(`PING :${tag}`);
  await until(() => sentTo(nick).some((line) => line.includes(tag)), 5000, `probe ${tag}`);
}

describe('closeBuffer parts only a channel we are on', () => {
  it('parts the channel we are still in', async () => {
    const { network, conn } = await connected('closejoined', ['#here']);

    closeBuffer(userId, network.id, '#here');
    await until(() => partsSent('closejoined').length > 0, 5000, 'PART sent');

    expect(partsSent('closejoined')).toEqual(['PART #here']);
    expect(getState(userId, network.id, '#here')).toBe('closed');
    expect(isAutojoin(userId, network.id, '#here')).toBe(false);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('sends nothing for a channel we already left, and still lowers autojoin', async () => {
    const { network, conn } = await connected('closeparted', ['#gone']);
    // What another client's PART leaves behind: off the channel, buffer still
    // in the list.
    ircManager.partChannel(userId, network.id, '#gone');
    await until(() => !conn.isChannelJoined('#gone'), 5000, 'parted #gone');
    expect(getState(userId, network.id, '#gone')).toBe('open');
    const before = partsSent('closeparted').length;

    closeBuffer(userId, network.id, '#gone');
    await probe(conn, 'closeparted', 'closeprobe');

    expect(partsSent('closeparted')).toHaveLength(before);
    expect(getState(userId, network.id, '#gone')).toBe('closed');
    expect(isAutojoin(userId, network.id, '#gone')).toBe(false);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('leaves the PART to the replay mid-restore, and the replay sends it', async () => {
    // An engine re-attach replays the joined set one JOIN at a time into a
    // socket that never dropped. The replay reconciles as it goes: a channel
    // whose row says autojoin=0 or closed is PARTed right there ("this is that
    // PART, late"). So a close in that window writes the row and stops — and
    // the PART follows when that channel's turn comes. Sending one here too
    // would put two on the wire, and the loser draws the 442.
    const { network, conn } = await connected('closerestore');
    ensureOpen(userId, network.id, '#replaying', { kind: 'channel', autojoin: true });
    conn.restoring = true;
    expect(conn.isChannelJoined('#replaying')).toBe(false);

    closeBuffer(userId, network.id, '#replaying');
    await probe(conn, 'closerestore', 'restoreprobe');
    expect(partsSent('closerestore')).toEqual([]);
    expect(getState(userId, network.id, '#replaying')).toBe('closed');

    // The replayed JOIN for it, which is where the PART comes from.
    conn.client.emit('join', { channel: '#replaying', nick: conn.currentNick });
    await until(() => partsSent('closerestore').length > 0, 5000, 'replay parted it');

    expect(partsSent('closerestore')).toEqual(['PART #replaying']);
    conn.restoring = false;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('clears the pending mark on a replayed join that the replay then parts', async () => {
    // The restoring arm of the join handler returns early, and its late-PART
    // path drops the channel from the map again. If the mark outlived that,
    // nothing would ever clear it — a re-attach doesn't dial, and only a dial
    // forgets the set — so every later close of that channel would PART one we
    // had already left, which is #967 again.
    const { network, conn } = await connected('closereplaymark');
    ircManager.joinChannel(userId, network.id, '#marked');
    expect(conn.mayBeJoined('#marked')).toBe(true); // JOIN on the wire
    // A row closed while we were away: what the replay reconciles. Closed at
    // the db, not through closeBuffer — that would PART it here (the mark is
    // set), and this test is about the PART the REPLAY sends.
    ensureOpen(userId, network.id, '#marked', { kind: 'channel' });
    closeRow(userId, network.id, '#marked');

    conn.restoring = true;
    conn.client.emit('join', { channel: '#marked', nick: conn.currentNick });
    conn.restoring = false;
    await until(() => partsSent('closereplaymark').length > 0, 5000, 'replay parted it');

    expect(conn.isChannelJoined('#marked')).toBe(false);
    expect(conn.mayBeJoined('#marked')).toBe(false);
    // And a later close of the same buffer adds nothing to the wire.
    closeBuffer(userId, network.id, '#marked');
    await probe(conn, 'closereplaymark', 'markprobe');

    expect(partsSent('closereplaymark')).toEqual(['PART #marked']);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts a channel whose JOIN has not echoed yet', async () => {
    // Membership is echo-written, so between a JOIN and its echo the map says
    // "not joined" for a channel we are about to be in. Closing there used to
    // be harmless — the PART went out behind the JOIN — and a gate that reads
    // the map alone would send nothing, let the echo reopen the buffer
    // (wsHub's reopensClosedBuffer) and leave the user in a channel they had
    // just closed.
    const { network, conn } = await connected('closepending');
    ircd.hold = (cmd) => cmd === 'JOIN'; // the echo never comes
    ircManager.joinChannel(userId, network.id, '#inflight');
    await until(() => sentTo('closepending').some((l) => l.startsWith('JOIN ')), 5000, 'JOIN sent');
    expect(conn.isChannelJoined('#inflight')).toBe(false);

    closeBuffer(userId, network.id, '#inflight');
    await until(() => partsSent('closepending').length > 0, 5000, 'PART sent');

    expect(partsSent('closepending')).toEqual(['PART #inflight']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts one channel out of a batched rejoin that has not echoed', async () => {
    // The reconnect rejoin doesn't send a JOIN per channel — planChannelRejoins
    // packs them, `JOIN #a,#b,#c` up to the line limit — and an echo names one.
    // Marking the blob would leave an entry no echo clears and no lookup
    // matches, so the guard would be inert on exactly the path where a close
    // races a join most often: the burst right after a reconnect.
    const { network, conn } = await connected('closebatch');
    ircd.hold = (cmd) => cmd === 'JOIN'; // no echoes
    conn.join('#bat1,#bat2');
    await until(() => sentTo('closebatch').some((l) => l.startsWith('JOIN ')), 5000, 'JOIN sent');
    expect(conn.isChannelJoined('#bat2')).toBe(false);

    closeBuffer(userId, network.id, '#bat2');
    await until(() => partsSent('closebatch').length > 0, 5000, 'PART sent');

    expect(partsSent('closebatch')).toEqual(['PART #bat2']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('sends nothing after a redundant join of a channel we are in', async () => {
    // joinChannel sends the JOIN even for a channel we are demonstrably in
    // (an attached client's own autojoin list is the ordinary source), and the
    // server answers a duplicate JOIN with nothing at all — the fake ircd
    // `continue`s on it, as real ones do. A mark left by that would never be
    // cleared, and would outlive the part that follows.
    const { network, conn } = await connected('closeredundant', ['#again']);
    ircManager.joinChannel(userId, network.id, '#again'); // the redundant one
    ircManager.partChannel(userId, network.id, '#again');
    await until(() => !conn.isChannelJoined('#again'), 5000, 'parted #again');
    expect(conn.mayBeJoined('#again')).toBe(false);
    const before = partsSent('closeredundant').length;

    closeBuffer(userId, network.id, '#again');
    await probe(conn, 'closeredundant', 'redundantprobe');

    expect(partsSent('closeredundant')).toHaveLength(before);
  });

  it('sends nothing after a redundant join and then a kick', async () => {
    // The same redundant JOIN, left by a KICK rather than a part — nothing on
    // that path clears a mark, so this is where a mark set for a channel we
    // were already in would survive to make the close PART one we are out of.
    const { network, conn } = await connected('closekickmark', ['#kickmark']);
    ircManager.joinChannel(userId, network.id, '#kickmark'); // redundant
    conn.client.emit('kick', {
      channel: '#kickmark',
      nick: 'opp',
      kicked: conn.currentNick,
      message: 'out',
    });
    await until(() => !conn.isChannelJoined('#kickmark'), 5000, 'kicked out');
    expect(conn.mayBeJoined('#kickmark')).toBe(false);
    const before = partsSent('closekickmark').length;

    closeBuffer(userId, network.id, '#kickmark');
    await probe(conn, 'closekickmark', 'kickmarkprobe');

    expect(partsSent('closekickmark')).toHaveLength(before);
  });

  it('sends nothing after parting a join the server never answered', async () => {
    // A JOIN with no answer keeps its mark — nothing else clears one — so the
    // part has to. Otherwise the close that follows reads "maybe in there" and
    // parts a channel we were never in, for a second 442.
    //
    // The PART is held too, so nothing ELSE can do the clearing: a server that
    // answers it 442 clears the mark through the rejection path, which would
    // make this pass whether or not part() pulls its weight.
    const { network, conn } = await connected('closeunanswered');
    ircd.hold = (cmd) => cmd === 'JOIN' || cmd === 'PART';
    ircManager.joinChannel(userId, network.id, '#unanswered');
    await until(
      () => sentTo('closeunanswered').some((l) => l.startsWith('JOIN ')),
      5000,
      'JOIN sent',
    );
    expect(conn.mayBeJoined('#unanswered')).toBe(true);

    ircManager.partChannel(userId, network.id, '#unanswered');
    await until(() => partsSent('closeunanswered').length > 0, 5000, 'PART sent');
    expect(conn.mayBeJoined('#unanswered')).toBe(false);

    closeBuffer(userId, network.id, '#unanswered');
    await probe(conn, 'closeunanswered', 'unansweredprobe');

    expect(partsSent('closeunanswered')).toEqual(['PART #unanswered']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('leaves the PART to the replay for a channel still in the map', async () => {
    // The map is PRUNED against the engine's set on `attached`, not cleared, so
    // after a link blip a channel we are in reads joined for the whole restore.
    // Parting here and letting the replay part it again is two on the wire.
    const { network, conn } = await connected('closeblip', ['#blip']);
    conn.restoring = true;
    expect(conn.isChannelJoined('#blip')).toBe(true);
    const before = partsSent('closeblip').length;

    closeBuffer(userId, network.id, '#blip');
    await probe(conn, 'closeblip', 'blipprobe');
    expect(partsSent('closeblip')).toHaveLength(before);

    // The replayed JOIN, which is where the one PART comes from.
    conn.client.emit('join', { channel: '#blip', nick: conn.currentNick });
    await until(() => partsSent('closeblip').length > before, 5000, 'replay parted it');

    expect(partsSent('closeblip')).toHaveLength(before + 1);
    conn.restoring = false;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('stops parting once the server refuses the join', async () => {
    // The pending mark can't outlive the JOIN it belongs to: a rejection ends
    // it, so a later close of that buffer is back to sending nothing. Left
    // pending, a refused join would make every close of it draw the 442 this
    // gate exists to stop.
    const { network, conn } = await connected('closerefused');
    ircManager.joinChannel(userId, network.id, '#refused');
    conn.client.emit('irc error', {
      error: 'channel_is_full',
      channel: '#refused',
      reason: 'Cannot join channel (+l)',
    });
    ensureOpen(userId, network.id, '#refused', { kind: 'channel' });
    const before = partsSent('closerefused').length;

    closeBuffer(userId, network.id, '#refused');
    await probe(conn, 'closerefused', 'refusedprobe');

    expect(partsSent('closerefused')).toHaveLength(before);
    expect(getState(userId, network.id, '#refused')).toBe('closed');
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('keeps the mark when an error about the channel answers something else', async () => {
    // event.channel is set on errors that have nothing to do with a JOIN — a
    // 404 refusing a message to the channel is the common one. Clearing on
    // those drops the mark for a JOIN still in flight, and the close that
    // follows sends no PART, so its echo reopens the buffer just closed.
    const { network, conn } = await connected('closesendfail');
    ircd.hold = (cmd) => cmd === 'JOIN';
    ircManager.joinChannel(userId, network.id, '#sendfail');
    await until(
      () => sentTo('closesendfail').some((l) => l.startsWith('JOIN ')),
      5000,
      'JOIN sent',
    );

    // ERR_CANNOTSENDTOCHAN for the same channel, while that JOIN is pending.
    conn.client.emit('irc error', {
      error: 'cannot_send_to_channel',
      channel: '#sendfail',
      reason: 'Cannot send to channel',
    });
    expect(conn.mayBeJoined('#sendfail')).toBe(true);

    closeBuffer(userId, network.id, '#sendfail');
    await until(() => partsSent('closesendfail').length > 0, 5000, 'PART sent');

    expect(partsSent('closesendfail')).toEqual(['PART #sendfail']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('stops parting after a rejection irc-framework does not model', async () => {
    // 403, 476 and 477 never reach the 'irc error' handler — irc-framework has
    // no entry for them, so they arrive as unknown commands. A rejection that
    // left the mark set would have every later close of that buffer PART a
    // channel we never got into.
    const { network, conn } = await connected('closeunmodelled');
    ircManager.joinChannel(userId, network.id, '#regged');
    expect(conn.mayBeJoined('#regged')).toBe(true);

    // ERR_NEEDREGGEDNICK, as an ircd sends it before services identify us.
    conn.client.emit('unknown command', {
      command: '477',
      params: [conn.currentNick, '#regged', 'Cannot join channel (+r)'],
    });
    expect(conn.mayBeJoined('#regged')).toBe(false);

    ensureOpen(userId, network.id, '#regged', { kind: 'channel' });
    const before = partsSent('closeunmodelled').length;
    closeBuffer(userId, network.id, '#regged');
    await probe(conn, 'closeunmodelled', 'reggedprobe');

    expect(partsSent('closeunmodelled')).toHaveLength(before);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('sends nothing when a PART is already on the wire, before its echo', async () => {
    // Membership is echo-written in both directions, so between a PART and its
    // echo the map still says we are in a channel we have left. An attached
    // client parting and the web app closing inside that round trip is the
    // reported flow, just faster than the echo.
    const { network, conn } = await connected('closeinflight', ['#inflightpart']);
    ircd.hold = (cmd) => cmd === 'PART'; // no echo, no 442
    ircManager.partChannel(userId, network.id, '#inflightpart');
    await until(() => partsSent('closeinflight').length > 0, 5000, 'PART sent');
    // The map has not caught up, which is the whole point.
    expect(conn.isChannelJoined('#inflightpart')).toBe(true);
    expect(conn.mayBeJoined('#inflightpart')).toBe(false);

    closeBuffer(userId, network.id, '#inflightpart');
    await probe(conn, 'closeinflight', 'inflightprobe');

    expect(partsSent('closeinflight')).toEqual(['PART #inflightpart']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('closing twice puts one PART on the wire', async () => {
    // Two devices with the buffer open, both closing. The row transition is
    // idempotent on its own; the wire has to be too.
    const { network, conn } = await connected('closetwice', ['#twiceclosed']);
    ircd.hold = (cmd) => cmd === 'PART';

    closeBuffer(userId, network.id, '#twiceclosed');
    await until(() => partsSent('closetwice').length > 0, 5000, 'first PART');
    closeBuffer(userId, network.id, '#twiceclosed');
    await probe(conn, 'closetwice', 'twiceprobe');

    expect(partsSent('closetwice')).toEqual(['PART #twiceclosed']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts again after the echo lands and the channel is re-joined', async () => {
    // The mark cannot outlive the PART it belongs to, or a channel you left and
    // came back to could never be closed properly again.
    const { network, conn } = await connected('closerejoin', ['#rejoined']);
    ircManager.partChannel(userId, network.id, '#rejoined');
    await until(() => !conn.isChannelJoined('#rejoined'), 5000, 'parted');
    ircManager.joinChannel(userId, network.id, '#rejoined');
    await until(() => conn.isChannelJoined('#rejoined'), 5000, 'rejoined');
    const before = partsSent('closerejoin').length;

    closeBuffer(userId, network.id, '#rejoined');
    await until(() => partsSent('closerejoin').length > before, 5000, 'PART sent');

    expect(partsSent('closerejoin')).toHaveLength(before + 1);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts a channel a JOIN echo we did not ask for put us back in', async () => {
    // The echo answered the PART, and then something else made us a member
    // again without going through join() — another client on the bouncer, or an
    // engine replay. Only deleteChannel clearing the mark covers this; the join
    // path never ran.
    const { network, conn } = await connected('closeforeignjoin', ['#foreign']);
    ircManager.partChannel(userId, network.id, '#foreign');
    await until(() => !conn.isChannelJoined('#foreign'), 5000, 'part echoed');
    const before = partsSent('closeforeignjoin').length;

    // A self-JOIN nobody here requested: membership back, no join() call.
    conn.client.emit('join', { channel: '#foreign', nick: conn.currentNick });
    await until(() => conn.isChannelJoined('#foreign'), 5000, 'member again');

    closeBuffer(userId, network.id, '#foreign');
    await until(() => partsSent('closeforeignjoin').length > before, 5000, 'PART sent');

    expect(partsSent('closeforeignjoin')).toHaveLength(before + 1);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts after a rejoin that overtakes an unanswered PART', async () => {
    // Part, then rejoin, with the PART never answered — so deleteChannel never
    // ran and only the JOIN can supersede the mark. Without that, the channel
    // could never be closed properly again.
    const { network, conn } = await connected('closeovertake', ['#overtake']);
    ircd.hold = (cmd) => cmd === 'PART';
    ircManager.partChannel(userId, network.id, '#overtake');
    await until(() => partsSent('closeovertake').length > 0, 5000, 'PART sent');
    expect(conn.mayBeJoined('#overtake')).toBe(false);

    ircManager.joinChannel(userId, network.id, '#overtake');
    expect(conn.mayBeJoined('#overtake')).toBe(true);

    closeBuffer(userId, network.id, '#overtake');
    await until(() => partsSent('closeovertake').length > 1, 5000, 'second PART sent');

    expect(partsSent('closeovertake')).toHaveLength(2);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('sends nothing after a PART echoed under a fold variant of the name', async () => {
    // On rfc1459 `[` and `{` are the same character, so an ircd may echo the
    // PART for a `#foo[bar]` we are in as `#foo{bar}`. Membership has to fold
    // both sides to see that as the channel leaving — an exact-key delete
    // misses it, and the map then claims we are in a channel we left for the
    // life of the connection, so every close of it PARTs again for another 442.
    const network = makeNetwork('foldpart');
    const conn = ircManager.startNetwork(userId, network.id)!;
    await until(() => conn.state === 'connected', 5000, 'connected');
    // After registration: the connection captures ISUPPORT CASEMAPPING on the
    // way in, and the fake ircd declares `ascii`, which would overwrite this.
    db.prepare('UPDATE networks SET casemapping = ? WHERE id = ?').run('rfc1459', network.id);
    invalidateCasemappingCache(network.id);
    ircManager.joinChannel(userId, network.id, '#foo[bar]');
    await until(() => conn.isChannelJoined('#foo[bar]'), 5000, 'joined');
    const before = partsSent('foldpart').length;

    // Somebody else's client parted it; the server relays the other spelling.
    conn.client.emit('part', { channel: '#foo{bar}', nick: conn.currentNick });
    expect(conn.isChannelJoined('#foo[bar]')).toBe(false);
    expect(conn.mayBeJoined('#foo[bar]')).toBe(false);

    closeBuffer(userId, network.id, '#foo[bar]');
    await probe(conn, 'foldpart', 'foldprobe');

    expect(partsSent('foldpart')).toHaveLength(before);
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts a cycle whose old PART echo lands before the new JOIN echo', async () => {
    // /part then /join, close in between. While the PART is unanswered the map
    // still says joined, so the JOIN looks redundant and goes untracked — and
    // when the PART echo then lands, membership goes false with nothing left
    // saying a JOIN is outstanding. A close there sends no PART and the JOIN
    // echo reopens the buffer it just closed, leaving the user in a channel
    // they closed.
    const { network, conn } = await connected('closecycle', ['#cyc']);
    ircd.hold = (cmd) => cmd === 'PART' || cmd === 'JOIN'; // we drive the echoes
    ircManager.partChannel(userId, network.id, '#cyc');
    await until(() => partsSent('closecycle').length > 0, 5000, 'PART sent');
    ircManager.joinChannel(userId, network.id, '#cyc');
    // Still a member as far as the map knows — that is what hid the JOIN.
    expect(conn.isChannelJoined('#cyc')).toBe(true);

    // The PART we sent first, answered at last.
    conn.client.emit('part', { channel: '#cyc', nick: conn.currentNick });
    expect(conn.isChannelJoined('#cyc')).toBe(false);
    expect(conn.mayBeJoined('#cyc')).toBe(true); // the JOIN is still owed one

    const before = partsSent('closecycle').length;
    closeBuffer(userId, network.id, '#cyc');
    await until(() => partsSent('closecycle').length > before, 5000, 'PART sent');

    expect(partsSent('closecycle')).toHaveLength(before + 1);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('sends nothing after a raw PART the user typed themselves', async () => {
    // `/quote PART #x` and `/raw PART #x` go to the socket verbatim, not
    // through part(), so nothing would record the PART — and the close right
    // after it would send the duplicate. The user reaching for a raw command
    // is not a reason to hand their other clients a 442.
    const { network, conn } = await connected('closerawpart', ['#rawpart']);
    ircd.hold = (cmd) => cmd === 'PART';
    conn.raw('PART #rawpart :bye');
    await until(() => partsSent('closerawpart').length > 0, 5000, 'raw PART sent');
    expect(conn.isChannelJoined('#rawpart')).toBe(true); // echo still owed
    expect(conn.mayBeJoined('#rawpart')).toBe(false);

    closeBuffer(userId, network.id, '#rawpart');
    await probe(conn, 'closerawpart', 'rawpartprobe');

    expect(partsSent('closerawpart')).toEqual(['PART #rawpart :bye']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('reads the PART behind a client-written prefix too (#1116)', async () => {
    // A server strips a `:prefix` a client wrote and acts on the verb, so the
    // mark has to be made for that shape as well — or the duplicate is back.
    const { network, conn } = await connected('closeprefixpart', ['#prefixpart']);
    ircd.hold = (cmd) => cmd === 'PART';
    conn.raw(':closeprefixpart!u@h PART #prefixpart :bye');
    expect(conn.mayBeJoined('#prefixpart')).toBe(false);

    closeBuffer(userId, network.id, '#prefixpart');
    await probe(conn, 'closeprefixpart', 'prefixpartprobe');

    expect(sentTo('closeprefixpart').filter((line) => /PART #prefixpart/.test(line))).toEqual([
      ':closeprefixpart!u@h PART #prefixpart :bye',
    ]);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('treats JOIN 0 as a part of every channel', async () => {
    // JOIN 0 leaves them all at once (RFC 2812 3.2.1), which is what a bouncer
    // client's JOIN 0 relays to. Every channel is on its way out, so none of
    // them owes a PART.
    const { network, conn } = await connected('closejoinzero', ['#zeroa', '#zerob']);
    ircd.hold = (cmd) => cmd === 'JOIN';
    conn.raw('JOIN 0');
    expect(conn.mayBeJoined('#zeroa')).toBe(false);
    expect(conn.mayBeJoined('#zerob')).toBe(false);
    const before = partsSent('closejoinzero').length;

    closeBuffer(userId, network.id, '#zeroa');
    await probe(conn, 'closejoinzero', 'zeroprobe');

    expect(partsSent('closejoinzero')).toHaveLength(before);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('parts a channel a raw JOIN is still waiting on', async () => {
    // The other direction: a raw JOIN is as much a pending join as join()'s,
    // and closing before its echo still owes the PART.
    const { network, conn } = await connected('closerawjoin');
    ircd.hold = (cmd) => cmd === 'JOIN';
    conn.raw('JOIN #rawjoin');
    expect(conn.mayBeJoined('#rawjoin')).toBe(true);

    closeBuffer(userId, network.id, '#rawjoin');
    await until(() => partsSent('closerawjoin').length > 0, 5000, 'PART sent');

    expect(partsSent('closerawjoin')).toEqual(['PART #rawjoin']);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('reads a raw PART that carries an IRCv3 tag block', async () => {
    const { network, conn } = await connected('closetagged', ['#tagged']);
    ircd.hold = (cmd) => cmd === 'PART';
    conn.raw('@label=abc PART #tagged');
    await until(() => partsSent('closetagged').length > 0, 5000, 'raw PART sent');
    expect(conn.mayBeJoined('#tagged')).toBe(false);

    closeBuffer(userId, network.id, '#tagged');
    await probe(conn, 'closetagged', 'taggedprobe');

    expect(partsSent('closetagged')).toHaveLength(1);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('JOIN 0 abandons a JOIN that has not echoed yet', async () => {
    // The channel is not in the map, so the leave-all loop can't see it — but
    // JOIN 0 abandons it all the same, and a mark left behind would have the
    // close PART the very channel this command is walking away from. It has to
    // survive the JOIN echo too, which briefly makes us a member.
    const { network, conn } = await connected('closezeropending');
    ircd.hold = (cmd) => cmd === 'JOIN';
    ircManager.joinChannel(userId, network.id, '#pendingzero');
    expect(conn.mayBeJoined('#pendingzero')).toBe(true);

    conn.raw('JOIN 0');
    expect(conn.mayBeJoined('#pendingzero')).toBe(false);

    // Its JOIN lands anyway — the server saw it before the leave-all.
    conn.client.emit('join', { channel: '#pendingzero', nick: conn.currentNick });
    expect(conn.isChannelJoined('#pendingzero')).toBe(true);
    expect(conn.mayBeJoined('#pendingzero')).toBe(false);

    closeBuffer(userId, network.id, '#pendingzero');
    await probe(conn, 'closezeropending', 'zeropendingprobe');

    expect(partsSent('closezeropending')).toEqual([]);
    ircd.hold = null;
    conn.dispose();
    ircManager.connectionsForUser(userId).delete(network.id);
  });

  it('lowers autojoin on a network with no connection at all', async () => {
    // The disconnected fallback: no socket to PART on, but the channel must
    // not come back the next time the network connects.
    const network = makeNetwork('closeoffline');
    ensureOpen(userId, network.id, '#offline', { kind: 'channel', autojoin: true });

    closeBuffer(userId, network.id, '#offline');

    expect(getState(userId, network.id, '#offline')).toBe('closed');
    expect(isAutojoin(userId, network.id, '#offline')).toBe(false);
  });
});
