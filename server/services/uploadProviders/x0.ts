// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// x0.at provider — anonymous, no auth, accepts multipart `file`. The response
// body is the bare URL with a trailing newline.

import { USER_AGENT } from '../../utils/userAgent.js';
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
  buffer: Buffer,
  { filename, mime }: UploadMeta,
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT },
    body: form,
  });
  const text = (await resp.text()).trim();
  if (!resp.ok) {
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
