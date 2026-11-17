// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// In node edition the cell reports every upload to the control plane's
// moderation index so the operator (who carries DMCA/abuse liability for the
// objects in their R2 bucket) can browse and take down uploads. The cell stamps
// its own name + the uploader's local user id; the CP resolves the account from
// the (cell_id, cell_user_id) mapping it already owns.
//
// Reporting is best-effort and NEVER blocks or fails a user's upload: the inline
// call after each insert is fire-and-forget, and a `synced_to_cp` flag plus a
// periodic flush reconcile any report that didn't land (CP was down). This is
// the OUTBOUND moderation half; the inbound takedown is routes/node.ts.
//
// Everything fails soft, exactly like orchestratorClient: not a node, or no
// orchestrator configured → no-op.

import { isNodeMode } from '../utils/edition.js';
import { USER_AGENT } from '../utils/userAgent.js';
import {
  listUnsyncedUploads,
  markUploadSynced,
  type UnsyncedUploadRow,
} from '../db/uploadHistory.js';
import * as systemLog from './systemLog.js';

interface ReporterConfig {
  url: string;
  name: string;
  secret: string;
}

// Same env as orchestratorClient (one fleet membership secret, one orchestrator
// URL). Any gap → null → no-op.
function readConfig(): ReporterConfig | null {
  if (!isNodeMode()) return null;
  const url = (process.env.LURKER_ORCHESTRATOR_URL || '').trim();
  const name = (process.env.LURKER_NODE_NAME || '').trim();
  const secret = (process.env.LURKER_NODE_SECRET || '').trim();
  if (!url || !name || !secret) return null;
  return { url, name, secret };
}

/** True when this cell can talk to the control plane (a configured node). */
export function controlPlaneConfigured(): boolean {
  return readConfig() !== null;
}

/** The per-upload moderation record the control plane indexes. */
export interface UploadReport {
  cell_upload_id: number;
  cell_user_id: number;
  url: string;
  thumb_url: string | null;
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
}

// POST one upload's record to the control plane. Returns true on a 2xx, false on
// any non-2xx or network error — never throws.
export async function reportUpload(rec: UploadReport): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/_cp/moderation/uploads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secret}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ cell: cfg.name, ...rec }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Fire-and-forget report immediately after an upload; marks the row synced on
// success so the flush skips it. Safe to call in any edition (no-op when not a
// configured node). The promise is for a caller that must not write the row
// until this report has settled; it never rejects.
export function reportUploadSoon(rec: UploadReport): Promise<boolean> {
  if (!readConfig()) return Promise.resolve(false);
  return reportUpload(rec).then((ok) => {
    if (ok) markUploadSynced(rec.cell_upload_id);
    return ok;
  });
}

// Report one history row and mark it synced once the control plane has it.
export async function reportRow(r: UnsyncedUploadRow): Promise<boolean> {
  const ok = await reportUpload({
    cell_upload_id: r.id,
    cell_user_id: r.user_id,
    url: r.url,
    thumb_url: r.thumbnail_url,
    mime: r.mime,
    byte_size: r.byte_size,
    width: r.width,
    height: r.height,
  });
  if (ok) markUploadSynced(r.id);
  return ok;
}

// Drain rows the CP hasn't acknowledged (it was down at upload time). One batch
// per call; the timer calls it again next tick. Stops at the first failure so we
// don't hammer a CP that's still down.
export async function flushUnsyncedUploads(batch = 50): Promise<number> {
  if (!readConfig()) return 0;
  let synced = 0;
  for (const r of listUnsyncedUploads(batch)) {
    if (!(await reportRow(r))) break;
    synced++;
  }
  return synced;
}

/**
 * The control plane's answer to an owner delete (control-plane #55). `code` is
 * the CP's machine-readable reason on a refusal ('not_indexed', 'taken_down',
 * …); status 0 means it couldn't be reached.
 */
export interface OwnerDeleteAnswer {
  status: number;
  code?: string;
  error?: string;
  retryAfter?: number;
}

// Ask the control plane to delete one of this cell's hosted uploads. Cells hold
// only the upload key, never the delete key, so the CP does the deleting (R2 +
// CDN) after checking the upload is this cell's and this user's. Never throws.
export async function requestOwnerDelete(
  cellUploadId: number,
  cellUserId: number,
): Promise<OwnerDeleteAnswer> {
  const cfg = readConfig();
  if (!cfg) return { status: 0, error: 'not a configured node' };
  try {
    const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/_cp/moderation/uploads/delete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secret}`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        cell: cfg.name,
        cell_user_id: cellUserId,
        cell_upload_id: cellUploadId,
      }),
      // The control plane deletes from R2 and purges the CDN before it answers,
      // each with its own 10s limit; give it room for both.
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
    const retry = Number(res.headers.get('retry-after'));
    return {
      status: res.status,
      code: body?.code,
      error: body?.error,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    };
  } catch (err) {
    return { status: 0, error: (err as Error).message };
  }
}

const DEFAULT_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Periodically reconcile unsynced uploads. No-op when not a configured node, so
// it's safe to call unconditionally at startup.
export function startModerationReporter(intervalMs = DEFAULT_INTERVAL_MS): void {
  stopModerationReporter();
  if (!readConfig()) return;
  const tick = async (): Promise<void> => {
    try {
      const n = await flushUnsyncedUploads();
      if (n > 0) {
        systemLog.log({ scope: 'node', text: `synced ${n} upload record(s) to moderation index` });
      }
    } catch {
      /* best-effort; retried next tick */
    }
  };
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

export function stopModerationReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
