// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Single source of truth for the per-user export/import contract. Every table
// in the live schema must be declared here as one of:
//
//   - 'export'  → rows are included in the export, with `columns` enumerated
//                 explicitly so a new column added without updating this
//                 registry trips the schema test.
//   - 'partial' → rows are included but with a subset of columns; the rest are
//                 listed in `skippedColumns` with a reason (see `users`).
//   - 'skip'    → table is intentionally not exported, with a `reason` recorded
//                 so future readers know why.
//
// `server/db/exportSchema.test.js` reads sqlite_master + PRAGMA table_info at
// runtime and refuses to pass if any table or column is unaccounted for. Bump
// EXPORT_FORMAT_VERSION when changing the file layout in a way that older
// importers can't tolerate.

export const EXPORT_FORMAT_VERSION = 1;

// Columns holding IRC network secrets that are encrypted at rest on hosted
// cells (see server/utils/secretCrypto.ts). connect_commands is included
// because it routinely carries `/msg NickServ identify <password>` and oper
// passwords — IRCCloud encrypts it for the same reason. Encryption is a no-op
// (plaintext passthrough) unless LURKER_SECRET_KEY is configured, so self-host
// is unaffected.
//
// Lives here (a db-singleton-free module) rather than in db/networks.ts so the
// worker-safe export builder can import it without pulling the db connection
// into a worker thread's import graph. db/networks.ts re-exports it for the
// callers that still reach for it there.
export const ENCRYPTED_NETWORK_COLUMNS = [
  'server_password',
  'sasl_account',
  'sasl_password',
  'connect_commands',
] as const;

// FTS5 maintains its own shadow tables (messages_fts_data, _idx, _content,
// _docsize, _config). Only the virtual `messages_fts` itself surfaces in
// sqlite_master as a row the registry needs to address; the shadows are
// filtered out by the schema test using this prefix.
export const FTS_SHADOW_PREFIXES: string[] = ['messages_fts_'];

// User-identity columns we explicitly don't carry across instances. password
// and role are issued by the target instance; ids/timestamps are local-only.
const USERS_SKIPPED_COLUMNS: Record<string, string> = Object.freeze({
  id: 'autoincrement, remapped to the importing user',
  password_hash: 'new instance issues its own credentials',
  role: 'first-user-becomes-admin rule on the target side reassigns roles',
  last_seen_at: 'tracked locally by each instance',
  created_at: 'tracked locally by each instance',
  is_paused: 'account access state, owned by the local instance / control plane',
});

// scope values control how the exporter filters rows for a given userId.
//   'user_id'      → WHERE user_id = ?
//   'via_network'  → WHERE network_id IN (SELECT id FROM networks WHERE user_id = ?)
//   'via_rules'    → WHERE rule_id   IN (SELECT id FROM highlight_rules WHERE user_id = ?)
//   'identity'     → WHERE id = ? (used for the `users` row only)
//
// rekeyOnImport=true marks tables whose primary key is referenced by other
// tables (via foreign keys we export). The importer rebuilds an
// {oldId → newId} map for each such table and rewrites referencing columns
// before insert.
//
// fkRekey lists FK columns whose values are rewritten through the map of the
// referenced table. Cascade order matters: networks must be inserted before
// channels/messages/etc.; highlight_rules before highlight_rule_networks;
// messages before user_bookmarks.

export const EXPORT_TABLES = Object.freeze({
  users: {
    mode: 'partial',
    scope: 'identity',
    section: 'data',
    columns: ['username'],
    skippedColumns: USERS_SKIPPED_COLUMNS,
    description:
      'Carries only the username so the manifest is human-readable. ' +
      'On import the row is mapped to whoever is logged in on the target instance.',
  },

  networks: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { user_id: 'users' },
    columns: [
      'id',
      'user_id',
      'name',
      'host',
      'port',
      'tls',
      'trusted_certificates',
      'nick',
      'username',
      'realname',
      'server_password',
      'autoconnect',
      'created_at',
      'sasl_account',
      'sasl_password',
      'connect_commands',
      'position',
    ],
  },

  channels: {
    mode: 'export',
    scope: 'via_network',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { network_id: 'networks' },
    columns: ['id', 'network_id', 'name', 'joined', 'created_at'],
  },

  // Friends/contacts. contacts is a rekey root (its id is referenced by
  // contact_targets), so it imports before contact_targets.
  contacts: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { user_id: 'users' },
    columns: ['id', 'user_id', 'display_name', 'notify_online', 'created_at'],
  },

  contact_targets: {
    mode: 'export',
    scope: 'via_network',
    section: 'data',
    fkRekey: { contact_id: 'contacts', network_id: 'networks' },
    columns: ['contact_id', 'network_id', 'nick', 'is_primary'],
  },

  messages: {
    mode: 'export',
    scope: 'via_network',
    section: 'messages',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: {
      network_id: 'networks',
      matched_rule_id: 'highlight_rules',
    },
    columns: [
      'id',
      'network_id',
      'target',
      'time',
      'type',
      'nick',
      'text',
      'kind',
      'self',
      'extra',
      'userhost',
      'matched_rule_id',
      'alt',
      'from_ignored',
    ],
  },

  buffer_reads: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    // Rows ship in data.json with everything else, but on import they're
    // deferred until after messages.ndjson because last_read_message_id
    // needs the messages id map. The importer auto-defers any table whose
    // fkRekey targets 'messages'. Settings-only imports drop these rows
    // (last_read_message_id is NOT NULL — no anchor, no row).
    fkRekey: {
      user_id: 'users',
      network_id: 'networks',
      last_read_message_id: 'messages',
      cleared_before_message_id: 'messages',
    },
    // cleared_before_message_id is a /clear marker, not the read pointer:
    // if the boundary message can't be resolved (missing from the messages
    // map), preserve the row with a NULL marker rather than dropping it
    // and losing the still-valid last_read_message_id alongside.
    fkRekeyNullable: ['cleared_before_message_id'],
    columns: [
      'user_id',
      'network_id',
      'target',
      'last_read_message_id',
      'updated_at',
      'cleared_before_message_id',
      'cleared_at',
    ],
  },

  user_away_state: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users' },
    columns: ['user_id', 'away_datetime', 'back_datetime', 'away_message', 'auto_set'],
  },

  closed_buffers: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'target', 'closed_at'],
  },

  user_settings: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users' },
    columns: ['user_id', 'key', 'value', 'updated_at'],
  },

  highlight_rules: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { user_id: 'users' },
    columns: [
      'id',
      'user_id',
      'pattern',
      'mask',
      'channels',
      'kind',
      'case_sensitive',
      'enabled',
      'auto_managed',
      'created_at',
    ],
  },

  highlight_rule_networks: {
    mode: 'export',
    scope: 'via_rules',
    section: 'data',
    fkRekey: { rule_id: 'highlight_rules', network_id: 'networks' },
    columns: ['rule_id', 'network_id'],
  },

  input_history: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['id', 'user_id', 'network_id', 'target', 'text', 'created_at'],
  },

  upload_history: {
    // 'partial': synced_to_cp and removed are operational/instance-local state
    // (see skippedColumns), so they're left out of the portable contract —
    // which also keeps imports of older archives working: both are
    // INTEGER NOT NULL, and since they're not in the INSERT the DB default (0)
    // applies rather than a NULL that would fail the constraint.
    mode: 'partial',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { user_id: 'users' },
    // thumbnail BLOB is written to thumbnails/<id>.jpg in the zip rather than
    // base64-inlined; the row carries a hasThumbnail boolean in data.json.
    // thumbnail_url (node edition) is a plain string column carried as-is.
    blobColumns: ['thumbnail'],
    columns: [
      'id',
      'user_id',
      'provider',
      'url',
      'filename',
      'mime',
      'byte_size',
      'width',
      'height',
      'thumbnail',
      'thumbnail_url',
      'created_at',
    ],
    skippedColumns: {
      synced_to_cp: 'operational: cell↔control-plane moderation-sync bookkeeping, not portable',
      removed: 'instance/CP-owned moderation state; a fresh instance starts it at the default 0',
    },
  },

  pinned_buffers: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'target', 'position', 'created_at'],
  },

  nicklist_collapsed: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'target', 'collapsed'],
  },

  channel_notify_settings: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'target', 'notify_always', 'muted', 'updated_at'],
  },

  user_drafts: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'target', 'body', 'updated_at'],
  },

  ignored_masks: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: [
      'id',
      'user_id',
      'network_id',
      'mask',
      'channels',
      'pattern',
      'pattern_kind',
      'levels',
      'is_except',
      'expires_at',
      'created_at',
    ],
  },

  user_nick_notes: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'nick', 'note', 'updated_at'],
  },

  user_relay_bots: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    fkRekey: { user_id: 'users', network_id: 'networks' },
    columns: ['user_id', 'network_id', 'nick', 'pattern', 'created_at'],
  },

  user_bookmarks: {
    mode: 'export',
    scope: 'user_id',
    section: 'bookmarks',
    fkRekey: { user_id: 'users', message_id: 'messages' },
    columns: ['user_id', 'message_id', 'created_at'],
  },

  // ---- skipped ----

  sessions: {
    mode: 'skip',
    reason: 'cookie-based session tokens; new instance issues its own',
  },

  webauthn_credentials: {
    mode: 'skip',
    reason:
      'WebAuthn credentials are bound to the source instance origin (RP ID); ' +
      'user must re-register passkeys on the target instance',
  },

  push_subscriptions: {
    mode: 'skip',
    reason:
      'web-push endpoints + VAPID keys are per-server; user re-subscribes per device on the target',
  },

  invite_tokens: {
    mode: 'skip',
    reason: 'admin/instance-scoped invitation state, not user data',
  },

  api_tokens: {
    mode: 'skip',
    reason:
      'bearer-token credentials bound to this instance; user re-issues tokens on the target instance',
  },

  peer_presence_state: {
    mode: 'skip',
    reason: 'transient cache; rebuilt by IRC events on next connect',
  },

  chanlist_channels: {
    mode: 'skip',
    reason: 'transient /LIST result cache; rebuilt on next refresh',
  },

  chanlist_meta: {
    mode: 'skip',
    reason: 'transient /LIST result cache; rebuilt on next refresh',
  },

  messages_fts: {
    mode: 'skip',
    reason: 'FTS5 virtual table; rebuilt automatically by the AFTER INSERT trigger on messages',
  },

  app_meta: {
    mode: 'skip',
    reason: 'instance-level metadata (schema_version, etc.), not user data',
  },

  data_exports: {
    mode: 'skip',
    reason:
      'per-user export job + artifact bookkeeping (status/progress/file path/TTL); ' +
      'instance-local operational state, not portable user data',
  },

  system_messages: {
    mode: 'skip',
    reason:
      'system-buffer log (server lifecycle events + global notices); ' +
      'transient operational state rebuilt by the live instance, not portable user data',
  },

  dcc_transfers: {
    mode: 'skip',
    reason:
      'DCC download-manager state (transfer lifecycle + instance-local destination paths ' +
      'and received-byte progress); operational, not portable — the received files live on ' +
      "the cell's disk (not in the export) and an in-flight transfer can't resume elsewhere",
  },

  user_capabilities: {
    mode: 'skip',
    reason:
      'admin-granted per-user capability grants (e.g. DCC); instance/operator-owned account ' +
      "state reassigned by the target instance's admin, not portable user data",
  },

  // RPE2E keyring (#382). Deliberately NOT in the bulk user data export. The
  // export DECRYPTS at-rest secrets to plaintext for cross-instance portability
  // (see exportService.ts) — so including these would drop the identity PRIVATE
  // KEY into every routine "download my data" artifact. Unlike a rotatable IRC
  // password, a leaked identity key lets someone impersonate you to every peer
  // until you rotate it AND each peer re-verifies your new fingerprint — too
  // high-consequence to bundle by default into an export most users take
  // without even using E2E. Keyring portability is therefore a separate,
  // explicitly-warned `/e2e export` (mirrors repartee's standalone keyring
  // export) that MUST ship when E2E goes live, so migrating users keep their
  // identity + trust pins rather than silently resetting them.
  e2e_identity: {
    mode: 'skip',
    reason:
      'E2E identity private key; cryptographic secret, exported via the dedicated /e2e export',
  },
  e2e_peers: {
    mode: 'skip',
    reason: 'E2E peer TOFU pins; part of the keyring, exported via the dedicated /e2e export',
  },
  e2e_incoming_sessions: {
    mode: 'skip',
    reason: 'E2E per-sender session keys; cryptographic secrets, exported via /e2e export',
  },
  e2e_outgoing_sessions: {
    mode: 'skip',
    reason: 'E2E per-channel session keys; cryptographic secrets, exported via /e2e export',
  },
  e2e_channel_config: {
    mode: 'skip',
    reason: 'E2E per-channel encryption policy; part of the keyring, exported via /e2e export',
  },
  e2e_autotrust: {
    mode: 'skip',
    reason: 'E2E autotrust rules; part of the keyring, exported via /e2e export',
  },
  e2e_outgoing_recipients: {
    mode: 'skip',
    reason: 'E2E key-distribution bookkeeping; transient keyring state, exported via /e2e export',
  },
});

// Insertion order on import. Each table must come after every table it
// references in `fkRekey`. Tables not listed here are inserted in the order
// they appear in EXPORT_TABLES (which already happens to be a valid topo
// order, but listing this explicitly keeps the contract obvious).
export const IMPORT_ORDER = Object.freeze([
  // FK-roots first.
  'networks',
  'channels',
  'highlight_rules',
  'highlight_rule_networks',
  'user_settings',
  'ignored_masks',
  'user_nick_notes',
  'user_relay_bots',
  'pinned_buffers',
  'nicklist_collapsed',
  'channel_notify_settings',
  'user_drafts',
  'closed_buffers',
  'user_away_state',
  'input_history',
  'upload_history',
  // contacts is referenced by contact_targets.
  'contacts',
  'contact_targets',
  // Messages depend on networks and highlight_rules.
  'messages',
  // Bookmarks and buffer_reads depend on messages.
  'user_bookmarks',
  'buffer_reads',
]);

export function listExportedTables(): string[] {
  return Object.entries(EXPORT_TABLES)
    .filter(([, def]) => def.mode === 'export' || def.mode === 'partial')
    .map(([name]) => name);
}

export function listSkippedTables(): string[] {
  return Object.entries(EXPORT_TABLES)
    .filter(([, def]) => def.mode === 'skip')
    .map(([name]) => name);
}
