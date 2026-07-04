// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Socket-driven integration harness for the built-in IRC bouncer, modeled on
// soju's server_test.go: start the real bouncer listener on an ephemeral port,
// inject a *fake* upstream IrcConnection into ircManager (no real IRC server),
// and drive the bouncer over a real TCP socket the way an attaching client
// would. Assert on the exact wire lines the bouncer sends back.
//
// The fake upstream implements only the slice of IrcConnection the bouncer
// touches (state, currentNick, registrationLines, channels, client, raw). Its
// `client` is a plain EventEmitter — `pushUpstream()` fires the `raw` events the
// bouncer relays to attached clients, and `rawSent` captures whatever the
// bouncer forwards back upstream (client → network).

import net from 'net';
import { EventEmitter, once } from 'node:events';
import ircManager from '../services/ircManager.js';
import {
  startBouncer,
  stopBouncer,
  resetAuthThrottle,
  attachedSessionCount,
  parseClientLine,
} from '../services/bouncer.js';
import { createUser, setPasswordHash } from '../db/users.js';
import { hashPassword } from '../services/password.js';
import { createToken } from '../db/apiTokens.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import type { User } from '../db/users.js';

export interface FakeChannel {
  name: string;
  topic: string | null;
  members: Map<string, { nick: string; modes: string[] }>;
  modes: Set<string>;
}

// Minimal stand-in for IrcConnection covering exactly what bouncer.ts reads.
export class FakeUpstream {
  state = 'connected';
  currentNick = 'tester';
  registrationLines: string[] = [];
  channels = new Map<string, FakeChannel>();
  // Lines the bouncer forwarded to the upstream network via conn.raw().
  rawSent: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;

  constructor(nick = 'tester') {
    this.currentNick = nick;
    const client = new EventEmitter();
    // Several attached sessions listen on one upstream; lift the default cap so
    // Node doesn't warn during multi-client tests.
    client.setMaxListeners(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).user = { username: nick, host: 'fake.host' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).network = {
      options: {
        PREFIX: [
          { mode: 'o', symbol: '@' },
          { mode: 'v', symbol: '+' },
        ],
      },
    };
    this.client = client;
  }

  raw(line: string): void {
    this.rawSent.push(line);
  }

  // Simulate the upstream network sending a raw line down to attached clients.
  pushUpstream(line: string): void {
    this.client.emit('raw', { from_server: true, line });
  }

  addChannel(name: string, opts: { topic?: string; members?: string[] } = {}): FakeChannel {
    const members = new Map<string, { nick: string; modes: string[] }>();
    for (const raw of opts.members ?? []) {
      const modes: string[] = [];
      let nick = raw;
      if (nick.startsWith('@')) {
        modes.push('o');
        nick = nick.slice(1);
      } else if (nick.startsWith('+')) {
        modes.push('v');
        nick = nick.slice(1);
      }
      members.set(nick.toLowerCase(), { nick, modes });
    }
    const ch: FakeChannel = {
      name,
      topic: opts.topic ?? null,
      members,
      modes: new Set(),
    };
    this.channels.set(name.toLowerCase(), ch);
    return ch;
  }
}

export interface HarnessAccount {
  user: User;
  network: Network;
  password: string;
  token: string;
  upstream: FakeUpstream;
}

let accountSeq = 0;

/**
 * Seed a user with a password, a read-write API token, and one network, then
 * inject a live FakeUpstream so the bouncer's getConnection() finds it already
 * "connected" (no real socket, no startNetwork).
 */
export function seedAccount(
  opts: {
    password?: string;
    nick?: string;
    networkName?: string;
    upstream?: FakeUpstream;
  } = {},
): HarnessAccount {
  accountSeq += 1;
  const username = `bnc_user_${accountSeq}`;
  const password = opts.password ?? 'hunter2hunter2';
  const nick = opts.nick ?? `nick${accountSeq}`;
  const networkName = opts.networkName ?? 'libera';

  const user = createUser(username);
  setPasswordHash(user.id, hashPassword(password));
  const token = createToken({ userId: user.id, name: 'bnc', scope: 'read-write' }).token;
  const network = createNetwork(user.id, {
    name: networkName,
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick,
  } as Parameters<typeof createNetwork>[1])!;

  const upstream = opts.upstream ?? new FakeUpstream(nick);
  ircManager.connectionsForUser(user.id).set(network.id, upstream as never);

  return { user, network, password, token, upstream };
}

/** Registered bouncer sessions currently attached to an account's network. */
export function attachedFor(acct: HarnessAccount): number {
  return attachedSessionCount(acct.user.id, acct.network.id);
}

/** Add a second network + upstream to an already-seeded user. */
export function seedNetwork(
  user: User,
  opts: { networkName: string; nick?: string; upstream?: FakeUpstream },
): { network: Network; upstream: FakeUpstream } {
  const nick = opts.nick ?? 'nick';
  const network = createNetwork(user.id, {
    name: opts.networkName,
    host: 'irc.example.test',
    port: 6697,
    tls: true,
    nick,
  } as Parameters<typeof createNetwork>[1])!;
  const upstream = opts.upstream ?? new FakeUpstream(nick);
  ircManager.connectionsForUser(user.id).set(network.id, upstream as never);
  return { network, upstream };
}

// ---------------------------------------------------------------------------
// Client socket driver
// ---------------------------------------------------------------------------

export class BouncerClient {
  readonly socket: net.Socket;
  readonly lines: string[] = [];
  private buf = '';
  private waiters: Array<{ pred: (line: string) => boolean; resolve: (line: string) => void }> = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.lines.push(line);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].pred(line)) {
          this.waiters[i].resolve(line);
          this.waiters.splice(i, 1);
        }
      }
    }
  }

  send(line: string): void {
    this.socket.write(line + '\r\n');
  }

  /** Resolve with the first line (past or future) matching `pred`. */
  waitFor(pred: (line: string) => boolean, timeoutMs = 2000): Promise<string> {
    const existing = this.lines.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for line; got:\n${this.lines.join('\n')}`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({
        pred,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }

  /** Wait until an IRC command (numeric or verb) is seen from the server. */
  waitForCommand(command: string, timeoutMs = 2000): Promise<string> {
    const cmd = command.toUpperCase();
    return this.waitFor((line) => commandOf(line) === cmd, timeoutMs);
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Extract the IRC command/numeric from a server line (skipping tags+prefix). */
export function commandOf(line: string): string {
  return parseClientLine(line)?.command ?? '';
}

export interface Harness {
  port: number;
  connect(): Promise<BouncerClient>;
  stop(): void;
}

/** Start the real bouncer on an ephemeral port. Call stop() in afterAll. */
export async function startHarness(): Promise<Harness> {
  const srv = startBouncer(0, '127.0.0.1');
  if (!srv) throw new Error('bouncer already started');
  await once(srv, 'listening');
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('no bouncer address');
  const port = addr.port;
  const clients: BouncerClient[] = [];
  return {
    port,
    async connect(): Promise<BouncerClient> {
      const socket = net.connect({ port, host: '127.0.0.1' });
      await once(socket, 'connect');
      const client = new BouncerClient(socket);
      clients.push(client);
      return client;
    },
    stop(): void {
      for (const c of clients) c.close();
      resetAuthThrottle();
      stopBouncer();
    },
  };
}
