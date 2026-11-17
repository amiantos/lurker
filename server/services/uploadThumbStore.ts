// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Storing an upload's thumbnail with the uploader that holds the upload, for an
// uploader whose policy hosts thumbnails (the hosted one: a `thumbs/` object
// instead of a BLOB in the cell DB). Shared by an image's thumbnail at upload
// time and a media poster made later (services/uploadPoster.ts).

import { bufferSource } from './uploadProviders/source.js';
import { thumbnailFormat } from './thumbnailFormat.js';
import type { UploadDriver } from './uploadProviders/index.js';

/** Absolutize a driver result URL. Drivers that store remotely already return an
 *  absolute URL; the local driver returns a root-relative path we prefix with the
 *  instance's public base, unless its own public_base_url made it absolute. */
export function absolutizeUrl(url: string, storesRemotely: boolean, baseUrl: () => string): string {
  if (storesRemotely || !url.startsWith('/')) return url;
  const base = baseUrl();
  return base ? base + url : url;
}

/** Store thumbnail bytes and answer their URL, or null when the driver gave
 *  none. Rejects as the driver does; every caller falls back to the BLOB. */
export type ThumbStore = (bytes: Buffer) => Promise<string | null>;

export function remoteThumbStore(
  driver: UploadDriver,
  driverConfig: Record<string, string>,
  baseUrl: () => string,
): ThumbStore {
  return async (bytes) => {
    // Describe the bytes we actually produced, not the format thumbnails
    // used to be: the dropper verifies the claimed mime against the magic
    // bytes and 415s a webp announced as image/jpeg.
    const thumbFmt = thumbnailFormat(bytes);
    const tRes = await driver.upload(
      bufferSource(bytes),
      {
        filename: `thumb.${thumbFmt.ext}`,
        mime: thumbFmt.mime,
        contentClass: 'image',
        kind: 'thumb',
      },
      driverConfig,
    );
    return tRes && typeof tRes.url === 'string'
      ? absolutizeUrl(tRes.url, driver.capabilities.storesRemotely, baseUrl)
      : null;
  };
}
