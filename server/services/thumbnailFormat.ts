// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which format a STORED thumbnail BLOB is in, read from its magic bytes.
//
// Thumbnails are WebP since #560, but every one written before it is a JPEG and
// those rows outlive the setting change — so a single account holds both, and the
// current default is never a safe thing to name. Every place that has to DECLARE a
// thumbnail's type sniffs it instead: the serving route's Content-Type, the mime
// claimed to the dropper (which verifies the claim against the bytes and 415s a
// mismatch), and the `.lurk` export entry name.
//
// Deliberately sharp-free. It's a 12-byte check, and the export path — a DB/zip
// module with no other reason to know what an image is — needs it without dragging
// the native image pipeline into its module graph.

export interface ThumbnailFormat {
  mime: string;
  ext: string;
}

const WEBP: ThumbnailFormat = { mime: 'image/webp', ext: 'webp' };
const JPEG: ThumbnailFormat = { mime: 'image/jpeg', ext: 'jpg' };

// WebP is a RIFF container — `RIFF` <4-byte length> `WEBP`. A JPEG never is, so
// the two thumbnail formats we can hold are distinguishable on 12 bytes. Anything
// else (a truncated or empty BLOB) reads as JPEG, which is what the pre-#560 rows
// are and the only thing an unrecognizable legacy blob could be.
export function thumbnailFormat(blob: Buffer): ThumbnailFormat {
  const isWebp =
    blob.length >= 12 &&
    blob.toString('latin1', 0, 4) === 'RIFF' &&
    blob.toString('latin1', 8, 12) === 'WEBP';
  return isWebp ? WEBP : JPEG;
}
