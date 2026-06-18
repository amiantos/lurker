// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import net from 'net';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import type { Server } from 'net';
import ircManager from './ircManager.js';
import { addExternalVisibleClient, removeExternalVisibleClient } from './wsHub.js';
import { hashToken, findActiveByHash, touchLastUsed } from '../db/apiTokens.js';
import { findUserById } from '../db/users.js';
import { getNetwork, ownsNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { listBufferTargets, listMessages } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import * as systemLog from './systemLog.js';
import { splitAction, splitSay } from './messageSplit.js';

const BACKLOG_LIMIT = 50;
const SERVER_NAME = 'lurker';
const CTCP_ACTION_PREFIX = '\x01ACTION ';

export interface IrcLine {
  tags: Record<string, string | true>;
  prefix: string | null;
  command: string;
  params: string[];
}

interface AuthContext {
  ok: true;
  userId: number;
  network: Network;
}

interface AuthFailure {
  ok: false;
  reason: string;
}

type AuthResult = AuthContext | AuthFailure;

interface BouncerManager extends EventEmitter {
  startNetwork(userId: number, networkId: number): unknown;
  getConnection(userId: number, networkId: number): BouncerConnection | null;
  send(userId: number, networkId: number, target: string, text: string): boolean;
  action(userId: number, networkId: number, target: string, text: string): boolean;
  notice(userId: number, networkId: number, target: string, text: string): boolean;
  joinChannel(userId: number, networkId: number, name: string): boolean;
  partChannel(userId: number, networkId: number, name: string, reason?: string): boolean;
}

interface BouncerConnection {
  state?: string;
  network: Network;
  raw(line: string): void;
  snapshot(): unknown;
}

export interface BouncerDeps {
  manager: BouncerManager;
  authenticate(pass: string): AuthResult;
  listBufferTargets(networkId: number): string[];
  listMessages(networkId: number, target: string, opts: { limit: number }): MessageEvent[];
  addPresence(userId: number): void;
  removePresence(userId: number): void;
  log(line: { scope: string; level?: string; text: string }): void;
}

interface BouncerOptions {
  host?: string;
  port: number;
  deps?: Partial<BouncerDeps>;
}

function defaultDeps(): BouncerDeps {
  return {
    manager: ircManager as unknown as BouncerManager,
    authenticate: authenticateBouncerPass,
    listBufferTargets,
    listMessages,
    addPresence: addExternalVisibleClient,
    removePresence: removeExternalVisibleClient,
    log: systemLog.log,
  };
}

export function parseIrcLine(raw: string): IrcLine | null {
  let line = raw.replace(/[\r\n]+$/, '');
  if (!line || line.length > 512) return null;
  const tags: Record<string, string | true> = {};
  let prefix: string | null = null;
  if (line.startsWith('@')) {
    const space = line.indexOf(' ');
    if (space === -1) return null;
    const rawTags = line.slice(1, space);
    line = line.slice(space + 1);
    for (const tag of rawTags.split(';')) {
      if (!tag) continue;
      const eq = tag.indexOf('=');
      if (eq === -1) tags[tag] = true;
      else tags[tag.slice(0, eq)] = unescapeTag(tag.slice(eq + 1));
    }
  }
  if (line.startsWith(':')) {
    const space = line.indexOf(' ');
    if (space === -1) return null;
    prefix = line.slice(1, space);
    line = line.slice(space + 1);
  }
  const params: string[] = [];
  let trailing = false;
  for (const part of line.split(' ')) {
    if (!part && !trailing) continue;
    if (trailing) {
      params[params.length - 1] += ` ${part}`;
    } else if (part.startsWith(':')) {
      params.push(part.slice(1));
      trailing = true;
    } else {
      params.push(part);
    }
  }
  const command = params.shift()?.toUpperCase() || '';
  if (!command) return null;
  return { tags, prefix, command, params };
}

export function formatIrcLine(line: {
  tags?: Record<string, string | number | boolean | null | undefined>;
  prefix?: string | null;
  command: string;
  params?: Array<string | number | null | undefined>;
}): string {
  const parts: string[] = [];
  const tags = Object.entries(line.tags || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => (value === true ? key : `${key}=${escapeTag(String(value))}`));
  if (tags.length) parts.push(`@${tags.join(';')}`);
  if (line.prefix) parts.push(`:${sanitizeToken(line.prefix)}`);
  parts.push(sanitizeToken(line.command).toUpperCase());
  const params = (line.params || []).filter((p) => p !== null && p !== undefined).map(String);
  for (let i = 0; i < params.length; i += 1) {
    const p = sanitizeParam(params[i]);
    const trailing = i === params.length - 1 && (p === '' || p.startsWith(':') || /\s/.test(p));
    parts.push(trailing ? `:${p}` : p);
  }
  return `${parts.join(' ')}\r\n`;
}

export class IrcLineFramer {
  private buf = '';

  push(chunk: Buffer | string): IrcLine[] {
    this.buf += chunk.toString();
    const out: IrcLine[] = [];
    for (;;) {
      const idx = this.buf.search(/\r?\n/);
      if (idx === -1) break;
      const raw = this.buf.slice(0, idx);
      const sepLen = this.buf[idx] === '\r' && this.buf[idx + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(idx + sepLen);
      const line = parseIrcLine(raw);
      if (line) out.push(line);
    }
    if (this.buf.length > 2048) this.buf = '';
    return out;
  }
}

export function authenticateBouncerPass(pass: string): AuthResult {
  const idx = pass.lastIndexOf(':');
  if (idx <= 0 || idx === pass.length - 1) return { ok: false, reason: 'invalid PASS format' };
  const rawToken = pass.slice(0, idx);
  const networkId = Number(pass.slice(idx + 1));
  if (!Number.isInteger(networkId) || networkId <= 0) {
    return { ok: false, reason: 'invalid network id' };
  }
  const token = findActiveByHash(hashToken(rawToken));
  if (!token) return { ok: false, reason: 'invalid token' };
  if (token.scope !== 'read-write') return { ok: false, reason: 'read-write token required' };
  const user = findUserById(token.userId);
  if (!user) return { ok: false, reason: 'user not found' };
  if (user.is_paused === 1) return { ok: false, reason: 'account paused' };
  if (!ownsNetwork(user.id, networkId)) return { ok: false, reason: 'network not accessible' };
  const network = getNetwork(networkId, user.id);
  if (!network) return { ok: false, reason: 'network not accessible' };
  touchLastUsed(token.id);
  return { ok: true, userId: user.id, network };
}

export class BouncerServer {
  private host: string;
  private port: number;
  private deps: BouncerDeps;
  private server: Server | null = null;
  private sessions = new Set<BouncerSession>();

  constructor(options: BouncerOptions) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port;
    this.deps = { ...defaultDeps(), ...options.deps };
  }

  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = net.createServer((socket) => {
      const session = new BouncerSession(socket, this.deps, () => this.sessions.delete(session));
      this.sessions.add(session);
    });
    return new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        this.deps.log({
          scope: 'server',
          text: `IRC bouncer listening on ${this.host}:${this.port}`,
        });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
  }

  close(): Promise<void> {
    for (const session of this.sessions) session.close();
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  address(): net.AddressInfo | string | null {
    return this.server?.address() || null;
  }
}

export class BouncerSession {
  private socket: Socket;
  private deps: BouncerDeps;
  private onDone: () => void;
  private framer = new IrcLineFramer();
  private pass: string | null = null;
  private nick: string | null = null;
  private user: string | null = null;
  private auth: AuthContext | null = null;
  private registered = false;
  private closed = false;
  private sentNamesFor = new Set<string>();
  private pendingSelfEchoes: Array<{ type: string; target: string; text: string }> = [];
  private boundEvent = (event: unknown) => this.onManagerEvent(event);

  constructor(socket: Socket, deps: BouncerDeps, onDone: () => void) {
    this.socket = socket;
    this.deps = deps;
    this.onDone = onDone;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.cleanup());
    socket.on('error', () => this.cleanup());
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer | string): void {
    for (const line of this.framer.push(chunk)) this.handleLine(line);
  }

  private handleLine(line: IrcLine): void {
    if (!this.registered) {
      switch (line.command) {
        case 'PASS':
          this.pass = line.params[0] || '';
          break;
        case 'NICK':
          this.nick = line.params[0] || null;
          break;
        case 'USER':
          this.user = line.params[0] || null;
          break;
        case 'PING':
          this.write({ command: 'PONG', params: [line.params[0] || SERVER_NAME] });
          return;
        case 'QUIT':
          this.socket.end();
          return;
      }
      this.tryRegister();
      return;
    }

    switch (line.command) {
      case 'PING':
        this.write({ command: 'PONG', params: [line.params[0] || SERVER_NAME] });
        break;
      case 'QUIT':
        this.socket.end();
        break;
      case 'PRIVMSG':
        this.handlePrivmsg(line);
        break;
      case 'NOTICE':
        this.handleNotice(line);
        break;
      case 'JOIN':
        for (const channel of splitCsv(line.params[0])) {
          if (!this.deps.manager.joinChannel(this.auth!.userId, this.auth!.network.id, channel)) {
            this.localNotice(
              `Network ${this.auth!.network.name} is not connected; JOIN was not sent.`,
            );
          }
        }
        break;
      case 'PART':
        for (const channel of splitCsv(line.params[0])) {
          this.deps.manager.partChannel(
            this.auth!.userId,
            this.auth!.network.id,
            channel,
            line.params[1],
          );
        }
        break;
      case 'NAMES':
        this.handleNames(line);
        break;
      case 'NICK':
      case 'MODE':
      case 'WHOIS':
      case 'TOPIC':
      case 'AWAY':
        this.forwardRaw(line);
        break;
      default:
        this.forwardRaw(line);
        break;
    }
  }

  private tryRegister(): void {
    if (this.registered || !this.pass || !this.nick || !this.user) return;
    const auth = this.deps.authenticate(this.pass);
    if (!auth.ok) {
      this.write({
        prefix: SERVER_NAME,
        command: '464',
        params: [this.nick || '*', `Authentication failed: ${auth.reason}`],
      });
      this.socket.end();
      return;
    }
    this.auth = auth;
    this.registered = true;
    this.deps.addPresence(auth.userId);
    this.deps.manager.on('event', this.boundEvent);
    this.deps.manager.startNetwork(auth.userId, auth.network.id);
    this.sendWelcome();
    this.replayState();
  }

  private sendWelcome(): void {
    const nick = this.currentNick();
    const now = new Date().toISOString();
    this.write({
      prefix: SERVER_NAME,
      command: '001',
      params: [nick, `Welcome to Lurker bouncer for ${this.auth!.network.name}`],
    });
    this.write({
      prefix: SERVER_NAME,
      command: '002',
      params: [nick, `Your host is ${SERVER_NAME}`],
    });
    this.write({
      prefix: SERVER_NAME,
      command: '003',
      params: [nick, `This bouncer session was created ${now}`],
    });
    this.write({
      prefix: SERVER_NAME,
      command: '004',
      params: [nick, SERVER_NAME, 'lurker', 'aiw', 'nt'],
    });
    this.write({ prefix: SERVER_NAME, command: '375', params: [nick, '- Lurker bouncer status'] });
    const conn = this.connection();
    const state = conn?.state || 'disconnected';
    this.write({
      prefix: SERVER_NAME,
      command: '372',
      params: [nick, `- Network: ${this.auth!.network.name} (${state})`],
    });
    this.write({ prefix: SERVER_NAME, command: '376', params: [nick, 'End of /MOTD command.'] });
  }

  private replayState(): void {
    const auth = this.auth!;
    const snapshot = snapshotFor(this.connection());
    const targets = new Set(this.deps.listBufferTargets(auth.network.id));
    for (const channel of snapshot.channels) targets.add(channel.name);
    for (const target of targets) {
      if (isChannel(target)) {
        this.emitSelfJoin(target);
        const channel = snapshot.channels.find(
          (ch) => ch.name.toLowerCase() === target.toLowerCase(),
        );
        if (channel?.topic) {
          this.write({
            prefix: SERVER_NAME,
            command: '332',
            params: [this.currentNick(), channel.name, channel.topic],
          });
        }
        if (channel) this.emitNames(channel);
      }
      for (const msg of this.deps.listMessages(auth.network.id, target, { limit: BACKLOG_LIMIT })) {
        const rendered = eventToIrcLine(msg, this.currentNick());
        if (rendered) this.write(rendered);
      }
    }
  }

  private handlePrivmsg(line: IrcLine): void {
    const target = line.params[0];
    const text = line.params[1] || '';
    if (!target || !text) return;
    if (text.startsWith(CTCP_ACTION_PREFIX) && text.endsWith('\x01')) {
      const action = text.slice(CTCP_ACTION_PREFIX.length, -1);
      const pendingLen = this.pendingSelfEchoes.length;
      this.trackPendingSelfEcho('action', target, action);
      if (!this.deps.manager.action(this.auth!.userId, this.auth!.network.id, target, action)) {
        this.pendingSelfEchoes.length = pendingLen;
        this.localNotice(
          `Network ${this.auth!.network.name} is not connected; ACTION was not sent.`,
        );
      }
      return;
    }
    const pendingLen = this.pendingSelfEchoes.length;
    this.trackPendingSelfEcho('message', target, text);
    if (!this.deps.manager.send(this.auth!.userId, this.auth!.network.id, target, text)) {
      this.pendingSelfEchoes.length = pendingLen;
      this.localNotice(
        `Network ${this.auth!.network.name} is not connected; message was not sent.`,
      );
    }
  }

  private handleNotice(line: IrcLine): void {
    const target = line.params[0];
    const text = line.params[1] || '';
    if (!target || !text) return;
    const pendingLen = this.pendingSelfEchoes.length;
    this.trackPendingSelfEcho('notice', target, text);
    if (!this.deps.manager.notice(this.auth!.userId, this.auth!.network.id, target, text)) {
      this.pendingSelfEchoes.length = pendingLen;
      this.localNotice(`Network ${this.auth!.network.name} is not connected; NOTICE was not sent.`);
    }
  }

  private handleNames(line: IrcLine): void {
    const requested = splitCsv(line.params[0]);
    const snapshot = snapshotFor(this.connection());
    const channels =
      requested.length > 0
        ? requested
        : snapshot.channels.length > 0
          ? snapshot.channels.map((ch) => ch.name)
          : ['*'];
    for (const name of channels) {
      const channel =
        snapshot.channels.find((ch) => ch.name.toLowerCase() === name.toLowerCase())?.name || name;
      this.write({
        prefix: SERVER_NAME,
        command: '366',
        params: [this.currentNick(), channel, 'End of /NAMES list.'],
      });
    }
  }

  private forwardRaw(line: IrcLine): void {
    const conn = this.connection();
    if (!conn || conn.state !== 'connected') {
      this.localNotice(
        `Network ${this.auth!.network.name} is not connected; ${line.command} was not sent.`,
      );
      return;
    }
    const rendered = formatRawCommand(line);
    if (rendered) conn.raw(rendered);
  }

  private onManagerEvent(raw: unknown): void {
    if (!this.registered || !this.auth) return;
    const event = raw as Record<string, unknown>;
    if (event.userId !== this.auth.userId || event.networkId !== this.auth.network.id) return;
    if (event.type === 'names' && typeof event.target === 'string') {
      if (this.sentNamesFor.has(event.target.toLowerCase())) return;
      const members = Array.isArray(event.members)
        ? event.members
            .map((m) => m as Record<string, unknown>)
            .filter((m) => typeof m.nick === 'string')
            .map((m) => ({
              nick: m.nick as string,
              modes: Array.isArray(m.modes) ? (m.modes as string[]) : [],
            }))
        : [];
      this.emitNames({ name: event.target, topic: null, members });
      return;
    }
    if (this.consumePendingSelfEcho(event)) return;
    const rendered = eventToIrcLine(event, this.currentNick());
    if (rendered) this.write(rendered);
  }

  private trackPendingSelfEcho(type: string, target: string, text: string): void {
    const chunks = type === 'action' ? splitAction(text) : splitSay(text);
    for (const chunk of chunks) this.pendingSelfEchoes.push({ type, target, text: chunk });
    if (this.pendingSelfEchoes.length > 200) {
      this.pendingSelfEchoes.splice(0, this.pendingSelfEchoes.length - 200);
    }
  }

  private consumePendingSelfEcho(event: Record<string, unknown>): boolean {
    if (!event.self) return false;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type !== 'message' && type !== 'action' && type !== 'notice') return false;
    const target = typeof event.target === 'string' ? event.target : '';
    const text = typeof event.text === 'string' ? event.text : '';
    const idx = this.pendingSelfEchoes.findIndex(
      (pending) => pending.type === type && pending.target === target && pending.text === text,
    );
    if (idx === -1) return false;
    this.pendingSelfEchoes.splice(idx, 1);
    return true;
  }

  private emitSelfJoin(target: string): void {
    this.write({
      prefix: `${this.currentNick()}!${sanitizeIdent(this.user || this.currentNick())}@lurker`,
      command: 'JOIN',
      params: [target],
    });
  }

  private emitNames(channel: SnapshotChannel): void {
    const names = channel.members.map((m) => `${prefixForModes(m.modes)}${m.nick}`);
    const nick = this.currentNick();
    for (const chunk of chunkNames(names)) {
      this.write({ prefix: SERVER_NAME, command: '353', params: [nick, '=', channel.name, chunk] });
    }
    this.write({
      prefix: SERVER_NAME,
      command: '366',
      params: [nick, channel.name, 'End of /NAMES list.'],
    });
    this.sentNamesFor.add(channel.name.toLowerCase());
  }

  private localNotice(text: string): void {
    this.write({
      prefix: `${SERVER_NAME}!bouncer@lurker`,
      command: 'NOTICE',
      params: [this.currentNick(), text],
    });
  }

  private currentNick(): string {
    const snap = snapshotFor(this.connection());
    return snap.nick || this.auth?.network.nick || this.nick || '*';
  }

  private connection(): BouncerConnection | null {
    if (!this.auth) return null;
    return this.deps.manager.getConnection(this.auth.userId, this.auth.network.id);
  }

  private write(line: Parameters<typeof formatIrcLine>[0]): void {
    if (!this.socket.destroyed) this.socket.write(formatIrcLine(line));
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.auth) {
      this.deps.manager.off('event', this.boundEvent);
      this.deps.removePresence(this.auth.userId);
    }
    this.onDone();
  }
}

interface SnapshotChannel {
  name: string;
  topic: string | null;
  members: Array<{ nick: string; modes: string[] }>;
}

function snapshotFor(conn: BouncerConnection | null): {
  nick: string | null;
  channels: SnapshotChannel[];
} {
  if (!conn) return { nick: null, channels: [] };
  const raw = conn.snapshot() as { nick?: unknown; channels?: unknown };
  const channels = Array.isArray(raw.channels)
    ? raw.channels
        .map((ch) => ch as Record<string, unknown>)
        .filter((ch) => typeof ch.name === 'string')
        .map((ch) => ({
          name: ch.name as string,
          topic: typeof ch.topic === 'string' ? ch.topic : null,
          members: Array.isArray(ch.members)
            ? ch.members
                .map((m) => m as Record<string, unknown>)
                .filter((m) => typeof m.nick === 'string')
                .map((m) => ({
                  nick: m.nick as string,
                  modes: Array.isArray(m.modes) ? (m.modes as string[]) : [],
                }))
            : [],
        }))
    : [];
  return { nick: typeof raw.nick === 'string' ? raw.nick : null, channels };
}

export function eventToIrcLine(
  raw: Record<string, unknown>,
  selfNick: string,
): Parameters<typeof formatIrcLine>[0] | null {
  const target = typeof raw.target === 'string' ? raw.target : '';
  const nick = typeof raw.nick === 'string' && raw.nick ? raw.nick : SERVER_NAME;
  const source = sourceFor(raw, nick);
  const tags = typeof raw.time === 'string' ? { time: raw.time } : undefined;
  switch (raw.type) {
    case 'message': {
      const wireTarget = directWireTarget(raw, target, selfNick);
      return {
        tags,
        prefix: source,
        command: 'PRIVMSG',
        params: [wireTarget, raw.text as string],
      };
    }
    case 'action':
      return {
        tags,
        prefix: source,
        command: 'PRIVMSG',
        params: [
          directWireTarget(raw, target, selfNick),
          `${CTCP_ACTION_PREFIX}${raw.text || ''}\x01`,
        ],
      };
    case 'notice':
    case 'motd':
    case 'error':
      return {
        tags,
        prefix: source,
        command: 'NOTICE',
        params: [
          target && !target.startsWith(':server:')
            ? directWireTarget(raw, target, selfNick)
            : selfNick,
          String(raw.text || ''),
        ],
      };
    case 'join':
    case 'channel-joined':
      return { tags, prefix: source, command: 'JOIN', params: [target] };
    case 'part':
    case 'channel-parted':
      return { tags, prefix: source, command: 'PART', params: [target, raw.text as string] };
    case 'quit':
      return { tags, prefix: source, command: 'QUIT', params: [raw.text as string] };
    case 'kick':
      return {
        tags,
        prefix: source,
        command: 'KICK',
        params: [target, String(raw.kicked || ''), String(raw.text || '')],
      };
    case 'nick':
      return { tags, prefix: source, command: 'NICK', params: [String(raw.newNick || '')] };
    case 'topic':
      return { tags, prefix: source, command: 'TOPIC', params: [target, String(raw.text || '')] };
    case 'mode':
      return { tags, prefix: source, command: 'MODE', params: [target, String(raw.text || '')] };
    case 'names':
      return null;
    case 'state':
      return {
        prefix: `${SERVER_NAME}!bouncer@lurker`,
        command: 'NOTICE',
        params: [selfNick, `Network state: ${String(raw.state || 'unknown')}`],
      };
    default:
      return null;
  }
}

function sourceFor(raw: Record<string, unknown>, nick: string): string {
  const userhost = typeof raw.userhost === 'string' ? raw.userhost : '';
  if (userhost.includes('!') && userhost.includes('@')) return userhost;
  if (nick === SERVER_NAME || nick === 'lurker') return `${SERVER_NAME}!server@lurker`;
  return `${nick}!${sanitizeIdent(nick)}@lurker`;
}

function directWireTarget(raw: Record<string, unknown>, target: string, selfNick: string): string {
  if (!target || target.startsWith(':server:')) return selfNick;
  if (isChannel(target)) return target;
  return raw.self ? target : selfNick;
}

function formatRawCommand(line: IrcLine): string {
  const params = line.params.map(sanitizeParam);
  if (!params.length) return line.command;
  const last = params[params.length - 1];
  const head = params.slice(0, -1);
  const tail = last === '' || last.startsWith(':') || /\s/.test(last) ? `:${last}` : last;
  return [line.command, ...head, tail].join(' ');
}

function splitCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isChannel(target: string): boolean {
  return /^[#&+!]/.test(target);
}

function sanitizeToken(value: string): string {
  return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('\0', '').replaceAll(' ', '');
}

function sanitizeParam(value: string): string {
  return value.replaceAll('\r', '').replaceAll('\n', '').replaceAll('\0', '');
}

function sanitizeIdent(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 16) || 'lurker';
}

function escapeTag(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\:')
    .replace(/ /g, '\\s')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function unescapeTag(value: string): string {
  return value.replace(/\\([\\:srn])/g, (_m, ch: string) => {
    if (ch === ':') return ';';
    if (ch === 's') return ' ';
    if (ch === 'r') return '\r';
    if (ch === 'n') return '\n';
    return ch;
  });
}

function prefixForModes(modes: string[]): string {
  if (modes.includes('q')) return '~';
  if (modes.includes('a')) return '&';
  if (modes.includes('o')) return '@';
  if (modes.includes('h')) return '%';
  if (modes.includes('v')) return '+';
  return '';
}

function chunkNames(names: string[]): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let len = 0;
  for (const name of names) {
    const add = name.length + (current.length ? 1 : 0);
    if (len + add > 350 && current.length) {
      chunks.push(current.join(' '));
      current = [];
      len = 0;
    }
    current.push(name);
    len += add;
  }
  chunks.push(current.join(' '));
  return chunks;
}

let singleton: BouncerServer | null = null;

export function startBouncerServer(options: { host?: string; port: number }): BouncerServer {
  if (singleton) return singleton;
  singleton = new BouncerServer(options);
  singleton.listen().catch((err) => {
    singleton = null;
    console.error('[bouncer] listen failed:', err?.message || err);
  });
  return singleton;
}

export async function stopBouncerServer(): Promise<void> {
  const server = singleton;
  singleton = null;
  if (server) await server.close();
}
