// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Asks push.lurker.chat whether this server's key is active there
// (lurker-dev/RELAY_PLAN.md §6.5). Signed with the server's own VAPID key, the
// same proof a push carries, so the relay knows whose status it's answering.
//
// Only ever called once the admin has opted in, or when they ask for it: the
// opt-in (§5a) means this server doesn't contact the relay on its own.

import * as webpush from 'web-push';
import { vapidCredentials } from '../pushService.js';
import { RELAY_ORIGIN } from './relayOrigin.js';
import type { RelayStatus } from '../../../shared/relayStatus.js';

export type { RelayStatus };

const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

let cached: { at: number; status: RelayStatus } | null = null;
// The one request in flight, shared by everyone who asks meanwhile.
let inflight: Promise<RelayStatus> | null = null;

export function resetRelayStatusCache(): void {
  cached = null;
  inflight = null;
}

async function fetchStatus(timeoutMs: number): Promise<RelayStatus> {
  let res: Response;
  try {
    const { subject, publicKey, privateKey } = vapidCredentials();
    const { Authorization } = webpush.getVapidHeaders(
      RELAY_ORIGIN,
      subject,
      publicKey,
      privateKey,
      'aes128gcm',
    ) as { Authorization: string };
    res = await fetch(`${RELAY_ORIGIN}/status`, {
      headers: { Authorization },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { state: 'unreachable', reason: (err as Error)?.message || String(err) };
  }
  if (res.status === 401) return { state: 'unauthorized' };
  // The relay answered and said no to the question — not the same as down.
  if (res.status >= 400 && res.status < 500) return { state: 'refused', httpStatus: res.status };

  if (!res.ok) return { state: 'unreachable', reason: `status ${res.status}` };
  let body: { registered?: unknown; active?: unknown; comped?: unknown; paidThrough?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: 'unreachable', reason: 'unparseable answer' };
  }
  if (typeof body?.active !== 'boolean') {
    return { state: 'unreachable', reason: 'unparseable answer' };
  }
  if (body.active) {
    return {
      state: 'active',
      comped: body.comped === true,
      paidThrough: typeof body.paidThrough === 'string' ? body.paidThrough : null,
    };
  }
  return { state: 'inactive', registered: body.registered === true };
}

/** Ask the relay now, joining a request already in flight. Never rejects. */
function fetchShared(timeoutMs: number, now: number): Promise<RelayStatus> {
  if (!inflight) {
    const request: Promise<RelayStatus> = fetchStatus(timeoutMs).then((status) => {
      // Only our own slot: a reset may have let a newer request in meanwhile.
      if (inflight === request) {
        cached = { at: now, status };
        inflight = null;
      }
      return status;
    });
    inflight = request;
  }
  return inflight;
}

/**
 * Ask the relay and wait for the answer. Turning the relay on and the admin's
 * "check" use `fresh`; without it a recent answer (a minute) is reused.
 */
export async function relayStatus(
  opts: { fresh?: boolean; timeoutMs?: number; now?: number } = {},
): Promise<RelayStatus> {
  const now = opts.now ?? Date.now();
  // A request already in flight is newer than anything cached: join it, so a
  // background read can't answer older than a concurrent "check".
  if (!opts.fresh && inflight) return inflight;

  if (!opts.fresh && cached && now - cached.at < CACHE_MS) return cached.status;
  return fetchShared(opts.timeoutMs ?? TIMEOUT_MS, now);
}

/**
 * The last answer, without waiting: what the admin pane shows. A stale or
 * missing answer starts a refresh in the background, so a hung relay can't hang
 * the pane; the next load shows what it found.
 */
export function peekRelayStatus(
  opts: { timeoutMs?: number; now?: number } = {},
): RelayStatus | null {
  const now = opts.now ?? Date.now();
  if (!cached || now - cached.at >= CACHE_MS) void fetchShared(opts.timeoutMs ?? TIMEOUT_MS, now);
  return cached?.status ?? null;
}
