// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// CTCP wiring (#263): the glue between live IRC traffic and our CTCP handling on
// IrcConnection. The wire-format + reply rules are unit-pinned in ctcp.test.ts;
// these exercise the PLUMBING — does an inbound request auto-reply over NOTICE
// and surface a status line; does an inbound reply route back to the issuing
// buffer with a PING latency; does an outbound /ctcp frame + echo; do the flood
// guard and self-echo / RPEE2E guards hold.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IrcConnection } from './ircConnection.js';
import { createUser } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import settingsService from './settingsService.js';
import * as buffers from '../db/buffers.js';
import ircManager from './ircManager.js';

// The default ctcp.version template (`${name} ${version}`) expands to this.
const DEFAULT_VERSION_REPLY = `${APP_NAME} ${APP_VERSION}`;

beforeAll(() => {
  createUser('ctcp-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      client_cert: null,
      client_key: null,
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
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

// Spy the wire + publish seams on a freshly-built connection.
function harness() {
  const conn = makeConn();
  const ctcpRequest = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
  conn.client.ctcpRequest = ctcpRequest;
  conn.client.ctcpResponse = ctcpResponse;
  conn.publishEphemeral = publishEphemeral;
  // Where each ctcp line went and what it said — all any assertion here reads.
  const ctcpLines = () =>
    publishEphemeral.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'ctcp')
      .map((e) => ({ target: e.target as string, text: e.text as string }));
  return { conn, ctcpRequest, ctcpResponse, publishEphemeral, ctcpLines };
}

// Every Date.now() reading is a new millisecond. Undo with vi.restoreAllMocks().
function tickingClock() {
  let now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => ++now);
}

describe('inbound CTCP request (auto-reply + surface)', () => {
  it('answers VERSION with the Lurker user-agent and notes the probe', () => {
    const { conn, ctcpResponse, ctcpLines } = harness();

    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION',
    });

    expect(ctcpResponse).toHaveBeenCalledWith('bob', 'VERSION', DEFAULT_VERSION_REPLY);
    const lines = ctcpLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].target).toBe(':server:1'); // probes land in the server buffer
    expect(lines[0].text).toBe(`bob requested CTCP VERSION (replied: ${DEFAULT_VERSION_REPLY})`);
  });

  it('echoes a PING payload back verbatim', () => {
    const { conn, ctcpResponse } = harness();
    conn.client.emit('ctcp request', { nick: 'bob', type: 'PING', message: 'PING 1719500000000' });
    expect(ctcpResponse).toHaveBeenCalledWith('bob', 'PING', '1719500000000');
  });

  it('does not reply to an unsupported type but still shows the probe', () => {
    const { conn, ctcpResponse, ctcpLines } = harness();
    conn.client.emit('ctcp request', { nick: 'bob', type: 'USERINFO', message: 'USERINFO' });
    expect(ctcpResponse).not.toHaveBeenCalled();
    expect(ctcpLines()[0].text).toBe('bob requested CTCP USERINFO (no reply)');
  });

  it('ignores our own request echoed back by an echo-message server', () => {
    const { conn, ctcpResponse, publishEphemeral } = harness();
    conn.client.emit('ctcp request', { nick: 'alice', type: 'VERSION', message: 'VERSION' });
    expect(ctcpResponse).not.toHaveBeenCalled();
    expect(publishEphemeral).not.toHaveBeenCalled();
  });

  it('never treats an RPEE2E PRIVMSG as a standard CTCP query', () => {
    const { conn, ctcpResponse, publishEphemeral } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      type: 'RPEE2E',
      message: 'RPEE2E KEYREQ v=1 c=#x',
    });
    expect(ctcpResponse).not.toHaveBeenCalled();
    expect(publishEphemeral).not.toHaveBeenCalled();
  });

  it('rate-limits a flood of requests from one peer (per-peer limiter)', () => {
    const { conn, ctcpResponse } = harness();
    for (let i = 0; i < 10; i++) {
      conn.client.emit('ctcp request', {
        nick: 'bob',
        ident: 'b',
        hostname: 'h',
        type: 'VERSION',
        message: 'VERSION',
      });
    }
    // The shared e2e RateLimiter allows 3 per peer per 60s window, then backoff.
    expect(ctcpResponse).toHaveBeenCalledTimes(3);
  });

  it('one peer flooding does not suppress replies to a different peer', () => {
    const { conn, ctcpResponse } = harness();
    for (let i = 0; i < 10; i++) {
      conn.client.emit('ctcp request', {
        nick: 'flood',
        ident: 'f',
        hostname: 'h',
        type: 'VERSION',
        message: 'VERSION',
      });
    }
    conn.client.emit('ctcp request', {
      nick: 'carol',
      ident: 'c',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION',
    });
    // carol's bucket is independent of flood's — she still gets answered.
    expect(ctcpResponse).toHaveBeenCalledWith('carol', 'VERSION', DEFAULT_VERSION_REPLY);
  });

  it('a malformed (empty) CTCP does not consume a peer rate-limit slot', () => {
    const { conn, ctcpResponse } = harness();
    // Empty-body CTCPs (\x01\x01) parse to no type — rejected BEFORE the limiter
    // records the peer, so they can't burn the budget and starve real probes.
    for (let i = 0; i < 20; i++) {
      conn.client.emit('ctcp request', {
        nick: 'bob',
        ident: 'b',
        hostname: 'h',
        type: '',
        message: '',
      });
    }
    expect(ctcpResponse).not.toHaveBeenCalled();
    // A real VERSION afterward is still answered — the budget is intact.
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(ctcpResponse).toHaveBeenCalledWith('bob', 'VERSION', DEFAULT_VERSION_REPLY);
  });
});

describe('outbound CTCP request (/ctcp, /ping)', () => {
  it('frames a /ctcp VERSION and echoes it to the issuing buffer', () => {
    const { conn, ctcpRequest, ctcpLines } = harness();
    conn.sendCtcpRequest('#chan', 'bob', 'VERSION', '');
    expect(ctcpRequest).toHaveBeenCalledWith('bob', 'VERSION');
    const lines = ctcpLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ target: '#chan', text: '→ CTCP VERSION to bob' });
  });

  it('auto-fills a bare PING with an epoch-ms timestamp payload', () => {
    const { conn, ctcpRequest } = harness();
    conn.sendCtcpRequest('bob', 'bob', 'PING', '');
    expect(ctcpRequest).toHaveBeenCalledTimes(1);
    const [target, type, payload] = ctcpRequest.mock.calls[0];
    expect(target).toBe('bob');
    expect(type).toBe('PING');
    expect(Number.isFinite(Number(payload))).toBe(true);
  });

  it('uppercases an arbitrary lowercase type', () => {
    const { conn, ctcpRequest } = harness();
    conn.sendCtcpRequest('#chan', 'bob', 'time', '');
    expect(ctcpRequest).toHaveBeenCalledWith('bob', 'TIME');
  });
});

describe('inbound CTCP reply (route + latency)', () => {
  it('routes a reply back to the buffer the request was issued from', () => {
    const { conn, ctcpResponse, ctcpLines } = harness();
    conn.sendCtcpRequest('#chan', 'bob', 'VERSION', '');
    conn.client.emit('ctcp response', {
      nick: 'bob',
      type: 'VERSION',
      message: 'VERSION WeeChat 4.0',
    });
    expect(ctcpResponse).not.toHaveBeenCalled(); // we never reply to a reply
    const reply = ctcpLines().find((l) => l.text.includes('reply'));
    expect(reply?.target).toBe('#chan');
    expect(reply?.text).toBe('CTCP VERSION reply from bob: WeeChat 4.0');
  });

  it('reports PING round-trip latency from the echoed timestamp', () => {
    const { conn, ctcpRequest, ctcpLines } = harness();
    conn.sendCtcpRequest('#chan', 'bob', 'PING', '');
    const ts = ctcpRequest.mock.calls[0][2] as string; // the auto-filled epoch-ms payload
    conn.client.emit('ctcp response', { nick: 'bob', type: 'PING', message: `PING ${ts}` });
    const reply = ctcpLines().find((l) => l.text.includes('PING reply'));
    expect(reply?.target).toBe('#chan');
    expect(reply?.text).toMatch(/^CTCP PING reply from bob: \d+\.\d{3}s$/);
  });

  it('falls back to the server buffer for an unsolicited reply', () => {
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp response', {
      nick: 'bob',
      type: 'VERSION',
      message: 'VERSION Unsolicited',
    });
    const reply = ctcpLines().find((l) => l.text.includes('reply'));
    expect(reply?.target).toBe(':server:1');
  });

  it('FIFO-routes concurrent same-type replies to the buffers in order (#11)', () => {
    const { conn, ctcpLines } = harness();
    conn.sendCtcpRequest('#chan1', 'bob', 'VERSION', '');
    conn.sendCtcpRequest('#chan2', 'bob', 'VERSION', '');
    conn.client.emit('ctcp response', { nick: 'bob', type: 'VERSION', message: 'VERSION first' });
    conn.client.emit('ctcp response', { nick: 'bob', type: 'VERSION', message: 'VERSION second' });
    const replies = ctcpLines().filter((l) => l.text.includes('reply'));
    expect(replies.map((r) => r.target)).toEqual(['#chan1', '#chan2']);
  });

  it('rate-limits an UNSOLICITED reply flood but never a solicited reply', () => {
    const { conn, ctcpLines } = harness();
    // Unsolicited (no outstanding request): per-peer limiter caps at 3/window.
    for (let i = 0; i < 10; i++) {
      conn.client.emit('ctcp response', {
        nick: 'mal',
        ident: 'm',
        hostname: 'h',
        type: 'VERSION',
        message: 'VERSION x',
      });
    }
    expect(ctcpLines().filter((l) => l.text.includes('reply'))).toHaveLength(3);

    // Solicited replies (matching outstanding /ctcp) bypass the limiter entirely,
    // so a burst of our own queries to one peer all surface.
    const { conn: conn2, ctcpLines: lines2 } = harness();
    for (let i = 0; i < 6; i++) conn2.sendCtcpRequest('#chan', 'bob', 'VERSION', '');
    for (let i = 0; i < 6; i++) {
      conn2.client.emit('ctcp response', { nick: 'bob', type: 'VERSION', message: 'VERSION ok' });
    }
    expect(lines2().filter((l) => l.text.includes('reply'))).toHaveLength(6);
  });

  it('does not surface a lowercase rpee2e NOTICE as a CTCP reply (#13)', () => {
    const { conn, ctcpLines } = harness();
    // Response types are raw-case; a lowercase rpee2e must route to the E2E path
    // (which won't parse it), not surface a bogus "CTCP rpee2e reply" line.
    conn.client.emit('ctcp response', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'rpee2e',
      message: 'rpee2e KEYREQ v=1 c=#x',
    });
    expect(ctcpLines()).toHaveLength(0);
  });

  it('clears CTCP routing/limit state on socket close (#8)', () => {
    const { conn } = harness();
    conn.sendCtcpRequest('#chan', 'bob', 'VERSION', '');
    expect(conn.ctcpOutstanding.size).toBe(1);
    conn.client.emit('close');
    expect(conn.ctcpOutstanding.size).toBe(0);
  });
});

describe('inbound CTCP request — settings gating', () => {
  // Settings persist in the shared isolated DB, so reset every ctcp.* key after
  // each test or the override leaks into the default-on tests above.
  afterEach(() => {
    for (const k of ['replies', 'version', 'time', 'source', 'clientinfo']) {
      settingsService.reset(1, `ctcp.${k}`);
    }
  });

  it('a disabled type (ctcp.version off) suppresses the reply but still shows the probe', () => {
    settingsService.update(1, { 'ctcp.version': '' });
    const { conn, ctcpResponse, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(ctcpResponse).not.toHaveBeenCalled();
    expect(ctcpLines()[0].text).toBe('bob requested CTCP VERSION (no reply)');
  });

  it('a still-enabled type keeps answering when a sibling is disabled', () => {
    settingsService.update(1, { 'ctcp.version': '' });
    const { conn, ctcpResponse } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'TIME',
      message: 'TIME',
    });
    expect(ctcpResponse).toHaveBeenCalledTimes(1);
    expect(ctcpResponse.mock.calls[0][1]).toBe('TIME');
  });

  it('the master switch (ctcp.replies off) silences all auto-replies', () => {
    settingsService.update(1, { 'ctcp.replies': false });
    const { conn, ctcpResponse } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'TIME',
      message: 'TIME',
    });
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      type: 'PING',
      message: 'PING 1',
    });
    expect(ctcpResponse).not.toHaveBeenCalled();
  });
});

describe('inbound CTCP request — msgbuffer routing (ctcp.msgbuffer)', () => {
  afterEach(() => settingsService.reset(1, 'ctcp.msgbuffer'));

  it('defaults to the server buffer', () => {
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: 'alice',
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(ctcpLines()[0].target).toBe(':server:1');
  });

  it('private: a direct CTCP routes to a DM with the sender', () => {
    settingsService.update(1, { 'ctcp.msgbuffer': 'private' });
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: 'alice', // sent to our nick → private
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(ctcpLines()[0].target).toBe('bob');
  });

  it('private: a channel-targeted CTCP routes to that channel', () => {
    settingsService.update(1, { 'ctcp.msgbuffer': 'private' });
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: '#chan',
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(ctcpLines()[0].target).toBe('#chan');
  });

  it('system: routes to the durable system buffer, not an ephemeral ctcp line', () => {
    settingsService.update(1, { 'ctcp.msgbuffer': 'system' });
    const { conn, publishEphemeral, ctcpLines } = harness();
    const logNet = vi.spyOn(conn, 'logNet').mockImplementation(() => {});
    conn.client.emit('ctcp request', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: 'alice',
      type: 'VERSION',
      message: 'VERSION',
    });
    expect(logNet).toHaveBeenCalledWith(
      `bob requested CTCP VERSION (replied: ${DEFAULT_VERSION_REPLY})`,
    );
    expect(ctcpLines()).toHaveLength(0); // no ephemeral ctcp line in system mode
    expect(publishEphemeral).not.toHaveBeenCalled();
    logNet.mockRestore();
  });
});

// #809. ircManager.ctcpRequest resolved through getConnection(), which during a
// reconnect backoff still hands back the IrcConnection the retry controller is
// holding — so the line went to a socket that discards it while the call reported
// success. The damage here is worse than a silent drop: sendCtcpRequest ALSO
// surfaces "→ CTCP PING to bob" into the issuing buffer, so the user watched a
// request they could see go out wait forever for a reply that could never arrive,
// while wsHub's "this network isn't connected" warning had no way to fire.
describe('outbound CTCP needs a writable connection', () => {
  // The spy lands on the ircManager singleton, which every other describe in this
  // file shares; nothing restores mocks globally.
  afterEach(() => vi.restoreAllMocks());

  function stub(state: string) {
    const sendCtcpRequest =
      vi.fn<(issuing: string, target: string, t: string, a: string) => void>();
    vi.spyOn(ircManager, 'getConnection').mockReturnValue({
      state,
      sendCtcpRequest,
    } as unknown as IrcConnection);
    return sendCtcpRequest;
  }

  it('refuses, and writes nothing, while the network is reconnecting', () => {
    const sendCtcpRequest = stub('reconnecting');
    expect(ircManager.ctcpRequest(1, 1, '#chan', 'bob', 'PING', '')).toBe(false);
    // ⚠ Both halves. Returning false is what lets wsHub say so; not calling
    // through is what keeps the "→ CTCP PING to bob" echo off the screen.
    expect(sendCtcpRequest).not.toHaveBeenCalled();
  });

  it('still sends on a connected network', () => {
    const sendCtcpRequest = stub('connected');
    expect(ircManager.ctcpRequest(1, 1, '#chan', 'bob', 'PING', '')).toBe(true);
    expect(sendCtcpRequest).toHaveBeenCalledWith('#chan', 'bob', 'PING', '');
  });
});

// #821. The exchange already routes its two happy halves to the buffer the
// command was typed in — the "→ CTCP VERSION to bob" echo and, via
// ctcpOutstanding, the reply. Failures consulted none of it and routed by nick,
// so the half that says "you tried" and the half that says "it failed" landed in
// different buffers, and WHICH buffer depended on why it failed.
describe('a failed /ctcp reports where it was issued (#821)', () => {
  // ⚠ Under a clock that ticks on EVERY Date.now() reading. Three of these were
  // the CI flake: sendCtcpRequest stamped the request, then noteUserSend
  // recorded the send as a nick intent with its own reading, and whenever a
  // millisecond boundary fell between the two the 401 path took the request's
  // OWN intent for a newer move and skipped it — or, with two requests, took
  // the second's for a move newer than the first. A few percent of full-suite
  // runs; certain here, so the same tests pin the fix instead.
  beforeEach(tickingClock);
  afterEach(() => vi.restoreAllMocks());

  type Lines = () => Array<{ target: string; text: string }>;

  // Sends a /ctcp from #anime, then hands back only the lines that came after,
  // so the outbound echo doesn't have to be filtered out of every assertion.
  function issued(conn: IrcConnection, ctcpLines: Lines) {
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    const before = ctcpLines().length;
    return () => ctcpLines().slice(before);
  }

  it('puts the echo and the failure in the same buffer', () => {
    const { conn, ctcpLines } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines()).toEqual([
      { target: '#anime', text: '→ CTCP VERSION to bob' },
      { target: '#anime', text: "bob isn't on this network." },
    ]);
  });

  it('says it in the issuing buffer even when a DM with that nick exists', () => {
    // The pre-fix split: with DM history the 401 fell to the DM-miss bucket, so
    // the attempt showed in #anime and the outcome in the bob query.
    const { conn, ctcpLines } = harness();
    const after = issued(conn, ctcpLines);
    conn.recentConversationalSend = (() => true) as never;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(after()).toEqual([{ target: '#anime', text: "bob isn't on this network." }]);
    expect(publish).not.toHaveBeenCalled(); // nothing landed in the bob query
  });

  it('routes a 531 to the same place as a 401 — the whole point', () => {
    // ⚠ The two failure paths must move together. Fixing only the 401 is worse
    // than fixing neither: one command would then report in two different
    // buffers depending on whether the nick was absent or just refusing.
    const { conn, ctcpLines } = harness();
    const after = issued(conn, ctcpLines);
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', {
      error: 'cannot_send_to_user',
      nick: 'bob',
      reason: 'You must be voiced',
    });

    expect(after()).toEqual([
      { target: '#anime', text: 'Message not delivered — You must be voiced' },
    ]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('still marks the target unsendable when it redirects a 531', () => {
    // The redirect changes where the failure is SHOWN; the speak-permission mark
    // that stops us firing typing TAGMSGs at a target that bounces them is a
    // separate job and must survive it (#283).
    const { conn } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    conn.client.emit('irc error', { error: 'cannot_send_to_user', nick: 'bob' });
    expect(conn.unsendableTargets.has('bob')).toBe(true);
  });

  it('consumes the request, so a later unrelated 401 is not claimed by it', () => {
    // The hazard takeCommandIntent had to learn in #815: one command, one
    // bounce. A spent entry left in the map lies in wait.
    const { conn, ctcpLines } = harness();
    const after = issued(conn, ctcpLines);
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });
    expect(after()).toHaveLength(1);

    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.say = vi.fn<(target: string, message: string) => void>(); // no real socket
    conn.say('bob', 'hi'); // a real message, minutes later
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(after()).toHaveLength(1); // nothing new in #anime
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: 'bob' }));
  });

  it('pairs a burst of failures with the requests oldest-first, across types', () => {
    // ctcpOutstanding is keyed by nick AND type; a 401 names only the nick. Each
    // CTCP is its own PRIVMSG and draws its own numeric, so the Nth failure
    // belongs to the Nth request regardless of which type it was.
    const { conn, ctcpLines } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    conn.sendCtcpRequest('#manga', 'bob', 'TIME', '');
    const before = ctcpLines().length;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(
      ctcpLines()
        .slice(before)
        .map((l) => l.target),
    ).toEqual(['#anime', '#manga']);
  });

  it('leaves a 401 with no outstanding CTCP alone', () => {
    // The gate that keeps this off every unrelated failure.
    const { conn, ctcpLines } = harness();
    conn.recentConversationalSend = (() => true) as never;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'stranger' });

    expect(ctcpLines()).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ target: 'stranger' }));
  });

  it('falls back to the server buffer when the issuing buffer was closed', () => {
    // Same guard the reply path uses, and the reason it exists: wsHub drops an
    // ephemeral event aimed at a closed buffer, so a /ctcp issued in a channel
    // the user then closed would end in silence rather than in the server
    // buffer. Really closes it rather than stubbing the lookup — the guard is
    // shared with the reply path, so what needs proving is that the FAILURE path
    // goes through it at all.
    const { conn, ctcpLines } = harness();
    buffers.ensureExists(1, 1, '#closed-later');
    conn.sendCtcpRequest('#closed-later', 'bob', 'VERSION', '');
    const before = ctcpLines().length;
    expect(buffers.close(1, 1, '#closed-later')).toBe(true);

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines().slice(before)).toEqual([
      { target: ':server:1', text: "bob isn't on this network." },
    ]);
  });

  it('does not touch DCC, which reports to the nick on purpose', () => {
    // DCC calls surfaceCtcp(nick, …) in many places and never records an
    // outstanding request, so there is nothing here for a failure to claim.
    const { conn } = harness();
    expect(conn.takeCtcpIssuer('bob')).toBeNull();
  });
});

// Applying the #821 review: the claim on a failure numeric has to be BOUNDED,
// or an outstanding CTCP quietly becomes an attractor for every later failure
// naming the same target.
describe('a CTCP claims a failure only while it is the last thing sent (#821)', () => {
  it('yields to a real message sent after it', () => {
    // The #434 rule. /ctcp bob from #anime, bob ignores it (they exist), then
    // the user messages bob and bob has since quit. That 401 answers the
    // MESSAGE, so it belongs in bob's query as the persisted row #817 puts
    // there — not pulled into #anime as transient CTCP status.
    const { conn, ctcpLines } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
    const before = ctcpLines().length;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.say = vi.fn<(target: string, message: string) => void>();

    conn.say('bob', 'you there?');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines().slice(before)).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', target: 'bob' }));
  });

  it('yields to a real message in a channel it was aimed at', () => {
    // Same shape with a channel target: /ctcp #anime is legal, and a later
    // refusal to SPEAK in #anime must stay the inline error #283 put there.
    const { conn, ctcpLines } = harness();
    conn.upsertChannel('#anime');
    conn.sendCtcpRequest(':server:1', '#anime', 'VERSION', '');
    const before = ctcpLines().length;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;
    conn.client.say = vi.fn<(target: string, message: string) => void>();

    conn.say('#anime', 'hello');
    conn.client.emit('irc error', {
      error: 'cannot_send_to_channel',
      channel: '#anime',
      reason: 'You need voice',
    });

    expect(ctcpLines().slice(before)).toHaveLength(0);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: '#anime' }),
    );
  });

  it('pairs the failure with the LIVE request, not a stale one of another type', () => {
    // The per-entry bound, which the last-send window alone does not give: a
    // second /ctcp refreshes "last thing sent here", so without it the
    // oldest-first scan would hand this 401 to the 20s-old VERSION request and
    // report in the buffer that one came from.
    vi.useFakeTimers();
    try {
      const { conn, ctcpLines } = harness();
      conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
      vi.advanceTimersByTime(20_000); // VERSION is now past the send window
      conn.sendCtcpRequest('#manga', 'bob', 'TIME', '');
      const before = ctcpLines().length;

      conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

      expect(ctcpLines().slice(before)).toEqual([
        { target: '#manga', text: "bob isn't on this network." },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields to a /whois issued after it', () => {
    // Copilot, PR #823. A nick-only command records a lastNickIntent but is not
    // a send, so the lastUserSendAt gate is blind to it — and the channel bucket
    // CONSUMES that intent before the CTCP bucket runs, so the signal is gone by
    // the time we look. The reachable case: bob exists and ignores the probe,
    // then quits, then /whois bob draws the 401. That 401 answers the whois.
    vi.useFakeTimers();
    try {
      const { conn, ctcpLines } = harness();
      conn.client.raw = vi.fn<(line: string) => void>();
      conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
      const before = ctcpLines().length;
      const publish = vi.fn<(event: unknown) => void>();
      conn.publish = publish;

      vi.advanceTimersByTime(2000);
      conn.raw('WHOIS bob');
      conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

      expect(ctcpLines().slice(before)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still claims a request issued AFTER that /whois', () => {
    // Per-entry, not a blanket refusal: the whois only disqualifies the requests
    // that predate it. Otherwise one /whois would poison the routing for every
    // subsequent /ctcp to that nick inside the window.
    vi.useFakeTimers();
    try {
      const { conn, ctcpLines } = harness();
      conn.client.raw = vi.fn<(line: string) => void>();
      conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
      vi.advanceTimersByTime(1000);
      conn.raw('WHOIS bob');
      vi.advanceTimersByTime(1000);
      conn.sendCtcpRequest('#manga', 'bob', 'VERSION', '');
      const before = ctcpLines().length;

      conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

      expect(ctcpLines().slice(before)).toEqual([
        { target: '#manga', text: "bob isn't on this network." },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops claiming once the send window has passed, though the reply TTL has not', () => {
    // The two windows are deliberately different lengths: a reply may be slow,
    // a refusal comes back on the same round trip. An entry a peer never
    // answered must stop catching unrelated failures long before it stops
    // being able to catch its own late reply.
    vi.useFakeTimers();
    try {
      const { conn, ctcpLines } = harness();
      conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
      const before = ctcpLines().length;
      const publish = vi.fn<(event: unknown) => void>();
      conn.publish = publish;

      vi.advanceTimersByTime(30_000); // past the 15s send window, inside the 60s TTL
      conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

      expect(ctcpLines().slice(before)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CTCP routing survives the shapes clients actually send (#821 review)', () => {
  it('routes a multi-token type, instead of building a key nothing can match', () => {
    // Only the web client guarantees a single-token type; iOS and MCP pass
    // through whatever was typed. `PING FOO` used to build the key
    // `bob PING FOO`, which no lookup could match — costing the reply AND the
    // failure their routing, silently.
    const { conn, ctcpRequest, ctcpLines } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'PING FOO', '');

    // The spare word becomes args, exactly as parseCtcp would split it inbound.
    expect(ctcpRequest).toHaveBeenCalledWith('bob', 'PING', 'FOO');

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });
    expect(ctcpLines().map((l) => l.target)).toEqual(['#anime', '#anime']);
  });

  it('carries an outstanding request through a /nick, for the reply and the failure', () => {
    // The re-key beside this one looked up the bare nick, but every key is
    // `<nick-lc> <TYPE>` — so the queue never followed a rename at all.
    const { conn, ctcpLines } = harness();
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    conn.client.emit('nick', { nick: 'bob', new_nick: 'rob' });

    conn.client.emit('ctcp response', {
      nick: 'rob',
      ident: 'b',
      hostname: 'h',
      target: 'alice',
      type: 'VERSION',
      message: 'VERSION SomeClient 1.0',
    });

    const last = ctcpLines()[ctcpLines().length - 1];
    expect(last.target).toBe('#anime'); // not the server buffer as unsolicited
    expect(last.text).toContain('SomeClient 1.0');
  });
});

describe('a /whois between requests is ordered by sequence, not by the clock', () => {
  // The other edge of the ticking clock over the #821 block: a frozen one,
  // where two moves share a millisecond and only their order can tell them
  // apart. A per-connection move sequence orders them; Date.now() cannot.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a /whois between two requests still outranks only the earlier one', () => {
    // The gate the fix must not loosen: a raw command IS a newer move, and a
    // later send must not erase its claim on the earlier request. One numeric
    // on purpose: takeCommandIntent consumes the whois with it.
    tickingClock();
    const { conn, ctcpLines } = harness();
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
    conn.raw('WHOIS bob');
    conn.sendCtcpRequest('#manga', 'bob', 'VERSION', '');
    const before = ctcpLines().length;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines().slice(before)).toEqual([
      { target: '#manga', text: "bob isn't on this network." },
    ]);
  });

  it('a same-type request issued after the /whois is not hidden by the one it outranked', () => {
    // VERSION is the type people actually send, so both requests share one
    // queue. Judged by its head alone, the outranked older request hid the
    // newer one and the #manga echo never got its outcome. The outranked one
    // stays in the queue, though: it can still catch its own late reply.
    tickingClock();
    const { conn, ctcpLines } = harness();
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.sendCtcpRequest('#anime', 'bob', 'VERSION', '');
    conn.raw('WHOIS bob');
    conn.sendCtcpRequest('#manga', 'bob', 'VERSION', '');
    const before = ctcpLines().length;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });
    expect(ctcpLines().slice(before)).toEqual([
      { target: '#manga', text: "bob isn't on this network." },
    ]);

    conn.client.emit('ctcp response', {
      nick: 'bob',
      ident: 'b',
      hostname: 'h',
      target: 'alice',
      type: 'VERSION',
      message: 'VERSION LateClient 1.0',
    });
    const last = ctcpLines()[ctcpLines().length - 1];
    expect(last.target).toBe('#anime');
    expect(last.text).toContain('LateClient 1.0');
  });

  it('a /whois in the same millisecond as the request still outranks it', () => {
    // A scripted or MCP client can land both frames in one chunk, and wsHub
    // dispatches them in one tick. The outranked request's 401 still goes
    // somewhere — the server buffer, as an unclaimed 401 does.
    vi.useFakeTimers();
    const { conn, ctcpLines } = harness();
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
    const before = ctcpLines().length;
    const publish = vi.fn<(event: unknown) => void>();
    conn.publish = publish;

    conn.raw('WHOIS bob');
    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines().slice(before)).toHaveLength(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', target: ':server:1' }),
    );
  });

  it('a request in the same millisecond as an earlier /whois still claims', () => {
    // The other order of the same tie — what a `<=` on timestamps would break.
    vi.useFakeTimers();
    const { conn, ctcpLines } = harness();
    conn.client.raw = vi.fn<(line: string) => void>();
    conn.raw('WHOIS bob');
    conn.sendCtcpRequest('#anime', 'bob', 'CLIENTINFO', '');
    const before = ctcpLines().length;

    conn.client.emit('irc error', { error: 'no_such_nick', nick: 'bob' });

    expect(ctcpLines().slice(before)).toEqual([
      { target: '#anime', text: "bob isn't on this network." },
    ]);
  });
});
