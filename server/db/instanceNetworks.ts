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
  enabled?: boolean;
}

// channels_json is written by us and only ever holds a JSON string[], but a
// hand-edited DB (or a future schema slip) shouldn't crash every request that
// lists presets — fall back to "no recommended channels" instead of throwing.
function parseChannels(json: string): string[] {
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
    channels: parseChannels(row.channels_json),
    enabled: !!row.enabled,
    position: row.position,
  };
}

// Admin view: every preset, disabled ones included.
export function listInstanceNetworks(): InstanceNetwork[] {
  const rows = db
    .prepare('SELECT * FROM instance_network ORDER BY position, id')
    .all() as InstanceNetworkRow[];
  return rows.map(toInstanceNetwork);
}

// User view: only what's actually on offer. Also the set the lockdown allows —
// see services/networkPolicy.ts, which is the single predicate both the picker
// and the connect path consult, so the UI can never offer something the connect
// would then refuse.
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
         (name, host, port, tls, sasl_likely_required, channels_json, enabled, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.host,
      input.port ?? 6697,
      input.tls === false ? 0 : 1,
      input.saslLikelyRequired ? 1 : 0,
      JSON.stringify(input.channels ?? []),
      input.enabled === false ? 0 : 1,
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
    enabled: patch.enabled ?? existing.enabled,
  };
  db.prepare(
    `UPDATE instance_network
        SET name = ?, host = ?, port = ?, tls = ?, sasl_likely_required = ?,
            channels_json = ?, enabled = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(
    merged.name,
    merged.host,
    merged.port,
    merged.tls ? 1 : 0,
    merged.saslLikelyRequired ? 1 : 0,
    JSON.stringify(merged.channels),
    merged.enabled ? 1 : 0,
    id,
  );
  return getInstanceNetwork(id);
}

export function deleteInstanceNetwork(id: number): boolean {
  return db.prepare('DELETE FROM instance_network WHERE id = ?').run(id).changes > 0;
}
