// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import { setupTestDb } from '../test-utils/testApp.js';
import type { Socket } from 'net';

const ctx = setupTestDb('services-bouncer');

let authenticateBouncerPass: typeof import('./bouncerServer.js').authenticateBouncerPass;
let BouncerSession: typeof import('./bouncerServer.js').BouncerSession;
let eventToIrcLine: typeof import('./bouncerServer.js').eventToIrcLine;
let formatIrcLine: typeof import('./bouncerServer.js').formatIrcLine;
let IrcLineFramer: typeof import('./bouncerServer.js').IrcLineFramer;
let parseIrcLine: typeof import('./bouncerServer.js').parseIrcLine;
let createUser: typeof import('../db/users.js').createUser;
let deleteUser: typeof import('../db/users.js').deleteUser;
let createToken: typeof import('../db/apiTokens.js').createToken;
let revoke: typeof import('../db/apiTokens.js').revoke;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let findActiveByHash: typeof import('../db/apiTokens.js').findActiveByHash;
let hashToken: typeof import('../db/apiTokens.js').hashToken;

beforeAll(async () => {
  ({
    authenticateBouncerPass,
    BouncerSession,
    eventToIrcLine,
    formatIrcLine,
    IrcLineFramer,
    parseIrcLine,
  } = await import('./bouncerServer.js'));
  ({ createUser, deleteUser } = await import('../db/users.js'));
  ({ createToken, revoke, findActiveByHash, hashToken } = await import('../db/apiTokens.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
});

afterAll(() => ctx.cleanup());

describe('IRC line parsing and serialization', () => {
  it('handles tags, prefixes, trailing params, and CRLF framing', () => {
    const framer = new IrcLineFramer();
    expect(framer.push('@time=2026-01-01T00:00:00Z :a!b@c PRIV')).toEqual([]);
    const lines = framer.push('MSG #x :hello world\r\nPING :abc\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      tags: { time: '2026-01-01T00:00:00Z' },
      prefix: 'a!b@c',
      command: 'PRIVMSG',
      params: ['#x', 'hello world'],
    });
    expect(lines[1]).toMatchObject({ command: 'PING', params: ['abc'] });
  });

  it('rejects malformed lines and escapes IRCv3 tag values', () => {
    expect(parseIrcLine('@badtag')).toBeNull();
    expect(
      formatIrcLine({ tags: { label: 'a b;c' }, command: 'NOTICE', params: ['me', 'hi'] }),
    ).toBe('@label=a\\sb\\:c NOTICE me hi\r\n');
  });
});

describe('bouncer authentication', () => {
  it('accepts a read-write token for an owned network and touches last-used', () => {
    const user = createUser('bounce-auth-ok');
    const network = createNetwork(user.id, {
      name: 'Libera',
      host: 'irc.example.invalid',
      nick: 'alice',
    });
    if (!network) throw new Error('network missing');
    const token = createToken({ userId: user.id, name: 'bouncer', scope: 'read-write' });

    const auth = authenticateBouncerPass(`${token.token}:${network.id}`);
    expect(auth).toMatchObject({ ok: true, userId: user.id });
    expect(findActiveByHash(hashToken(token.token))!.lastUsedAt).not.toBeNull();
  });

  it('rejects invalid, read-only, revoked, deleted-user, unknown, and cross-user networks', () => {
    const owner = createUser('bounce-auth-owner');
    const other = createUser('bounce-auth-other');
    const ownNetwork = createNetwork(owner.id, { name: 'own', host: 'irc.invalid', nick: 'own' });
    const otherNetwork = createNetwork(other.id, {
      name: 'other',
      host: 'irc.invalid',
      nick: 'other',
    });
    if (!ownNetwork || !otherNetwork) throw new Error('network missing');
    const readOnly = createToken({ userId: owner.id, name: 'ro', scope: 'read' });
    const revoked = createToken({ userId: owner.id, name: 'revoked', scope: 'read-write' });
    const doomedUser = createUser('bounce-auth-doomed');
    const doomedNetwork = createNetwork(doomedUser.id, {
      name: 'doomed',
      host: 'irc.invalid',
      nick: 'doomed',
    });
    if (!doomedNetwork) throw new Error('network missing');
    const doomed = createToken({ userId: doomedUser.id, name: 'doomed', scope: 'read-write' });
    revoke(revoked.id, owner.id);
    deleteUser(doomedUser.id);

    expect(authenticateBouncerPass(`nope:${ownNetwork.id}`).ok).toBe(false);
    expect(authenticateBouncerPass(`${readOnly.token}:${ownNetwork.id}`).ok).toBe(false);
    expect(authenticateBouncerPass(`${revoked.token}:${ownNetwork.id}`).ok).toBe(false);
    expect(authenticateBouncerPass(`${doomed.token}:${doomedNetwork.id}`).ok).toBe(false);
    expect(authenticateBouncerPass(`${readOnly.token}:999999`).ok).toBe(false);
    const cross = createToken({ userId: owner.id, name: 'rw', scope: 'read-write' });
    expect(authenticateBouncerPass(`${cross.token}:${otherNetwork.id}`).ok).toBe(false);
  });
});

describe('bouncer behavior', () => {
  it('registers, replays channel state/backlog, maps commands, and fans out live events', async () => {
    const user = createUser('bounce-behavior');
    const network = createNetwork(user.id, {
      name: 'TestNet',
      host: 'irc.example.invalid',
      nick: 'configured',
    });
    if (!network) throw new Error('network missing');
    const token = createToken({ userId: user.id, name: 'bouncer', scope: 'read-write' });
    insertMessage({
      networkId: network.id,
      target: '#test',
      time: '2026-06-14T12:00:00.000Z',
      type: 'message',
      nick: 'bob',
      text: 'old line',
    });
    insertMessage({
      networkId: network.id,
      target: 'bob',
      time: '2026-06-14T12:01:00.000Z',
      type: 'notice',
      nick: 'bob',
      text: 'dm notice',
    });
    const raw = vi.fn<(line: string) => void>();
    const manager = Object.assign(new EventEmitter(), {
      startNetwork: vi.fn<(userId: number, networkId: number) => unknown>(),
      getConnection: vi.fn<(userId: number, networkId: number) => unknown>((userId, networkId) => ({
        userId,
        networkId,
        state: 'connected',
        network,
        raw,
        snapshot: () => ({
          nick: 'liveNick',
          channels: [
            {
              name: '#test',
              topic: 'topic text',
              members: [
                { nick: 'liveNick', modes: ['o'] },
                { nick: 'bob', modes: ['v'] },
              ],
            },
          ],
        }),
      })),
      send: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        (userId, networkId, target, text) => {
          manager.emit('event', {
            userId,
            networkId,
            type: 'message',
            target,
            nick: 'liveNick',
            text,
            self: true,
            time: '2026-06-14T12:03:00.000Z',
          });
          return true;
        },
      ),
      action: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        () => true,
      ),
      notice: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        () => true,
      ),
      joinChannel: vi.fn<(userId: number, networkId: number, name: string) => boolean>(() => true),
      partChannel: vi.fn<
        (userId: number, networkId: number, name: string, reason?: string) => boolean
      >(() => true),
    });
    const addPresence = vi.fn<(userId: number) => void>();
    const removePresence = vi.fn<(userId: number) => void>();

    const socket = new FakeSocket();
    const received = socket.received;
    const session = new BouncerSession(
      socket as unknown as Socket,
      {
        manager: manager as never,
        authenticate: authenticateBouncerPass,
        listBufferTargets: (await import('../db/messages.js')).listBufferTargets,
        listMessages: (await import('../db/messages.js')).listMessages,
        addPresence,
        removePresence,
        log: vi.fn<(_line: { scope: string; level?: string; text: string }) => void>(),
      },
      vi.fn<() => void>(),
    );
    expect(session).toBeDefined();
    socket.clientWrite(
      `PASS ${token.token}:${network.id}\r\nNICK clientNick\r\nUSER u 0 * :Real\r\n`,
    );
    await waitFor(() => received.join('').includes(' 376 '));
    expect(received.join('')).toContain(' 001 liveNick ');
    expect(received.join('')).toContain(':liveNick!u@lurker JOIN #test');
    expect(received.join('')).toContain(' 332 liveNick #test :topic text');
    expect(received.join('')).toContain(' 353 liveNick = #test :@liveNick +bob');
    expect(received.join('')).toContain(
      '@time=2026-06-14T12:00:00.000Z :bob!bob@lurker PRIVMSG #test :old line',
    );
    expect(received.join('')).toContain(
      '@time=2026-06-14T12:01:00.000Z :bob!bob@lurker NOTICE liveNick :dm notice',
    );
    expect(addPresence).toHaveBeenCalledWith(user.id);

    socket.clientWrite('PRIVMSG #test :hello\r\n');
    socket.clientWrite('PRIVMSG #test :\x01ACTION waves\x01\r\n');
    socket.clientWrite('NOTICE #test :heads up\r\n');
    socket.clientWrite('JOIN #next\r\nPART #next :bye\r\nPING :abc\r\nWHOIS bob\r\n');
    await waitFor(() => raw.mock.calls.length > 0);
    expect(manager.send).toHaveBeenCalledWith(user.id, network.id, '#test', 'hello');
    expect(manager.action).toHaveBeenCalledWith(user.id, network.id, '#test', 'waves');
    expect(manager.notice).toHaveBeenCalledWith(user.id, network.id, '#test', 'heads up');
    expect(manager.joinChannel).toHaveBeenCalledWith(user.id, network.id, '#next');
    expect(manager.partChannel).toHaveBeenCalledWith(user.id, network.id, '#next', 'bye');
    expect(raw).toHaveBeenCalledWith('WHOIS bob');
    expect(received.join('')).toContain('PONG abc');

    manager.emit('event', {
      userId: user.id,
      networkId: network.id,
      type: 'message',
      target: '#test',
      nick: 'carol',
      text: 'live line',
      time: '2026-06-14T12:02:00.000Z',
    });
    await waitFor(() => received.join('').includes('live line'));

    expect(received.join('')).not.toContain('PRIVMSG #test :hello');

    manager.emit('event', {
      userId: user.id,
      networkId: network.id,
      type: 'message',
      target: '#test',
      nick: 'liveNick',
      text: 'sent elsewhere',
      self: true,
      time: '2026-06-14T12:04:00.000Z',
    });
    await waitFor(() => received.join('').includes('sent elsewhere'));

    socket.clientWrite('QUIT :done\r\n');
    await once(socket, 'close');
    expect(removePresence).toHaveBeenCalledWith(user.id);
  });

  it('keeps the bouncer socket alive when upstream is disconnected', async () => {
    const user = createUser('bounce-offline');
    const network = createNetwork(user.id, { name: 'Offline', host: 'irc.invalid', nick: 'off' });
    if (!network) throw new Error('network missing');
    const token = createToken({ userId: user.id, name: 'bouncer', scope: 'read-write' });
    const manager = Object.assign(new EventEmitter(), {
      startNetwork: vi.fn<(userId: number, networkId: number) => unknown>(),
      getConnection: vi.fn<(userId: number, networkId: number) => null>(() => null),
      send: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        () => false,
      ),
      action: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        () => false,
      ),
      notice: vi.fn<(userId: number, networkId: number, target: string, text: string) => boolean>(
        () => false,
      ),
      joinChannel: vi.fn<(userId: number, networkId: number, name: string) => boolean>(() => false),
      partChannel: vi.fn<
        (userId: number, networkId: number, name: string, reason?: string) => boolean
      >(() => false),
    });
    const socket = new FakeSocket();
    const session = new BouncerSession(
      socket as unknown as Socket,
      {
        manager: manager as never,
        authenticate: authenticateBouncerPass,
        listBufferTargets: (await import('../db/messages.js')).listBufferTargets,
        listMessages: (await import('../db/messages.js')).listMessages,
        addPresence: vi.fn<(userId: number) => void>(),
        removePresence: vi.fn<(userId: number) => void>(),
        log: vi.fn<(_line: { scope: string; level?: string; text: string }) => void>(),
      },
      vi.fn<() => void>(),
    );
    expect(session).toBeDefined();
    const received = socket.received;
    socket.clientWrite(`PASS ${token.token}:${network.id}\r\nNICK c\r\nUSER u 0 * :Real\r\n`);
    await waitFor(() => received.join('').includes(' 376 '));
    socket.clientWrite('PRIVMSG #x :not sent\r\n');
    await waitFor(() => received.join('').includes('message was not sent'));
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });
});

describe('event translation', () => {
  it('translates persisted events into IRC lines with server-time tags', () => {
    const line = eventToIrcLine(
      {
        type: 'action',
        target: '#x',
        nick: 'alice',
        text: 'waves',
        time: '2026-06-14T00:00:00.000Z',
      },
      'me',
    );
    expect(formatIrcLine(line!)).toBe(
      '@time=2026-06-14T00:00:00.000Z :alice!alice@lurker PRIVMSG #x :\x01ACTION waves\x01\r\n',
    );
  });
});

function once(emitter: EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

class FakeSocket extends EventEmitter {
  received: string[] = [];
  destroyed = false;

  setEncoding(_encoding: BufferEncoding): void {
    /* noop */
  }

  write(chunk: string | Buffer): boolean {
    this.received.push(chunk.toString());
    return true;
  }

  clientWrite(chunk: string): void {
    this.emit('data', chunk);
  }

  end(): this {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
