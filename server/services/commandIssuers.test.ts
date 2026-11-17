// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which buffer a command was typed in (#816): the bookkeeping on its own, then
// wired through IrcConnection the way a socket line arrives, so both of
// irc-framework's handlers see it ('raw', then the parsed event).

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandIssuers, isErrorNumeric, refusedCommand } from './commandIssuers.js';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import * as buffers from '../db/buffers.js';

const WINDOW = 15_000;

// A line the user typed in `buffer`, as raw() notes one: sent, then given its buffer.
function typed(issuers: CommandIssuers, line: string, buffer: string, at: number) {
  issuers.sent(line, at);
  issuers.typedIn(line, buffer);
}

describe('CommandIssuers', () => {
  it('reads the command an error names, and only where one is named', () => {
    expect(refusedCommand('421', ['me', 'frob', 'Unknown command'])).toBe('FROB');
    expect(refusedCommand('461', ['me', 'KICK', 'Not enough parameters'])).toBe('KICK');
    expect(refusedCommand('481', ['me', "Permission Denied- You're not an IRC operator"])).toBe(
      null,
    );
    // A 461 whose second param is already the sentence names nothing.
    expect(refusedCommand('461', ['me', 'Not enough parameters'])).toBe(null);
  });

  it('counts 4xx, 5xx and the error numerics outside them, and nothing else', () => {
    for (const n of ['401', '481', '502', '263', '696', '723', '742', '972']) {
      expect(isErrorNumeric(n)).toBe(true);
    }
    for (const n of ['001', '324', '367', '718', 'FAIL', 'PRIVMSG']) {
      expect(isErrorNumeric(n)).toBe(false);
    }
  });

  it('gives a named error to the last line of that command, once', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'FROB a', '#one', 1000);
    typed(issuers, 'KICK #two bob', '#two', 1001);
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 1002)).toBe('#one');
    // Spent: a second 421 for it is nobody's.
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 1003)).toBe(null);
    // The other command is still there for its own error.
    expect(issuers.take('461', ['me', 'KICK', 'Not enough parameters'], 1004)).toBe('#two');
  });

  it('never gives a named error to a line of another command', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'KICK #chan bob', '#chan', 1000);
    // Lurker's own TAGMSG on a server without message-tags.
    expect(issuers.take('421', ['me', 'TAGMSG', 'Unknown command'], 1001)).toBe(null);
    expect(issuers.take('461', ['me', 'KICK', 'Not enough parameters'], 1002)).toBe('#chan');
  });

  it('gives an error that names a channel or nick to the last line that named it', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'MODE #Elsewhere +m', '#one', 1000);
    typed(issuers, 'NAMES #one', '#one', 1001);
    // Lurker's own JOIN, by a path that is not raw(): noted, with no buffer.
    issuers.sent('JOIN #a,#bad*name', 1002);
    expect(issuers.take('479', ['me', '#bad*name', 'Illegal channel name'], 1003)).toBe(null);
    // A refusal naming something no line here named is nobody's.
    expect(issuers.take('442', ['me', '#other', "You're not on that channel"], 1004)).toBe(null);
    expect(issuers.take('403', ['me', '#elsewhere', 'No such channel'], 1005)).toBe('#one');
  });

  it('gives an error that names nothing to the last line sent, whoever sent it', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'MODE #one +m', '#one', 1000);
    typed(issuers, 'OPER me pw', '#two', 1001);
    expect(issuers.take('481', ['me', 'Permission Denied'], 1002)).toBe('#two');
    // Something else went out after the user's command: the error is its.
    typed(issuers, 'OPER me pw', '#two', 1003);
    issuers.sent('ACCEPT bob', 1004);
    expect(issuers.take('456', ['me', 'Accept list is full'], 1005)).toBe(null);
  });

  it('does not count a keepalive as the last line sent', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'OPER me pw', '#chan', 1000);
    issuers.sent('PONG :irc.test', 1001);
    issuers.sent('PING 123', 1002);
    expect(issuers.take('481', ['me', 'Permission Denied'], 1003)).toBe('#chan');
  });

  it("keeps a bouncer client's error out of the user's buffer, tagged or not", () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'FROB', '#chan', 1000);
    issuers.sent('@label=x;+draft/a=b FROB', 1001);
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 1002)).toBe(null);
    // typedIn is for the line that just went, and no other.
    issuers.sent('FROB', 1003);
    issuers.typedIn('KICK', '#chan');
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 1004)).toBe(null);
  });

  it('forgets a line past the window, and all of them with the socket', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'FROB', '#chan', 1000);
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 1001 + WINDOW)).toBe(null);
    typed(issuers, 'FROB', '#chan', 50_000);
    issuers.clear();
    expect(issuers.take('421', ['me', 'FROB', 'Unknown command'], 50_001)).toBe(null);
  });

  it('holds a bounded number of lines', () => {
    const issuers = new CommandIssuers(WINDOW);
    typed(issuers, 'FIRST', '#first', 1000);
    for (let i = 0; i < 128; i++) typed(issuers, `CMD${i}`, '#chan', 1000);
    expect(issuers.take('421', ['me', 'FIRST', 'Unknown command'], 1001)).toBe(null);
    expect(issuers.take('421', ['me', 'CMD127', 'Unknown command'], 1001)).toBe('#chan');
  });
});

beforeAll(() => {
  createUser('issuer-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
  buffers.ensureExists(1, 1, '#anime');
  buffers.ensureExists(1, 1, '#closed');
  buffers.close(1, 1, '#closed');
});

function harness() {
  const conn = new IrcConnection({
    network: {
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
      flood_protection: 1,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
  // Connected: a command is read as it goes out (#1149).
  conn.state = 'connected';
  conn.client.raw = vi.fn<(line: string) => void>();
  const publish = vi.fn<(event: Record<string, unknown>) => void>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
  conn.publish = publish as unknown as typeof conn.publish;
  conn.publishEphemeral = publishEphemeral;
  // A server line as the socket delivers it.
  const receive = (line: string) => conn.client.connection.addReadBuffer(line);
  const said = () =>
    publishEphemeral.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'error')
      .map((e) => ({ target: e.target, text: e.text }));
  const serverBuffer = () =>
    publish.mock.calls
      .map((c) => c[0])
      .filter((e) => e.target === ':server:1')
      .map((e) => e.text);
  return { conn, receive, said, serverBuffer, publish };
}

describe('an error is said where its command was typed (#816)', () => {
  it('mirrors an unknown command (421, modelled by irc-framework) into its buffer', () => {
    const { conn, receive, said, serverBuffer } = harness();
    conn.raw('FROB now', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 421 alice FROB :Unknown command');

    expect(said()).toEqual([{ target: '#anime', text: 'FROB Unknown command' }]);
    // The server buffer keeps its own lines, as before.
    expect(serverBuffer()).toContain('FROB Unknown command');
  });

  it('mirrors a 461 and a 481, which irc-framework does not model', () => {
    const { conn, receive, said } = harness();
    conn.raw('KICK', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 461 alice KICK :Not enough parameters');
    conn.raw('OPER alice pw', 'user', { issuingTarget: '#anime' });
    receive(":irc.example.test 481 alice :Permission Denied- You're not an IRC operator");

    expect(said()).toEqual([
      { target: '#anime', text: 'KICK Not enough parameters' },
      { target: '#anime', text: "Permission Denied- You're not an IRC operator" },
    ]);
  });

  it('says a refusal naming a channel we are not in where the command was typed', () => {
    const { conn, receive, said } = harness();
    conn.raw('MODE #elsewhere +m', 'user', { issuingTarget: '#anime' });
    receive(":irc.example.test 482 alice #elsewhere :You're not channel operator");

    expect(said()).toEqual([{ target: '#anime', text: "#elsewhere You're not channel operator" }]);
  });

  it('adds nothing to an error that was placed by the channel it names', () => {
    const { conn, receive, said, publish } = harness();
    conn.upsertChannel('#anime');
    conn.raw('MODE #anime +m', 'user', { issuingTarget: '#anime' });
    receive(":irc.example.test 482 alice #anime :You're not channel operator");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: '#anime' }),
    );
    expect(said()).toEqual([]);
  });

  it('says nothing new for one command, one error: the second 421 is not ours', () => {
    const { conn, receive, said } = harness();
    conn.raw('FROB', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(said()).toHaveLength(1);
  });

  it('says nothing new without an issuing buffer, or typed in the server buffer', () => {
    const { conn, receive, said } = harness();
    conn.raw('FROB');
    receive(':irc.example.test 421 alice FROB :Unknown command');
    conn.raw('FROB', 'user', { issuingTarget: ':server:1' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(said()).toEqual([]);
  });

  it('says nothing in a buffer that is closed, or that does not exist', () => {
    const { conn, receive, said } = harness();
    conn.raw('FROB', 'user', { issuingTarget: '#closed' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    conn.raw('FROB', 'user', { issuingTarget: '#never-was' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(said()).toEqual([]);
  });

  it("leaves another asker's error alone", () => {
    const { conn, receive, said } = harness();
    conn.raw('FROB', 'user', { issuingTarget: '#anime' });
    // A bouncer client sends the same command after the user did.
    conn.raw('FROB', { replyFromCache: () => {}, replyAborted: () => {} });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(said()).toEqual([]);
  });

  it('does not mirror an unclaimed 401, which the profile modal reports (#904)', () => {
    const { conn, receive, said } = harness();
    conn.raw('WHOIS ghost', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 401 alice ghost :No such nick/channel');
    expect(said()).toEqual([]);
  });

  it('stores no second 421 line in the server buffer when it was said elsewhere', () => {
    const { conn, receive, publish } = harness();
    const stored = () =>
      publish.mock.calls.map((c) => c[0]).filter((e) => e.unknownCommand === 'FROB');
    conn.raw('FROB', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(stored()).toEqual([]);

    publish.mockClear();
    conn.raw('FROB', 'user', { issuingTarget: '#never-was' });
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(stored()).toHaveLength(1);
  });

  it('does not carry an error that was placed over to the next line of the same read', () => {
    // A socket read's lines run back to back, with no microtask between.
    const { conn, receive, said } = harness();
    // The refused JOIN is placed as a toast on the channel it names.
    conn.raw('JOIN #full', 'user', { issuingTarget: '#anime' });
    receive(':irc.example.test 471 alice #full :Cannot join channel (+l)');
    receive(':irc.example.test 300 alice :nothing');
    expect(said()).toEqual([]);
  });

  it("gives a refusal of Lurker's own JOIN to nobody's buffer", () => {
    const { conn, receive, said } = harness();
    conn.raw('NAMES #anime', 'user', { issuingTarget: '#anime' });
    // By a path that is not raw(), as client.join() goes.
    (conn as unknown as { sendPacer: { write(line: string): void } }).sendPacer.write(
      'JOIN #bad*name',
    );
    receive(':irc.example.test 479 alice #bad*name :Illegal channel name');
    expect(said()).toEqual([]);
  });

  it('forgets what was typed on a socket that has gone', () => {
    const { conn, receive, said } = harness();
    conn.raw('FROB', 'user', { issuingTarget: '#anime' });
    conn.resetSendState();
    receive(':irc.example.test 421 alice FROB :Unknown command');
    expect(said()).toEqual([]);
  });
});
