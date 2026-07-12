// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as x0 from './x0.js';
import * as catbox from './catbox.js';
import * as hoarder from './hoarder.js';
import * as zipline from './zipline.js';
import * as chibisafe from './chibisafe.js';
import * as s3 from './s3.js';
import * as multipart from './multipart.js';
import type { PostBufferResult } from './multipart.js';

// Helper that grabs the FormData passed to fetch() so we can assert the
// multipart shape without reaching into providers' internals.
function captureFormData(): {
  url: string | null;
  init: RequestInit | null;
  formData: FormData | null;
} {
  const captured: { url: string | null; init: RequestInit | null; formData: FormData | null } = {
    url: null,
    init: null,
    formData: null,
  };
  globalThis.fetch = vi.fn<typeof fetch>(
    async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      captured.init = init ?? null;
      captured.formData = (init?.body as FormData | null) ?? null;
      return captureResponse;
    },
  );
  return captured;
}

// Catbox uses postBuffer (https.request under the hood) instead of fetch.
// We spy on postBuffer directly to capture the body Buffer and headers.
function captureCatboxCall(): {
  url: string | null;
  body: Buffer | null;
  headers: Record<string, string> | null;
} {
  const captured: {
    url: string | null;
    body: Buffer | null;
    headers: Record<string, string> | null;
  } = { url: null, body: null, headers: null };
  vi.spyOn(multipart, 'postBuffer').mockImplementation(
    async (url: string, body: Buffer, opts?: { headers?: Record<string, string> }) => {
      captured.url = url;
      captured.body = body;
      captured.headers = opts?.headers ?? {};
      return catboxResponse;
    },
  );
  return captured;
}

let captureResponse: Response;
let catboxResponse: PostBufferResult;

beforeEach(() => {
  captureResponse = new Response('https://example.test/abc.png', { status: 200 });
  catboxResponse = { status: 200, headers: {}, text: 'https://files.catbox.moe/xyz.png' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('x0 provider', () => {
  it('POSTs multipart `file` and returns the URL from the response body', async () => {
    const cap = captureFormData();
    const result = await x0.upload(Buffer.from([1, 2, 3]), {
      filename: 'a.png',
      mime: 'image/png',
    });
    expect(cap.url).toBe('https://x0.at/');
    expect((cap.init as RequestInit & { method: string }).method).toBe('POST');
    expect(
      (cap.init as RequestInit & { headers: Record<string, string> }).headers['User-Agent'],
    ).toMatch(/^Lurker\//);
    expect(cap.formData!.get('file')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://example.test/abc.png');
  });

  it('throws PROVIDER_ERROR on non-2xx response', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('rejected', { status: 500 }));
    await expect(
      x0.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws PROVIDER_ERROR when response is not a URL', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('not a url', { status: 200 }));
    await expect(
      x0.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('catbox provider', () => {
  it('POSTs a hand-encoded multipart body via postBuffer with reqtype, optional userhash, and fileToUpload', async () => {
    const cap = captureCatboxCall();
    const result = await catbox.upload(
      Buffer.from([7, 7]),
      { filename: 'b.png', mime: 'image/png' },
      { userhash: 'abc123' },
    );
    expect(cap.url).toBe('https://catbox.moe/user/api.php');
    expect(Buffer.isBuffer(cap.body)).toBe(true);
    expect(cap.headers!['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    const text = cap.body!.toString('binary');
    expect(text).toContain('name="reqtype"');
    expect(text).toContain('fileupload');
    expect(text).toContain('name="userhash"');
    expect(text).toContain('abc123');
    expect(text).toContain('name="fileToUpload"; filename="b.png"');
    expect(text).toContain('Content-Type: image/png');
    expect(result.url).toBe('https://files.catbox.moe/xyz.png');
  });

  it('omits userhash when not provided', async () => {
    const cap = captureCatboxCall();
    await catbox.upload(Buffer.from([1]), { filename: 'a.png', mime: 'image/png' }, {});
    const text = cap.body!.toString('binary');
    expect(text).not.toContain('name="userhash"');
  });

  it('throws PROVIDER_ERROR on non-URL response body (catbox returns 200 with error string)', async () => {
    vi.spyOn(multipart, 'postBuffer').mockResolvedValue({
      status: 200,
      headers: {},
      text: 'Files larger than 200MB are not allowed.',
    });
    await expect(
      catbox.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, {}),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('surfaces the underlying socket error code on transport failure', async () => {
    const sockErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    vi.spyOn(multipart, 'postBuffer').mockRejectedValue(sockErr);
    await expect(
      catbox.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, {}),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('ECONNRESET'),
    });
  });
});

describe('hoarder provider', () => {
  it('POSTs to {base}/api/upload with Authorization: Bearer and `file` field', async () => {
    const cap = captureFormData();
    captureResponse = new Response(
      JSON.stringify({ id: 'aB3kZ', url: 'https://cdn.test/aB3kZ.gif' }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    const result = await hoarder.upload(
      Buffer.from([0xff, 0xd8]),
      { filename: 'wave.gif', mime: 'image/gif' },
      { url: 'https://upload.example.com', api_key: 'sekret' },
    );
    expect(cap.url).toBe('https://upload.example.com/api/upload');
    expect(
      (cap.init as RequestInit & { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer sekret');
    expect(
      (cap.init as RequestInit & { headers: Record<string, string> }).headers['User-Agent'],
    ).toMatch(/^Lurker\//);
    expect(cap.formData!.get('file')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://cdn.test/aB3kZ.gif');
  });

  it('strips trailing slash from base URL', async () => {
    const cap = captureFormData();
    captureResponse = new Response(JSON.stringify({ url: 'https://cdn.test/x.png' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await hoarder.upload(
      Buffer.from([1]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://upload.example.com/', api_key: 'k' },
    );
    expect(cap.url).toBe('https://upload.example.com/api/upload');
  });

  it('rejects with PROVIDER_CONFIG when url is missing', async () => {
    await expect(
      hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, { api_key: 'k' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('rejects with PROVIDER_CONFIG when api_key is missing', async () => {
    await expect(
      hoarder.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('Invalid API key', { status: 401 }),
    );
    await expect(
      hoarder.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('rejects PROVIDER_ERROR when JSON has no url', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ id: 'x' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      hoarder.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('zipline provider', () => {
  it('POSTs to {base}/api/upload with raw authorization header and `file` field', async () => {
    const cap = captureFormData();
    captureResponse = new Response(
      JSON.stringify({
        files: [{ id: 'a1', name: 'x.png', type: 'image/png', url: 'https://zl.test/u/x.png' }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const result = await zipline.upload(
      Buffer.from([0x89, 0x50]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://zl.test', token: 'ziptok' },
    );
    expect(cap.url).toBe('https://zl.test/api/upload');
    const headers = (cap.init as RequestInit & { headers: Record<string, string> }).headers;
    // Raw token, NOT "Bearer …" — Zipline's middleware decrypts the header verbatim.
    expect(headers.authorization).toBe('ziptok');
    expect(headers['User-Agent']).toMatch(/^Lurker\//);
    expect(cap.formData!.get('file')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://zl.test/u/x.png');
  });

  it('accepts the v3 response shape (files as URL strings)', async () => {
    captureFormData();
    captureResponse = new Response(JSON.stringify({ files: ['https://zl.test/u/y.png'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await zipline.upload(
      Buffer.from([1]),
      { filename: 'y.png', mime: 'image/png' },
      { url: 'https://zl.test/', token: 't' },
    );
    expect(result.url).toBe('https://zl.test/u/y.png');
  });

  it('rejects with PROVIDER_CONFIG when url or token is missing', async () => {
    await expect(
      zipline.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, { token: 't' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    await expect(
      zipline.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH and missing url in body to PROVIDER_ERROR', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('unauthorized', { status: 401 }),
    );
    await expect(
      zipline.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', token: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ files: [] }), { status: 200 }),
    );
    await expect(
      zipline.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', token: 't' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('chibisafe provider', () => {
  it('POSTs to {base}/api/upload with x-api-key and `file[]` field', async () => {
    const cap = captureFormData();
    captureResponse = new Response(
      JSON.stringify({ name: 'x.png', uuid: 'u-u-i-d', url: 'https://cb.test/x1y2z.png' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
    const result = await chibisafe.upload(
      Buffer.from([0x47, 0x49]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://cb.test/', api_key: 'chibikey' },
    );
    expect(cap.url).toBe('https://cb.test/api/upload');
    const headers = (cap.init as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('chibikey');
    expect(headers['User-Agent']).toMatch(/^Lurker\//);
    // Chibisafe's uploader expects the lolisafe-lineage field name `file[]`.
    expect(cap.formData!.get('file[]')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://cb.test/x1y2z.png');
  });

  it('rejects with PROVIDER_CONFIG when url or api_key is missing', async () => {
    await expect(
      chibisafe.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { api_key: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    await expect(
      chibisafe.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH and missing url in body to PROVIDER_ERROR', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('no key', { status: 401 }));
    await expect(
      chibisafe.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    );
    await expect(
      chibisafe.upload(
        Buffer.from([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('s3 provider', () => {
  const SECRETS = {
    endpoint: 'http://minio.test:9000',
    bucket: 'lurker',
    access_key_id: 'AKIDEXAMPLE',
    secret_access_key: 'sekrit',
    public_base_url: 'https://cdn.test',
  };

  it('buildObjectKey sanitizes prefix/kind and keeps a safe extension', () => {
    const key = s3.buildObjectKey('photo.PNG', { prefix: 'lurker/../etc', kind: 'thumb' });
    // '..' segments are dropped entirely — a proxy serving the bucket could
    // normalize them.
    expect(key).toMatch(/^lurker\/etc\/thumb\/[A-Za-z0-9_-]{8}\.png$/);
    expect(s3.buildObjectKey('noext', {})).toMatch(/^[A-Za-z0-9_-]{8}\.bin$/);
    expect(s3.buildObjectKey('evil.<scr>', {})).toMatch(/\.bin$/);
  });

  it('signPutObject is deterministic for a pinned clock and shaped like SigV4', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const args = {
      endpoint: SECRETS.endpoint,
      bucket: SECRETS.bucket,
      key: 'abc123.png',
      payload: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
      region: 'auto',
      accessKeyId: SECRETS.access_key_id,
      secretAccessKey: SECRETS.secret_access_key,
    };
    const a = s3.signPutObject(args, now);
    const b = s3.signPutObject(args, now);
    expect(a).toEqual(b);
    expect(a.url).toBe('http://minio.test:9000/lurker/abc123.png');
    expect(a.headers['x-amz-date']).toBe('20260102T030405Z');
    expect(a.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // A different secret must change the signature.
    const c = s3.signPutObject({ ...args, secretAccessKey: 'other' }, now);
    expect(c.headers.authorization).not.toBe(a.headers.authorization);
  });

  it('PUTs path-style to the endpoint and returns the public URL for the same key', async () => {
    let putUrl = '';
    let putHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn<typeof fetch>(async (url, init) => {
      putUrl = String(url);
      putHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response('', { status: 200 });
    });
    const result = await s3.upload(
      Buffer.from([0x89, 0x50]),
      { filename: 'x.png', mime: 'image/png' },
      SECRETS,
    );
    expect(putUrl).toMatch(/^http:\/\/minio\.test:9000\/lurker\/[A-Za-z0-9_-]{8}\.png$/);
    const key = putUrl.slice('http://minio.test:9000/lurker/'.length);
    expect(result.url).toBe(`https://cdn.test/${key}`);
    expect(putHeaders['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(putHeaders['content-type']).toBe('image/png');
    expect(putHeaders.authorization).toContain('AWS4-HMAC-SHA256');
  });

  it('rejects with PROVIDER_CONFIG when any required setting is missing', async () => {
    for (const missing of [
      'endpoint',
      'bucket',
      'access_key_id',
      'secret_access_key',
      'public_base_url',
    ] as const) {
      const partial = { ...SECRETS, [missing]: '' };
      await expect(
        s3.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, partial),
      ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    }
  });

  it('maps 403 to PROVIDER_AUTH and other failures to PROVIDER_ERROR', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('SignatureDoesNotMatch', { status: 403 }),
    );
    await expect(
      s3.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, SECRETS),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('oops', { status: 500 }));
    await expect(
      s3.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, SECRETS),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
