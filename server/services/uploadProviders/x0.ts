// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// x0.at provider — anonymous, no auth, accepts multipart `file`. The response
// body is the bare URL with a trailing newline.

import { USER_AGENT } from '../../utils/userAgent.js';
import { postMultipart } from './multipart.js';
import type { UploadSource } from './source.js';
import type { ConfigField, DriverCapabilities, UploadMeta, UploadResult } from './types.js';

const ENDPOINT = 'https://x0.at/';

export const driver = 'x0';
export const label = 'x0.at';
export const capabilities: DriverCapabilities = {
  storesRemotely: true,
  supportsDelete: false,
  mintsKeys: false,
  acceptsContentClasses: ['image', 'text'],
};
export const configSchema: ConfigField[] = [];

export async function upload(
  source: UploadSource,
  { filename, mime }: UploadMeta,
): Promise<UploadResult> {
  const resp = await postMultipart(
    ENDPOINT,
    [{ name: 'file', filename, contentType: mime, source }],
    { headers: { 'User-Agent': USER_AGENT } },
  );
  const text = resp.text.trim();
  if (resp.status < 200 || resp.status >= 300) {
    throw Object.assign(new Error(`x0.at upload failed: ${resp.status} ${text.slice(0, 200)}`), {
      code: 'PROVIDER_ERROR',
    });
  }
  if (!/^https?:\/\//.test(text)) {
    throw Object.assign(new Error(`x0.at unexpected response: ${text.slice(0, 200)}`), {
      code: 'PROVIDER_ERROR',
    });
  }
  return { url: text };
}
