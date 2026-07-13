// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Hoarder provider — the operator's own self-hosted file dropper at
// ~/Coding/hoarder, deployed at upload.bradroot.me. Authenticates via
// Authorization: Bearer <api_key> (support added in coordinated change to
// the Hoarder repo); returns JSON `{ id, ext, url, thumb_url, ... }` where
// `url` is already the public CDN URL.

import { USER_AGENT } from '../../utils/userAgent.js';
import { postMultipart, isOk, jsonBody, type StreamPart } from './multipart.js';
import type { UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

export const driver = 'hoarder';
export const label = 'Hoarder';
export const capabilities: DriverCapabilities = {
  storesRemotely: true,
  supportsDelete: false,
  mintsKeys: false,
  // The hosted dropper accepts the same media set the cell scrubs (control-plane
  // #56). ⚠ The dropper has to be DEPLOYED before a cell running this code, or the
  // cell will happily send a video to a dropper that still 415s it.
  acceptsContentClasses: ['image', 'text', 'media'],
};
export const configSchema: ConfigField[] = [
  {
    key: 'url',
    label: 'Hoarder URL',
    type: 'string',
    required: true,
    default: '',
    description: 'Base URL of your Hoarder instance (e.g. https://upload.example.com).',
  },
  {
    key: 'api_key',
    label: 'Hoarder API key',
    type: 'secret',
    required: true,
    default: '',
    description: 'API key for your Hoarder instance.',
  },
];

export async function upload(
  source: UploadSource,
  { filename, mime, kind }: UploadMeta,
  config: { url?: string; api_key?: string } = {},
): Promise<UploadResult> {
  if (!config.url) {
    throw Object.assign(new Error('hoarder uploader requires a url'), {
      code: 'PROVIDER_CONFIG',
    });
  }
  if (!config.api_key) {
    throw Object.assign(new Error('hoarder uploader requires an api_key'), {
      code: 'PROVIDER_CONFIG',
    });
  }

  const base = config.url.replace(/\/+$/, '');
  const parts: StreamPart[] = [];
  // Text fields before the file so multipart parsers populate req.body reliably.
  if (kind) parts.push({ name: 'kind', value: kind });
  parts.push({ name: 'file', filename, contentType: mime, source });

  const resp = await postMultipart(`${base}/api/upload`, parts, {
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!isOk(resp)) {
    const text = resp.text.slice(0, 200);
    throw Object.assign(new Error(`hoarder upload failed: ${resp.status} ${text}`), {
      code: resp.status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR',
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = jsonBody(resp) as any;
  if (!body || typeof body.url !== 'string') {
    throw Object.assign(new Error('hoarder returned no url'), { code: 'PROVIDER_ERROR' });
  }
  return { url: body.url as string };
}
