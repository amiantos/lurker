// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { randomBytes } from 'crypto';
import https from 'https';
import http from 'http';
import type { IncomingHttpHeaders } from 'http';
import { Readable } from 'node:stream';
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

/** Drop the named headers (case-insensitively) from a caller-supplied set, so a
 *  header this module computes can't be shadowed by a case variant — node would
 *  otherwise emit both and produce a malformed request. */
function omitHeaders(headers: Record<string, string>, drop: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!drop.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

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

    // A keep-alive agent, private to this ONE request and destroyed when it ends.
    //
    // We used to send `Connection: close`. That is actively harmful on an upload:
    // a provider that rejects early (413 too-large, 401 bad token) answers while
    // we are still pushing bytes, and a server told `close` destroys the socket
    // the moment it has finished writing that answer — no matter how politely it
    // drains the rest of the body. Node's socket then takes the EPIPE and throws
    // away the response bytes already in its receive buffer, so we lose the very
    // status and message the provider just sent us and fall back to the generic
    // hangup error below. Measured against a draining server: `close` lost the
    // 413 on ~30% of 8MB uploads; keep-alive delivered it every time.
    //
    // Owning the agent (rather than letting node's global one pool sockets to
    // providers between uploads) keeps the old header's real benefit: nothing is
    // reused, the connection still goes away as soon as we're done with it.
    const agent = new lib.Agent({ keepAlive: true });

    let settled = false;
    const done = (r: PostBufferResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        // Content-Length and Connection are OURS: a caller that supplied either
        // could silently corrupt the framing (a wrong Content-Length hangs the
        // request or truncates the body). Strip any case-variant they passed so
        // node can't emit the header twice. Connection is left to the agent,
        // which means keep-alive — see the agent above for why that matters.
        headers: {
          ...omitHeaders(headers, ['content-length', 'connection']),
          'Content-Length': String(contentLength),
        },
        agent,
      },
      (res) => {
        // Provider responses are small (a URL or a little JSON), so buffering the
        // RESPONSE is fine — it's the request body that had to stop being buffered.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        const finish = (): void =>
          done({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        res.on('end', finish);
        // A peer that answers early and hangs up may never deliver 'end'. Settle
        // with what arrived rather than hanging until the timeout.
        res.on('close', finish);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }),
      );
    });

    // Deliberately NOT stream.pipeline, which rejects on a write error and destroys
    // the request with it.
    //
    // A provider that rejects a big upload EARLY (catbox: "Files larger than 200MB
    // are not allowed"; a 401 on a bad token) answers and hangs up while we are
    // still pushing bytes — so our write then fails with EPIPE/ECONNRESET. That
    // write error is the expected *consequence* of the rejection, not the outcome:
    // the outcome is the status and message the server just sent, and streaming
    // widens the window from microseconds to the whole upload.
    //
    // ⚠ A write error must therefore NEVER settle this promise on its own: the error
    // is only REMEMBERED, and we settle on the request's 'close', by which point any
    // response the parser could surface HAS been surfaced. That removes the ordering
    // dependency (it showed up as a rare load-dependent flaky test).
    //
    // But it does not always save the answer, and pretending otherwise would be a
    // lie: when the peer hangs up abruptly, node's socket takes the EPIPE and
    // DESTROYS itself, discarding response bytes already sitting in the receive
    // buffer. The 413 is then genuinely unrecoverable — it's the same reason an
    // nginx `client_max_body_size` rejection so often reaches a client as
    // "connection reset" rather than as the 413 it sent. So: surface the response
    // whenever it parsed, and otherwise fail with something that NAMES the likely
    // cause instead of a bare `write EPIPE` that tells a user nothing.
    //
    // What we no longer do is CAUSE that hangup ourselves — a provider that drains
    // gets to finish talking to us now (see the keep-alive agent above), so this
    // path is for providers that cut us off regardless, not the common case.
    let writeError: Error | null = null;
    const body = Readable.from(makeBody());
    body.on('error', (err: Error) => {
      writeError = err;
      req.destroy();
    });
    req.on('error', (err: Error) => {
      writeError = err;
      body.destroy();
    });
    req.on('close', () => {
      // Nothing may outlive the request: the agent is ours alone, so drop its
      // socket rather than leave a keep-alive connection open to the provider.
      agent.destroy();
      // The SUCCESS path lands here too, having already resolved via done(). Bail
      // before building an error: fail() would discard it anyway, but constructing
      // one captures a V8 stack trace on every successful upload, and it reads like
      // we're erroring on a request that worked.
      if (settled) return;
      // The connection died without an answer, so the write error is the real story
      // — dressed up so the user sees a cause rather than an errno.
      fail(hangupError(writeError));
    });
    body.pipe(req);
  });
}

/** The peer went away mid-upload. Almost always this means it rejected the file and
 *  closed rather than draining the rest of it — a size limit, or an auth failure it
 *  didn't want to keep reading through. Say so: `write EPIPE` on its own leaves the
 *  user (and the provider column in the uploads list) with nothing to act on. */
function hangupError(cause: Error | null): Error {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === 'EPIPE' || code === 'ECONNRESET') {
    return Object.assign(
      new Error(
        'the provider closed the connection while the file was still uploading — ' +
          'it most likely rejected the file (too large, or a bad credential)',
      ),
      { code, cause },
    );
  }
  return cause ?? new Error('connection closed before a response');
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
    // Ours wins: a caller-supplied Content-Type would carry the wrong boundary (or
    // none), and the server would fail to parse a body it can't find the parts in.
    headers: {
      ...omitHeaders(opts.headers ?? {}, ['content-type']),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
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
