// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A scriptable in-process SOCKS5 / HTTP CONNECT proxy for tests, in the shape
// `fakeIrcd` already established (#303).
//
// Its value is NOT that it stands in for a real proxy — `ssh -D` does that
// better, see PROXY_PLAN.md §13. Its value is that it can misbehave to order,
// which no real proxy can: dribble a reply one byte per tick, pipeline the
// ircd's first line into its own CONNECT response, return SOCKS reply code 0x02
// on demand, accept a connection and then say nothing at all. Those are the
// bugs this feature actually has, and they are only reachable from here.
//
// It also RECORDS what it was asked for, which is how the one rule that matters
// gets asserted on the wire rather than by convention: the destination must
// arrive as a NAME, because a name is what lets the proxy resolve it.

import net from 'node:net';

/** What a proxy was asked to connect to, as it arrived on the wire. */
export interface ProxyRequest {
  /** 'domain' is the one that proves we did not resolve locally. */
  addressType: 'domain' | 'ipv4' | 'ipv6';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface FakeProxyOptions {
  protocol: 'socks5' | 'http';
  /** Demand username/password. SOCKS5 answers method 0x02; HTTP answers 407
   *  until a matching Proxy-Authorization arrives. */
  auth?: { username: string; password: string };
  /** Refuse the tunnel with this SOCKS5 reply code (0x01–0x08), or this HTTP
   *  status. The handshake still completes up to that point. */
  reject?: number;
  /** Accept the TCP connection and then never speak — the deadline case. */
  tarpit?: boolean;
  /** Write the success reply one byte at a time, a tick apart. The framing
   *  test: a length-naive reader passes without this and fails with it. */
  dribble?: boolean;
  /** Bytes to append to the SUCCESS reply in the same write — standing in for a
   *  proxy that delivers the ircd's first line alongside its own response. The
   *  caller must still receive these. */
  pipeline?: string;
  /** Where to forward a successful tunnel. When absent the proxy is a sink that
   *  completes the handshake and then echoes nothing, which is all most tests
   *  need. */
  forwardTo?: { host: string; port: number };
}

export class FakeProxy {
  private server: net.Server;
  /** Every request this proxy received, in order. */
  readonly requests: ProxyRequest[] = [];
  private sockets = new Set<net.Socket>();

  private constructor(
    server: net.Server,
    readonly port: number,
    private readonly opts: FakeProxyOptions,
  ) {
    this.server = server;
  }

  static async start(opts: FakeProxyOptions): Promise<FakeProxy> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;
    const proxy = new FakeProxy(server, addr.port, opts);
    server.on('connection', (sock) => {
      proxy.sockets.add(sock);
      sock.on('close', () => proxy.sockets.delete(sock));
      // A test asserting on a failure will destroy its end; that is not an
      // error worth surfacing from the harness.
      sock.on('error', () => {});
      if (opts.tarpit) return;
      if (opts.protocol === 'socks5') proxy.handleSocks5(sock);
      else proxy.handleHttp(sock);
    });
    return proxy;
  }

  /** The last request received, for the common single-dial assertion. */
  get lastRequest(): ProxyRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Write `buf`, optionally one byte per tick. The dribble path is the whole
   *  point of the harness for the HTTP half, so it is shared by both. */
  private write(sock: net.Socket, buf: Buffer): void {
    if (!this.opts.dribble) {
      sock.write(buf);
      return;
    }
    let i = 0;
    const tick = () => {
      if (i >= buf.length || sock.destroyed) return;
      sock.write(buf.subarray(i, i + 1));
      i += 1;
      setTimeout(tick, 1);
    };
    tick();
  }

  // --- SOCKS5 -------------------------------------------------------------
  // Deliberately a hand-rolled reader: it must accept whatever `socks` sends,
  // including a greeting and a request that arrive in one segment.

  private handleSocks5(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    let phase: 'greet' | 'auth' | 'request' | 'done' = 'greet';
    let username: string | undefined;
    let password: string | undefined;

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      // A loop, not an if: `socks` may pipeline the next step into the same
      // segment, and a single-step reader would stall waiting for data that
      // has already arrived.
      for (;;) {
        if (phase === 'greet') {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          const methods = [...buf.subarray(2, 2 + nMethods)];
          buf = buf.subarray(2 + nMethods);
          if (this.opts.auth) {
            if (!methods.includes(0x02)) {
              // 0xFF: no acceptable method.
              sock.end(Buffer.from([0x05, 0xff]));
              return;
            }
            sock.write(Buffer.from([0x05, 0x02]));
            phase = 'auth';
          } else {
            sock.write(Buffer.from([0x05, 0x00]));
            phase = 'request';
          }
          continue;
        }
        if (phase === 'auth') {
          // RFC 1929: ver, ulen, uname, plen, passwd.
          if (buf.length < 2) return;
          const uLen = buf[1];
          if (buf.length < 2 + uLen + 1) return;
          const pLen = buf[2 + uLen];
          if (buf.length < 3 + uLen + pLen) return;
          username = buf.subarray(2, 2 + uLen).toString();
          password = buf.subarray(3 + uLen, 3 + uLen + pLen).toString();
          buf = buf.subarray(3 + uLen + pLen);
          const ok = username === this.opts.auth?.username && password === this.opts.auth?.password;
          sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            sock.end();
            return;
          }
          phase = 'request';
          continue;
        }
        if (phase === 'request') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host: string;
          let addressType: ProxyRequest['addressType'];
          let offset: number;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = [...buf.subarray(4, 8)].join('.');
            addressType = 'ipv4';
            offset = 8;
          } else if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 5 + len + 2) return;
            host = buf.subarray(5, 5 + len).toString();
            addressType = 'domain';
            offset = 5 + len;
          } else if (atyp === 0x04) {
            if (buf.length < 22) return;
            const parts: string[] = [];
            for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
            host = parts.join(':');
            addressType = 'ipv6';
            offset = 20;
          } else {
            sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = buf.readUInt16BE(offset);
          buf = buf.subarray(offset + 2);
          this.requests.push({ addressType, host, port, username, password });
          phase = 'done';
          // ⚠ Detach before bridging. Left attached, this parser keeps
          // concat-ing every tunnelled byte into `buf` forever, and anything a
          // client pipelined after the request would sit in `buf` instead of
          // reaching the tunnel — a test that writes immediately after
          // connecting would silently lose its first line.
          sock.off('data', onData);
          const pipelined = buf;
          buf = Buffer.alloc(0);
          this.finishSocks5(sock, host, port);
          if (pipelined.length) sock.unshift(pipelined);
          return;
        }
        return;
      }
    };
    sock.on('data', onData);
  }

  private finishSocks5(sock: net.Socket, host: string, port: number): void {
    if (this.opts.reject) {
      sock.end(
        Buffer.from([0x05, this.opts.reject, 0x00, 0x01, 127, 0, 0, 1, port >> 8, port & 0xff]),
      );
      return;
    }
    // ⚠ The bound address is replied as a DOMAIN on purpose, not as the IPv4
    // every naive implementation assumes. A client that reads a fixed 10 bytes
    // passes an IPv4-bound reply and desynchronises here — which is the trap
    // WeeChat switches on and `socks` handles, and the reason this is the
    // default shape rather than an option.
    const name = Buffer.from(host);
    const reply = Buffer.concat([
      Buffer.from([0x05, 0x00, 0x00, 0x03, name.length]),
      name,
      Buffer.from([port >> 8, port & 0xff]),
      Buffer.from(this.opts.pipeline ?? ''),
    ]);
    this.write(sock, reply);
    this.bridge(sock);
  }

  // --- HTTP CONNECT -------------------------------------------------------

  private handleHttp(sock: net.Socket): void {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      // Same rule as the SOCKS5 half: stop parsing once the request is read, or
      // tunnelled traffic is re-parsed as a CONNECT on every byte and anything
      // pipelined after the header never reaches the tunnel.
      sock.off('data', onData);
      const pipelined = buf.subarray(end + 4);
      const head = buf.subarray(0, end).toString('latin1');
      const [requestLine, ...headers] = head.split('\r\n');
      // A bracketed IPv6 literal is the only correct spelling of one in a
      // CONNECT authority, so accept both shapes and record the address.
      const m = /^CONNECT\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s+HTTP\/\d(?:\.\d)?$/.exec(requestLine);
      if (!m) {
        sock.end('HTTP/1.0 400 Bad Request\r\n\r\n');
        return;
      }
      const host = m[1].replace(/^\[|\]$/g, '');
      const port = Number(m[2]);
      let username: string | undefined;
      let password: string | undefined;
      const authHeader = headers.find((h) => /^proxy-authorization:/i.test(h));
      if (authHeader) {
        const b64 = authHeader.split(/\s+/)[2] || '';
        const pair = Buffer.from(b64, 'base64').toString();
        const colon = pair.indexOf(':');
        username = colon >= 0 ? pair.slice(0, colon) : pair;
        password = colon >= 0 ? pair.slice(colon + 1) : undefined;
      }
      this.requests.push({
        // A CONNECT target is always text; whether it is a name is decided by
        // what it looks like, which is exactly the assertion a test wants.
        addressType: net.isIPv4(host) ? 'ipv4' : net.isIPv6(host) ? 'ipv6' : 'domain',
        host,
        port,
        username,
        password,
      });
      if (this.opts.auth) {
        const ok = username === this.opts.auth.username && password === this.opts.auth.password;
        if (!ok) {
          sock.end('HTTP/1.0 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
      }
      if (this.opts.reject) {
        sock.end(`HTTP/1.0 ${this.opts.reject} Forbidden\r\n\r\n`);
        return;
      }
      // ⚠ `pipeline` rides in the SAME write as the response, which is what a
      // real proxy does when the server speaks first. A client that does not
      // unshift the remainder loses it silently.
      this.write(
        sock,
        Buffer.from(`HTTP/1.0 200 Connection established\r\n\r\n${this.opts.pipeline ?? ''}`),
      );
      this.bridge(sock);
      if (pipelined.length) sock.unshift(pipelined);
    };
    sock.on('data', onData);
  }

  // --- after the handshake ------------------------------------------------

  private bridge(sock: net.Socket): void {
    const to = this.opts.forwardTo;
    if (!to) return;
    const upstream = net.connect(to);
    // ⚠ Tracked like any other socket. An untracked upstream keeps the
    // forwarded-to server's `close()` pending forever, which is a hung test
    // suite rather than a failing one — much harder to read.
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
    upstream.on('error', () => sock.destroy());
    sock.on('error', () => upstream.destroy());
    // Either end going away takes the pair with it, so nothing is left half
    // open once a test destroys its socket.
    sock.on('close', () => upstream.destroy());
    upstream.on('end', () => sock.destroy());
    sock.pipe(upstream);
    upstream.pipe(sock);
  }
}
