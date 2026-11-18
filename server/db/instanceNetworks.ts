// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin-defined network presets (#298) — the networks this instance recommends.
// A preset is a *template*, not a connection: users instantiate one into their
// own `networks` row. See the instance_network schema comment in db/index.ts for
// why this isn't a scope column on `networks`.

import db from './index.js';

export interface InstanceNetworkRow {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: number;
  sasl_likely_required: number;
  channels_json: string;
  tags_json: string;
  users: number | null;
  channel_count: number | null;
  enabled: number;
  position: number;
  created_at: string;
  updated_at: string;
}

// The wire shape. Deliberately camelCase and deliberately close to the client's
// BuiltinNetwork, so the picker can merge instance presets and bundled builtins
// into one list without a translation layer on either side.
export interface InstanceNetwork {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  saslLikelyRequired: boolean;
  channels: string[];
  /** Browse tags, as a builtin's card shows them. */
  tags: string[];
  /** How many people are on the network, as the admin gave it. */
  users: number | null;
  /** How many channels. `channelCount` because `channels` is the recommended list. */
  channelCount: number | null;
  /** Always true. A network that is listed is offered; the field outlives the
   *  switch it reported so nothing reading the wire shape has to change. */
  enabled: boolean;
  position: number;
}

export interface InstanceNetworkInput {
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  saslLikelyRequired?: boolean;
  channels?: string[];
  tags?: string[];
  /** null clears a count; absent leaves it. */
  users?: number | null;
  channelCount?: number | null;
}

// channels_json and tags_json are written by us and only ever hold a JSON
// string[], but a hand-edited DB (or a future schema slip) shouldn't crash every
// request that lists presets — fall back to an empty list instead of throwing.
function parseStrings(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

export function toInstanceNetwork(row: InstanceNetworkRow): InstanceNetwork {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    tls: !!row.tls,
    saslLikelyRequired: !!row.sasl_likely_required,
    channels: parseStrings(row.channels_json),
    tags: parseStrings(row.tags_json),
    users: row.users,
    channelCount: row.channel_count,
    enabled: !!row.enabled,
    position: row.position,
  };
}

// Every preset. There is no disabled one: see `enabled` above.
export function listInstanceNetworks(): InstanceNetwork[] {
  const rows = db
    .prepare('SELECT * FROM instance_network ORDER BY position, id')
    .all() as InstanceNetworkRow[];
  return rows.map(toInstanceNetwork);
}

// User view: what's on offer, which is all of them. Also the set the lockdown
// allows — see services/networkPolicy.ts, the single predicate both the picker
// and the connect path consult, so the UI can never offer something the connect
// would then refuse. Its own name because those callers mean "offered", and the
// filter guards a row written with enabled = 0 by anything but this module.
export function listEnabledInstanceNetworks(): InstanceNetwork[] {
  return listInstanceNetworks().filter((n) => n.enabled);
}

export function getInstanceNetwork(id: number): InstanceNetwork | null {
  const row = db.prepare('SELECT * FROM instance_network WHERE id = ?').get(id) as
    | InstanceNetworkRow
    | undefined;
  return row ? toInstanceNetwork(row) : null;
}

export function createInstanceNetwork(input: InstanceNetworkInput): InstanceNetwork {
  // New presets land at the bottom of the picker rather than silently jumping
  // the queue ahead of ones the admin already ordered.
  const { next } = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM instance_network')
    .get() as { next: number };
  const result = db
    .prepare(
      `INSERT INTO instance_network
         (name, host, port, tls, sasl_likely_required, channels_json, tags_json, users,
          channel_count, enabled, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.host,
      input.port ?? 6697,
      input.tls === false ? 0 : 1,
      input.saslLikelyRequired ? 1 : 0,
      JSON.stringify(input.channels ?? []),
      JSON.stringify(input.tags ?? []),
      input.users ?? null,
      input.channelCount ?? null,
      1,
      next,
    );
  return getInstanceNetwork(Number(result.lastInsertRowid))!;
}

export function updateInstanceNetwork(
  id: number,
  patch: Partial<InstanceNetworkInput>,
): InstanceNetwork | null {
  const existing = getInstanceNetwork(id);
  if (!existing) return null;
  const merged = {
    name: patch.name ?? existing.name,
    host: patch.host ?? existing.host,
    port: patch.port ?? existing.port,
    tls: patch.tls ?? existing.tls,
    saslLikelyRequired: patch.saslLikelyRequired ?? existing.saslLikelyRequired,
    channels: patch.channels ?? existing.channels,
    tags: patch.tags ?? existing.tags,
    users: patch.users !== undefined ? patch.users : existing.users,
    channelCount: patch.channelCount !== undefined ? patch.channelCount : existing.channelCount,
  };
  db.prepare(
    `UPDATE instance_network
        SET name = ?, host = ?, port = ?, tls = ?, sasl_likely_required = ?,
            channels_json = ?, tags_json = ?, users = ?, channel_count = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.host,
    merged.port,
    merged.tls ? 1 : 0,
    merged.saslLikelyRequired ? 1 : 0,
    JSON.stringify(merged.channels),
    JSON.stringify(merged.tags),
    merged.users,
    merged.channelCount,
    id,
  );
  return getInstanceNetwork(id);
}

export function deleteInstanceNetwork(id: number): boolean {
  return db.prepare('DELETE FROM instance_network WHERE id = ?').run(id).changes > 0;
}
