// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from 'crypto';
import https from 'https';
import http from 'http';
import type { IncomingHttpHeaders } from 'http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sizeOf, streamOf, type UploadSource } from './source.js';

// Multipart/form-data encoding + posting, on node's http/https rather than fetch.
//
// TWO reasons this doesn't use fetch, and both are load-bearing:
//
//   1. Chunked encoding. WHATWG FormData + native fetch sends the body with
//      chunked transfer-encoding, which catbox's PHP backend silently stalls on.
//      We always send an exact Content-Length instead.
//   2. Memory. undici (fetch's engine) does NOT propagate backpressure into a
//      request body — it drains the whole thing into memory first, whatever shape
//      you hand it. Measured on node 22 with a 300 MB upload: fetch holds 300 MB
//      live no matter what; node:http + pipeline holds 7 MB. See source.ts for the
//      full table. This is why `postMultipart` streams and why fetch must never
//      come back to an upload path.

const CRLF = '\r\n';

/** A text field or a file field in a multipart form. A file field's bytes come
 *  from an UploadSource, so the caller never has to know whether they live in a
 *  buffer or in a temp file on disk — this module streams either one. */
export type MultipartPart =
  | { name: string; value: string; filename?: undefined; contentType?: undefined }
  | { name: string; filename: string; contentType?: string; value: Buffer | string };

export type StreamPart =
  | { name: string; value: string; filename?: undefined; contentType?: undefined }
  | { name: string; filename: string; contentType?: string; source: UploadSource };

export interface MultipartResult {
  body: Buffer;
  contentType: string;
}

export interface PostBufferResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** fetch's `resp.ok`, for the node:http results these helpers return. */
export function isOk(resp: PostBufferResult): boolean {
  return resp.status >= 200 && resp.status < 300;
}

/** fetch's `resp.json().catch(() => null)`. Providers occasionally answer a
 *  success status with a non-JSON body; callers already treat that as an error. */
export function jsonBody(resp: PostBufferResult): unknown {
  try {
    return JSON.parse(resp.text);
  } catch {
    return null;
  }
}

// RFC 7578: backslashes and quotes in filenames need escaping.
function encodeFilename(name: string): string {
  return name.replace(/["\\]/g, (c) => `\\${c}`);
}

function partHeader(boundary: string, part: MultipartPart | StreamPart): Buffer {
  if (part.filename !== undefined) {
    return Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${part.name}"; filename="${encodeFilename(part.filename)}"${CRLF}` +
        `Content-Type: ${part.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
    );
  }
  return Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${part.name}"${CRLF}${CRLF}` +
      String((part as { value: string }).value),
  );
}

/** Serialize a whole multipart body into one Buffer. Still used for small bodies
 *  (catbox's delete), where streaming would be pure ceremony. Never use it for an
 *  upload — that's what postMultipart is for. */
export function buildMultipart(parts: MultipartPart[]): MultipartResult {
  const boundary = `----LurkerBoundary${randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(partHeader(boundary, part));
    if (part.filename !== undefined) {
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    }
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// The one place we actually talk HTTP. `makeBody` is called once, lazily, and its
// chunks are piped into the request — so a file part is read off disk at the rate
// the socket drains it, and nothing accumulates. contentLength MUST be exact; it's
// computed by the caller from part headers + byte sizes, all of which are known
// before a single byte is read.
function sendStreamed(
  method: 'POST' | 'PUT',
  urlString: string,
  contentLength: number,
  makeBody: () => AsyncIterable<Buffer>,
  { headers = {}, timeoutMs = 60_000 }: RequestOptions = {},
): Promise<PostBufferResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch (err) {
      return reject(err);
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Length': String(contentLength),
          Connection: 'close',
          ...headers,
        },
      },
      (res) => {
        // Provider responses are small (a URL or a little JSON), so buffering the
        // RESPONSE is fine — it's the request body that had to stop being buffered.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }),
      );
    });
    req.on('error', reject);
    // pipeline ends the request when the body is exhausted, and destroys it (so
    // the socket doesn't leak) if reading the source fails partway.
    pipeline(Readable.from(makeBody()), req).catch(reject);
  });
}

/** POST a pre-serialized body. For small payloads only. */
export function postBuffer(
  urlString: string,
  body: Buffer,
  opts: RequestOptions = {},
): Promise<PostBufferResult> {
  return sendStreamed(
    'POST',
    urlString,
    body.length,
    async function* () {
      yield body;
    },
    opts,
  );
}

/** POST a multipart form, streaming any file parts straight off disk. This is the
 *  upload path for every HTTP-forwarding driver. */
export function postMultipart(
  urlString: string,
  parts: StreamPart[],
  opts: RequestOptions = {},
): Promise<PostBufferResult> {
  const boundary = `----LurkerBoundary${randomBytes(16).toString('hex')}`;
  const closing = Buffer.from(`--${boundary}--${CRLF}`);
  const crlf = Buffer.from(CRLF);

  // Exact Content-Length up front: headers are known strings, and a file part's
  // size is known from the temp file's stat. No need to read a byte to compute it.
  let contentLength = closing.length;
  const heads = parts.map((part) => {
    const head = partHeader(boundary, part);
    const bodyLen = 'source' in part ? sizeOf(part.source) : 0;
    contentLength += head.length + bodyLen + crlf.length;
    return head;
  });

  async function* body(): AsyncIterable<Buffer> {
    for (let i = 0; i < parts.length; i++) {
      yield heads[i];
      const part = parts[i];
      if ('source' in part) {
        for await (const chunk of streamOf(part.source)) yield chunk as Buffer;
      }
      yield crlf;
    }
    yield closing;
  }

  return sendStreamed('POST', urlString, contentLength, body, {
    ...opts,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...opts.headers,
    },
  });
}

/** PUT raw bytes, streamed. Used by the s3 driver, whose body is the object
 *  itself rather than a multipart form. */
export function putSource(
  urlString: string,
  source: UploadSource,
  opts: RequestOptions = {},
): Promise<PostBufferResult> {
  return sendStreamed(
    'PUT',
    urlString,
    sizeOf(source),
    async function* () {
      for await (const chunk of streamOf(source)) yield chunk as Buffer;
    },
    opts,
  );
}
