// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Export must carry network secrets as portable PLAINTEXT (so an export is
// restorable on a self-host without the key), and import onto a keyed cell must
// re-encrypt them at rest. Exercises both raw-SQL bypass paths end to end.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import yauzl from 'yauzl';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-secrets-rt-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
process.env.LURKER_SECRET_KEY = Buffer.alloc(32, 5).toString('base64');

let db: typeof import('../db/index.js').default;
let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let getNetwork: typeof import('../db/networks.js').getNetwork;
let buffers: typeof import('../db/buffers.js');
let isEncrypted: typeof import('../utils/secretCrypto.js').isEncrypted;
let buildExportZip: typeof import('./exportService.js').buildExportZip;
let importFromZipBuffer: typeof import('./importService.js').importFromZipBuffer;

const SECRETS = {
  server_password: 'hunter2',
  sasl_account: 'alice-acct',
  sasl_password: 'sasl-secret',
  connect_commands: 'PRIVMSG NickServ :identify supersecret',
};
const SECRET_COLS = Object.keys(SECRETS) as (keyof typeof SECRETS)[];

beforeAll(async () => {
  db = (await import('../db/index.js')).default;
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork, getNetwork } = await import('../db/networks.js'));
  buffers = await import('../db/buffers.js');
  ({ isEncrypted } = await import('../utils/secretCrypto.js'));
  ({ buildExportZip } = await import('./exportService.js'));
  ({ importFromZipBuffer } = await import('./importService.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function exportToBuffer(userId: number): Promise<Buffer> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  await buildExportZip(db, userId, { includeMessages: false }, sink);
  return Buffer.concat(chunks);
}

function readZipEntry(buffer: Buffer, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on('entry', (entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        });
      });
      zip.on('end', () => reject(new Error(`entry ${name} not found`)));
      zip.on('error', reject);
    });
  });
}

describe('network secret export/import round-trip (key configured)', () => {
  it('exports plaintext and re-encrypts on import', async () => {
    const alice = createUser('alice');
    const net = createNetwork(alice.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'alice',
      ...SECRETS,
    })!;
    // Stored encrypted at rest.
    const aliceRaw = db.prepare('SELECT * FROM networks WHERE id = ?').get(net.id) as Record<
      string,
      string | null
    >;
    expect(isEncrypted(aliceRaw.server_password)).toBe(true);

    // ---- export carries plaintext ----
    const buf = await exportToBuffer(alice.id);
    const data = JSON.parse(await readZipEntry(buf, 'data.json')) as {
      networks: Record<string, string>[];
    };
    const exported = data.networks[0];
    for (const col of SECRET_COLS) {
      expect(exported[col]).toBe(SECRETS[col]);
    }

    // ---- import re-encrypts on a fresh, keyed account ----
    const bob = createUser('bob');
    await importFromZipBuffer(bob.id, buf);
    const bobNet = db.prepare('SELECT * FROM networks WHERE user_id = ?').get(bob.id) as Record<
      string,
      string | null
    >;
    for (const col of SECRET_COLS) {
      expect(isEncrypted(bobNet[col])).toBe(true);
    }
    const bobFetched = getNetwork(bobNet.id as unknown as number, bob.id)!;
    for (const col of SECRET_COLS) {
      expect(bobFetched[col]).toBe(SECRETS[col]);
    }
  });

  it('channel keys are encrypted at rest, exported plaintext, and re-encrypted on import', async () => {
    const carol = createUser('carol');
    const net = createNetwork(carol.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'carol',
    })!;
    buffers.ensureOpen(carol.id, net.id, '#secret', {
      kind: 'channel',
      autojoin: true,
      key: 'chankey',
    });

    // Stored encrypted at rest; decrypted on read.
    const raw = db
      .prepare('SELECT key FROM buffers WHERE network_id = ? AND target = ?')
      .get(net.id, '#secret') as { key: string | null };
    expect(isEncrypted(raw.key)).toBe(true);
    expect(buffers.getBuffer(carol.id, net.id, '#secret')!.key).toBe('chankey');

    // Export carries the key as portable plaintext.
    const buf = await exportToBuffer(carol.id);
    const data = JSON.parse(await readZipEntry(buf, 'data.json')) as {
      buffers: Record<string, string>[];
    };
    expect(data.buffers.find((c) => c.target === '#secret')!.key).toBe('chankey');

    // Import onto a fresh keyed account re-encrypts at rest and reads back plain.
    const dave = createUser('dave');
    await importFromZipBuffer(dave.id, buf);
    const daveNet = db.prepare('SELECT id FROM networks WHERE user_id = ?').get(dave.id) as {
      id: number;
    };
    const daveRaw = db
      .prepare('SELECT key FROM buffers WHERE network_id = ? AND target = ?')
      .get(daveNet.id, '#secret') as { key: string | null };
    expect(isEncrypted(daveRaw.key)).toBe(true);
    expect(buffers.getBuffer(dave.id, daveNet.id, '#secret')!.key).toBe('chankey');
  });
});
