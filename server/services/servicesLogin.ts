// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A password the user just gave NickServ by hand (#1412). Someone who registers
// a nick and never adds the password to the network identifies by hand on every
// connect, usually after the network has already renamed them. Read off their
// own outgoing line, the password can be offered back as the network's saved
// login once the network confirms it worked (RPL_LOGGEDIN).
//
// Only NickServ, and only its password verbs. QuakeNet's Q and Undernet's X
// take a password too, but neither network has SASL to save it for.

export interface ServicesLogin {
  /** The account named on the line, when it named one. The 900 has the last word. */
  account?: string;
  password: string;
}

// `NickServ`, or `NickServ@services.host` as some networks ask for it.
const NICKSERV = /^nickserv(?:@\S+)?$/i;

/** A PRIVMSG's target and text, read as a login given to NickServ. */
export function servicesLoginFromMessage(target: string, text: string): ServicesLogin | null {
  if (!NICKSERV.test(target)) return null;
  const [verb, ...args] = text.trim().split(/\s+/);
  switch (verb?.toUpperCase()) {
    // `IDENTIFY <password>` or `IDENTIFY <account> <password>` (Atheme, Anope,
    // ergo); ID and LOGIN are the same command under other names.
    case 'IDENTIFY':
    case 'ID':
    case 'LOGIN':
      if (args.length === 1) return { password: args[0] };
      if (args.length >= 2) return { account: args[0], password: args[1] };
      return null;
    // `REGISTER <password> [email]`, for the nick in use.
    case 'REGISTER':
      return args.length >= 1 ? { password: args[0] } : null;
    default:
      return null;
  }
}

/** A raw line of the user's: `PRIVMSG NickServ :…`, or the `NS` / `NICKSERV` command. */
export function servicesLoginFromRaw(line: string): ServicesLogin | null {
  const match = /^\s*(\S+)\s+(.*)$/.exec(line);
  if (!match) return null;
  const command = match[1].toUpperCase();
  const rest = match[2];
  if (command === 'NS' || command === 'NICKSERV') {
    return servicesLoginFromMessage('NickServ', rest.replace(/^:/, ''));
  }
  if (command !== 'PRIVMSG') return null;
  const privmsg = /^(\S+)\s+:?(.*)$/.exec(rest);
  return privmsg ? servicesLoginFromMessage(privmsg[1], privmsg[2]) : null;
}
