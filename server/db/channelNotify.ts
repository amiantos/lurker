// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

/** Per-target settings shape returned to callers. */
export interface ChannelNotifyShape {
  notifyAlways: boolean;
}

// Per-(user, network, channel) override. One flag lives here now:
//   notify_always — treat every message in the channel like a notification
//                   trigger for push/toast (no visual highlight).
// The old display-only `muted` flag was folded into the ignore engine as a
// NOUNREAD/NONOTIFY rule (issue #359, so mute now also silences notifications).
// The `muted` column remains in the table (always written 0) for backward-compat
// with older images, but is no longer read or written meaningfully — the boot
// migration in index.ts converts any lingering muted=1 rows into ignore rules.

const getStmt = db.prepare(`
  SELECT notify_always FROM channel_notify_settings
  WHERE user_id = ? AND network_id = ? AND target = ?
`);

const listForUserStmt = db.prepare(`
  SELECT network_id AS networkId, target, notify_always AS notifyAlways
  FROM channel_notify_settings
  WHERE user_id = ? AND notify_always = 1
`);

const upsertStmt = db.prepare(`
  INSERT INTO channel_notify_settings (user_id, network_id, target, notify_always, muted, updated_at)
  VALUES (?, ?, ?, 1, 0, datetime('now'))
  ON CONFLICT(user_id, network_id, target)
  DO UPDATE SET notify_always = 1, updated_at = excluded.updated_at
`);

const deleteStmt = db.prepare(`
  DELETE FROM channel_notify_settings
  WHERE user_id = ? AND network_id = ? AND target = ?
`);

export function getChannelNotifyAlways(userId: number, networkId: number, target: string): boolean {
  const row = getStmt.get(userId, networkId, target) as { notify_always: number } | undefined;
  return !!(row && row.notify_always);
}

/** Flags for a channel — used by the WS layer to broadcast state. */
export function getChannelFlags(
  userId: number,
  networkId: number,
  target: string,
): ChannelNotifyShape {
  return { notifyAlways: getChannelNotifyAlways(userId, networkId, target) };
}

// Map<networkId, { [target]: { notifyAlways } }> snapshot for the whole user,
// shaped to drop straight into the client's channelNotify store.
export function listChannelNotifyForUser(
  userId: number,
): Map<number, Record<string, ChannelNotifyShape>> {
  const byNetwork = new Map<number, Record<string, ChannelNotifyShape>>();
  for (const row of listForUserStmt.all(userId) as Array<{
    networkId: number;
    target: string;
    notifyAlways: number;
  }>) {
    if (!byNetwork.has(row.networkId)) byNetwork.set(row.networkId, {});
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    byNetwork.get(row.networkId)![row.target] = { notifyAlways: !!row.notifyAlways };
  }
  return byNetwork;
}

// Upsert while notify-always is on; delete the row once it's off so we never
// leave an all-default row behind.
export function setChannelNotifyAlways(
  userId: number,
  networkId: number,
  target: string,
  notifyAlways: boolean,
): void {
  if (notifyAlways) {
    upsertStmt.run(userId, networkId, target);
  } else {
    deleteStmt.run(userId, networkId, target);
  }
}
