// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Zipline driver — self-hosted ShareX-style file host
// (https://github.com/diced/zipline). Authenticates with the user's Zipline
// token sent RAW in the `authorization` header (no "Bearer" prefix — Zipline's
// userMiddleware passes the header value straight to its token decryptor).
// The v4 upload route responds `{ files: [{ id, name, type, url, … }] }`;
// v3 instances respond `{ files: ["https://…"] }` — both shapes are accepted
// since the difference is one line and v3 servers are still common.

import { USER_AGENT } from '../../utils/userAgent.js';
import { postMultipart, isOk, jsonBody } from './multipart.js';
import type { UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'zipline';
export const label = 'Zipline';
export const capabilities: DriverCapabilities = {
  creatable: true,
  storesRemotely: true,
  supportsDelete: true,
  mintsKeys: false,
  acceptsContentClasses: ['image', 'text'],
  selfHostOnly: true,
};
export const configSchema: ConfigField[] = [
  {
    key: 'url',
    label: 'Zipline URL',
    type: 'string',
    required: true,
    default: '',
    description: 'Base URL of your Zipline instance (e.g. https://zipline.example.com).',
  },
  {
    key: 'token',
    label: 'Zipline token',
    type: 'secret',
    required: true,
    default: '',
    description:
      'Your Zipline user token — copy it from the Zipline dashboard. Sent as the authorization header.',
  },
];

export async function upload(
  source: UploadSource,
  { filename, mime }: UploadMeta,
  config: { url?: string; token?: string } = {},
): Promise<UploadResult> {
  if (!config.url) {
    throw Object.assign(new Error('zipline uploader requires a url'), { code: 'PROVIDER_CONFIG' });
  }
  if (!config.token) {
    throw Object.assign(new Error('zipline uploader requires a token'), {
      code: 'PROVIDER_CONFIG',
    });
  }

  const base = config.url.replace(/\/+$/, '');
  const resp = await postMultipart(
    `${base}/api/upload`,
    [{ name: 'file', filename, contentType: mime, source }],
    { headers: { authorization: config.token, 'User-Agent': USER_AGENT } },
  );

  if (!isOk(resp)) {
    const text = resp.text.slice(0, 200);
    throw Object.assign(new Error(`zipline upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = jsonBody(resp) as any;
  const first = body?.files?.[0];
  // v4: files is an array of objects with `url`; v3: an array of URL strings.
  const url = typeof first === 'string' ? first : first?.url;
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error('zipline returned no url'), { code: 'PROVIDER_ERROR' });
  }
  // v4 responses carry the file id — the delete handle. v3 responses are bare
  // URL strings with no id, so a v3 upload is simply not deletable (no ref).
  const ref = typeof first === 'object' && typeof first?.id === 'string' ? first.id : undefined;
  return { url, ...(ref ? { ref } : {}) };
}

/** Delete a file by the id upload() captured. Zipline v4's delete route accepts
 *  the file id (or name) in the path; a 404 means it's already gone, which is
 *  the outcome the caller wanted. */
async function deleteFile(
  ref: string,
  config: { url?: string; token?: string } = {},
): Promise<void> {
  if (!config.url || !config.token) {
    throw Object.assign(new Error('zipline uploader is missing its url or token'), {
      code: 'PROVIDER_CONFIG',
    });
  }
  const base = config.url.replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/user/files/${encodeURIComponent(ref)}`, {
    method: 'DELETE',
    headers: { authorization: config.token, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok && resp.status !== 404) {
    const text = (await resp.text()).slice(0, 200);
    throw Object.assign(new Error(`zipline delete failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
}

export { deleteFile as delete };
