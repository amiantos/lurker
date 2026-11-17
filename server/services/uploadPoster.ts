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
// Uploads from before this existed, and ones whose decoder was down or busy at
// the time, are caught up lazily: listing a page of uploads queues the media
// rows on it that have no thumbnail and no recent answer (`poster_tried_at`),
// one at a time. A row nobody lists is never dialled.
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
import { markPosterTried, setUploadThumbnail, uploadAwaitsThumbnail } from '../db/uploadHistory.js';
import { effectiveSettings } from './uploadLimits.js';
import { loadDriverForRef } from './uploadProviders/resolve.js';
import { previewsEnabled } from '../utils/previews.js';
import { remoteThumbStore, type ThumbStore } from './uploadThumbStore.js';

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
  storeRemotely: ThumbStore | null;
  /** Wait out a busy decoder and ask once more. The catch-up queue doesn't: a
   *  busy decoder is its cue to stop. */
  retryBusy: boolean;
  /** Wait out a decoder backoff. A test passes its own. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * How one attempt ended.
 * - `stored`: the row has its thumbnail.
 * - `none`: the decoder answered about the file and there is no poster to be
 *   had (refused, dead, no frame, bytes that aren't a picture). Recorded on the
 *   row, which isn't asked about again for POSTER_RETRY_DAYS.
 * - `unavailable`: the decoder is down or busy. Nothing was learned about the
 *   file, and the row is asked about later.
 * - `skipped`: this row couldn't take a thumbnail (deleted or taken down
 *   meanwhile). Also not recorded.
 */
export type PosterOutcome = 'stored' | 'none' | 'unavailable' | 'skipped';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** Can the decoder be asked for this upload at all? A local upload on an
 *  instance with no public base has a root-relative URL: nothing to dial. */
export function posterableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Video and audio: the uploads the decoder can make a poster for. */
export function posterableMime(mime: string | null): boolean {
  return !!mime && (mime.startsWith('video/') || mime.startsWith('audio/'));
}

// Uploads with an attempt waiting or running, so an upload's own attempt and a
// list that shows the row a moment later don't both ask.
const pending = new Set<number>();

/**
 * Fetch, store and announce one upload's poster. Never throws.
 */
export async function posterForUpload(job: UploadPosterJob): Promise<PosterOutcome> {
  const none = (): PosterOutcome => {
    markPosterTried(job.uploadId);
    return 'none';
  };
  try {
    let out: DecoderResolve = await decoderResolve(job.url, true);
    if (out.status === 'backoff' && job.retryBusy) {
      // The decoder's pool is full, which says nothing about this file. Once
      // more after the wait it asked for.
      await (job.wait ?? sleep)(Math.min(out.retryAfterS, MAX_BACKOFF_S) * 1000);
      out = await decoderResolve(job.url, true);
    }
    if (out.status === 'backoff' || out.status === 'down') return 'unavailable';
    if (out.status !== 'ok' || !out.poster) return none();
    // The decoder is the box expected to be compromised first, so its JPEG is a
    // claim. It is re-encoded below, as an uploaded image's bytes are.
    if (imageSignatureOf(out.poster.jpeg) !== 'image/jpeg') return none();
    let thumb: Buffer;
    try {
      thumb = await imagePipeline.thumbnail(out.poster.jpeg, { format: job.format });
    } catch {
      return none();
    }

    // Deleted or taken down while the decoder worked: nothing to store against.
    if (!uploadAwaitsThumbnail(job.uploadId)) return 'skipped';

    let thumbnailUrl: string | null = null;
    if (job.storeRemotely) {
      try {
        thumbnailUrl = await job.storeRemotely(thumb);
      } catch {
        // falls back to the inline BLOB, as an image's thumbnail does
      }
    }

    // ⚠ A delete landing between the check above and here (the length of the
    // store call) leaves a remote thumbnail no row names. Its URL was never
    // sent to anyone.
    if (!setUploadThumbnail(job.uploadId, thumbnailUrl ? null : thumb, thumbnailUrl)) {
      return 'skipped';
    }

    if (thumbnailUrl) {
      // The control plane has to index the object to ever delete it. The write
      // above marked the row unsynced, so the periodic flush retries this.
      void reportRow({ id: job.uploadId, user_id: job.userId }).catch(() => {});
    }
    // ⚠ `uploadId`, not `id`: fan-out reads a numeric `id` as a message event
    // id and moves the socket's resume cursor to it.
    fanOutToUser(job.userId, {
      kind: 'upload-thumbnail',
      uploadId: job.uploadId,
      thumbnail_url: thumbnailUrl ?? `/api/uploads/${job.uploadId}/thumb`,
    });
    return 'stored';
  } catch {
    return 'skipped';
  }
}

/** An upload's own attempt, fired as it is recorded and not awaited. */
export function posterForUploadSoon(job: Omit<UploadPosterJob, 'retryBusy'>): void {
  pending.add(job.uploadId);
  void posterForUpload({ ...job, retryBusy: true }).finally(() => pending.delete(job.uploadId));
}

// ─── Catching up rows that have no answer yet ────────────────────────────────

/** A listed row, as much of it as picking and running an attempt needs. */
export interface PosterCandidate {
  id: number;
  url: string;
  mime: string;
  removed: number;
  has_thumbnail: number;
  thumbnail_url: string | null;
  poster_tried: number;
  uploader_config_id: number | null;
}

interface Queued {
  userId: number;
  row: PosterCandidate;
  /** The instance's public base, for a hosted thumbnail's root-relative URL. */
  baseUrl: string;
}

// One at a time across the instance: this is old history, and the decoder's
// pool is there for the links people are pasting now.
const backlog: Queued[] = [];
let draining = false;

/**
 * Queue the rows of a listed page that could have a poster and have no answer
 * yet. Cheap when there are none, which is every page once it has been seen.
 */
export function queuePosterCatchUp(
  userId: number,
  rows: PosterCandidate[],
  baseUrl: () => string,
): void {
  if (!previewsEnabled()) return;
  // Asked for once, by the first row queued: a queue entry must not hold the
  // request it came from for as long as the drain takes.
  let base: string | null = null;
  for (const row of rows) {
    if (
      row.removed ||
      row.has_thumbnail ||
      row.thumbnail_url ||
      row.poster_tried ||
      pending.has(row.id) ||
      !posterableMime(row.mime) ||
      !posterableUrl(row.url)
    ) {
      continue;
    }
    pending.add(row.id);
    base ??= baseUrl();
    backlog.push({ userId, row, baseUrl: base });
  }
  if (!draining && backlog.length > 0) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    for (let next = backlog.shift(); next; next = backlog.shift()) {
      // catchUp reads the DB before it reaches posterForUpload's own catch, and
      // a rejection here would be unhandled, which ends the process.
      const outcome = await catchUp(next).catch((): PosterOutcome => 'skipped');
      pending.delete(next.row.id);
      if (outcome === 'unavailable') {
        // Down or busy: drop the rest. None of them is marked, so the next
        // list that shows them queues them again.
        for (const left of backlog.splice(0)) pending.delete(left.row.id);
      }
    }
  } finally {
    draining = false;
  }
}

async function catchUp({ userId, row, baseUrl }: Queued): Promise<PosterOutcome> {
  // The row's own uploader says where its thumbnail lives. One whose uploader
  // is gone keeps the thumbnail inline.
  const uploader = row.uploader_config_id != null ? loadDriverForRef(row.uploader_config_id) : null;
  const storeRemotely = uploader?.policy.hostsThumbnails
    ? remoteThumbStore(uploader.driver, uploader.driverConfig, () => baseUrl)
    : null;
  const settings = effectiveSettings(userId);
  return posterForUpload({
    userId,
    uploadId: row.id,
    url: row.url,
    format: settings['uploads.image.format'] === 'jpeg' ? 'jpeg' : 'webp',
    storeRemotely,
    retryBusy: false,
  });
}
