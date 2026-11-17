// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineStore } from 'pinia';
import { socketSendWithAck } from '../composables/useSocket.js';
import type { PendingReply } from './replies.js';
import type { DraftReply } from '../../../shared/replies.js';
import { useReplyQuote } from '../composables/useReplyQuote.js';

// Idle-typing debounce before a buffer's draft is flushed to the server.
// Short enough that a typical pause between sentences is plenty to persist
// the line; long enough that a rapid burst of keystrokes coalesces into one
// write. Buffer switch, blur, and submit all force an immediate flush.
const FLUSH_DEBOUNCE_MS = 500;

function key(networkId: number | string, target: string) {
  return `${networkId}::${target}`;
}

// A network buffer's key back to its parts. The network id is the part before
// the first `::` — a channel name may hold `::` itself.
function splitKey(k: string): { networkId: number; target: string } | null {
  const at = k.indexOf('::');
  const networkId = Number(k.slice(0, at));
  if (at <= 0 || !Number.isInteger(networkId)) return null;
  return { networkId, target: k.slice(at + 2) };
}

// What the server stores of a pending reply: the line, and whether the Reply
// put the address in the text. The rest (nick, excerpt) it resolves itself.
function replyRef(
  reply: PendingReply | undefined,
): { messageId: number; addressed: boolean } | null {
  return reply ? { messageId: reply.messageId, addressed: !!reply.addressed } : null;
}

// A draft's reply as the server resolved it, as the composer holds one. Null
// for none, or for a line the server couldn't resolve (gone, not replyable).
//
// The server sends the line as stored; the composer names it as the timeline
// quotes it (useReplyQuote, the one rule): a marked relay bot's line as the
// person inside it — whom the Reply addressed, and whose `nick: ` a cancel takes
// back — and a line from someone ignored since without their words. It's still
// a reply to them; the status bar just doesn't quote them.
export function pendingReplyFrom(
  reply: DraftReply | null | undefined,
  networkId: number | string,
  target: string,
): PendingReply | null {
  if (!reply?.parent) return null;
  const shown = useReplyQuote().shownReply(
    { msgid: '', parent: reply.parent },
    { type: 'message', text: '' },
    Number(networkId),
    target,
  ).parent;
  return {
    messageId: reply.messageId,
    nick: shown?.nick ?? reply.parent.nick,
    type: reply.parent.type,
    text: shown ? shown.text : '',
    self: shown ? shown.self : reply.parent.self,
    addressed: reply.addressed,
  };
}

// Debounce timers and the unflushed-pending tracker live module-local: they
// aren't reactive state, and keeping them out of Pinia means $reset doesn't
// have to handle non-serializable Map entries. `resetTimers()` clears them
// in concert with $reset on logout.
type BufferRef = { networkId: number | string; target: string };
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key -> setTimeout id
// Buffers whose local draft the server has not confirmed it holds. A buffer
// leaves when the server ACKS the flush that carried its current text, not when
// the flush is sent: a frame sent into a closed or dead socket goes nowhere,
// and the snapshot that follows the reconnect would then put the server's
// older copy over what was typed.
const pending = new Map<string, BufferRef>();
// Bumped by every local change, so an ACK can tell whether the text it
// confirms is still the text in the box.
const version = new Map<string, number>();
// The version a flush still waiting on its ACK carried.
const inFlight = new Map<string, number>();
// Flushed, and the server never answered (it may be one that doesn't ACK a
// draft) or said it kept nothing. Not held against another device's update, as
// `pending` is, but a snapshot still doesn't overwrite it, and it is sent
// again behind one.
const unconfirmed = new Map<string, BufferRef>();

function touch(k: string): void {
  version.set(k, (version.get(k) ?? 0) + 1);
}

// The buffer the composer is actively IME-composing into (compositionstart →
// compositionend), or null. Dropping v-model gave the composer live text
// during composition, but also dropped vModelText's beforeUpdate guard that
// deferred WRITES to a composing textarea — this flag re-establishes that
// protection at the store, where every dangerous write originates. While set,
// for that one buffer:
//   - remote updates and snapshot seeds are DROPPED: the in-flight composition
//     is by definition newer (last-write-wins), and the next local flush
//     overwrites the server copy anyway — while a write-through would repaint
//     the focused textarea under a live preedit and destroy the word;
//   - the debounce flush is DEFERRED, so a mid-word pause can't ship raw
//     phonetic preedit as the durable cross-device draft (and `pending` stays
//     armed for the whole composition instead of disarming at the 500ms mark).
// The pagehide beacon still ships the store as-is: a killed app keeps its
// draft, possibly with a trailing preedit — better than losing the line.
let composingKey: string | null = null;

// Mirrors the server's per-buffer drafts table. Server is the source of truth
// on snapshot (initial connect, visibility-resync). Local writes go in
// optimistically and flush on a debounce so the input bar doesn't feel
// rate-limited; `pending` records which buffers the server hasn't confirmed
// yet so a snapshot or a remote-update fan-out won't clobber what the user
// typed.
export const useDraftStore = defineStore('drafts', {
  state: () => ({
    // `${networkId}::${target}` -> body string. Sparse: an empty/unused
    // buffer has no entry. Drives `hasDraft` for the pencil indicator.
    drafts: {} as Record<string, string>,
    // The reply the draft is being written as, same keys (the replies store is
    // its face): part of the draft, so it syncs, flushes and survives a reload
    // with the text — a draft that came back with its `alice: ` and not its
    // reply would go out looking like a reply it wasn't.
    replies: {} as Record<string, PendingReply>,
  }),
  getters: {
    forBuffer: (state) => (networkId: number | string, target: string) =>
      state.drafts[key(networkId, target)] || '',
    // A reply with nothing typed yet (on your own line, in a DM) is a draft too.
    hasDraft: (state) => (networkId: number | string, target: string) => {
      const k = key(networkId, target);
      const body = state.drafts[k];
      return (typeof body === 'string' && body.length > 0) || !!state.replies[k];
    },
    replyForKey:
      (state) =>
      (k: string | null | undefined): PendingReply | null =>
        (k && state.replies[k]) || null,
  },
  actions: {
    // Apply a fresh server snapshot. Buffers with an un-flushed local edit
    // are preserved — last-write-wins should treat the still-pending edit as
    // newer than whatever the snapshot froze.
    seed(list: any[]) {
      const next: Record<string, string> = {};
      const nextReplies: Record<string, PendingReply> = {};
      // A buffer's local state, kept whole — text and reply are one draft.
      const keep = (k: string) => {
        const existing = this.drafts[k];
        if (typeof existing === 'string' && existing.length > 0) next[k] = existing;
        if (this.replies[k]) nextReplies[k] = this.replies[k];
      };
      if (Array.isArray(list)) {
        for (const d of list) {
          if (!d) continue;
          const k = key(d.networkId, d.target);
          if (pending.has(k) || unconfirmed.has(k) || k === composingKey) {
            keep(k);
            continue;
          }
          if (typeof d.body === 'string' && d.body.length > 0) next[k] = d.body;
          const reply = pendingReplyFrom(d.reply, d.networkId, d.target);
          if (reply) nextReplies[k] = reply;
        }
      }
      // Bring along pending-only buffers the snapshot didn't include (typed
      // locally before this client ever flushed, so the server doesn't know
      // about them yet). The composing buffer rides along too: compositionstart
      // fires before the first input event, so there's a gap where it isn't
      // pending yet.
      const held = [...pending.keys(), ...unconfirmed.keys()];
      for (const k of composingKey ? [...held, composingKey] : held) {
        if (next[k] != null || nextReplies[k]) continue;
        keep(k);
      }
      this.drafts = next;
      this.replies = nextReplies;
      // A snapshot is a socket that works. Whatever a flush could not deliver
      // (sent while disconnected, or never answered) goes now, so the server
      // has what the box has. A buffer with a debounce running is still being
      // typed in and goes when that fires.
      for (const [k, ref] of unconfirmed) pending.set(k, ref);
      unconfirmed.clear();
      for (const [k, ref] of pending) {
        if (flushTimers.has(k) || k === composingKey) continue;
        this.flushBuffer(ref.networkId, ref.target);
      }
    },
    // Fan-out from another tab/device. Skip if we have a pending local edit —
    // our debounce will flush momentarily and last-write-wins picks the right
    // one by updated_at.
    // `reply` undefined: the frame had none (an older server) — leave ours.
    applyRemoteUpdate(
      networkId: number | string,
      target: string,
      body: string,
      reply?: DraftReply | null,
    ) {
      const k = key(networkId, target);
      // The composing check is load-bearing on its own: `pending` disarms when
      // the debounced flush fires, which a >500ms mid-word pause used to allow —
      // leaving a remote update free to repaint the focused, composing textarea
      // through the :value binding and destroy the in-flight word.
      if (k === composingKey) return;
      const text = typeof body === 'string' ? body : '';
      // Held off while this buffer has text the server hasn't confirmed, with
      // one exception: the server's answer to the flush now in flight, which it
      // sends when it didn't keep the reply (the line is gone). That one has
      // our own text, so taking it costs nothing typed.
      if (pending.has(k)) {
        const answersOurs =
          inFlight.get(k) === (version.get(k) ?? 0) && text === (this.drafts[k] || '');
        if (!answersOurs) return;
      }
      // The server is alive and this is its newer word on the buffer.
      unconfirmed.delete(k);
      if (text.length > 0) this.drafts[k] = text;
      else delete this.drafts[k];
      if (reply === undefined) return;
      const pendingReply = pendingReplyFrom(reply, networkId, target);
      if (pendingReply) this.replies[k] = pendingReply;
      else delete this.replies[k];
    },
    // The replies store's writes: the reply is part of the draft, so it flushes
    // with it (and holds off remote updates until it has, as typing does).
    setReplyForKey(k: string, reply: PendingReply | null) {
      const parts = splitKey(k);
      if (!parts) return;
      if (reply) this.replies[k] = reply;
      else if (this.replies[k]) delete this.replies[k];
      else return;
      touch(k);
      pending.set(k, parts);
      this.scheduleFlush(parts.networkId, parts.target);
    },
    // Local optimistic write — input bar binds through this. Schedules a
    // debounced WS push to the server.
    setLocal(networkId: number | string, target: string, body: string) {
      const k = key(networkId, target);
      const text = typeof body === 'string' ? body : '';
      if (text.length > 0) this.drafts[k] = text;
      else delete this.drafts[k];
      touch(k);
      pending.set(k, { networkId, target });
      this.scheduleFlush(networkId, target);
    },
    // Force-flush a single buffer's pending write to the server immediately.
    // Called on buffer-switch, input blur, and right before clearing on send.
    flushBuffer(networkId: number | string, target: string) {
      const k = key(networkId, target);
      if (!pending.has(k)) return;
      // Already on its way as it stands; the ACK settles it.
      if (inFlight.get(k) === (version.get(k) ?? 0)) return;
      this.sendForBuffer(networkId, target);
    },
    // Drop in-memory state for a closed buffer. The server-side row is also
    // cleared by wsHub's close-buffer handler, so no flush is needed.
    drop(networkId: number | string, target: string) {
      const k = key(networkId, target);
      delete this.drafts[k];
      delete this.replies[k];
      this.clearTimer(k);
      pending.delete(k);
      unconfirmed.delete(k);
      inFlight.delete(k);
      // Bumped, not deleted: an ACK still on its way must not match.
      touch(k);
      if (composingKey === k) composingKey = null;
    },
    // Lifecycle hooks (lib/bufferLifecycle.ts). rekey moves the body AND the
    // module-level debounce bookkeeping — a pending flush keyed by the dead
    // name would otherwise fire a draft-set for a buffer the server just
    // renamed away.
    dropBuffer(networkId: number | string | null, target: string) {
      if (networkId == null) return;
      this.drop(networkId, target);
    },
    rekeyBuffer(networkId: number | string | null, from: string, to: string) {
      if (networkId == null) return;
      const fromKey = key(networkId, from);
      const toKey = key(networkId, to);
      // Destination wins on a merge collision: if the destination buffer has
      // ANY local draft state (body, pending flush, armed timer), the
      // source's is dropped rather than clobbering what the user typed there
      // — mirroring the server's merge (survivor's non-empty draft wins).
      const destHasState =
        this.drafts[toKey] != null ||
        this.replies[toKey] != null ||
        pending.has(toKey) ||
        unconfirmed.has(toKey) ||
        flushTimers.has(toKey);
      const fromTimer = flushTimers.get(fromKey);
      if (fromTimer) {
        // Never move the old timeout: its closure captured the OLD name.
        clearTimeout(fromTimer);
        flushTimers.delete(fromKey);
      }
      const fromUnconfirmed = unconfirmed.has(fromKey);
      unconfirmed.delete(fromKey);
      inFlight.delete(fromKey);
      touch(fromKey);
      if (destHasState) {
        delete this.drafts[fromKey];
        delete this.replies[fromKey];
        pending.delete(fromKey);
        return;
      }
      if (this.drafts[fromKey] != null) {
        this.drafts[toKey] = this.drafts[fromKey];
        delete this.drafts[fromKey];
      }
      if (this.replies[fromKey] != null) {
        this.replies[toKey] = this.replies[fromKey];
        delete this.replies[fromKey];
      }
      // The server may hold the text under neither name (a flush in flight
      // named the old one), so the moved draft goes again under the new.
      if (pending.has(fromKey) || fromUnconfirmed) {
        pending.delete(fromKey);
        touch(toKey);
        pending.set(toKey, { networkId, target: to });
        this.scheduleFlush(networkId, to);
      }
    },
    // Beacon path used on tab close: ship every un-flushed buffer in one POST
    // since a WS send may already be in teardown. Returns whether anything
    // was actually queued — the sendBeacon return is best-effort either way.
    // Nothing is marked saved here: a beacon isn't answered, and a page that
    // was only hidden comes back still holding these buffers as its own.
    flushAllForBeacon() {
      if (!pending.size && !unconfirmed.size) return false;
      const drafts: {
        networkId: number | string;
        target: string;
        body: string;
        reply: { messageId: number; addressed: boolean } | null;
      }[] = [];
      for (const [k, ref] of [...pending, ...unconfirmed]) {
        const body = this.drafts[k] || '';
        drafts.push({
          networkId: ref.networkId,
          target: ref.target,
          body,
          reply: replyRef(this.replies[k]),
        });
      }
      try {
        // sendBeacon rejects application/json (CORS preflight is not allowed
        // on a beacon), so we ship a text/plain Blob carrying the JSON string
        // and the server JSON.parses it. Same-origin in production, so cookies
        // ride along normally.
        const blob = new Blob([JSON.stringify({ drafts })], { type: 'text/plain;charset=UTF-8' });
        return navigator.sendBeacon('/api/drafts/flush', blob);
      } catch (_) {
        return false;
      }
    },
    // Pinia's $reset wipes `drafts`, but the module-level timers/pending Maps
    // are out of band — useSessionReset calls this so they're cleared too.
    resetTimers() {
      for (const id of flushTimers.values()) clearTimeout(id);
      flushTimers.clear();
      pending.clear();
      unconfirmed.clear();
      inFlight.clear();
      // `version` stays: an ACK still on its way must not match a later draft.
      for (const k of version.keys()) touch(k);
      composingKey = null;
    },
    // The composer's composition handlers. beginComposition marks the buffer;
    // endComposition clears WHICHEVER buffer was marked (buffer-switch and blur
    // call it too, so a missed compositionend can never suppress remote updates
    // forever) and arms the flush that scheduleFlush deferred meanwhile.
    beginComposition(networkId: number | string, target: string) {
      composingKey = key(networkId, target);
    },
    endComposition() {
      if (composingKey == null) return;
      const k = composingKey;
      composingKey = null;
      const ref = pending.get(k);
      if (ref) this.scheduleFlush(ref.networkId, ref.target);
    },
    scheduleFlush(networkId: number | string, target: string) {
      const k = key(networkId, target);
      this.clearTimer(k);
      // Deferred while this buffer is mid-composition: flushing now would ship
      // raw preedit as the durable cross-device draft AND disarm `pending`.
      // endComposition re-arms the flush; `pending` stays set meanwhile.
      if (k === composingKey) return;
      const id = setTimeout(() => {
        flushTimers.delete(k);
        this.sendForBuffer(networkId, target);
      }, FLUSH_DEBOUNCE_MS);
      flushTimers.set(k, id);
    },
    clearTimer(k: string) {
      const id = flushTimers.get(k);
      if (id) {
        clearTimeout(id);
        flushTimers.delete(k);
      }
    },
    sendForBuffer(networkId: number | string, target: string) {
      const k = key(networkId, target);
      this.clearTimer(k);
      const body = this.drafts[k] || '';
      const reply = replyRef(this.replies[k]);
      const sent = version.get(k) ?? 0;
      const ack = socketSendWithAck(
        body.length > 0 || reply
          ? { type: 'draft-set', networkId, target, body, reply }
          : { type: 'draft-clear', networkId, target },
      );
      // No socket: the buffer stays pending, and goes behind the next snapshot.
      if (!ack) return;
      inFlight.set(k, sent);
      void ack.then((result) => {
        if (inFlight.get(k) === sent) inFlight.delete(k);
        // Changed since: this answer is about older text, and the change has
        // its own flush coming.
        if ((version.get(k) ?? 0) !== sent || !pending.has(k)) return;
        // The socket closed under it: stays pending, as with no socket.
        if (!result.ok && result.error === 'disconnected') return;
        pending.delete(k);
        // No answer, or the server kept nothing. Stop holding off other
        // devices, but the next snapshot won't have this text either.
        if (!result.ok) unconfirmed.set(k, { networkId, target });
      });
    },
  },
});
