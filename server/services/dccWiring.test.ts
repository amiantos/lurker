// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC wiring (#270, phase 0): the glue between an inbound CTCP `DCC SEND` and the
// download manager on IrcConnection. The wire parse is unit-pinned in
// dcc.test.ts; these exercise the PLUMBING — does an enabled user get a detected
// offer recorded as pending_approval with a surfaced status line, does a disabled
// user fall through to the ordinary unsupported-CTCP path with no row, and are
// non-SEND subtypes recorded-not.

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import db from '../db/index.js';
import { createNetwork } from '../db/networks.js';
import { createUser } from '../db/users.js';
import { CAPABILITY_DCC, setUserCapability } from '../db/userCapabilities.js';
import { listDccTransfers } from '../db/dccTransfers.js';
import { IrcConnection } from './ircConnection.js';

beforeAll(() => {
  createUser('dcc-wire-alice'); // id 1
  createNetwork(1, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'alice' }); // network id 1
});

let tmpDir: string | null = null;
let activeSender: { close: () => void } | null = null;
afterEach(() => {
  // Isolate each test: the DB and env persist across a file's tests.
  delete process.env.LURKER_DCC_ENABLED;
  delete process.env.LURKER_DCC_DIR;
  delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  delete process.env.LURKER_DCC_MAX_FILE_MB;
  setUserCapability(1, CAPABILITY_DCC, false);
  db.prepare('DELETE FROM dcc_transfers').run();
  activeSender?.close();
  activeSender = null;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

function makeConn(): IrcConnection {
  return new IrcConnection({
    network: {
      id: 1,
      user_id: 1,
      name: 'n',
      host: 'irc.example.test',
      port: 6697,
      tls: 1,
      trusted_certificates: 1,
      nick: 'alice',
      username: null,
      realname: null,
      server_password: null,
      autoconnect: 1,
      sasl_account: null,
      sasl_password: null,
      connect_commands: null,
      position: 0,
      created_at: new Date().toISOString(),
    },
    onEvent: () => {},
  });
}

function harness() {
  const conn = makeConn();
  const ctcpResponse = vi.fn<(target: string, type: string, ...p: string[]) => void>();
  const publishEphemeral = vi.fn<(event: Record<string, unknown>) => void>();
  conn.client.ctcpResponse = ctcpResponse;
  conn.publishEphemeral = publishEphemeral;
  const ctcpLines = () =>
    publishEphemeral.mock.calls.map((c) => c[0]).filter((e) => e.type === 'ctcp') as Array<{
      target: string;
      text: string;
    }>;
  return { conn, ctcpResponse, ctcpLines };
}

// Both tiers of the gate on: cell-wide master switch + per-user grant.
function enableDcc() {
  process.env.LURKER_DCC_ENABLED = '1';
  setUserCapability(1, CAPABILITY_DCC, true);
}

function makePayload(n: number): Buffer {
  return Buffer.from(Array.from({ length: n }, (_, i) => i % 256));
}

// A fake DCC sender: writes the payload then half-closes.
function startSender(toSend: Buffer): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.write(toSend, () => sock.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('inbound DCC SEND — enabled', () => {
  it('records the offer as pending_approval and surfaces a status line', () => {
    enableDcc();
    const { conn, ctcpLines } = harness();

    conn.client.emit('ctcp request', {
      nick: '[EWG]MArchive',
      ident: 'a',
      hostname: 'h',
      type: 'DCC',
      message: 'DCC SEND scene.mkv 3232235777 50612 5368709120',
    });

    const rows = listDccTransfers(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      network_id: 1,
      peer_nick: '[EWG]MArchive',
      filename: 'scene.mkv',
      advertised_size: 5368709120, // > 4 GiB, exact
      state: 'pending_approval',
      passive: 0,
      received_bytes: 0,
    });
    const last = ctcpLines().at(-1);
    expect(last?.text).toBe('[EWG]MArchive offered "scene.mkv" (5.0 GB) via DCC SEND');
  });

  it('captures a passive offer with its token', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 0 1024 42',
    });
    const row = listDccTransfers(1)[0];
    expect(row.passive).toBe(1);
    expect(row.token).toBe(42);
    expect(row.state).toBe('pending_approval');
  });

  it('records nothing for a non-SEND subtype but still surfaces it', () => {
    enableDcc();
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bob',
      type: 'DCC',
      message: 'DCC CHAT chat 16843009 5000',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
    expect(ctcpLines().at(-1)?.text).toBe('bob requested CTCP DCC (no reply)');
  });

  it('ignores our own DCC offer echoed back by an echo-message server', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'alice', // our own nick
      type: 'DCC',
      message: 'DCC SEND x 16843009 1 1',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
  });
});

describe('inbound DCC SEND — disabled (gate closed)', () => {
  it('falls through to the ordinary unsupported-CTCP path with no row', () => {
    // master switch + capability both off (default)
    const { conn, ctcpLines } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 50612 1024',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
    expect(ctcpLines().at(-1)?.text).toBe('bot requested CTCP DCC (no reply)');
  });

  it('stays closed when only the per-user grant is on (master off)', () => {
    setUserCapability(1, CAPABILITY_DCC, true);
    const { conn } = harness();
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 50612 1024',
    });
    expect(listDccTransfers(1)).toHaveLength(0);
  });
});

describe('arm-on-trigger + auto-accept', () => {
  it('arms a requested row when the user sends an XDCC trigger to a bot', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('[EWG]MArchive', 'xdcc send #27228');
    const rows = listDccTransfers(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'requested',
      peer_nick: '[EWG]MArchive',
      filename: 'XDCC #27228',
      trigger_text: 'xdcc send #27228',
      advertised_size: 0,
    });
  });

  it('does not arm a channel-targeted trigger or when DCC is disabled', () => {
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    // disabled
    conn.say('bot', 'xdcc send #1');
    expect(listDccTransfers(1)).toHaveLength(0);
    // enabled but sent to a channel → not armed
    enableDcc();
    conn.say('#chan', 'xdcc send #1');
    expect(listDccTransfers(1)).toHaveLength(0);
  });

  it('auto-accepts a matching offer and streams the file to disk', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-dcc-e2e-'));
    process.env.LURKER_DCC_DIR = tmpDir;
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1'; // the fake sender is on 127.0.0.1
    enableDcc();
    const payload = makePayload(40_000);
    const sender = await startSender(payload);
    activeSender = sender;

    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();

    // 1. user fires the trigger → arms a requested row
    conn.say('[EWG]MArchive', 'xdcc send #1');
    // 2. bot answers with a DCC SEND offer (127.0.0.1 = 2130706433)
    conn.client.emit('ctcp request', {
      nick: '[EWG]MArchive',
      type: 'DCC',
      message: `DCC SEND payload.bin 2130706433 ${sender.port} ${payload.length}`,
    });

    // 3. the download runs to completion on its own socket
    await waitFor(() => listDccTransfers(1)[0]?.state === 'completed', 5000);

    const row = listDccTransfers(1)[0];
    expect(row.received_bytes).toBe(payload.length);
    expect(row.destination_path).toBe(path.join(tmpDir, 'dcc-wire-alice', 'payload.bin'));
    expect(fs.readFileSync(row.destination_path as string).equals(payload)).toBe(true);
  });

  it('fails an armed passive offer (not yet supported)', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #2');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 2130706433 0 1024 7', // port 0 = passive
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/passive/i);
  });

  it('refuses an armed offer pointing at a private/loopback address (SSRF guard)', () => {
    enableDcc(); // note: LURKER_DCC_ALLOW_PRIVATE_HOSTS is NOT set
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #3');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 2130706433 8080 1024', // 2130706433 = 127.0.0.1
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/blocked address/i);
  });

  it('refuses an armed offer with no advertised size', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'xdcc send #4');
    conn.client.emit('ctcp request', {
      nick: 'bot',
      type: 'DCC',
      message: 'DCC SEND f.bin 16843009 8080 0', // 1.1.1.1 (public), size 0
    });
    const row = listDccTransfers(1)[0];
    expect(row.state).toBe('failed');
    expect(row.error).toMatch(/no advertised/i);
  });

  it('does not arm an xdcc trigger mentioned mid-sentence', () => {
    enableDcc();
    const { conn } = harness();
    conn.client.say = vi.fn<(target: string, text: string) => void>();
    conn.say('bot', 'hey did you ever get that xdcc send #5 file?');
    expect(listDccTransfers(1)).toHaveLength(0);
  });
});
