// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as x0 from './x0.js';
import * as catbox from './catbox.js';
import * as dropper from './dropper.js';
import * as zipline from './zipline.js';
import * as chibisafe from './chibisafe.js';
import * as s3 from './s3.js';
import * as multipart from './multipart.js';
import type { PostBufferResult } from './multipart.js';
import { bufferSource } from './source.js';
import { createHash } from 'node:crypto';

// UPLOADS now go through multipart.postMultipart (node:http + pipeline), never
// fetch — undici buffers request bodies, which is the whole point of #543. So the
// upload path is captured by spying on that one helper, and what we assert is the
// multipart PARTS (field name, filename, content type, source) rather than a
// FormData object. The DELETE paths still use fetch (tiny bodies), so the fetch
// capture below stays for them.
interface CapturedPost {
  url: string | null;
  parts: multipart.StreamPart[] | null;
  headers: Record<string, string> | null;
}
function capturePost(): CapturedPost {
  const captured: CapturedPost = { url: null, parts: null, headers: null };
  vi.spyOn(multipart, 'postMultipart').mockImplementation(
    async (url: string, parts: multipart.StreamPart[], opts?: multipart.RequestOptions) => {
      captured.url = url;
      captured.parts = parts;
      captured.headers = opts?.headers ?? {};
      return postResponse;
    },
  );
  return captured;
}

/** The file part of a captured multipart post, for shape assertions. */
function filePart(cap: CapturedPost, name: string): multipart.StreamPart & { source: unknown } {
  const part = cap.parts?.find((p) => p.name === name);
  if (!part || !('source' in part)) throw new Error(`no file part named ${name}`);
  return part as multipart.StreamPart & { source: unknown };
}

// Captures a fetch() call — used by the DELETE tests (and catbox's HEAD probe),
// which legitimately still use fetch.
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

// Catbox's DELETE still uses postBuffer (a small hand-encoded body).
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

/** Stub the streamed PUT the s3 driver uses. */
function capturePut(): { url: string | null; headers: Record<string, string> | null } {
  const captured: { url: string | null; headers: Record<string, string> | null } = {
    url: null,
    headers: null,
  };
  vi.spyOn(multipart, 'putSource').mockImplementation(
    async (url: string, _source: unknown, opts?: multipart.RequestOptions) => {
      captured.url = url;
      captured.headers = opts?.headers ?? {};
      return postResponse;
    },
  );
  return captured;
}

let captureResponse: Response;
let catboxResponse: PostBufferResult;
let postResponse: PostBufferResult;

/** Every driver takes an UploadSource now; the tests' bytes are small, so a
 *  buffer source is the natural stand-in. The streaming (file-source) path gets
 *  its own real-HTTP coverage in multipart.test.ts. */
function src(bytes: number[]): ReturnType<typeof bufferSource> {
  return bufferSource(Buffer.from(bytes));
}

beforeEach(() => {
  captureResponse = new Response('https://example.test/abc.png', { status: 200 });
  catboxResponse = { status: 200, headers: {}, text: 'https://files.catbox.moe/xyz.png' };
  postResponse = { status: 200, headers: {}, text: 'https://example.test/abc.png' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('x0 provider', () => {
  it('POSTs multipart `file` and returns the URL from the response body', async () => {
    const cap = capturePost();
    const result = await x0.upload(src([1, 2, 3]), {
      filename: 'a.png',
      mime: 'image/png',
    });
    expect(cap.url).toBe('https://x0.at/');
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    const file = filePart(cap, 'file');
    expect(file.filename).toBe('a.png');
    expect(file.contentType).toBe('image/png');
    expect(result.url).toBe('https://example.test/abc.png');
  });

  it('throws PROVIDER_ERROR on non-2xx response', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 500,
      headers: {},
      text: 'rejected',
    });
    await expect(
      x0.upload(src([1]), { filename: 'x.png', mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws PROVIDER_ERROR when response is not a URL', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 200,
      headers: {},
      text: 'not a url',
    });
    await expect(
      x0.upload(src([1]), { filename: 'x.png', mime: 'image/png' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('catbox provider', () => {
  it('POSTs a streamed multipart body with reqtype, optional userhash, and fileToUpload', async () => {
    const cap = capturePost();
    postResponse = { status: 200, headers: {}, text: 'https://files.catbox.moe/xyz.png' };
    const result = await catbox.upload(
      src([7, 7]),
      { filename: 'b.png', mime: 'image/png' },
      { userhash: 'abc123' },
    );
    expect(cap.url).toBe('https://catbox.moe/user/api.php');
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    // Text fields carry values; the file part carries a source postMultipart
    // streams. Content-Length is still exact (catbox stalls on chunked encoding),
    // which multipart.test.ts asserts against a real socket.
    expect(cap.parts).toEqual([
      { name: 'reqtype', value: 'fileupload' },
      { name: 'userhash', value: 'abc123' },
      expect.objectContaining({
        name: 'fileToUpload',
        filename: 'b.png',
        contentType: 'image/png',
      }),
    ]);
    expect(result.url).toBe('https://files.catbox.moe/xyz.png');
  });

  it('omits userhash when not provided', async () => {
    const cap = capturePost();
    postResponse = { status: 200, headers: {}, text: 'https://files.catbox.moe/xyz.png' };
    await catbox.upload(src([1]), { filename: 'a.png', mime: 'image/png' }, {});
    expect(cap.parts!.some((p) => p.name === 'userhash')).toBe(false);
  });

  it('throws PROVIDER_ERROR on non-URL response body (catbox returns 200 with error string)', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 200,
      headers: {},
      text: 'Files larger than 200MB are not allowed.',
    });
    await expect(
      catbox.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, {}),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('surfaces the underlying socket error code on transport failure', async () => {
    const sockErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    vi.spyOn(multipart, 'postMultipart').mockRejectedValue(sockErr);
    await expect(
      catbox.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, {}),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('ECONNRESET'),
    });
  });

  // Deletability is decided at capture time: only a userhash upload can ever be
  // deleted on catbox's side, so only it carries a ref.
  it('returns the served filename as ref for userhash uploads, no ref when anonymous', async () => {
    capturePost();
    postResponse = { status: 200, headers: {}, text: 'https://files.catbox.moe/xyz.png' };
    const withHash = await catbox.upload(
      src([1]),
      { filename: 'a.png', mime: 'image/png' },
      { userhash: 'abc123' },
    );
    expect(withHash.ref).toBe('xyz.png');
    const anonymous = await catbox.upload(src([1]), { filename: 'a.png', mime: 'image/png' }, {});
    expect(anonymous.ref).toBeUndefined();
  });

  it('delete POSTs reqtype=deletefiles with the userhash and filename', async () => {
    const cap = captureCatboxCall();
    catboxResponse = { status: 200, headers: {}, text: 'Files successfully deleted.' };
    await catbox.delete('xyz.png', { userhash: 'abc123' });
    expect(cap.url).toBe('https://catbox.moe/user/api.php');
    const text = cap.body!.toString('binary');
    expect(text).toContain('name="reqtype"');
    expect(text).toContain('deletefiles');
    expect(text).toContain('name="userhash"');
    expect(text).toContain('abc123');
    expect(text).toContain('name="files"');
    expect(text).toContain('xyz.png');
  });

  it('delete resolves a non-success reply only when the public URL proves the file is gone', async () => {
    // Catbox says "doesn't exist" both for a genuinely-deleted file and for one
    // the current userhash doesn't own. The driver probes the public URL to
    // disambiguate: 404 → really gone (success)…
    vi.spyOn(multipart, 'postBuffer').mockResolvedValue({
      status: 200,
      headers: {},
      text: "File doesn't exist?",
    });
    // ⚠ A one-byte GET, never a HEAD: files.catbox.moe answers a HEAD for a
    // missing file with 200 and an empty body (#1289), so a HEAD could never
    // prove the file gone.
    globalThis.fetch = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://files.catbox.moe/gone.png');
      expect(init?.method).toBe('GET');
      expect((init!.headers as Record<string, string>).Range).toBe('bytes=0-0');
      return new Response('not found', { status: 404 });
    });
    await expect(catbox.delete('gone.png', { userhash: 'h' })).resolves.toBeUndefined();

    // …but a file that's still being served must NOT count as deleted — that's
    // the userhash-mismatch case, and dropping the record would strand the file.
    // The served byte is cancelled, not read.
    let cancelled = false;
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 206 });
    });
    await expect(catbox.delete('gone.png', { userhash: 'h' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(cancelled).toBe(true);

    // An unrecognized error reply with a live file also fails.
    vi.spyOn(multipart, 'postBuffer').mockResolvedValue({
      status: 200,
      headers: {},
      text: 'Invalid userhash.',
    });
    await expect(catbox.delete('xyz.png', { userhash: 'bad' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('delete rejects with PROVIDER_CONFIG when the config has no userhash', async () => {
    await expect(catbox.delete('xyz.png', {})).rejects.toMatchObject({
      code: 'PROVIDER_CONFIG',
    });
  });

  it('canDeleteWith tracks the presence of a userhash', () => {
    expect(catbox.canDeleteWith({ userhash: 'abc' })).toBe(true);
    expect(catbox.canDeleteWith({})).toBe(false);
  });
});

describe('dropper provider', () => {
  it('POSTs to {base}/api/upload with Authorization: Bearer and `file` field', async () => {
    const cap = capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ id: 'aB3kZ', url: 'https://cdn.test/aB3kZ.gif' }),
    };
    const result = await dropper.upload(
      src([0xff, 0xd8]),
      { filename: 'wave.gif', mime: 'image/gif' },
      { url: 'https://upload.example.com', api_key: 'sekret' },
    );
    expect(cap.url).toBe('https://upload.example.com/api/upload');
    expect(cap.headers!.Authorization).toBe('Bearer sekret');
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    expect(filePart(cap, 'file').filename).toBe('wave.gif');
    expect(result.url).toBe('https://cdn.test/aB3kZ.gif');
  });

  // ⚠⚠ The claim posted to dropper must stay the BARE mime, never the stored-header
  // form the s3 driver sends (#788). Dropper matches a claim against an exact
  // allowlist of bare types, so a `text/plain; charset=utf-8` claim 415s EVERY text
  // upload on the hosted service — dropper pins the charset on its own PutObject.
  // The bare mime is the identity; the parameter belongs only on a header we write.
  it('posts the bare mime as its claim, with no charset parameter', async () => {
    for (const mime of ['text/plain', 'text/markdown', 'application/json']) {
      const cap = capturePost();
      postResponse = {
        status: 200,
        headers: {},
        text: JSON.stringify({ url: 'https://cdn.test/x.txt' }),
      };
      await dropper.upload(
        src([0x68, 0x69]),
        { filename: 'note.txt', mime },
        { url: 'https://upload.example.com', api_key: 'k' },
      );
      expect(filePart(cap, 'file').contentType).toBe(mime);
    }
  });

  it('strips trailing slash from base URL', async () => {
    const cap = capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ url: 'https://cdn.test/x.png' }),
    };
    await dropper.upload(
      src([1]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://upload.example.com/', api_key: 'k' },
    );
    expect(cap.url).toBe('https://upload.example.com/api/upload');
  });

  it('rejects with PROVIDER_CONFIG when url is missing', async () => {
    await expect(
      dropper.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { api_key: 'k' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('rejects with PROVIDER_CONFIG when api_key is missing', async () => {
    await expect(
      dropper.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { url: 'https://u' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 401,
      headers: {},
      text: 'Invalid API key',
    });
    await expect(
      dropper.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('rejects PROVIDER_ERROR when JSON has no url', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 200,
      headers: {},
      text: JSON.stringify({ id: 'x' }),
    });
    await expect(
      dropper.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});

describe('zipline provider', () => {
  it('POSTs to {base}/api/upload with raw authorization header and `file` field', async () => {
    const cap = capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({
        files: [{ id: 'a1', name: 'x.png', type: 'image/png', url: 'https://zl.test/u/x.png' }],
      }),
    };
    const result = await zipline.upload(
      src([0x89, 0x50]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://zl.test', token: 'ziptok' },
    );
    expect(cap.url).toBe('https://zl.test/api/upload');
    // Raw token, NOT "Bearer …" — Zipline's middleware decrypts the header verbatim.
    expect(cap.headers!.authorization).toBe('ziptok');
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    expect(filePart(cap, 'file').filename).toBe('x.png');
    // The upstream /u/ view path is rewritten to /raw/ on the way out (#589).
    expect(result.url).toBe('https://zl.test/raw/x.png');
  });

  it('accepts the v3 response shape (files as URL strings)', async () => {
    capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ files: ['https://zl.test/u/y.png'] }),
    };
    const result = await zipline.upload(
      src([1]),
      { filename: 'y.png', mime: 'image/png' },
      { url: 'https://zl.test/', token: 't' },
    );
    expect(result.url).toBe('https://zl.test/raw/y.png');
  });

  it('rejects with PROVIDER_CONFIG when url or token is missing', async () => {
    await expect(
      zipline.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { token: 't' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    await expect(
      zipline.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { url: 'https://u' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH and missing url in body to PROVIDER_ERROR', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 401,
      headers: {},
      text: 'unauthorized',
    });
    await expect(
      zipline.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', token: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 200,
      headers: {},
      text: JSON.stringify({ files: [] }),
    });
    await expect(
      zipline.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', token: 't' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('captures the v4 file id as ref; v3 string responses carry no ref', async () => {
    capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ files: [{ id: 'clxyz123', url: 'https://zl.test/u/x.png' }] }),
    };
    const v4 = await zipline.upload(
      src([1]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://zl.test', token: 't' },
    );
    expect(v4.ref).toBe('clxyz123');

    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ files: ['https://zl.test/u/y.png'] }),
    };
    const v3 = await zipline.upload(
      src([1]),
      { filename: 'y.png', mime: 'image/png' },
      { url: 'https://zl.test', token: 't' },
    );
    expect(v3.ref).toBeUndefined();
  });

  // #589: /u/ serves an HTML viewer page wrapping the file. Lurker's media
  // viewer classifies by extension, so a /u/*.txt link fetched into the text
  // pane renders Zipline's HTML at the reader; /raw/ serves the bytes.
  it('rewrites the /u/ view path to /raw/ on both response shapes', async () => {
    capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ files: [{ id: 'clxyz123', url: 'https://zl.test/u/notes.txt' }] }),
    };
    const v4 = await zipline.upload(
      src([1]),
      { filename: 'notes.txt', mime: 'text/plain' },
      { url: 'https://zl.test', token: 't' },
    );
    expect(v4.url).toBe('https://zl.test/raw/notes.txt');

    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ files: ['https://zl.test/u/pic.png'] }),
    };
    const v3 = await zipline.upload(
      src([1]),
      { filename: 'pic.png', mime: 'image/png' },
      { url: 'https://zl.test', token: 't' },
    );
    expect(v3.url).toBe('https://zl.test/raw/pic.png');
  });

  it('only rewrites the leading path segment, and leaves other shapes alone', async () => {
    // A substring replace would corrupt each of these.
    expect(zipline.toRawUrl('https://zl.test/u/u/x.txt')).toBe('https://zl.test/raw/u/x.txt');
    expect(zipline.toRawUrl('https://u.test/u/x.txt')).toBe('https://u.test/raw/x.txt');
    expect(zipline.toRawUrl('https://zl.test/files/u/x.txt')).toBe('https://zl.test/files/u/x.txt');
    // Already raw, an unrecognized route, and an unparseable value all pass through.
    expect(zipline.toRawUrl('https://zl.test/raw/x.txt')).toBe('https://zl.test/raw/x.txt');
    expect(zipline.toRawUrl('https://zl.test/view/x.txt')).toBe('https://zl.test/view/x.txt');
    expect(zipline.toRawUrl('not a url')).toBe('not a url');
  });

  it('delete DELETEs /api/user/files/{ref} with the raw token; 404 = already gone', async () => {
    const cap = captureFormData();
    captureResponse = new Response(JSON.stringify({ id: 'clxyz123' }), { status: 200 });
    await zipline.delete('clxyz123', { url: 'https://zl.test/', token: 'ziptok' });
    expect(cap.url).toBe('https://zl.test/api/user/files/clxyz123');
    const init = cap.init as RequestInit & { method: string; headers: Record<string, string> };
    expect(init.method).toBe('DELETE');
    expect(init.headers.authorization).toBe('ziptok');

    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('gone', { status: 404 }));
    await expect(
      zipline.delete('clxyz123', { url: 'https://zl.test', token: 't' }),
    ).resolves.toBeUndefined();
  });

  it('delete maps 401 to PROVIDER_AUTH and missing config to PROVIDER_CONFIG', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('nope', { status: 401 }));
    await expect(
      zipline.delete('clxyz123', { url: 'https://zl.test', token: 'bad' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    await expect(zipline.delete('clxyz123', { url: 'https://zl.test' })).rejects.toMatchObject({
      code: 'PROVIDER_CONFIG',
    });
  });
});

describe('chibisafe provider', () => {
  it('POSTs to {base}/api/upload with x-api-key and `file[]` field', async () => {
    const cap = capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ name: 'x.png', uuid: 'u-u-i-d', url: 'https://cb.test/x1y2z.png' }),
    };
    const result = await chibisafe.upload(
      src([0x47, 0x49]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://cb.test/', api_key: 'chibikey' },
    );
    expect(cap.url).toBe('https://cb.test/api/upload');
    expect(cap.headers!['x-api-key']).toBe('chibikey');
    expect(cap.headers!['User-Agent']).toMatch(/^Lurker\//);
    // Chibisafe's uploader expects the lolisafe-lineage field name `file[]`.
    expect(filePart(cap, 'file[]').filename).toBe('x.png');
    expect(result.url).toBe('https://cb.test/x1y2z.png');
  });

  it('rejects with PROVIDER_CONFIG when url or api_key is missing', async () => {
    await expect(
      chibisafe.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { api_key: 'k' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    await expect(
      chibisafe.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, { url: 'https://u' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
  });

  it('maps 401 to PROVIDER_AUTH and missing url in body to PROVIDER_ERROR', async () => {
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 401,
      headers: {},
      text: 'no key',
    });
    await expect(
      chibisafe.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({
      status: 200,
      headers: {},
      text: JSON.stringify({ name: 'x' }),
    });
    await expect(
      chibisafe.upload(
        src([1]),
        { filename: 'x.png', mime: 'image/png' },
        { url: 'https://u', api_key: 'k' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('captures the response uuid as ref; a uuid-less response carries no ref', async () => {
    capturePost();
    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ name: 'x.png', uuid: 'u-u-i-d', url: 'https://cb.test/x.png' }),
    };
    const withUuid = await chibisafe.upload(
      src([1]),
      { filename: 'x.png', mime: 'image/png' },
      { url: 'https://cb.test', api_key: 'k' },
    );
    expect(withUuid.ref).toBe('u-u-i-d');

    postResponse = {
      status: 200,
      headers: {},
      text: JSON.stringify({ url: 'https://cb.test/y.png' }),
    };
    const without = await chibisafe.upload(
      src([1]),
      { filename: 'y.png', mime: 'image/png' },
      { url: 'https://cb.test', api_key: 'k' },
    );
    expect(without.ref).toBeUndefined();
  });

  it('delete DELETEs /api/file/{uuid} with x-api-key; 404 = already gone', async () => {
    const cap = captureFormData();
    captureResponse = new Response('{}', { status: 200 });
    await chibisafe.delete('u-u-i-d', { url: 'https://cb.test/', api_key: 'chibikey' });
    expect(cap.url).toBe('https://cb.test/api/file/u-u-i-d');
    const init = cap.init as RequestInit & { method: string; headers: Record<string, string> };
    expect(init.method).toBe('DELETE');
    expect(init.headers['x-api-key']).toBe('chibikey');

    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('gone', { status: 404 }));
    await expect(
      chibisafe.delete('u-u-i-d', { url: 'https://cb.test', api_key: 'k' }),
    ).resolves.toBeUndefined();
  });

  it('delete maps 401 to PROVIDER_AUTH and missing config to PROVIDER_CONFIG', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('nope', { status: 401 }));
    await expect(
      chibisafe.delete('u-u-i-d', { url: 'https://cb.test', api_key: 'bad' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    await expect(chibisafe.delete('u-u-i-d', { url: 'https://cb.test' })).rejects.toMatchObject({
      code: 'PROVIDER_CONFIG',
    });
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

  it('signObjectRequest is deterministic for a pinned clock and shaped like SigV4', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const args = {
      method: 'PUT' as const,
      endpoint: SECRETS.endpoint,
      bucket: SECRETS.bucket,
      key: 'abc123.png',
      payload: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
      region: 'auto',
      accessKeyId: SECRETS.access_key_id,
      secretAccessKey: SECRETS.secret_access_key,
    };
    const a = s3.signObjectRequest(args, now);
    const b = s3.signObjectRequest(args, now);
    expect(a).toEqual(b);
    expect(a.url).toBe('http://minio.test:9000/lurker/abc123.png');
    expect(a.headers['x-amz-date']).toBe('20260102T030405Z');
    expect(a.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // A different secret must change the signature.
    const c = s3.signObjectRequest({ ...args, secretAccessKey: 'other' }, now);
    expect(c.headers.authorization).not.toBe(a.headers.authorization);
  });

  it('PUTs path-style to the endpoint and returns the public URL for the same key', async () => {
    const cap = capturePut();
    postResponse = { status: 200, headers: {}, text: '' };
    const result = await s3.upload(
      src([0x89, 0x50]),
      { filename: 'x.png', mime: 'image/png' },
      SECRETS,
    );
    expect(cap.url).toMatch(/^http:\/\/minio\.test:9000\/lurker\/[A-Za-z0-9_-]{8}\.png$/);
    const key = cap.url!.slice('http://minio.test:9000/lurker/'.length);
    expect(result.url).toBe(`https://cdn.test/${key}`);
    // The payload hash is streamed from the source (source.hashOf), not computed
    // from a Buffer the driver holds — but it must still be the real sha256.
    expect(cap.headers!['x-amz-content-sha256']).toBe(
      createHash('sha256')
        .update(Buffer.from([0x89, 0x50]))
        .digest('hex'),
    );
    expect(cap.headers!['content-type']).toBe('image/png');
    expect(cap.headers!.authorization).toContain('AWS4-HMAC-SHA256');
  });

  // #788, the self-host half. The bucket replays this header verbatim to every viewer
  // and nothing of ours is in front of it to add the charset later — so a bare
  // `text/plain` is what a browser decodes as Latin-1, turning a UTF-8 paste into
  // mojibake. routes/localUploads.ts has always sent the parameter when serving from
  // disk; a bucket-backed self-host was the path that didn't.
  it('states the charset on the stored content-type for text', async () => {
    const cases: [string, string, string][] = [
      ['n.txt', 'text/plain', 'text/plain; charset=utf-8'],
      ['r.md', 'text/markdown', 'text/markdown; charset=utf-8'],
      // RFC 8259 defines no charset parameter for application/json.
      ['d.json', 'application/json', 'application/json'],
      // Untouched for everything else.
      ['x.png', 'image/png', 'image/png'],
    ];
    for (const [filename, mime, stored] of cases) {
      const cap = capturePut();
      postResponse = { status: 200, headers: {}, text: '' };
      await s3.upload(src([0x68, 0x69]), { filename, mime }, SECRETS);
      expect({ mime, sent: cap.headers!['content-type'] }).toEqual({ mime, sent: stored });
      // ⚠ And it must be the SIGNED value: content-type is in SignedHeaders, so a
      // header the signature didn't cover is a 403 from the store, not a wrong label.
      expect(cap.headers!.authorization).toContain('content-type');
    }
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
        s3.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, partial),
      ).rejects.toMatchObject({ code: 'PROVIDER_CONFIG' });
    }
  });

  it('maps 403 to PROVIDER_AUTH and other failures to PROVIDER_ERROR', async () => {
    vi.spyOn(multipart, 'putSource').mockResolvedValue({
      status: 403,
      headers: {},
      text: 'SignatureDoesNotMatch',
    });
    await expect(
      s3.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, SECRETS),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });

    vi.spyOn(multipart, 'putSource').mockResolvedValue({ status: 500, headers: {}, text: 'oops' });
    await expect(
      s3.upload(src([1]), { filename: 'x.png', mime: 'image/png' }, SECRETS),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('signObjectRequest DELETE signs an empty payload without content headers', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const signed = s3.signObjectRequest(
      {
        method: 'DELETE',
        endpoint: SECRETS.endpoint,
        bucket: SECRETS.bucket,
        key: 'abc123.png',
        region: 'auto',
        accessKeyId: SECRETS.access_key_id,
        secretAccessKey: SECRETS.secret_access_key,
      },
      now,
    );
    expect(signed.url).toBe('http://minio.test:9000/lurker/abc123.png');
    // Empty payload hash (sha256 of zero bytes), no content-type/cache-control.
    expect(signed.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(signed.headers['content-type']).toBeUndefined();
    expect(signed.headers.authorization).toMatch(
      /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('delete sends a signed DELETE for the ref; 204 succeeds (S3 delete is idempotent)', async () => {
    let delUrl = '';
    let delMethod = '';
    globalThis.fetch = vi.fn<typeof fetch>(async (url, init) => {
      delUrl = String(url);
      delMethod = init?.method ?? '';
      return new Response(null, { status: 204 });
    });
    await s3.delete('abc123.png', SECRETS);
    expect(delMethod).toBe('DELETE');
    expect(delUrl).toBe('http://minio.test:9000/lurker/abc123.png');
  });

  it('delete rejects on 404 — a real DeleteObject never 404s, so the target was wrong', async () => {
    // S3 answers 204 even for a missing key; a 404 means the config points
    // somewhere that isn't the object's home (repointed endpoint/bucket) and
    // must NOT count as "already gone".
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response('NoSuchKey', { status: 404 }));
    await expect(s3.delete('abc123.png', SECRETS)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('delete maps 403 to PROVIDER_AUTH and missing config to PROVIDER_CONFIG', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('SignatureDoesNotMatch', { status: 403 }),
    );
    await expect(s3.delete('abc123.png', SECRETS)).rejects.toMatchObject({
      code: 'PROVIDER_AUTH',
    });
    await expect(s3.delete('abc123.png', { ...SECRETS, bucket: '' })).rejects.toMatchObject({
      code: 'PROVIDER_CONFIG',
    });
  });
});

// #1038: a provider's error body reaches the user in the upload or delete error, so
// the 200-unit cap on it must not leave half of an emoji behind.
describe('provider error bodies are capped without splitting an emoji', () => {
  const body = 'x'.repeat(199) + '😀';
  const meta = { filename: 'x.png', mime: 'image/png' };
  const S3 = {
    endpoint: 'http://minio.test:9000',
    bucket: 'lurker',
    access_key_id: 'AKIDEXAMPLE',
    secret_access_key: 'sekrit',
    public_base_url: 'https://cdn.test',
  };
  const post = (status: number) =>
    vi.spyOn(multipart, 'postMultipart').mockResolvedValue({ status, headers: {}, text: body });
  const fetchFails = () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response(body, { status: 500 }));
  };

  it.each<[string, () => Promise<unknown>]>([
    ['x0 upload', () => (post(500), x0.upload(src([1]), meta))],
    ['x0 non-URL reply', () => (post(200), x0.upload(src([1]), meta))],
    ['catbox upload', () => (post(500), catbox.upload(src([1]), meta, {}))],
    ['catbox non-URL reply', () => (post(200), catbox.upload(src([1]), meta, {}))],
    [
      'catbox delete',
      () => {
        vi.spyOn(multipart, 'postBuffer').mockResolvedValue({
          status: 200,
          headers: {},
          text: body,
        });
        // The file is still served, so the delete really failed.
        globalThis.fetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        return catbox.delete('xyz.png', { userhash: 'h' });
      },
    ],
    [
      'dropper upload',
      () => (post(500), dropper.upload(src([1]), meta, { url: 'https://u', api_key: 'k' })),
    ],
    [
      'zipline upload',
      () => (post(500), zipline.upload(src([1]), meta, { url: 'https://u', token: 't' })),
    ],
    [
      'zipline delete',
      () => (fetchFails(), zipline.delete('clxyz123', { url: 'https://zl.test', token: 't' })),
    ],
    [
      'chibisafe upload',
      () => (post(500), chibisafe.upload(src([1]), meta, { url: 'https://u', api_key: 'k' })),
    ],
    [
      'chibisafe delete',
      () => (fetchFails(), chibisafe.delete('u-u-i-d', { url: 'https://cb.test', api_key: 'k' })),
    ],
    [
      's3 upload',
      () => {
        vi.spyOn(multipart, 'putSource').mockResolvedValue({
          status: 500,
          headers: {},
          text: body,
        });
        return s3.upload(src([1]), meta, S3);
      },
    ],
    ['s3 delete', () => (fetchFails(), s3.delete('abc123.png', S3))],
  ])('%s', async (_name, run) => {
    const err = (await run().then(
      () => null,
      (e: Error) => e,
    )) as Error;
    expect(err.message).toContain('x'.repeat(199));
    expect(err.message).not.toMatch(/\p{Cs}/u);
  });
});
