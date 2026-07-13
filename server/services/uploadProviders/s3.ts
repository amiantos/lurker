// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// S3-compatible driver — uploads straight to an object-storage bucket
// (Cloudflare R2, MinIO, Garage, AWS S3, …) and returns a link under the
// bucket's public base URL. AWS Signature V4 is implemented here with node
// crypto rather than pulling in @aws-sdk/client-s3: one signed PUT is ~70
// lines, and the SDK is a heavyweight dependency for exactly that.
//
// Requests are always PATH-STYLE ({endpoint}/{bucket}/{key}). Virtual-host
// style needs wildcard DNS that self-hosted MinIO setups rarely have, and every
// S3-compatible store — including R2 and AWS — still accepts path-style, so it's
// the lowest-friction default. The uploading endpoint and the PUBLIC base URL
// are separate config fields because they usually differ (R2's storage endpoint
// is never public; serving objects is the bucket/proxy's job, not Lurker's).
//
// SECURITY: the access key + secret are `secret` config fields (encrypted at
// rest, never projected to the client). Give the instance a credential scoped to
// the one upload bucket, not an account/root key. Object keys are 48 bits of
// randomness over a safe alphabet with dot-only segments dropped, so a proxy
// serving the bucket can't be walked with `..`; the secret is used only in the
// HMAC ladder — never a URL, header, log, or error string.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { USER_AGENT } from '../../utils/userAgent.js';
import { putSource, isOk } from './multipart.js';
import { hashOf, type UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 's3';
export const label = 'S3 / R2';
export const capabilities: DriverCapabilities = {
  creatable: true,
  storesRemotely: true,
  supportsDelete: true,
  // WE construct the object key (unlike a remote host that names the file).
  mintsKeys: true,
  acceptsContentClasses: ['image', 'text', 'binary'],
  selfHostOnly: true,
};
export const configSchema: ConfigField[] = [
  {
    key: 'endpoint',
    label: 'S3 endpoint',
    type: 'string',
    required: true,
    default: '',
    description:
      'Bucket API endpoint: https://<account-id>.r2.cloudflarestorage.com for R2, or your MinIO/Garage URL. Path-style, so no wildcard DNS needed.',
  },
  {
    key: 'region',
    label: 'S3 region',
    type: 'string',
    required: false,
    default: '',
    description: 'Signing region. Blank = "auto" (R2, MinIO); AWS needs the real bucket region.',
  },
  {
    key: 'bucket',
    label: 'S3 bucket',
    type: 'string',
    required: true,
    default: '',
    description: 'Bucket name uploads are written into.',
  },
  {
    key: 'access_key_id',
    label: 'S3 access key ID',
    type: 'string',
    required: true,
    default: '',
    description: 'Access key ID for a credential with write access to the bucket.',
  },
  {
    key: 'secret_access_key',
    label: 'S3 secret access key',
    type: 'secret',
    required: true,
    default: '',
    description: 'Secret access key paired with the access key ID.',
  },
  {
    key: 'public_base_url',
    label: 'S3 public base URL',
    type: 'string',
    required: true,
    default: '',
    description:
      'Public URL prefix the object is reachable under — an R2 public bucket domain, a CDN, or a reverse-proxied MinIO bucket. The key is appended to this.',
  },
  {
    key: 'key_prefix',
    label: 'S3 key prefix',
    type: 'string',
    required: false,
    default: '',
    description:
      'Optional folder prefix for objects (e.g. lurker). Unsafe characters are stripped.',
  },
];

function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

// Keys are built strictly from URL-unreserved characters ([A-Za-z0-9._-] plus
// '/' separators), so neither the canonical request nor the public URL ever
// needs percent-encoding — that sidesteps the classic SigV4 encoding-mismatch
// bugs. User-supplied prefixes are sanitized to the same alphabet.
function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

export function buildObjectKey(
  filename: string,
  { kind, prefix }: { kind?: string; prefix?: string } = {},
): string {
  const dotIdx = filename.lastIndexOf('.');
  const rawExt = dotIdx > 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'bin';
  const idPart = randomBytes(6).toString('base64url');
  const segments: string[] = [];
  // Dot-only segments ('.', '..') are dropped: a proxy serving the bucket may
  // normalize '..' — a traversal risk no object key needs to carry.
  const pushClean = (part: string) => {
    const clean = sanitizeSegment(part);
    if (clean && !/^\.+$/.test(clean)) segments.push(clean);
  };
  if (prefix) for (const part of prefix.split('/')) pushClean(part);
  if (kind) pushClean(kind);
  segments.push(`${idPart}.${ext}`);
  return segments.join('/');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/** Build a SigV4-signed request for one object. Pure given `now`, so tests can
 *  pin the clock and assert determinism. PUT carries the payload plus the
 *  cache/content headers a store may validate; DELETE signs an empty payload
 *  and only the mandatory host/x-amz headers. */
export function signObjectRequest(
  {
    method,
    endpoint,
    bucket,
    key,
    payload = Buffer.alloc(0),
    payloadHash: precomputedHash,
    contentType,
    region,
    accessKeyId,
    secretAccessKey,
  }: {
    method: 'PUT' | 'DELETE';
    endpoint: string;
    bucket: string;
    key: string;
    payload?: Buffer;
    // Hex sha256 of the body, when the caller already has it. SigV4 needs the
    // payload hash to sign, but an upload's payload may be a 200 MB temp file we
    // refuse to read into memory — so the caller streams it through a hash first
    // (source.hashOf) and passes the digest here instead of the bytes.
    payloadHash?: string;
    contentType?: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  },
  now: Date = new Date(),
): SignedRequest {
  const base = endpoint.replace(/\/+$/, '');
  const url = new URL(`${base}/${bucket}/${key}`);
  const host = url.host;
  const path = url.pathname;

  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const payloadHash = precomputedHash ?? sha256hex(payload);

  // Signed headers, sorted by lowercase name. Everything we send that the server
  // may validate is signed — including cache-control, so a store can't reject it
  // as an unsigned x-amz-adjacent header surprise.
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (method === 'PUT') {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
    headers['content-type'] = contentType || 'application/octet-stream';
  }
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: url.toString(),
    headers: { ...headers, authorization, 'User-Agent': USER_AGENT },
  };
}

function requireField(config: Record<string, string>, field: string): string {
  const value = (config[field] || '').trim();
  if (!value) {
    throw Object.assign(new Error(`s3 uploader requires ${field}`), { code: 'PROVIDER_CONFIG' });
  }
  return value;
}

export async function upload(
  source: UploadSource,
  { filename, mime, kind }: UploadMeta,
  config: Record<string, string> = {},
): Promise<UploadResult> {
  const endpoint = requireField(config, 'endpoint');
  const bucket = requireField(config, 'bucket');
  const accessKeyId = requireField(config, 'access_key_id');
  const secretAccessKey = requireField(config, 'secret_access_key');
  const publicBase = requireField(config, 'public_base_url');
  // R2 wants literally "auto"; MinIO accepts any region. Default keeps it optional.
  const region = (config.region || '').trim() || 'auto';

  const key = buildObjectKey(filename, { kind, prefix: config.key_prefix });
  // SigV4 signs the payload hash, so the bytes get read twice: once to hash
  // (streamed, constant memory), once to send (streamed, constant memory). Two
  // passes over a warm temp file beats holding it in the heap. UNSIGNED-PAYLOAD
  // would avoid the first pass but changes the signing contract — not this PR.
  const payloadHash = await hashOf(source);
  const signed = signObjectRequest({
    method: 'PUT',
    endpoint,
    bucket,
    key,
    payloadHash,
    contentType: mime,
    region,
    accessKeyId,
    secretAccessKey,
  });

  const resp = await putSource(signed.url, source, { headers: signed.headers });

  if (!isOk(resp)) {
    const text = resp.text.slice(0, 200);
    throw Object.assign(new Error(`s3 upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // key is the delete handle consumed by delete() below.
  return { url: `${publicBase.replace(/\/+$/, '')}/${key}`, ref: key };
}

/** Remove one object by its key (the ref upload() returned). S3 DeleteObject is
 *  idempotent by protocol — deleting a key that's already gone returns 204 — so
 *  the "already deleted counts as success" contract holds with NO 404
 *  carve-out. Deliberately so: a 404 here means the request never reached a
 *  real DeleteObject handler (repointed endpoint, wrong bucket), and swallowing
 *  it would drop the record while the original object lives on. */
async function deleteObject(ref: string, config: Record<string, string> = {}): Promise<void> {
  const endpoint = requireField(config, 'endpoint');
  const bucket = requireField(config, 'bucket');
  const accessKeyId = requireField(config, 'access_key_id');
  const secretAccessKey = requireField(config, 'secret_access_key');
  const region = (config.region || '').trim() || 'auto';

  const signed = signObjectRequest({
    method: 'DELETE',
    endpoint,
    bucket,
    key: ref,
    region,
    accessKeyId,
    secretAccessKey,
  });

  const resp = await fetch(signed.url, {
    method: 'DELETE',
    headers: signed.headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 200);
    throw Object.assign(new Error(`s3 delete failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
}

export { deleteObject as delete };
