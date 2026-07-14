// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Chibisafe driver — self-hosted file host
// (https://github.com/chibisafe/chibisafe). Authenticates with the user's API
// key in the `x-api-key` header (generated under Credentials in the Chibisafe
// dashboard). A plain single multipart POST with field `file[]` is the same
// shape Chibisafe's own generated ShareX config uses; the chunked-upload
// protocol only matters past the server's chunk size and Lurker's uploads sit
// far below it. The response is `{ name, uuid, url, … }` where `url` is public.

import { USER_AGENT } from '../../utils/userAgent.js';
import { postMultipart, isOk, jsonBody } from './multipart.js';
import type { UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'chibisafe';
export const label = 'Chibisafe';
export const capabilities: DriverCapabilities = {
  creatable: true,
  storesRemotely: true,
  supportsDelete: true,
  mintsKeys: false,
  acceptsContentClasses: ['image', 'text', 'media'],
  selfHostOnly: true,
};
export const configSchema: ConfigField[] = [
  {
    key: 'url',
    label: 'Chibisafe URL',
    type: 'string',
    required: true,
    default: '',
    description: 'Base URL of your Chibisafe instance (e.g. https://chibi.example.com).',
  },
  {
    key: 'api_key',
    label: 'Chibisafe API key',
    type: 'secret',
    required: true,
    default: '',
    description:
      'API key for your Chibisafe instance — generate it under Credentials. Sent as x-api-key.',
  },
];

export async function upload(
  source: UploadSource,
  { filename, mime, onProgress }: UploadMeta,
  config: { url?: string; api_key?: string } = {},
): Promise<UploadResult> {
  if (!config.url) {
    throw Object.assign(new Error('chibisafe uploader requires a url'), {
      code: 'PROVIDER_CONFIG',
    });
  }
  if (!config.api_key) {
    throw Object.assign(new Error('chibisafe uploader requires an api_key'), {
      code: 'PROVIDER_CONFIG',
    });
  }

  const base = config.url.replace(/\/+$/, '');
  const resp = await postMultipart(
    `${base}/api/upload`,
    [{ name: 'file[]', filename, contentType: mime, source }],
    { headers: { 'x-api-key': config.api_key, 'User-Agent': USER_AGENT }, onProgress },
  );

  if (!isOk(resp)) {
    const text = resp.text.slice(0, 200);
    throw Object.assign(new Error(`chibisafe upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = jsonBody(resp) as any;
  if (!body || typeof body.url !== 'string' || !body.url) {
    throw Object.assign(new Error('chibisafe returned no url'), { code: 'PROVIDER_ERROR' });
  }
  // The uuid is the delete handle; an older server that omits it just makes the
  // upload non-deletable (no ref).
  const ref = typeof body.uuid === 'string' && body.uuid ? (body.uuid as string) : undefined;
  return { url: body.url as string, ...(ref ? { ref } : {}) };
}

/** Delete a file by the uuid upload() captured. 404 = already gone = success. */
async function deleteFile(
  ref: string,
  config: { url?: string; api_key?: string } = {},
): Promise<void> {
  if (!config.url || !config.api_key) {
    throw Object.assign(new Error('chibisafe uploader is missing its url or api_key'), {
      code: 'PROVIDER_CONFIG',
    });
  }
  const base = config.url.replace(/\/+$/, '');
  const resp = await fetch(`${base}/api/file/${encodeURIComponent(ref)}`, {
    method: 'DELETE',
    headers: { 'x-api-key': config.api_key, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok && resp.status !== 404) {
    const text = (await resp.text()).slice(0, 200);
    throw Object.assign(new Error(`chibisafe delete failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
}

export { deleteFile as delete };
