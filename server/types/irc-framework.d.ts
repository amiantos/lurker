// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Hand-written ambient declarations for the irc-framework npm package.
// The package ships no types of its own. This file declares exactly the
// API surface that ircConnection.ts, ircManager.ts, and messageSplit.ts
// actually use — nothing more. Loose typing is intentional; the real
// library is highly dynamic (EventEmitter + IRC protocol events).

declare module 'irc-framework' {
  import { EventEmitter } from 'events';

  /** Options passed to Client.connect(). */
  export interface ConnectOptions {
    host: string;
    port: number;
    tls?: boolean;
    rejectUnauthorized?: boolean;
    nick?: string;
    username?: string;
    gecos?: string;
    password?: string;
    account?: { account: string; password: string };
    auto_reconnect?: boolean;
    auto_reconnect_max_retries?: number;
    enable_chghost?: boolean;
    enable_setname?: boolean;
    enable_echomessage?: boolean;
    /** CTCP VERSION auto-reply string, or `false` to disable the built-in reply
     *  so the host can answer CTCP itself. This is the interface that actually
     *  governs runtime VERSION behavior (connect() overwrites client.options). */
    version?: string | false;
    /**
     * Local source address to bind the outgoing socket to. irc-framework's net
     * transport forwards this as the socket's `localAddress` (and derives the
     * address family from it), letting a multi-homed host choose which local IP
     * — and therefore which identd — a connection appears to originate from.
     */
    outgoing_addr?: string;
  }

  /** Options passed to the Client constructor. */
  export interface ClientOptions {
    version?: string;
    nick?: string;
    username?: string;
    gecos?: string;
    encoding?: string;
    enable_chghost?: boolean;
    enable_setname?: boolean;
    enable_echomessage?: boolean;
    ping_interval?: number;
    ping_timeout?: number;
  }

  /** Capability negotiation state on the network object. */
  export interface CapState {
    negotiating: boolean;
    requested: string[];
    enabled: string[];
    available: Map<string, unknown>;
  }

  /** Network-level information (ISUPPORT, CAP, etc.). */
  export interface NetworkInfo {
    name: string;
    server: string;
    ircd: string;
    options: Record<string, string | undefined>;
    cap: CapState;
  }

  /** The connected user state. */
  export interface UserInfo {
    nick: string;
    username: string;
    gecos: string;
    host: string;
    away: boolean;
  }

  // Generic IRC event payload. Individual named events carry specific fields
  // but they all arrive as loosely-shaped objects from the EventEmitter bus.
  // Using Record<string, unknown> here keeps callers honest — narrow the
  // specific fields you care about rather than using implicit any.
  export type IrcEventPayload = Record<string, unknown>;

  export class Client extends EventEmitter {
    constructor(options?: ClientOptions);

    /** Network-level information (ISUPPORT, CAP negotiation). */
    network: NetworkInfo;

    /** The local user's state (nick, username, etc.). */
    user: UserInfo;

    /**
     * True while the TCP/TLS socket is up (client.js proxies
     * connection.connected). NOT reset caps/registration state — cap.enabled
     * survives a socket drop until the next 'connecting' event.
     */
    readonly connected: boolean;

    /** Request an IRCv3 capability during CAP negotiation. */
    requestCap(cap: string): void;

    /** Open a connection to the IRC server. */
    connect(options: ConnectOptions): void;

    /** Send a raw IRC line. Accepts varargs: raw(cmd, ...params). */
    raw(...args: string[]): void;

    /** Send QUIT with an optional message. */
    quit(message?: string): void;

    /** Send PING with a token. */
    ping(message?: string): void;

    /** Change the local user's nick. */
    changeNick(nick: string): void;

    /** Send a PRIVMSG. */
    say(target: string, message: string, tags?: Record<string, string>): void;

    /** Send a CTCP ACTION (/me). */
    action(target: string, message: string): void;

    /** Send a CTCP request (PRIVMSG `\x01TYPE params\x01`); type is uppercased. */
    ctcpRequest(target: string, type: string, ...params: string[]): void;

    /** Send a CTCP reply (NOTICE `\x01TYPE params\x01`); type is uppercased. */
    ctcpResponse(target: string, type: string, ...params: string[]): void;

    /** Send a NOTICE. */
    notice(target: string, message: string, tags?: Record<string, string>): void;

    /** Send a TAGMSG (IRCv3 message tags with no visible text). */
    tagmsg(target: string, tags?: Record<string, string>): void;

    /** JOIN a channel (or comma-separated batch). */
    join(channel: string, key?: string): void;

    /** PART a channel. */
    part(channel: string, message?: string): void;

    /** Send WHO for away/hostmask sync. */
    who(target: string, cb?: (event: IrcEventPayload) => void): void;

    /** Send WHOIS. */
    whois(target: string, ...args: unknown[]): void;

    /** Add a nick to the MONITOR watch list (IRCv3 presence). */
    addMonitor(target: string): void;

    /** Remove a nick from the MONITOR watch list. */
    removeMonitor(target: string): void;

    /** Listen for an IRC event by name. Overrides EventEmitter signature. */
    on(event: string, listener: (event: IrcEventPayload) => void): this;
    on(event: 'raw', listener: (event: { from_server: boolean; line: string }) => void): this;
  }

  /** Parse a raw IRC line into a message object. */
  export function ircLineParser(line: string): {
    command: string;
    params: string[];
    tags?: Record<string, string>;
    prefix?: string;
  };

  // Default export in the package is an object with a `Client` property.
  // ircConnection.ts imports it as: import IRC from 'irc-framework'
  const defaultExport: { Client: typeof Client; ircLineParser: typeof ircLineParser };
  export default defaultExport;
}

declare module 'irc-framework/src/linebreak.js' {
  export interface LineBreakOptions {
    bytes: number;
    allowBreakingWords?: boolean;
    allowBreakingGraphemes?: boolean;
  }

  /** Generator that yields chunks of `str` each fitting within `opts.bytes`. */
  export function lineBreak(str: string, opts: LineBreakOptions): IterableIterator<string>;
}
