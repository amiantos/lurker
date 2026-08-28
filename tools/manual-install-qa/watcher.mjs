// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The bystander for tools/manual-install-qa: a bare IRC client that sits in a
// channel on the rig's ergo and records what the NETWORK sees of Lurker's nick
// — the only vantage point from which "the restart dropped nothing" can be
// judged. Two modes:
//
//   watch <host> <port> <channel> <nick> <logfile>
//       Stay joined and append one line per event about <nick> — "<iso> JOIN",
//       "QUIT", "PART", or "PRESENT" (from the NAMES reply, for a nick that was
//       already there) — until killed.
//   say <host> <port> <channel> <text>
//       Join, say one line, quit. Exit 0 once the server closes the socket.
//
// Plain sockets and hand-rolled lines on purpose: irc-framework is part of the
// code under test, and a witness that shares its bugs is no witness.

import net from 'node:net';
import fs from 'node:fs';

const [mode, host, portArg, channel, ...rest] = process.argv.slice(2);
// Validated once: net.connect throws synchronously on a bad port, before any
// 'error' handler is attached, which would read as a crash rather than usage.
const port = Number(portArg);
if (
  !mode ||
  !host ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !channel ||
  rest.length < 1
) {
  console.error(
    'usage: watcher.mjs watch <host> <port> <channel> <nick> <logfile> | say <host> <port> <channel> <text>',
  );
  process.exit(2);
}

// The nick portion of a prefix; NAMES entries carry a mode sigil to strip.
const nickOf = (prefix) =>
  prefix
    .replace(/^:/, '')
    .split('!')[0]
    .replace(/^[~&@%+]+/, '');
const sameNick = (a, b) => a.toLowerCase() === b.toLowerCase();

// `:prefix CMD p1 p2 :trailing` — the prefix is optional, and the trailing
// parameter is the one that may contain spaces, so it is split off first.
function parse(line) {
  let rest = line;
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(0, sp);
    rest = rest.slice(sp + 1);
  }
  const t = rest.indexOf(' :');
  const head = (t >= 0 ? rest.slice(0, t) : rest).split(' ');
  const params = head.slice(1);
  if (t >= 0) params.push(rest.slice(t + 2));
  return { prefix, cmd: head[0], params };
}

function connect(nick, handler) {
  const sock = net.connect(port, host);
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('connect', () => sock.write(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`));
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('PING')) {
        sock.write(`PONG${line.slice(4)}\r\n`);
        continue;
      }
      const { prefix, cmd, params } = parse(line);
      handler(cmd, prefix, params);
    }
  });
  sock.on('error', (err) => {
    console.error(`[watcher] ${err.message}`);
    process.exit(1);
  });
  return sock;
}

if (mode === 'watch') {
  const [target, logfile] = rest;
  if (!logfile) {
    console.error('watch: need <nick> <logfile>');
    process.exit(2);
  }
  const record = (event) =>
    fs.appendFileSync(logfile, `${new Date().toISOString()} ${event} ${target}\n`);
  const sock = connect('qawatch', (cmd, prefix, params) => {
    if (cmd === '001') sock.write(`JOIN ${channel}\r\n`);
    else if (cmd === '353') {
      // :server 353 me = #chan :nick1 @nick2 … — the names are the trailing parameter.
      for (const n of (params.at(-1) || '').split(' ')) {
        if (n && sameNick(nickOf(n), target)) record('PRESENT');
      }
    } else if (cmd === 'JOIN' || cmd === 'PART') {
      if (sameNick(params[0] || '', channel) && sameNick(nickOf(prefix), target)) record(cmd);
    } else if (cmd === 'QUIT') {
      if (sameNick(nickOf(prefix), target)) record('QUIT');
    }
  });
  sock.on('close', () => {
    console.error('[watcher] server closed the connection');
    process.exit(1);
  });
} else if (mode === 'say') {
  const text = rest.join(' ');
  setTimeout(() => {
    console.error('[watcher] say: timed out');
    process.exit(1);
  }, 15000);
  // Exit 0 only if the line actually went out: a server that closes the link
  // before the JOIN (a nick collision, a throttle) must not read as "said".
  let sent = false;
  const sock = connect('qasay', (cmd, prefix) => {
    if (cmd === '001') sock.write(`JOIN ${channel}\r\n`);
    else if (cmd === 'JOIN' && sameNick(nickOf(prefix), 'qasay')) {
      sent = true;
      sock.write(`PRIVMSG ${channel} :${text}\r\nQUIT :done\r\n`);
    }
  });
  sock.on('close', () => {
    if (!sent) console.error('[watcher] say: the server closed the link before the line was sent');
    process.exit(sent ? 0 : 1);
  });
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
