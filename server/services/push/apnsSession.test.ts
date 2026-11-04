// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The APNs connection's lifecycle, against local gateways standing in for Apple:
// one that accepts TCP and never finishes TLS, one that never answers a stream,
// and one that sends a graceful GOAWAY with a push in flight. Ported from the
// push relay's tests (lurker-control-plane#73), where Codex found both bugs.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import http2 from 'http2';
import net from 'net';
import type { AddressInfo } from 'net';
import { generate as generateSelfSigned } from 'selfsigned';
import { apnsSender, setApnsGatewayForTests } from './apnsSender.js';
import { resetCredentialCache } from './credentials.js';
import type { PushSubscription } from '../../db/pushSubscriptions.js';
import { composeNotification, type PushPayload } from '../notificationContent.js';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const APNS_ENV: Record<string, string> = {
  LURKER_APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  LURKER_APNS_KEY_ID: 'KEYID123',
  LURKER_APNS_TEAM_ID: 'TEAM456',
  LURKER_APNS_BUNDLE_ID: 'net.amiantos.Lurker',
};

const sub: PushSubscription = {
  id: 1,
  user_id: 1,
  endpoint: 'ab'.repeat(32),
  transport: 'apns',
  p256dh: null,
  auth: null,
  user_agent: null,
  enabled: true,
  created_at: '',
  last_seen_at: '',
  fail_count: 0,
};

const payload: PushPayload = {
  kind: 'dm',
  networkId: 7,
  networkName: 'Libera',
  target: 'bob',
  nick: 'bob',
  text: 'hey',
};

const send = () => apnsSender.send(sub, payload, composeNotification(payload));
const failureOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

let key: string;
let cert: string;

beforeAll(async () => {
  const pems = await generateSelfSigned([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    algorithm: 'sha256',
  });
  key = pems.private;
  cert = pems.cert;
  Object.assign(process.env, APNS_ENV);
  resetCredentialCache();
});

afterEach(() => setApnsGatewayForTests());

afterAll(() => {
  for (const k of Object.keys(APNS_ENV)) delete process.env[k];
  resetCredentialCache();
});

function pointAt(host: string, over: { connectTimeoutMs?: number; requestTimeoutMs?: number }) {
  setApnsGatewayForTests({
    prodHost: host,
    sandboxHost: host,
    connectOptions: { ca: cert },
    ...over,
  });
}

// TCP connects, TLS never completes: a gateway that has stalled.
async function stalledGateway() {
  const sockets: net.Socket[] = [];
  let connections = 0;
  let closed = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.push(socket);
    socket.on('close', () => closed++);
    socket.on('error', () => {});
    // Read (and ignore) the TLS hello. A socket left paused with unread data
    // never sees the client's FIN, so its close would never be observed.
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  return {
    host: `https://localhost:${(server.address() as AddressInfo).port}`,
    connections: () => connections,
    closed: () => closed,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function http2Gateway(onStream: (stream: http2.ServerHttp2Stream) => void) {
  const server = http2.createSecureServer({ key, cert });
  const sessions: http2.ServerHttp2Session[] = [];
  server.on('session', (s) => sessions.push(s));
  server.on('stream', onStream);
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  return {
    host: `https://localhost:${(server.address() as AddressInfo).port}`,
    sessions,
    async stop() {
      for (const s of sessions) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('APNs connection lifecycle', () => {
  it('drops a session that never finishes connecting; the next push opens a new one', async () => {
    const gw = await stalledGateway();
    try {
      pointAt(gw.host, { connectTimeoutMs: 100, requestTimeoutMs: 60_000 });
      const first = await failureOf(send());
      // The connect deadline failed the push long before its own timeout, and
      // with no status: transient, never the device's fault.
      expect(first).toMatchObject({ status: null });
      expect(apnsSender.classify(first)).toBe('transient');
      await vi.waitFor(() => expect(gw.closed()).toBe(1));

      await failureOf(send());
      expect(gw.connections()).toBe(2);
    } finally {
      await gw.stop();
    }
  });

  it('drops a still-connecting session when a push on it times out', async () => {
    const gw = await stalledGateway();
    try {
      pointAt(gw.host, { connectTimeoutMs: 60_000, requestTimeoutMs: 100 });
      const first = await failureOf(send());
      expect(first).toMatchObject({ status: null, message: 'APNs request timed out' });
      expect(apnsSender.classify(first)).toBe('transient');
      await vi.waitFor(() => expect(gw.closed()).toBe(1));

      await failureOf(send());
      expect(gw.connections()).toBe(2);
    } finally {
      await gw.stop();
    }
  });

  it('times out a push Apple never answers, and resets its stream', async () => {
    let streamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (streamClosed = resolve));
    const gw = await http2Gateway((stream) => {
      stream.on('data', () => {});
      stream.on('close', () => streamClosed());
    });
    try {
      pointAt(gw.host, { requestTimeoutMs: 100 });
      const err = await failureOf(send());
      expect(err).toMatchObject({ status: null, message: 'APNs request timed out' });
      expect(apnsSender.classify(err)).toBe('transient');
      // Reset, not left waiting on the connection forever.
      await closed;
    } finally {
      await gw.stop();
    }
  });

  it('lets an in-flight push finish after a graceful GOAWAY; the next opens a new session', async () => {
    let held: http2.ServerHttp2Stream | null = null;
    let firstArrived!: () => void;
    const arrived = new Promise<void>((resolve) => (firstArrived = resolve));
    const gw = await http2Gateway((stream) => {
      stream.on('data', () => {});
      stream.on('end', () => {
        if (!held) {
          // Apple shutting the connection down gracefully: no new streams, but
          // this one (lastStreamID = its id) will still be answered.
          held = stream;
          stream.session?.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id);
          firstArrived();
          return;
        }
        // The next push, on a new connection. Answer it, then the held one.
        stream.respond({ ':status': 200 });
        stream.end();
        held.respond({ ':status': 410 });
        held.end(JSON.stringify({ reason: 'Unregistered' }));
      });
    });
    try {
      pointAt(gw.host, { requestTimeoutMs: 5_000 });
      const first = failureOf(send());
      await arrived;
      // Give the client a moment to read the GOAWAY.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await send();

      // The held push got Apple's real answer, not a destroyed stream: the
      // device is deleted as gone rather than kept as a transient failure.
      const err = await first;
      expect(err).toMatchObject({ status: 410, reason: 'Unregistered' });
      expect(apnsSender.classify(err)).toBe('permanent');
      expect(gw.sessions).toHaveLength(2);
    } finally {
      await gw.stop();
    }
  });

  it('still drops the old session at once when the gateway itself changes', async () => {
    // Sandbox ↔ production is a config switch, and nothing on the old session
    // is wanted — the host stays part of the cache key (review of #490).
    const a = await http2Gateway((stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    const b = await http2Gateway((stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    try {
      setApnsGatewayForTests({
        prodHost: a.host,
        sandboxHost: b.host,
        connectOptions: { ca: cert },
      });
      await send();
      process.env.LURKER_APNS_SANDBOX = '1';
      resetCredentialCache();
      await send();
      expect(a.sessions).toHaveLength(1);
      expect(b.sessions).toHaveLength(1);
      await vi.waitFor(() => expect(a.sessions[0].closed || a.sessions[0].destroyed).toBe(true));
    } finally {
      delete process.env.LURKER_APNS_SANDBOX;
      resetCredentialCache();
      await a.stop();
      await b.stop();
    }
  });
});
