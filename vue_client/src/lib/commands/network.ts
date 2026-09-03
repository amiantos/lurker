// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Argument parser for the /network command (#356) — the slash-command front-end
// for network management, sharing the networks store with the Settings →
// Networks pane (one core, two front-ends per #353).
//
// The grammar follows irssi's /network option style (the way /ignore mirrors
// irssi), e.g.
//   /network add -host irc.libera.chat -tls -nick mynick Libera
// with one deliberate divergence: irssi splits a network (identity: nick/SASL)
// from a server (address: host/port/tls), one network → many servers. Lurker
// collapses both into a single network row, so the address lives here and
// connection control folds into `/network connect|disconnect` rather than a
// separate /server command.
//
// This module is pure (no store, no Vue) so the grammar unit-tests in isolation;
// the SFC's runNetwork() turns the parsed intent into store calls + system-buffer
// output.

import { tokenizeArgs } from './tokenize.js';

/** The network fields a /network add|modify can set, post-mapping from flags. */
export interface NetworkInput {
  host?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  username?: string;
  realname?: string;
  sasl_account?: string;
  sasl_password?: string;
  server_password?: string;
  /** CertFP: mint a client certificate with the network, before its first
   *  connect (add only — `/network cert <name> new` replaces one later). */
  generate_client_cert?: boolean;
  connect_commands?: string;
  default_channel?: string;
  autoconnect?: boolean;
}

/** The parsed intent of a /network invocation. `error` carries a user message. */
export type NetworkCommand =
  | { kind: 'list' }
  | { kind: 'add'; name: string; input: NetworkInput }
  | { kind: 'modify'; ref: string; input: NetworkInput }
  | { kind: 'remove'; ref: string }
  | { kind: 'connect'; ref: string }
  | { kind: 'disconnect'; ref: string }
  | { kind: 'move'; ref: string; position: number }
  // CertFP (#459). `show` prints the fingerprint to register with services;
  // generate/remove write. Importing an existing PEM is deliberately NOT here —
  // pasting a private key into a message composer is a bad place for it (the
  // input has history), so that stays in the network form.
  | { kind: 'cert'; ref: string; action: 'show' | 'generate' | 'remove' }
  | { kind: 'error'; message: string };

// irssi-style options. Value flags consume the following token; bool flags
// stand alone. `-user`/`-sasl_username` map onto Lurker's column names below.
const VALUE_FLAGS = new Set([
  'host',
  'port',
  'nick',
  'user',
  'realname',
  'sasl_username',
  'sasl_password',
  'password',
  'autosendcmd',
  'channel',
]);
const BOOL_FLAGS = new Set(['tls', 'notls', 'auto', 'noauto', 'cert']);

function isKnownFlag(name: string): boolean {
  return VALUE_FLAGS.has(name) || BOOL_FLAGS.has(name);
}

interface Flags {
  values: Record<string, string>;
  bools: Set<string>;
  positional: string[];
  error?: string;
}

function parseFlags(tokens: string[]): Flags {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-') && tok.length > 1) {
      const name = tok.slice(1).toLowerCase();
      if (VALUE_FLAGS.has(name)) {
        const val = tokens[i + 1];
        // Treat a following *recognized* option as a missing value (e.g.
        // `-nick -tls`) instead of silently swallowing it. A dash-leading value
        // that isn't a known flag (an odd password, irssi's bare `-` sentinel)
        // is still accepted — quote it if it collides with a real flag name.
        const nextIsFlag =
          val !== undefined &&
          val.length > 1 &&
          val.startsWith('-') &&
          isKnownFlag(val.slice(1).toLowerCase());
        if (val === undefined || nextIsFlag) {
          return { values, bools, positional, error: `-${name} needs a value` };
        }
        values[name] = val;
        i++;
      } else if (BOOL_FLAGS.has(name)) {
        bools.add(name);
      } else {
        return { values, bools, positional, error: `unknown option: ${tok}` };
      }
    } else {
      positional.push(tok);
    }
  }
  return { values, bools, positional };
}

// Map parsed flags onto the network payload. Returns an error string for a
// conflicting/invalid flag (e.g. -tls and -notls together, a bad port).
function buildInput(flags: Flags): NetworkInput | { error: string } {
  const { values, bools } = flags;
  const input: NetworkInput = {};

  if (values.host !== undefined) input.host = values.host;
  if (values.nick !== undefined) input.nick = values.nick;
  if (values.user !== undefined) input.username = values.user;
  if (values.realname !== undefined) input.realname = values.realname;
  if (values.sasl_username !== undefined) input.sasl_account = values.sasl_username;
  if (values.sasl_password !== undefined) input.sasl_password = values.sasl_password;
  if (values.password !== undefined) input.server_password = values.password;
  if (values.autosendcmd !== undefined) input.connect_commands = values.autosendcmd;
  if (values.channel !== undefined) input.default_channel = values.channel;

  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `invalid port: ${values.port}` };
    }
    input.port = port;
  }

  if (bools.has('tls') && bools.has('notls')) return { error: 'cannot combine -tls and -notls' };
  if (bools.has('tls')) input.tls = true;
  if (bools.has('notls')) input.tls = false;

  if (bools.has('cert')) input.generate_client_cert = true;

  if (bools.has('auto') && bools.has('noauto')) {
    return { error: 'cannot combine -auto and -noauto' };
  }
  if (bools.has('auto')) input.autoconnect = true;
  if (bools.has('noauto')) input.autoconnect = false;

  return input;
}

// A single network name/ref. Names with spaces must be quoted, so a ref is
// exactly one token; more than one is almost always a missing-quote mistake.
function singleRef(positional: string[], verb: string): string | { error: string } {
  if (!positional.length) return { error: `/network ${verb} needs a network name` };
  if (positional.length > 1) {
    return { error: `/network ${verb}: one network name (quote it if it contains spaces)` };
  }
  return positional[0];
}

export function parseNetworkCommand(argLine: string): NetworkCommand {
  const tokens = tokenizeArgs(argLine);
  if (!tokens.length) return { kind: 'list' };

  const sub = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  switch (sub) {
    case 'list':
    case 'ls':
      return { kind: 'list' };

    case 'add': {
      const flags = parseFlags(rest);
      if (flags.error) return { kind: 'error', message: flags.error };
      const name = singleRef(flags.positional, 'add');
      if (typeof name !== 'string') return { kind: 'error', message: name.error };
      const built = buildInput(flags);
      if ('error' in built) return { kind: 'error', message: built.error };
      // A merged network row needs an address to dial and a nick to dial as.
      if (!built.host) return { kind: 'error', message: '/network add needs -host <address>' };
      if (!built.nick) return { kind: 'error', message: '/network add needs -nick <nick>' };
      // Default to TLS (and the matching well-known port) unless told otherwise,
      // so a bare add doesn't silently produce a plaintext-on-6697 mismatch.
      if (built.tls === undefined) built.tls = true;
      if (built.port === undefined) built.port = built.tls ? 6697 : 6667;
      return { kind: 'add', name, input: built };
    }

    case 'modify':
    case 'edit': {
      const flags = parseFlags(rest);
      if (flags.error) return { kind: 'error', message: flags.error };
      const ref = singleRef(flags.positional, 'modify');
      if (typeof ref !== 'string') return { kind: 'error', message: ref.error };
      const built = buildInput(flags);
      if ('error' in built) return { kind: 'error', message: built.error };
      // -channel sets a default/autojoin channel, which the server only wires up
      // at create time; the update path ignores it. Reject rather than silently
      // report a no-op success.
      if (built.default_channel !== undefined) {
        return { kind: 'error', message: '-channel can only be set when adding a network' };
      }
      // Minting rides on network creation (it has to happen before the first
      // dial). Replacing one on an existing network is `/network cert <name> new`.
      if (built.generate_client_cert !== undefined) {
        return {
          kind: 'error',
          message: `-cert can only be set when adding a network — use /network cert ${ref} new`,
        };
      }
      if (!Object.keys(built).length) {
        return { kind: 'error', message: `/network modify ${ref}: no changes given` };
      }
      return { kind: 'modify', ref, input: built };
    }

    case 'remove':
    case 'rm':
    case 'del':
    case 'delete': {
      const ref = singleRef(rest, 'remove');
      if (typeof ref !== 'string') return { kind: 'error', message: ref.error };
      return { kind: 'remove', ref };
    }

    case 'connect': {
      const ref = singleRef(rest, 'connect');
      if (typeof ref !== 'string') return { kind: 'error', message: ref.error };
      return { kind: 'connect', ref };
    }

    case 'disconnect': {
      const ref = singleRef(rest, 'disconnect');
      if (typeof ref !== 'string') return { kind: 'error', message: ref.error };
      return { kind: 'disconnect', ref };
    }

    case 'cert': {
      if (!rest.length) return { kind: 'error', message: '/network cert <network> [new|remove]' };
      const action = (rest[1] ?? 'show').toLowerCase();
      if (rest.length > 2) {
        return { kind: 'error', message: '/network cert <network> [new|remove]' };
      }
      if (action === 'show') return { kind: 'cert', ref: rest[0], action: 'show' };
      // "new" rather than "generate": it replaces whatever is there, and a
      // replaced certificate has to be re-registered at NickServ.
      if (action === 'new') return { kind: 'cert', ref: rest[0], action: 'generate' };
      if (action === 'remove' || action === 'rm') {
        return { kind: 'cert', ref: rest[0], action: 'remove' };
      }
      return { kind: 'error', message: `/network cert: unknown action "${rest[1]}"` };
    }

    case 'move': {
      if (rest.length < 2) {
        return { kind: 'error', message: '/network move <name> <position>' };
      }
      if (rest.length > 2) {
        return {
          kind: 'error',
          message: '/network move: one name and one position (quote a name with spaces)',
        };
      }
      const position = Number(rest[1]);
      if (!Number.isInteger(position) || position < 1) {
        return { kind: 'error', message: `invalid position: ${rest[1]} (1-based)` };
      }
      return { kind: 'move', ref: rest[0], position };
    }

    default:
      return {
        kind: 'error',
        message: `unknown /network subcommand: ${sub} — try list, add, modify, remove, connect, disconnect, move`,
      };
  }
}
