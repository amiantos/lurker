// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A live fserve session: one peer browsing your archive over a DCC CHAT socket.
// Wraps a DccChat (the line transport) with the sandboxed command interpreter
// (fserveCommands) and, for password-mode servers, an in-band auth gate. Each
// `get` is handed to the caller (ircConnection), which runs it through the send
// queue and performs the DCC SEND. Stateful commands (queues/sends/stats/who/
// clr_queue) are delegated to the caller too, via onControl, since their data
// lives outside this session. An idle timer (with a short grace warning) frees
// the slot when a peer wanders off. Process-bound and DB-free, like the DCC
// engines.

import path from 'path';
import net from 'net';

import { DccChat } from './dccChat.js';
import { runFserveCommand, displayPath, type FserveFilter } from './fserveCommands.js';

export interface FserveSessionOptions {
  socket: net.Socket;
  /** Canonical archive root — the sandbox ceiling. */
  root: string;
  /** Peer nick, for logging/labels/clr_queue ownership. */
  nick: string;
  /** Optional greeting sent before the status banner. */
  welcome?: string;
  /** Status-banner lines sent once the session is authenticated (slots, limits,
   *  command hint). Evaluated live so the counts are current. */
  banner?: () => string[];
  /** When set, the peer must send this exact line before any command runs. */
  password?: string | null;
  /** Optional visibility filter (hidden files / allowed extensions). */
  filter?: FserveFilter;
  /** Idle disconnect in ms; 0/undefined disables. A grace warning precedes it. */
  idleTimeoutMs?: number;
  /** A resolved, in-sandbox file path the peer asked to `get` — the caller
   *  queues + DCC-SENDs it and reports the outcome via this session's notify. */
  onGet: (absPath: string) => void;
  /** Run a stateful command (queues/sends/stats/who/clr_queue/clr_queues) against
   *  live caller state; return the lines to show. */
  onControl?: (name: string, arg: string, nick: string) => string[];
  /** The session ended (peer closed, quit, auth failed, idle, or error). */
  onClose: () => void;
}

const AUTH_PROMPT = 'This fserve is password-protected. Enter the password:';
const MAX_LINES_PER_CMD = 400; // bound a huge dir listing on the wire
const IDLE_GRACE_MS = 20_000; // warn-before-disconnect window

export class FserveSession {
  readonly nick: string;
  private readonly chat: DccChat;
  private cwd: string;
  private authed: boolean;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWarned = false;

  constructor(private readonly opts: FserveSessionOptions) {
    this.nick = opts.nick;
    this.cwd = opts.root;
    // No password configured → already authenticated.
    this.authed = opts.password == null || opts.password === '';
    this.chat = new DccChat({
      socket: opts.socket,
      onLine: (line) => this.onLine(line),
      onClose: () => this.finish(),
      onError: () => this.finish(),
    });
  }

  start(): void {
    this.chat.start();
    if (this.opts.welcome) this.send(this.opts.welcome);
    if (!this.authed) {
      this.send(AUTH_PROMPT);
    } else {
      this.greet();
    }
    this.resetIdle();
  }

  // Banner + first prompt, shown once authenticated.
  private greet(): void {
    for (const l of this.opts.banner?.() ?? []) this.send(l);
    this.send('Type help for commands.');
    this.prompt();
  }

  private onLine(rawLine: string): void {
    if (this.closed) return;
    this.resetIdle();
    const line = rawLine.replace(/\r$/, '');

    if (!this.authed) {
      if (line.trim() === this.opts.password) {
        this.authed = true;
        this.send('Access granted.');
        this.greet();
      } else {
        this.send('Access denied.');
        this.close();
      }
      return;
    }

    const result = runFserveCommand(
      { root: this.opts.root, cwd: this.cwd, filter: this.opts.filter },
      line,
    );

    // Stateful command → delegate to the caller for the live answer.
    if (result.control && this.opts.onControl) {
      const lines = this.opts.onControl(result.control.name, result.control.arg, this.nick);
      for (const l of lines.slice(0, MAX_LINES_PER_CMD)) this.send(l);
      this.prompt();
      return;
    }

    for (const l of result.lines.slice(0, MAX_LINES_PER_CMD)) this.send(l);
    if (result.lines.length > MAX_LINES_PER_CMD) {
      this.send(`… (${result.lines.length - MAX_LINES_PER_CMD} more lines truncated)`);
    }
    if (result.newCwd) this.cwd = result.newCwd;
    if (result.sendPath) {
      try {
        this.opts.onGet(result.sendPath);
      } catch {
        this.send('Could not start the transfer.');
      }
    }
    if (result.close) this.close();
    else this.prompt();
  }

  private prompt(): void {
    // A trailing-space prompt showing the current directory, fserve-style.
    this.send(`${displayPath(this.opts.root, this.cwd)}> `);
  }

  /** Send an out-of-band line (e.g. "your queued file is now sending") followed
   *  by a fresh prompt. Public so the caller can push async queue/transfer
   *  updates into an idle session. */
  notify(text: string): void {
    if (this.closed) return;
    this.send(text);
    this.prompt();
  }

  /** Send a line WITHOUT a trailing prompt — for status emitted mid-command (the
   *  command handler prints the prompt itself right after). */
  emitLine(text: string): void {
    this.send(text);
  }

  private send(text: string): void {
    if (!this.closed) this.chat.send(text);
  }

  // --- idle handling ---------------------------------------------------------

  private resetIdle(): void {
    this.idleWarned = false;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const t = this.opts.idleTimeoutMs ?? 0;
    if (t <= 0 || this.closed) return;
    this.idleTimer = setTimeout(() => this.onIdle(), t);
    this.idleTimer.unref?.();
  }

  private onIdle(): void {
    if (this.closed) return;
    if (!this.idleWarned) {
      this.idleWarned = true;
      this.send(`Closing idle connection in ${Math.round(IDLE_GRACE_MS / 1000)} seconds…`);
      this.idleTimer = setTimeout(() => this.onIdle(), IDLE_GRACE_MS);
      this.idleTimer.unref?.();
    } else {
      this.send('Idle timeout — goodbye.');
      this.close();
    }
  }

  /** Close the session (also called by the caller on dispose). Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.chat.close();
    this.opts.onClose();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.opts.onClose();
  }
}

// Derive a peer-facing filename + size for a `get`, or null when the file
// vanished between the stat in the interpreter and the send. (Thin helper the
// caller uses to build the DCC SEND.)
export function fserveBasename(absPath: string): string {
  return path.basename(absPath);
}
