// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Server→client progress for an upload, over the WS the user already has open.
//
// WHY THIS EXISTS (#545): the browser's own upload progress (`xhr.upload`) only
// measures browser→server. When it reaches 100% the file has merely ARRIVED here —
// and then the two slowest things happen: the sharp/scrub pipeline, and the
// server→provider send, which on a home uplink is by far the longest phase. The bar
// used to read "Uploading: 100%" and sit there for all of it, looking hung. It was
// honest about the wrong thing.
//
// Only the server knows about those phases, so only the server can narrate them.
//
// The events are a COURTESY, not part of the upload's contract: the HTTP response is
// still what completes the upload. A client that sends no token (or an old one that
// doesn't know about this) gets no events and falls back to an indeterminate
// "Processing…" label — strictly better than the lie, and nothing breaks.

import { fanOutToUser } from './wsHub.js';

// Slow enough that a 200 MB upload on a fast link doesn't spray hundreds of frames
// at a client that can only repaint 60 times a second; fast enough to feel live.
const THROTTLE_MS = 150;

export type UploadPhase = 'processing' | 'sending';

export interface UploadProgress {
  /** The pipeline is working (sharp re-encode, or the in-place media scrub). No
   *  percentage: it's a one-shot native call with no seam to count. */
  processing(): void;
  /** The send to the provider has begun. Emitted even for drivers that will never
   *  report a byte (`local` renames the temp file — no wire to count), so the user
   *  always learns WHICH half they're waiting on even when we can't say how far. */
  sending(): void;
  /** Handed to the driver as UploadMeta.onProgress. Throttled, and only ever moves
   *  forward. */
  onBytes(sentBytes: number, totalBytes: number): void;
}

const NOOP: UploadProgress = {
  processing() {},
  sending() {},
  onBytes() {},
};

/**
 * `token` correlates the events with the one upload the client is watching. It is
 * the client's own random string, echoed back untouched — two tabs (or two devices)
 * of the same user each fan out to BOTH sockets, so without it a second upload's
 * progress would drive the first one's bar. No token → no events (NOOP).
 *
 * `destination` is the resolved uploader's human label, so the client can say
 * "Sending to Catbox…" rather than "Sending…".
 */
export function makeUploadProgress(
  userId: number,
  token: string | null,
  destination: string,
): UploadProgress {
  if (!token) return NOOP;

  const emit = (phase: UploadPhase, percent: number | null): void => {
    fanOutToUser(userId, { kind: 'upload-progress', token, phase, destination, percent });
  };

  let lastEmitAt = 0;
  let lastPercent = -1;

  return {
    processing() {
      emit('processing', null);
    },
    sending() {
      emit('sending', 0);
      lastEmitAt = Date.now();
      lastPercent = 0;
    },
    onBytes(sentBytes, totalBytes) {
      const percent =
        totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 0;
      // Nothing new to say, or too soon to say it again. 100 always goes out
      // regardless of the throttle: it's the frame that ends the "sending" phase, and
      // dropping it would strand the bar just short of done — the same class of lie
      // this whole thing exists to kill.
      if (percent === lastPercent) return;
      const now = Date.now();
      if (percent < 100 && now - lastEmitAt < THROTTLE_MS) return;
      lastEmitAt = now;
      lastPercent = percent;
      emit('sending', percent);
    },
  };
}
