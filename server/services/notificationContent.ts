// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What a push notification actually SAYS (#490).
//
// This used to live in vue_client/public/sw.js, which was fine while Web Push
// was the only transport: the payload could stay semantic (nick, target, text)
// and the service worker turned it into a title and a body. APNs and FCM have no
// service worker — they want a composed alert on the wire — so the copy has to be
// written here instead.
//
// Note this is composition, not decision. Whether to push at all is maybePush's
// job in wsHub and is genuinely transport-neutral; this is the part that wasn't,
// because it wasn't on the server at all.
//
// The strings below are a deliberate byte-for-byte port of the service worker's,
// so the move was invisible to anyone already running Lurker. sw.js keeps its copy
// and prefers these when present. The raw `text` it composed a body from is no
// longer sent (see PushBody), so a worker cached before #490 phase 2 now shows a
// title alone; its title fields still ride.

import { stripFormatting } from './textMatch.js';

export type PushPayloadKind =
  | 'dm'
  | 'highlight'
  | 'always_notify'
  | 'friend_online'
  | 'kicked'
  // POST /api/push/test (#1272): the user asking whether push reaches this
  // device. Every client renders an unknown kind as title + body (Android files
  // it under Kind.OTHER), so the button needs no app change.
  | 'test';

/**
 * The semantic push payload wsHub hands to pushService. Deliberately typed (it
 * was `unknown`, which was only tenable while every consumer just re-stringified
 * it): a native transport has to READ these fields to build an alert, so a field
 * quietly dropped here is a notification that renders wrong on a device with
 * nothing else failing.
 */
export interface PushPayload {
  kind: PushPayloadKind;
  networkId: number;
  networkName: string;
  target: string;
  /** buffers(id) the notification points at, so a tap on a COLD app can launch
   *  straight into `/buffer/<id>` (#744) instead of a name-carrying query
   *  string. Optional: a handful of synthetic events are never persisted and so
   *  have no row, and sw.js falls back to the name form for those. */
  bufferId?: number;
  nick?: string | null;
  text?: string | null;
  time?: string;
  messageId?: number | null;
  /** friend_online only. Under buffer favorites it always equals `target` —
   *  the field survives for the sw.js/iOS payload shape (and its parity test). */
  displayName?: string | null;
  /** Unread-highlight total for the app icon; absent when it can't have changed. */
  badge?: number;
}

export interface NotificationContent {
  title: string;
  body: string;
  /**
   * Collapse key: later notifications for the same buffer replace earlier ones
   * rather than stacking. Maps to the Notification API's `tag` on Web Push and
   * `aps.thread-id` on APNs. On FCM it rides in the data map and the app passes
   * it to its own notify() call — see buildFcmMessage.
   */
  tag: string;
}

/**
 * Everything a notification needs, as one flat object: the semantic payload plus
 * the composed copy. This is the Web Push message body, and the FCM data map is
 * the same keys stringified, so one renderer on the device reads either. That
 * matters beyond today's two transports: a push relayed for a self-hosted server
 * (#1045) arrives as an encrypted Web Push body, and the app decrypts it to
 * exactly this object.
 *
 * Without the raw `text`: `body` is the same words with the formatting stripped,
 * and every reader shows `body`. The raw copy only served a service worker cached
 * before #490 phase 2 (July 2026), which composed locally; such a worker now shows
 * the title alone. It doubled the largest field on a wire capped at 4 KB, and a
 * relayed push has to fit an APNs payload once encrypted and encoded.
 *
 * Composed fields spread LAST, so they win a name clash.
 */
export type PushBody = Omit<PushPayload, 'text'> & NotificationContent;

export function pushBody(payload: PushPayload, content: NotificationContent): PushBody {
  const { text: _text, ...semantic } = payload;
  return { ...semantic, ...content };
}

/**
 * How long a push is worth delivering, in seconds: an undelivered push expires
 * after this rather than the four weeks web-push and FCM default to. A DM that
 * reaches a phone switched on two weeks later is noise, not news. Mastodon uses
 * the same 48 hours.
 */
export const PUSH_TTL_SECONDS = 48 * 60 * 60;

// "nostimo came online (Libera)". Byte-for-byte the composition sw.js's
// legacyTitle applies (the parity suite runs the real worker against this).
// The "(as nick)" branch is vestigial under buffer favorites — displayName
// always equals target now — but a stale cached worker still carries it, so
// the server keeps the identical expression rather than a simplification the
// worker would disagree with on a crafted payload.
function friendOnlineTitle(payload: PushPayload): string {
  const name = payload.displayName || 'A friend';
  const parts: string[] = [];
  if (payload.target && String(payload.target).toLowerCase() !== name.toLowerCase()) {
    parts.push(`as ${payload.target}`);
  }
  if (payload.networkName) parts.push(payload.networkName);
  return `${name} came online${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

// "bob kicked you from #lurker (Libera)", with the kick reason as the body
// (#968). `nick` is the KICKER — the one useful name here, since the kicked
// party is by definition the reader. It's spelled out rather than folded into
// the "<nick> in <target>" shape every other channel notification uses, because
// this one is not a message someone sent to a room you're in: it's the room
// telling you you're out of it, and it has to read that way at a glance on a
// lock screen. A server-issued kick carries no nick, hence the second branch.
function kickedTitle(payload: PushPayload): string {
  const where = payload.target || 'a channel';
  const who = payload.nick ? `${payload.nick} kicked you` : 'You were kicked';
  return `${who} from ${where}${payload.networkName ? ` (${payload.networkName})` : ''}`;
}

function title(payload: PushPayload): string {
  // A DM is already identified by its sender, so the target would just repeat the
  // nick; a channel highlight needs to say where it happened.
  if (payload.kind === 'dm') {
    return `${payload.nick || 'someone'}${payload.networkName ? ' (' + payload.networkName + ')' : ''}`;
  }
  if (payload.kind === 'friend_online') return friendOnlineTitle(payload);
  if (payload.kind === 'kicked') return kickedTitle(payload);
  if (payload.kind === 'test') return 'Test notification';
  return `${payload.nick || 'someone'} in ${payload.target || ''}`;
}

/**
 * The most message body a push carries (formatting stripped), measured as
 * JSON-encoded UTF-8 bytes —
 * how the transports measure it. Every transport caps the whole message at 4 KB
 * (Web Push's encrypted record, the APNs payload, FCM's message), and a relayed
 * push must also fit an APNs payload once encrypted and encoded (#1045). An
 * inbound draft/multiline batch is reassembled into one message, so a pasted
 * block can be several KB on its own. Raw bytes undercount: the control characters
 * stripping leaves (a CTCP `\x01`, a bell) JSON-escape to six bytes each. Over
 * the cap, Web Push answers 413 and FCM answers INVALID_ARGUMENT — a failed push
 * either way. 1 KB is more than a lock screen shows, and leaves room for the
 * title and routing keys. The app opens the full message on tap.
 */
export const MAX_PUSH_TEXT_BYTES = 1024;

/**
 * The most network name a push carries, same measure. The name is user-entered
 * with no length limit, and rides twice (`networkName`, and inside `title`), so
 * a long one would overflow the 4 KB cap with no message text at all. IRC
 * bounds the other names (nick, target) on the wire; this one it doesn't.
 */
export const MAX_PUSH_NETWORK_NAME_BYTES = 128;

const ELLIPSIS = '…';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** What `s` costs inside a JSON string, in UTF-8 bytes (no quotes). */
function jsonBytes(s: string): number {
  return Buffer.byteLength(JSON.stringify(s)) - 2;
}

/**
 * Cut `text` to the push budget, marking the cut with an ellipsis. Cuts between
 * graphemes, so an emoji sequence or a flag is never split into its parts.
 */
export function clampPushText(text: string, maxBytes = MAX_PUSH_TEXT_BYTES): string {
  if (jsonBytes(text) <= maxBytes) return text;
  const budget = maxBytes - jsonBytes(ELLIPSIS);
  let out = '';
  let bytes = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = jsonBytes(segment);
    if (bytes + size > budget) break;
    out += segment;
    bytes += size;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * The most `pushBody()` JSON a push may carry, in UTF-8 bytes. The tightest
 * transport sets it: a push relayed for a self-hosted server
 * (lurker-dev/RELAY_PLAN.md §6.2) arrives as an APNs payload — capped at 4 KB —
 * holding the encrypted body base64url-encoded beside the relay's placeholder
 * alert. aes128gcm adds an 86-byte header, a padding delimiter and a 16-byte tag
 * (RFC 8188/8291). Fitting this fits every other transport too: Web Push and FCM
 * also cap at 4 KB, and carry the same fields without the encoding.
 */
export const RELAY_APNS_WRAPPER = JSON.stringify({
  aps: { alert: { title: 'Lurker', body: 'New message' }, 'mutable-content': 1, sound: 'default' },
  p: '',
});
const APNS_PAYLOAD_BYTES = 4096;
const AES128GCM_OVERHEAD_BYTES = 86 + 1 + 16;
export const MAX_PUSH_BODY_BYTES =
  Math.floor(((APNS_PAYLOAD_BYTES - Buffer.byteLength(RELAY_APNS_WRAPPER)) * 3) / 4) -
  AES128GCM_OVERHEAD_BYTES;

/**
 * Shorten a push until its body fits MAX_PUSH_BODY_BYTES. The per-field clamps
 * keep ordinary pushes far under it, but names IRC leaves unbounded — a long
 * UTF-8 channel or nick — repeat across `target`, `tag`, `nick` and the title,
 * and a kick puts all of them in the title at once. Over the cap a push service
 * refuses the push, and the server counts that against the device.
 *
 * Cuts what matters least first: the message text (the app opens the whole line
 * on tap), then the title, then the names it repeats. Routing — networkId,
 * target, bufferId, tag — is never cut: a shortened target would open the wrong
 * buffer. So `fits` can still be false: a channel name of control characters
 * (six bytes each, JSON-escaped) rides in `target` and `tag` and alone can
 * overflow. The caller drops such a push rather than send one that's refused.
 */
export function fitPushBody(
  payload: PushPayload,
  content: NotificationContent,
): { payload: PushPayload; content: NotificationContent; fits: boolean } {
  let p = payload;
  let c = content;
  const over = () => Buffer.byteLength(JSON.stringify(pushBody(p, c))) - MAX_PUSH_BODY_BYTES;
  const fields: [get: () => string, set: (v: string) => void][] = [
    [() => c.body, (v) => (c = { ...c, body: v })],
    [() => c.title, (v) => (c = { ...c, title: v })],
    [() => p.nick ?? '', (v) => (p = { ...p, nick: v })],
    [() => p.displayName ?? '', (v) => (p = { ...p, displayName: v })],
  ];
  for (const [get, set] of fields) {
    while (over() > 0 && get()) {
      const limit = jsonBytes(get()) - over();
      // Too little room for the ellipsis itself: empty the field, rather than
      // "shorten" it to an ellipsis that's longer than what it replaced.
      const next = limit < jsonBytes(ELLIPSIS) ? '' : clampPushText(get(), limit);
      if (next === get()) break;
      set(next);
    }
  }
  return { payload: p, content: c, fits: over() <= 0 };
}

/**
 * Everything deliver() does to a payload before any transport sees it: the
 * network-name clamp, composition, and the final fit. Exported so the relay test
 * vectors are built by the same code the server sends with.
 */
export function prepareNotification(message: PushPayload): {
  payload: PushPayload;
  content: NotificationContent;
  fits: boolean;
} {
  // The network name is user-entered with no limit — see MAX_PUSH_NETWORK_NAME_BYTES.
  // (The body is clamped where it's composed, on the words that go on the wire.)
  const payload: PushPayload = {
    ...message,
    networkName: clampPushText(message.networkName, MAX_PUSH_NETWORK_NAME_BYTES),
  };
  return fitPushBody(payload, composeNotification(payload));
}

function bufferTag(payload: PushPayload): string {
  return `${payload.networkId || 0}::${(payload.target || '').toLowerCase()}`;
}

export function composeNotification(payload: PushPayload): NotificationContent {
  return {
    title: title(payload),
    // friend_online carries no text, so its body is empty — the title says it all.
    // Strip mIRC formatting codes (\x03 colors, \x02 bold, …): a native alert
    // renders body as plain text, so the codes would otherwise arrive as literal
    // control chars on the lock screen (#606).
    // Clamped here, on the words that go on the wire, not on the raw text: a
    // formatting-heavy line would otherwise be cut for codes the body never carries.
    body: clampPushText(stripFormatting(payload.text || '')),
    // Presence transitions collapse among THEMSELVES, never with the peer's
    // message notifications: the shared per-buffer tag meant "bob came online"
    // silently REPLACED an unread "bob: hey" alert on a connection flap (the
    // collapse key swaps content instead of stacking). A contacts-era quirk,
    // fixed on revival rather than inherited. A kick gets its own suffix for the
    // same reason and it matters more here: a collapse key shared with the
    // channel would let the next line in a channel you were just removed from
    // REPLACE the notification telling you that you were removed.
    //
    // The target is case-folded (house style: toLowerCase): IRC sends `Bob` and
    // `bob` for the same buffer, and two spellings would be two tags — two
    // notifications for one buffer instead of the newer replacing the older.
    tag:
      payload.kind === 'friend_online'
        ? `${bufferTag(payload)}::presence`
        : payload.kind === 'kicked'
          ? `${bufferTag(payload)}::kick`
          : payload.kind === 'test'
            ? 'test'
            : bufferTag(payload),
  };
}
