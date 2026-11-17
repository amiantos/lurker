// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { upsertDraft, clearDraft, listForUser, getDraftForBuffer } from '../db/drafts.js';
import type { DraftRow } from '../db/drafts.js';
import { resolveBuffer } from '../db/bufferResolve.js';
import type { DraftReplyRef } from '../../shared/replies.js';

// Per-buffer drafts are last-write-wins — no merging, no CRDT. The conflict
// surface is tiny in practice (you don't actively type into the same buffer on
// two devices simultaneously), so this service upserts and emits a `change` for
// wsHub to fan out to every other tab of the same user.
//
// "Last" is by when the text was TYPED, not when it arrived: a device that was
// offline delivers its draft late, and must not put it over one written
// elsewhere since (or bring back a draft that was sent from another device).
// See DraftGuard.
//
// A draft with nothing in it is a delete: the row is sparse on disk, and clients
// expect "no draft" rather than "draft with empty string" so the pencil chip
// can drive itself off `hasDraft` without extra trim checks. Nothing means no
// text AND no reply: a Reply with nothing typed yet (on your own line, in a DM,
// where it inserts no address) is a draft all the same, and follows you to
// another device like one.
//
// `reply` (see upsertDraft): undefined leaves the stored one, null clears it —
// except that emptying the text with no reply key clears the whole draft, as a
// send does: that's how a client that knows nothing of replies clears one. The
// change announces the reply as it was stored and resolved, which is not always
// what was sent: one that doesn't resolve is dropped, and then the sender is
// told as well, or it would go on showing a reply the draft no longer has.

/**
 * What a client says about the write it is making, so a late one can be told
 * from a new one.
 * - `base`: the revision of this buffer's draft the client last had from the
 *   server. Equal to the current one, nobody else has written since and the
 *   write stands, whatever the clocks say.
 * - `ageMs`: how long ago the text was typed, by the client's own clock. Only
 *   consulted when `base` is behind: the write is then refused as stale if the
 *   draft here was typed later.
 * A write with no guard (the apps today) always stands, as before.
 */
export interface DraftGuard {
  base?: number;
  ageMs?: number;
}

export type DraftWrite =
  | { ok: true; bufferId: number; rev: number }
  /** Names no buffer of the user's: nothing stored, nothing announced. */
  | { ok: false; error: 'unknown-buffer' }
  /** Older than what is here. `current` is what is here (undefined: no draft). */
  | { ok: false; error: 'stale'; bufferId: number; rev: number; current: DraftRow | undefined };

// A draft's revision and when it was typed, per (user, buffer). In memory: it
// has to outlive a cleared draft (the row is deleted), and it only has to tell
// writes apart while clients hold revisions from this process. After a restart
// every draft is at `bootRev`, which no client holds, so the first write to
// each is judged on its age against the row's own timestamp, or stands.
interface DraftState {
  rev: number;
  typedMs: number;
}
const bootRev = Date.now();
let lastRev = bootRev;
const states = new Map<string, DraftState>();
const stateKey = (userId: number, bufferId: number): string => `${userId}:${bufferId}`;

function stateOf(userId: number, bufferId: number): DraftState {
  const known = states.get(stateKey(userId, bufferId));
  if (known) return known;
  // SQLite's datetime('now'): UTC, to the second, no zone marker.
  const stored = getDraftForBuffer(userId, bufferId)?.updatedAt;
  const typedMs = stored ? Date.parse(`${stored.replace(' ', 'T')}Z`) : 0;
  return { rev: bootRev, typedMs: Number.isFinite(typedMs) ? typedMs : 0 };
}

function typedAt(guard: DraftGuard | undefined, now: number): number {
  const age = guard?.ageMs;
  return typeof age === 'number' && Number.isFinite(age) && age > 0 ? now - age : now;
}

class DraftsService extends EventEmitter {
  /** The draft's current revision, for a frame that carries the draft. */
  revOf(userId: number, bufferId: number): number {
    return stateOf(userId, bufferId).rev;
  }

  /** A change made outside set/clear (a buffer merge): a new revision, as of now. */
  touch(userId: number, bufferId: number): number {
    return this.stamp(userId, bufferId, Date.now());
  }

  private stamp(userId: number, bufferId: number, typedMs: number): number {
    const rev = ++lastRev;
    states.set(stateKey(userId, bufferId), { rev, typedMs });
    return rev;
  }

  // The guard's verdict: the refusal, or undefined for a write that stands.
  private refuse(
    userId: number,
    bufferId: number,
    guard: DraftGuard | undefined,
    typedMs: number,
  ): Extract<DraftWrite, { error: 'stale' }> | undefined {
    if (!guard) return undefined;
    const state = stateOf(userId, bufferId);
    if (guard.base === state.rev || state.typedMs <= typedMs) return undefined;
    return {
      ok: false,
      error: 'stale',
      bufferId,
      rev: state.rev,
      current: getDraftForBuffer(userId, bufferId),
    };
  }

  set(
    userId: number,
    networkId: number,
    target: string,
    body: unknown,
    reply: DraftReplyRef | null | undefined,
    originWs: unknown = null,
    guard?: DraftGuard,
  ): DraftWrite {
    const text = typeof body === 'string' ? body : '';
    if (text.length === 0 && !reply) return this.clear(userId, networkId, target, originWs, guard);
    const buffer = resolveBuffer(userId, networkId, target);
    if (!buffer) return { ok: false, error: 'unknown-buffer' };
    const typedMs = typedAt(guard, Date.now());
    const refused = this.refuse(userId, buffer.id, guard, typedMs);
    if (refused) return refused;
    const bufferId = upsertDraft(userId, networkId, target, text, reply);
    if (bufferId === undefined) return { ok: false, error: 'unknown-buffer' };
    if (reply === null) {
      // Nothing to read back: the text as sent, no reply.
      const rev = this.stamp(userId, bufferId, typedMs);
      this.emit('change', {
        userId,
        networkId,
        target,
        bufferId,
        body: text,
        reply: null,
        rev,
        originWs,
      });
      return { ok: true, bufferId, rev };
    }
    const stored = getDraftForBuffer(userId, bufferId);
    // A reply sent and not kept: the sender still shows it, so it's told too.
    const dropped = !!reply && !stored?.reply;
    if (!stored?.body && !stored?.reply) {
      // Only a reply, and it didn't hold. Already judged above: no guard.
      return this.clear(userId, networkId, target, dropped ? null : originWs, undefined, typedMs);
    }
    const rev = this.stamp(userId, bufferId, typedMs);
    this.emit('change', {
      userId,
      networkId,
      target,
      bufferId,
      body: stored.body,
      reply: stored.reply,
      rev,
      originWs: dropped ? null : originWs,
    });
    return { ok: true, bufferId, rev };
  }

  clear(
    userId: number,
    networkId: number,
    target: string,
    originWs: unknown = null,
    guard?: DraftGuard,
    typedMs: number = typedAt(guard, Date.now()),
  ): DraftWrite {
    const buffer = resolveBuffer(userId, networkId, target);
    if (!buffer) return { ok: false, error: 'unknown-buffer' };
    const refused = this.refuse(userId, buffer.id, guard, typedMs);
    if (refused) return refused;
    const bufferId = clearDraft(userId, networkId, target);
    if (bufferId === undefined) return { ok: false, error: 'unknown-buffer' };
    const rev = this.stamp(userId, bufferId, typedMs);
    this.emit('change', {
      userId,
      networkId,
      target,
      bufferId,
      body: '',
      reply: null,
      rev,
      originWs,
    });
    return { ok: true, bufferId, rev };
  }

  snapshotForUser(userId: number): unknown[] {
    return listForUser(userId).map((d) => ({ ...d, rev: stateOf(userId, d.bufferId).rev }));
  }
}

const draftsService = new DraftsService();
export default draftsService;

/** The guard a client sent with a draft write, or undefined when it sent none. */
export function parseDraftGuard(raw: { base?: unknown; age?: unknown }): DraftGuard | undefined {
  const base = typeof raw.base === 'number' && Number.isFinite(raw.base) ? raw.base : undefined;
  const ageMs = typeof raw.age === 'number' && Number.isFinite(raw.age) ? raw.age : undefined;
  if (base === undefined && ageMs === undefined) return undefined;
  return { base, ageMs };
}
