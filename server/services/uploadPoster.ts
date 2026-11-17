// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A thumbnail for an uploaded video or audio file (#778): a poster frame from the
// lurker-previews decoder, stored in the upload's own thumbnail slot.
//
// The cell has no ffmpeg and must not grow one (LINK_PREVIEWS_ISOLATION.md), so
// the decoder fetches the upload from its public URL exactly as it would a
// pasted link and hands back a JPEG. That makes this a feature of instances
// that run a decoder which can reach their uploads: with no decoder, or an
// upload URL the decoder's guard refuses (an instance on a private address),
// the row keeps its type icon.
//
// ⚠ It runs AFTER the upload has answered. The decoder range-fetches and runs
// ffmpeg, which is seconds, and the upload's URL is what the user is waiting
// for. The thumbnail lands on the row when it is ready and an
// `upload-thumbnail` frame tells the user's open clients.
//
// ⚠⚠ The thumbnail goes where an image upload's does (the inline BLOB, or a
// `thumbs/` object on an uploader that hosts them), never the preview byte
// cache: it must be deleted and taken down with the upload, and must not be
// evicted while the upload lives.

import { decoderResolve, type DecoderResolve } from './previewClient.js';
import { imageSignatureOf } from '../utils/imageSignature.js';
import * as imagePipeline from './imagePipeline.js';
import { fanOutToUser } from './wsHub.js';
import { reportRow } from './moderationReport.js';
import {
  getUploadForReport,
  setUploadThumbnail,
  uploadAwaitsThumbnail,
} from '../db/uploadHistory.js';

/** The longest a busy decoder's Retry-After is honoured for the one retry. */
const MAX_BACKOFF_S = 30;

export interface UploadPosterJob {
  userId: number;
  uploadId: number;
  /** The upload's public URL, absolute. */
  url: string;
  /** The user's image format, so the thumbnail matches their other ones. */
  format: imagePipeline.OutputFormat;
  /** Store the thumbnail with the uploader and answer its URL, on an uploader
   *  that hosts thumbnails; null keeps it as the row's inline BLOB. */
  storeRemotely: ((thumb: Buffer) => Promise<string | null>) | null;
  /** Settles once the row's first moderation report has (see the note below). */
  reported: Promise<unknown>;
  /** Wait out a decoder backoff. A test passes its own. */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Can the decoder be asked for this upload at all? A local upload on an
 *  instance with no public base has a root-relative URL: nothing to dial. */
export function posterableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Fetch, store and announce one upload's poster. Resolves true when the row
 * got a thumbnail. Never throws: every failure is a row without one.
 */
export async function posterForUpload(job: UploadPosterJob): Promise<boolean> {
  try {
    let out: DecoderResolve = await decoderResolve(job.url, true);
    if (out.status === 'backoff') {
      // The decoder's pool is full, which says nothing about this file. Once
      // more after the wait it asked for; there is no later pass to catch it.
      await (job.wait ?? sleep)(Math.min(out.retryAfterS, MAX_BACKOFF_S) * 1000);
      out = await decoderResolve(job.url, true);
    }
    if (out.status !== 'ok' || !out.poster) return false;
    // The decoder is the box expected to be compromised first, so its JPEG is a
    // claim. It is re-encoded below, as an uploaded image's bytes are.
    if (imageSignatureOf(out.poster.jpeg) !== 'image/jpeg') return false;
    const thumb = await imagePipeline.thumbnail(out.poster.jpeg, { format: job.format });

    // Deleted or taken down while the decoder worked: nothing to store against.
    if (!uploadAwaitsThumbnail(job.uploadId)) return false;

    let thumbnailUrl: string | null = null;
    if (job.storeRemotely) {
      try {
        thumbnailUrl = await job.storeRemotely(thumb);
      } catch {
        // falls back to the inline BLOB, as an image's thumbnail does
      }
    }

    // ⚠ The row's first report (thumb_url null) may still be in flight, and its
    // completion marks the row synced. Writing before it settles would let
    // that stale mark hide the thumbnail from the control plane, which deletes
    // only the objects it has indexed.
    await job.reported.catch(() => {});

    // ⚠ A delete landing between the check above and here leaves a remote
    // thumbnail no row names. Its URL was never sent to anyone.
    if (!setUploadThumbnail(job.uploadId, thumbnailUrl ? null : thumb, thumbnailUrl)) return false;

    if (thumbnailUrl) {
      // Unsynced by the write above, so the periodic flush retries this.
      const row = getUploadForReport(job.userId, job.uploadId);
      if (row) void reportRow(row);
    }
    fanOutToUser(job.userId, {
      kind: 'upload-thumbnail',
      id: job.uploadId,
      thumbnail_url: thumbnailUrl ?? `/api/uploads/${job.uploadId}/thumb`,
    });
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget {@link posterForUpload}. */
export function posterForUploadSoon(job: UploadPosterJob): void {
  void posterForUpload(job);
}
