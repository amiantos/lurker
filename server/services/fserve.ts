// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A live fserve session: one peer browsing your archive over a DCC CHAT socket.
// Wraps a DccChat (the line transport) with the sandboxed command interpreter
// (fserveCommands) and, for password-mode servers, an in-band auth gate. Each
// `get` is handed back to the caller (ircConnection), which performs the actual
// DCC SEND of the file. Process-bound and DB-free, like the DCC engines.

import path from 'path';
import net from 'net';

import { DccChat } from './dccChat.js';
import { runFserveCommand, displayPath } from './fserveCommands.js';

export interface FserveSessionOptions {
  socket: net.Socket;
  /** Canonical archive root — the sandbox ceiling. */
  root: string;
  /** Peer nick, for logging/labels. */
  nick: string;
  /** Optional greeting sent before the first prompt. */
  welcome?: string;
  /** When set, the peer must send this exact line before any command runs. */
  password?: string | null;
  /** A resolved, in-sandbox file path the peer asked to `get` — the caller
   *  DCC-SENDs it. */
  onGet: (absPath: string) => void;
  /** The session ended (peer closed, quit, auth failed, or error). */
  onClose: () => void;
}

const AUTH_PROMPT = 'This fserve is password-protected. Enter the password:';
const MAX_LINES_PER_CMD = 400; // bound a huge dir listing on the wire

export class FserveSession {
  private readonly chat: DccChat;
  private cwd: string;
  private authed: boolean;
  private closed = false;

  constructor(private readonly opts: FserveSessionOptions) {
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
    if (!this.authed) this.send(AUTH_PROMPT);
    else {
      this.send(`Connected to fserve. Type help for commands.`);
      this.prompt();
    }
  }

  private onLine(rawLine: string): void {
    if (this.closed) return;
    const line = rawLine.replace(/\r$/, '');

    if (!this.authed) {
      if (line.trim() === this.opts.password) {
        this.authed = true;
        this.send('Access granted. Type help for commands.');
        this.prompt();
      } else {
        this.send('Access denied.');
        this.close();
      }
      return;
    }

    const result = runFserveCommand({ root: this.opts.root, cwd: this.cwd }, line);
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

  private send(text: string): void {
    if (!this.closed) this.chat.send(text);
  }

  /** Close the session (also called by the caller on dispose). Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.chat.close();
    this.opts.onClose();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose();
  }
}

// Derive a peer-facing filename + size for a `get`, or null when the file
// vanished between the stat in the interpreter and the send. (Thin helper the
// caller uses to build the DCC SEND.)
export function fserveBasename(absPath: string): string {
  return path.basename(absPath);
}
