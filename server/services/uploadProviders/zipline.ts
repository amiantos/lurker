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
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'zipline';
export const label = 'Zipline';
export const capabilities: DriverCapabilities = {
  creatable: true,
  storesRemotely: true,
  supportsDelete: false,
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
  buffer: Buffer,
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
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);

  const resp = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { authorization: config.token, 'User-Agent': USER_AGENT },
    body: form,
  });

  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 200);
    throw Object.assign(new Error(`zipline upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 || resp.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await resp.json().catch(() => null)) as any;
  const first = body?.files?.[0];
  // v4: files is an array of objects with `url`; v3: an array of URL strings.
  const url = typeof first === 'string' ? first : first?.url;
  if (typeof url !== 'string' || !url) {
    throw Object.assign(new Error('zipline returned no url'), { code: 'PROVIDER_ERROR' });
  }
  return { url };
}
