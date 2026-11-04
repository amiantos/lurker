// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The push log in words (#1272). The server names a gate; a user reads "a
// client was visible". Shared by Settings → Notifications (own rows) and
// Admin → Notifications (everyone's, plus the paste-into-a-bug-report dump).

import { formatDateTime } from './timestamp.js';

export interface PushLogRow {
  id: number;
  user_id: number;
  at: string;
  kind: string;
  network_id: number | null;
  network_name: string | null;
  target: string | null;
  nick: string | null;
  message_id: number | null;
  outcome: 'sent' | 'failed' | 'suppressed';
  reason: string | null;
  transport: string | null;
  device: string | null;
  status: number | null;
  /** Admin rows only. */
  username?: string | null;
}

export interface LiveClient {
  userAgent: string | null;
  connectedAt: string | null;
  visible: boolean;
}

/** What held a push, as a reader would say it. The server's names are the keys. */
export const SUPPRESSED_REASONS: Record<string, string> = {
  visible_client: 'a client was visible',
  no_devices: 'no device is registered',
  kind_disabled: 'this kind of alert is off',
  manual_away: 'muted while away',
  quiet_hours: 'quiet hours',
  oversize: 'too big to send',
  relay_off: 'the relay is off',
  unconfigured: 'the transport has no credentials',
};

const KINDS: Record<string, string> = {
  dm: 'DM',
  highlight: 'highlight',
  always_notify: 'channel activity',
  friend_online: 'friend online',
  kicked: 'kick',
  test: 'test',
};

export function kindLabel(kind: string): string {
  return KINDS[kind] ?? kind;
}

/** "bob (Libera)" for a DM, "alice in #lurker (Libera)" for a channel, "test" for a test. */
export function subjectLabel(row: PushLogRow): string {
  if (row.kind === 'test') return 'test push';
  const net = row.network_name ? ` (${row.network_name})` : '';
  if (row.kind === 'dm' || row.kind === 'friend_online') return `${row.nick || '?'}${net}`;
  if (row.kind === 'kicked') return `kicked from ${row.target || '?'}${net}`;
  return `${row.nick || '?'} in ${row.target || '?'}${net}`;
}

export function deviceLabel(row: PushLogRow): string {
  const what =
    row.transport === 'apns'
      ? 'Lurker for iOS'
      : row.transport === 'fcm'
        ? 'Lurker for Android'
        : row.device || 'device';
  return row.transport === 'webpush' || !row.transport
    ? what
    : `${what} ${row.device || ''}`.trim();
}

/** The outcome column: "sent to push.lurker.chat (201)", "held: quiet hours", "failed: …". */
export function outcomeLabel(row: PushLogRow): string {
  if (row.outcome === 'sent') {
    return `sent to ${deviceLabel(row)}${row.status != null ? ` (${row.status})` : ''}`;
  }
  if (row.outcome === 'failed') {
    return `failed for ${deviceLabel(row)}${row.status != null ? ` (${row.status})` : ''}: ${
      row.reason || 'unknown'
    }`;
  }
  const why = (row.reason && SUPPRESSED_REASONS[row.reason]) || row.reason || 'held';
  // A device-scoped hold names the device; a gate hold is about the account.
  return row.device ? `held for ${deviceLabel(row)}: ${why}` : `held: ${why}`;
}

/**
 * The plain-text dump an admin pastes into a bug report: one line per row,
 * oldest first so it reads as a timeline, every field the server kept.
 */
export function pushLogText(rows: PushLogRow[]): string {
  return rows
    .toReversed()
    .map((r) => {
      const who = r.username ? `${r.username} ` : '';
      return `${r.at} ${who}${kindLabel(r.kind)} ${subjectLabel(r)} — ${outcomeLabel(r)}`;
    })
    .join('\n');
}

/** "Safari on macOS", "Lurker for iOS", or the raw string when nothing matches. */
export function clientLabel(ua: string | null | undefined): string {
  if (!ua) return 'unknown client';
  if (/^Lurker iOS|Lurker\/.*iOS|CFNetwork/.test(ua)) return 'Lurker for iOS';
  if (/^Lurker Android|okhttp/i.test(ua)) return 'Lurker for Android';
  let browser = 'browser';
  if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (browser === 'browser' && !os) return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
  return os ? `${browser} on ${os}` : browser;
}

export function clientText(c: LiveClient): string {
  const since = c.connectedAt ? `since ${formatDateTime(c.connectedAt)}` : '';
  return `${clientLabel(c.userAgent)} — ${c.visible ? 'visible' : 'in the background'} ${since}`.trim();
}
