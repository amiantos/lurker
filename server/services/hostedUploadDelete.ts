// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Deleting an upload on the hosted service (node edition, control-plane #55).
// Every hosted upload goes through the operator's dropper, and a cell holds only
// its upload key, never the delete key, so a compromised cell can't wipe the
// bucket. The control plane does the deleting instead: it checks the upload is
// this cell's and this user's, deletes the file and thumbnail from R2, and
// purges the CDN. Same order as every other delete (decision 8): the bytes go
// first, and the history row is dropped only once the control plane says so,
// so a failure leaves the row for the user to retry.

import {
  controlPlaneConfigured,
  requestOwnerDelete,
  reportRow,
  type OwnerDeleteAnswer,
} from './moderationReport.js';
import {
  deleteUploadUnlessRemoved,
  getUnsyncedUploadForReport,
  getUploadForReport,
} from '../db/uploadHistory.js';
import { getHostedUploaderId } from '../db/uploaderConfig.js';
import { NODE_UPLOAD_PROVIDER_ID } from './uploadProviders/nodeUpload.js';
import * as systemLog from './systemLog.js';

// Rows the hosted dropper stored. 'hoarder' is its id before #537's rename,
// still on rows uploaded before it.
const HOSTED_PROVIDERS: ReadonlySet<string> = new Set([NODE_UPLOAD_PROVIDER_ID, 'hoarder']);

/**
 * Is this row deleted through the control plane? Only on a node that can reach
 * it (controlPlaneConfigured is false outside node edition), only for what the
 * hosted dropper stored, and not for the cell's admin: that's the operator's
 * account on the cell, with no control-plane account to own an upload.
 *
 * "What the hosted dropper stored" is the hosted uploader config, or no config
 * at all with the dropper's name: hosted uploads from before #510 recorded none.
 * A row naming any other config came from an uploader of the user's own (an
 * imported archive's Hoarder, say), which only its own driver can delete.
 */
export function hostedDeletable(
  row: { provider: string; uploader_config_id: number | null },
  isAdmin: boolean,
): boolean {
  if (isAdmin || !HOSTED_PROVIDERS.has(row.provider) || !controlPlaneConfigured()) return false;
  return row.uploader_config_id == null || row.uploader_config_id === getHostedUploaderId();
}

export type HostedDeleteResult =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfter?: number };

// One delete per row at a time: a double tap (or two devices) joins the one in
// flight rather than asking the control plane twice.
const inFlight = new Map<string, Promise<HostedDeleteResult>>();

export function deleteHostedUpload(userId: number, id: number): Promise<HostedDeleteResult> {
  const key = `${userId}:${id}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = deleteOnce(userId, id).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function deleteOnce(userId: number, id: number): Promise<HostedDeleteResult> {
  // The control plane deletes the objects it has indexed for the upload. A row
  // it hasn't acknowledged may hold one it hasn't heard of (a poster thumbnail
  // stored after the first report, #778), so that report lands first.
  const unsynced = getUnsyncedUploadForReport(userId, id);
  if (unsynced && !(await reportRow(unsynced))) {
    return {
      ok: false,
      status: 503,
      error: 'this upload is still being recorded — try again shortly',
    };
  }
  let answer = await requestOwnerDelete(id, userId);
  // The control plane hasn't indexed it (its report never landed, or hasn't
  // yet): report it now, then ask once more.
  if (answer.code === 'not_indexed') {
    const row = getUploadForReport(userId, id);
    if (row && (await reportRow(row))) answer = await requestOwnerDelete(id, userId);
  }
  if (answer.status >= 200 && answer.status < 300) {
    // A takedown that landed while the control plane was answering keeps its
    // tombstone; the bytes are gone either way.
    if (!deleteUploadUnlessRemoved(userId, id) && getUploadForReport(userId, id)) {
      return { ok: false, status: 409, error: 'this upload was removed by moderation' };
    }
    return { ok: true };
  }
  return refusal(answer);
}

// What the user hears. The control plane's own wording is for operators; these
// are for the person who pressed delete.
function refusal(answer: OwnerDeleteAnswer): HostedDeleteResult & { ok: false } {
  // By status as well as code: a proxy's 429 or 409 has no JSON body.
  const code =
    answer.code ??
    (answer.status === 429 ? 'rate_limited' : answer.status === 409 ? 'taken_down' : undefined);
  switch (code) {
    case 'taken_down':
      return { ok: false, status: 409, error: 'this upload was removed by moderation' };
    case 'not_owner':
      // The control plane has no account for this cell user. Nothing the user
      // can do about it, and an operator should look.
      systemLog.log({
        scope: 'node',
        text: `hosted upload delete refused: the control plane does not own this user's upload (${answer.error ?? 'not_owner'})`,
      });
      return { ok: false, status: 409, error: 'this upload cannot be deleted' };
    case 'rate_limited':
      return {
        ok: false,
        status: 429,
        error: 'too many deletes right now — try again shortly',
        retryAfter: answer.retryAfter,
      };
    case 'not_indexed':
      return {
        ok: false,
        status: 503,
        error: 'this upload is still being recorded — try again shortly',
      };
    case 'storage_unavailable':
      return { ok: false, status: 502, error: 'could not delete it right now — try again' };
    default:
      // Unreachable, unconfigured, or refused for a reason only the operator can
      // fix (wrong cell, not this user's): a gateway error for the user, the
      // reason in the system log for the operator.
      systemLog.log({
        scope: 'node',
        text:
          answer.status === 0
            ? `hosted upload delete: the control plane could not be reached (${answer.error ?? 'no answer'})`
            : `hosted upload delete refused by the control plane: ${answer.status} ${answer.code ?? ''} ${answer.error ?? ''}`.trim(),
      });
      return {
        ok: false,
        status: answer.status === 503 ? 503 : 502,
        error: 'the upload host could not delete it',
      };
  }
}
