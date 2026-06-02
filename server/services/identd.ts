// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A minimal built-in identd (RFC 1413). When a multi-user Lurker connects many
// users to a network from one IP, the network can't tell them apart unless an
// identd vouches for each connection's ident. This server answers the IRC
// server's port-113 callback by mapping the connection's *local source port* to
// the ident Lurker registered for it (see ircConnection.ts).
//
// Opt-in via LURKER_IDENTD_ENABLED — binding :113 is privileged and most
// single-user self-hosts don't need it; the hosted (node) edition turns it on
// per cell. Mirrors The Lounge's built-in identd: to avoid running as root you
// can set LURKER_IDENTD_PORT to a high port and have the host's oidentd forward
// to it (:113 must be reachable by the IRC server either way).

import net from 'net';

// local source port -> ident. Populated as IRC sockets connect, cleared as they
// close. Module-scoped so the connection layer and the server share one map.
const idents = new Map<number, string>();

export function registerIdent(localPort: number, ident: string): void {
  if (localPort > 0 && ident) idents.set(localPort, ident);
}

export function unregisterIdent(localPort: number | null): void {
  if (localPort && localPort > 0) idents.delete(localPort);
}

// RFC 1413: the querying server sends "<our-port> , <their-port>"; we reply
// "<our-port>, <their-port> : USERID : UNIX : <ident>" or ERROR : NO-USER.
function handleConnection(socket: net.Socket): void {
  socket.setTimeout(10_000);
  let buf = '';
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('latin1');
    const nl = buf.indexOf('\n');
    if (nl === -1) {
      if (buf.length > 100) socket.destroy(); // junk, no newline — bail
      return;
    }
    const m = /^\s*(\d{1,5})\s*,\s*(\d{1,5})/.exec(buf.slice(0, nl));
    if (!m) {
      socket.end('0, 0 : ERROR : INVALID-PORT\r\n');
      return;
    }
    const lport = Number(m[1]);
    const rport = Number(m[2]);
    const ident = idents.get(lport);
    socket.end(
      ident
        ? `${lport}, ${rport} : USERID : UNIX : ${ident}\r\n`
        : `${lport}, ${rport} : ERROR : NO-USER\r\n`,
    );
  });
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => {});
}

/** Build (but don't listen on) an identd server. Exposed for tests. */
export function createIdentdServer(): net.Server {
  return net.createServer(handleConnection);
}

let server: net.Server | null = null;

export function startIdentd(port: number): void {
  if (server) return;
  const srv = createIdentdServer();
  srv.on('error', (err: Error) => {
    // A failed bind (EACCES without the privilege to bind :113, or EADDRINUSE)
    // must not take down the whole server — log and carry on without identd. If
    // the error arrives after we were already listening, close the listener so
    // it can't keep accepting connections once we drop our reference to it.
    console.error(`[identd] failed to listen on :${port}: ${err.message}`);
    if (srv.listening) srv.close();
    if (server === srv) server = null;
  });
  srv.listen(port, () => console.log(`[identd] listening on :${port}`));
  server = srv;
}

export function stopIdentd(): void {
  if (server) {
    server.close();
    server = null;
  }
}

export function isIdentdEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LURKER_IDENTD_ENABLED || '').trim());
}

export function identdPort(): number {
  const p = Number(process.env.LURKER_IDENTD_PORT);
  return Number.isInteger(p) && p > 0 ? p : 113;
}
