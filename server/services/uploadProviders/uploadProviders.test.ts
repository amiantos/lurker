// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as x0 from './x0.js';
import * as catbox from './catbox.js';
import * as hoarder from './hoarder.js';
import * as multipart from './multipart.js';
import type { PostBufferResult } from './multipart.js';

// Helper that grabs the FormData passed to fetch() so we can assert the
// multipart shape without reaching into providers' internals.
function captureFormData(): { url: string | null; init: RequestInit | null; formData: FormData | null } {
  const captured: { url: string | null; init: RequestInit | null; formData: FormData | null } = { url: null, init: null, formData: null };
  globalThis.fetch = vi.fn<typeof fetch>(async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    captured.init = init ?? null;
    captured.formData = (init?.body as FormData | null) ?? null;
    return captureResponse;
  });
  return captured;
}

// Catbox uses postBuffer (https.request under the hood) instead of fetch.
// We spy on postBuffer directly to capture the body Buffer and headers.
function captureCatboxCall(): { url: string | null; body: Buffer | null; headers: Record<string, string> | null } {
  const captured: { url: string | null; body: Buffer | null; headers: Record<string, string> | null } = { url: null, body: null, headers: null };
  vi.spyOn(multipart, 'postBuffer').mockImplementation(async (url: string, body: Buffer, opts?: { headers?: Record<string, string> }) => {
    captured.url = url;
    captured.body = body;
    captured.headers = opts?.headers ?? {};
    return catboxResponse;
  });
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
    const result = await x0.upload(Buffer.from([1, 2, 3]), { filename: 'a.png', mime: 'image/png' });
    expect(cap.url).toBe('https://x0.at/');
    expect((cap.init as RequestInit & { method: string }).method).toBe('POST');
    expect((cap.init as RequestInit & { headers: Record<string, string> }).headers['User-Agent']).toMatch(/^Lurker\//);
    expect(cap.formData!.get('file')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://example.test/abc.png');
  });

  it('throws PROVIDER_ERROR on non-2xx response', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('rejected', { status: 500 }));
    await expect(x0.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws PROVIDER_ERROR when response is not a URL', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('not a url', { status: 200 }));
    await expect(x0.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
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
      status: 200, headers: {}, text: 'Files larger than 200MB are not allowed.',
    });
    await expect(catbox.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, {}))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('surfaces the underlying socket error code on transport failure', async () => {
    const sockErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    vi.spyOn(multipart, 'postBuffer').mockRejectedValue(sockErr);
    await expect(catbox.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, {}))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('ECONNRESET') });
  });
});

describe('hoarder provider', () => {
  it('POSTs to {base}/api/upload with Authorization: Bearer and `file` field', async () => {
    const cap = captureFormData();
    captureResponse = new Response(JSON.stringify({ id: 'aB3kZ', url: 'https://cdn.test/aB3kZ.gif' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const result = await hoarder.upload(
      Buffer.from([0xff, 0xd8]),
      { filename: 'wave.gif', mime: 'image/gif' },
      { url: 'https://upload.example.com', api_key: 'sekret' },
    );
    expect(cap.url).toBe('https://upload.example.com/api/upload');
    expect((cap.init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sekret');
    expect((cap.init as RequestInit & { headers: Record<string, string> }).headers['User-Agent']).toMatch(/^Lurker\//);
    expect(cap.formData!.get('file')).toBeInstanceOf(Blob);
    expect(result.url).toBe('https://cdn.test/aB3kZ.gif');
  });

  it('strips trailing slash from base URL', async () => {
    const cap = captureFormData();
    captureResponse = new Response(JSON.stringify({ url: 'https://cdn.test/x.png' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' },
      { url: 'https://upload.example.com/', api_key: 'k' });
    expect(cap.url).toBe('https://upload.example.com/api/upload');
  });

  it('rejects with PROVIDER_CONFIG when url is missing', async () => {
    await expect(hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, { api_key: 'k' }))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('rejects with PROVIDER_CONFIG when api_key is missing', async () => {
    await expect(hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' }, { url: 'https://u' }))
      .rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('Invalid API key', { status: 401 }));
    await expect(hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' },
      { url: 'https://u', api_key: 'bad' }))
      .rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('rejects PROVIDER_ERROR when JSON has no url', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'x' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(hoarder.upload(Buffer.from([1]), { filename: 'x.png', mime: 'image/png' },
      { url: 'https://u', api_key: 'k' }))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
