// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// soju.im/FILEHOST, through the real app (buildApp) so the mount order is under
// test: ahead of cors() and express.json. The seeded `local` uploader writes to
// a temp dir, and the file comes back through the public /uploads route at the
// Location we answered with.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Express } from 'express';
import { setupTestDb, testRequest, TEST_SESSION_SECRET } from '../test-utils/testApp.js';
import type { User } from '../db/users.js';

const ctx = setupTestDb('routes-filehost');

const PASSWORD = 'hunter2hunter2';
const BASE = 'https://irc.example.test';

let app: Express;
let storageDir: string;
let clientDist: string;
let png: Buffer;
let users: typeof import('../db/users.js');
let settings: typeof import('../db/settings.js');
let localRowId: number;
let filehost: typeof import('./filehost.js');
let resetAuthRateLimits: () => void;

let seq = 0;
async function seedUser(): Promise<User> {
  const { hashPassword } = await import('../services/password.js');
  const user = users.createUser(`filehost_${++seq}`);
  users.setPasswordHash(user.id, hashPassword(PASSWORD));
  settings.setUserSetting(user.id, 'uploads.uploader_id', localRowId);
  return user;
}

function basic(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
}

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-filehost-'));
  process.env.LOCAL_UPLOADS_DIR = storageDir;
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  clientDist = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-filehost-dist-'));
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html>\n');
  users = await import('../db/users.js');
  settings = await import('../db/settings.js');
  filehost = await import('./filehost.js');
  ({ resetAuthRateLimits } = await import('../middleware/rateLimit.js'));
  const { listInstanceUploaders } = await import('../db/uploaderConfig.js');
  const localRow = listInstanceUploaders().find((r) => r.driver === 'local');
  if (!localRow) throw new Error('expected the seeded self-host local uploader row');
  localRowId = localRow.id;
  const { buildApp } = await import('../app.js');
  app = buildApp(TEST_SESSION_SECRET, { clientDist });
  png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 200, b: 90 } },
  })
    .png()
    .toBuffer();
});

afterAll(() => {
  delete process.env.LOCAL_UPLOADS_DIR;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.LURKER_BOUNCER_ENABLED;
  fs.rmSync(storageDir, { recursive: true, force: true });
  fs.rmSync(clientDist, { recursive: true, force: true });
  ctx.cleanup();
});

beforeEach(() => resetAuthRateLimits());

function upload(authorization: string | null, body: Buffer = png, headers = {}) {
  const req = testRequest(app)
    .post('/api/filehost')
    .set('Content-Type', 'image/png')
    .set('Content-Disposition', 'attachment; filename="photo.png"');
  if (authorization) req.set('Authorization', authorization);
  for (const [k, v] of Object.entries(headers)) req.set(k, v as string);
  return req.send(body);
}

describe('OPTIONS', () => {
  it('answers itself, with Accept-Post and CORS for any origin', async () => {
    const res = await testRequest(app)
      .options('/api/filehost')
      .set('Origin', 'https://gamja.example.net')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['allow']).toBe('OPTIONS, POST');
    expect(res.headers['accept-post']).toContain('image/*');
    expect(res.headers['accept-post']).toContain('video/mp4');
    expect(res.headers['accept-post']).toContain('application/json');
    expect(res.headers['access-control-allow-origin']).toBe('https://gamja.example.net');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization, Content-Type, Content-Disposition',
    );
    expect(res.headers['access-control-expose-headers']).toBe('Location');
  });
});

describe('POST', () => {
  it('stores the file and answers 201 with its Location, which serves it', async () => {
    const user = await seedUser();
    const res = await upload(basic(user.username, PASSWORD), png, {
      Origin: 'https://gamja.example.net',
    });
    expect(res.status).toBe(201);
    const location = res.headers['location'];
    expect(location).toMatch(new RegExp(`^${BASE}/uploads/[0-9a-f]{12}\\.webp$`));
    expect(res.text).toBe(location);
    expect(res.headers['access-control-allow-origin']).toBe('https://gamja.example.net');
    expect(res.headers['access-control-expose-headers']).toBe('Location');

    const served = await testRequest(app).get(new URL(location).pathname);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    const head = await testRequest(app).head(new URL(location).pathname);
    expect(head.status).toBe(200);

    // It's in the uploads list, as a web upload would be.
    const { listUploads } = await import('../db/uploadHistory.js');
    const rows = listUploads(user.id, {});
    expect(rows.map((r) => r.url)).toContain(location);
    expect(rows.find((r) => r.url === location)?.filename).toBe('photo.png');
  });

  it('takes a read-write API token and a username carrying /network and @client', async () => {
    const user = await seedUser();
    const { createToken } = await import('../db/apiTokens.js');
    const { token } = createToken({ userId: user.id, name: 'irc', scope: 'read-write' });
    const res = await upload(basic(`${user.username}/libera@phone`, token));
    expect(res.status).toBe(201);
  });

  it('refuses a read-only API token', async () => {
    const user = await seedUser();
    const { createToken } = await import('../db/apiTokens.js');
    const { token } = createToken({ userId: user.id, name: 'ro', scope: 'read' });
    const res = await upload(basic(user.username, token));
    expect(res.status).toBe(401);
  });

  it('takes an OAuth token as Bearer, or as the password for its own user only', async () => {
    const user = await seedUser();
    const other = await seedUser();
    const oauth = await import('../db/oauth.js');
    const oauthApp = oauth.createApp({
      clientName: 'gamja',
      clientUri: null,
      redirectUris: ['urn:ietf:wg:oauth:2.0:oob'],
    });
    const token = oauth.createToken(oauthApp.id, user.id);
    expect((await upload(`Bearer ${token}`)).status).toBe(201);
    expect((await upload(basic(user.username, token))).status).toBe(201);
    expect((await upload(basic(other.username, token))).status).toBe(401);
  });

  // Never a Basic challenge: a browser would prompt for a password and keep it.
  it('answers bad or missing credentials with 401, a Bearer challenge and text', async () => {
    const user = await seedUser();
    for (const authorization of [basic(user.username, 'wrong-password'), null]) {
      const res = await upload(authorization);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="Lurker"');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    }
  });

  // goguma or a script with no credentials set: it tried no password, so it
  // doesn't use up the IP's login budget for the client that has one.
  it("doesn't count a request with no credentials as a failed login", async () => {
    const user = await seedUser();
    const { LOGIN_FAILURE_MAX } = await import('../middleware/rateLimit.js');
    for (let i = 0; i <= LOGIN_FAILURE_MAX; i++) {
      expect((await upload(null)).status).toBe(401);
    }
    expect((await upload(basic(user.username, PASSWORD))).status).toBe(201);
  });

  it('ignores a session cookie', async () => {
    const user = await seedUser();
    const { createAuthedAgent } = await import('../test-utils/testApp.js');
    const agent = await createAuthedAgent(app, user.id);
    const res = await agent.post('/api/filehost').set('Content-Type', 'image/png').send(png);
    expect(res.status).toBe(401);
  });

  it('throttles repeated failed logins', async () => {
    const user = await seedUser();
    const { LOGIN_FAILURE_MAX } = await import('../middleware/rateLimit.js');
    for (let i = 0; i < LOGIN_FAILURE_MAX; i++) {
      expect((await upload(basic(user.username, 'nope'))).status).toBe(401);
    }
    const res = await upload(basic(user.username, PASSWORD));
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('refuses a paused account', async () => {
    const user = await seedUser();
    users.setUserPaused(user.id, true);
    expect((await upload(basic(user.username, PASSWORD))).status).toBe(403);
  });

  // Refused before the body is read, and the connection closed so the client
  // stops sending. A client may fail to write the rest (EPIPE) before it reads
  // the 413, which supertest treats as an error, so these go over raw http.
  it('refuses a file over the cap before reading it, and while reading it', async () => {
    const user = await seedUser();
    settings.setUserSetting(user.id, 'uploads.image.max_upload_mb', 1);
    const server = http.createServer(app).listen(0);
    const { port } = server.address() as AddressInfo;
    const send = (headers: Record<string, string>, chunks = 4, end = true) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            port,
            method: 'POST',
            path: '/api/filehost',
            headers: {
              Authorization: basic(user.username, PASSWORD),
              'Content-Type': 'image/png',
              ...headers,
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', () => {});
        setTimeout(() => reject(new Error('no response')), 5000).unref();
        // Node holds the headers back until the first write; send them regardless.
        req.flushHeaders();
        for (let i = 0; i < chunks; i++) req.write(Buffer.alloc(512 * 1024, 1));
        if (chunks > 0 && end) req.end();
      });
    try {
      const declared = await send({ 'Content-Length': String(2 * 1024 * 1024) });
      expect(declared.status).toBe(413);
      expect(declared.body).toMatch(/file exceeds/);
      // Refused on the declared length alone, before a byte of the body arrives.
      const unsent = await send({ 'Content-Length': String(2 * 1024 * 1024) }, 0);
      expect(unsent.status).toBe(413);
      // Chunked, with no Content-Length to refuse on, and never finished: only
      // stopping once the body passes the cap answers it.
      const chunked = await send({ 'Transfer-Encoding': 'chunked' }, 4, false);
      expect(chunked.status).toBe(413);
    } finally {
      server.close();
    }
  });

  // Over a raw socket: Node's http client stops writing a body once it has read
  // the whole response, which would hide whether the server kept reading.
  it('closes the connection once a refused body runs well past the cap', async () => {
    const user = await seedUser();
    settings.setUserSetting(user.id, 'uploads.image.max_upload_mb', 1);
    const server = http.createServer(app).listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const outcome = await new Promise<{ response: string; closedAfter: number }>(
        (resolve, reject) => {
          const socket = net.connect(port, '127.0.0.1');
          let response = '';
          let sent = 0;
          const chunk = Buffer.alloc(256 * 1024, 1);
          const pump = () => {
            while (sent < 64 * 1024 * 1024) {
              sent += chunk.length;
              if (!socket.write(chunk)) return socket.once('drain', pump);
            }
          };
          socket.on('data', (data) => {
            const first = response === '';
            response += data.toString('latin1');
            // Keep sending the body after the answer, well past what's thrown away.
            if (first) pump();
          });
          socket.on('error', () => {});
          socket.on('close', () => resolve({ response, closedAfter: sent }));
          setTimeout(() => reject(new Error('never closed')), 8000).unref();
          socket.write(
            `POST /api/filehost HTTP/1.1\r\nHost: localhost\r\n` +
              `Authorization: ${basic(user.username, PASSWORD)}\r\n` +
              `Content-Type: image/png\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`,
          );
        },
      );
      expect(outcome.response).toMatch(/^HTTP\/1\.1 413 /);
      // Closed long before the declared 64 MB was sent.
      expect(outcome.closedAfter).toBeLessThan(32 * 1024 * 1024);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  // A client that resets the connection partway through a body, while it's being
  // received and while a refused one is being drained. The temp file goes, and
  // the server carries on.
  it('survives a client that resets partway through a body', async () => {
    const user = await seedUser();
    const { UPLOAD_TMP_DIR } = await import('../services/uploadService.js');
    const temps = () => fs.readdirSync(UPLOAD_TMP_DIR).filter((f) => f.startsWith('up-'));
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(done()).toBe(true);
    };
    const server = http.createServer(app).listen(0);
    const { port } = server.address() as AddressInfo;
    const open = (authorization: string | null) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('error', () => {});
      let response = '';
      socket.on('data', (data) => (response += data.toString('latin1')));
      socket.write(
        `POST /api/filehost HTTP/1.1\r\nHost: localhost\r\n` +
          (authorization ? `Authorization: ${authorization}\r\n` : '') +
          `Content-Type: image/png\r\nContent-Length: ${8 * 1024 * 1024}\r\n\r\n`,
      );
      socket.write(Buffer.alloc(256 * 1024, 1));
      return { socket, response: () => response };
    };
    try {
      const before = temps().length;
      const receiving = open(basic(user.username, PASSWORD));
      await until(() => temps().length > before);
      receiving.socket.resetAndDestroy();
      await until(() => temps().length === before);

      const refused = open(null);
      await until(() => refused.response().startsWith('HTTP/1.1 401 '));
      refused.socket.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 100));

      expect((await upload(basic(user.username, PASSWORD))).status).toBe(201);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  // A padded PUBLIC_BASE_URL is what the bouncer advertises, so the URL answered
  // here has to match it (publicOrigin.configuredBaseUrl).
  it('answers the same base the bouncer advertises when the value has whitespace', async () => {
    const user = await seedUser();
    process.env.PUBLIC_BASE_URL = `  ${BASE}/  `;
    try {
      const res = await upload(basic(user.username, PASSWORD));
      expect(res.status).toBe(201);
      expect(res.headers['location']).toMatch(new RegExp(`^${BASE}/uploads/[0-9a-f]{12}\\.webp$`));
    } finally {
      process.env.PUBLIC_BASE_URL = BASE;
    }
  });

  // #983: the files on their own host, while the endpoint (and the credentials a
  // client sends it) stays on PUBLIC_BASE_URL.
  it('answers with the local uploader’s public_base_url when it has one', async () => {
    const user = await seedUser();
    const { updateUploaderConfig } = await import('../db/uploaderConfig.js');
    updateUploaderConfig(localRowId, {
      values: { public_base_url: 'https://files.example.test/' },
    });
    try {
      const res = await upload(basic(user.username, PASSWORD));
      expect(res.status).toBe(201);
      const location = res.headers['location'];
      expect(location).toMatch(/^https:\/\/files\.example\.test\/uploads\/[0-9a-f]{12}\.webp$/);
      // The files host's reverse proxy hands /uploads/ to this same instance.
      const served = await testRequest(app).get(new URL(location).pathname);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/webp');
    } finally {
      updateUploaderConfig(localRowId, { values: { public_base_url: '' } });
    }
  });

  it('keeps control characters out of the stored name', async () => {
    const user = await seedUser();
    const res = await upload(basic(user.username, PASSWORD), png, {
      'Content-Disposition': "attachment; filename*=UTF-8''shot%0D%0AX-Injected%3A%201%07.png",
    });
    expect(res.status).toBe(201);
    const { listUploads } = await import('../db/uploadHistory.js');
    const row = listUploads(user.id, {}).find((r) => r.url === res.headers['location']);
    expect(row?.filename).toBe('shotX-Injected: 1.png');
  });

  it('refuses what the upload rules do, with the reason as text', async () => {
    const user = await seedUser();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const res = await upload(basic(user.username, PASSWORD), pdf, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="doc.pdf"',
    });
    expect(res.status).toBe(415);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/images, text/);
  });

  it('keeps a JSON file away from the JSON body parser', async () => {
    const user = await seedUser();
    const res = await upload(basic(user.username, PASSWORD), Buffer.from('{"a": 1}\n'), {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="data.json"',
    });
    expect(res.status).toBe(201);
  });

  it('refuses an empty body', async () => {
    const user = await seedUser();
    const res = await upload(basic(user.username, PASSWORD), Buffer.alloc(0));
    expect(res.status).toBe(400);
  });
});

describe('with the bouncer off', () => {
  it('is not mounted', async () => {
    delete process.env.LURKER_BOUNCER_ENABLED;
    try {
      const { buildApp } = await import('../app.js');
      const off = buildApp(TEST_SESSION_SECRET, { clientDist });
      const user = await seedUser();
      const res = await testRequest(off)
        .post('/api/filehost')
        .set('Authorization', basic(user.username, PASSWORD))
        .set('Content-Type', 'image/png')
        .send(png);
      expect(res.status).toBe(404);
      expect(res.headers['location']).toBeUndefined();
    } finally {
      process.env.LURKER_BOUNCER_ENABLED = 'true';
    }
  });
});

describe('dispositionFilename', () => {
  it.each([
    ['attachment; filename="photo.png"', 'photo.png'],
    ['attachment; filename=photo.png', 'photo.png'],
    ['attachment; filename="say \\"hi\\".txt"', 'say "hi".txt'],
    // gamja leaves ( ) and ' unescaped in filename*.
    ["attachment; filename*=UTF-8''a%20(1).png", 'a (1).png'],
    // goguma encodes a space as + there.
    ["attachment; filename*=UTF-8''my+file.jpg", 'my file.jpg'],
    // halloy sends both; filename* wins.
    [`attachment; filename="caf_.png"; filename*=UTF-8''caf%C3%A9.png`, 'café.png'],
    ['attachment; filename="../../etc/passwd"', 'passwd'],
    ['attachment; filename="C:\\\\Users\\\\me\\\\shot.png"', 'shot.png'],
    ["attachment; filename*=UTF-8''bad%E0%A4.png", 'bad%E0%A4.png'],
    ['attachment', ''],
  ])('%s → %s', (header, expected) => {
    expect(filehost.dispositionFilename(header)).toBe(expected);
  });

  it('has no name without a header', () => {
    expect(filehost.dispositionFilename(undefined)).toBe('');
  });
});
