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

// `encryptedColumns` (declared per-table below) lists columns holding secrets
// that are encrypted at rest on hosted cells (see server/utils/secretCrypto.ts).
// It's the single source of truth for three otherwise-scattered behaviors, so
// adding a newly-encrypted column is one edit here instead of four:
//   - the export DECRYPTS these columns to portable plaintext (exportService.ts)
//   - the import RE-ENCRYPTS them at rest on a keyed cell (importService.ts)
//   - the boot backfill wraps any plaintext left from a keyless window
//     (db/secretBackfill.ts, driven by encryptedColumnsByTable())
// Encryption is a no-op (plaintext passthrough) unless LURKER_SECRET_KEY is
// configured, so self-host is unaffected. Because the export/import loops only
// touch exported tables, declaring encryptedColumns on a `skip` table (the e2e
// keyring) feeds the boot backfill WITHOUT ever decrypting it into an export.
//
// This module is db-singleton-free so the worker-safe export builder can import
// it without pulling the db connection into a worker thread's import graph;
// ENCRYPTED_NETWORK_COLUMNS / ENCRYPTED_CHANNEL_COLUMNS are derived from the
// declarations below and re-exported by db/networks.ts for the runtime CRUD
// paths that still reach for them there.

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
    // connect_commands is encrypted because it routinely carries
    // `/msg NickServ identify <password>` and oper passwords — IRCCloud
    // encrypts it for the same reason.
    encryptedColumns: ['server_password', 'sasl_account', 'sasl_password', 'connect_commands'],
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

  // The buffer registry (replaced channels + closed_buffers; a legacy archive
  // carrying those instead is converted by convertLegacyBuffers in
  // importService). network_id is NULL for app-scoped rows — rekeyRow passes
  // NULL through untouched, while a non-NULL id that isn't in the archive's
  // network map correctly drops the row (NOT fkRekeyNullable, which would
  // morph an orphaned network buffer into an app-scoped one).
  buffers: {
    mode: 'export',
    scope: 'user_id',
    section: 'data',
    pk: 'id',
    rekeyOnImport: true,
    fkRekey: { user_id: 'users', network_id: 'networks' },
    // The +k channel key gates entry to the channel — same credential class as
    // the network secrets, so same at-rest treatment.
    encryptedColumns: ['key'],
    columns: [
      'id',
      'user_id',
      'network_id',
      'target',
      'target_folded',
      'kind',
      'state',
      'autojoin',
      'key',
      'created_at',
      'closed_at',
    ],
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
      'mirrored',
      'notable',
      'msgid',
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
    // uploader_config_id now rides the uploader_config id map (#514): user
    // uploaders survive the trip, so the history row can still say which of them
    // produced a file. It lands NULL when it pointed at an INSTANCE uploader
    // (those aren't exported and the map has no entry) — correct: on the target
    // that upload came from a host the importing user doesn't own.
    fkRekey: { user_id: 'users', uploader_config_id: 'uploader_config' },
    // MUST be nullable: an unmapped FK otherwise makes the importer DROP the row,
    // and rows uploaded through an instance uploader (x0/catbox/local — most of
    // them) have no map entry by design. Nulling the column keeps the upload in
    // the user's history, just without a link to an uploader that isn't theirs.
    fkRekeyNullable: ['uploader_config_id'],
    // thumbnail BLOB is written to thumbnails/<id>.<ext> in the zip rather than
    // base64-inlined; the row carries a hasThumbnail boolean in data.json. The ext
    // is sniffed from the bytes (services/thumbnailFormat.ts) — webp since #560,
    // jpg for everything stored before it, and one archive can hold both.
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
      'uploader_config_id',
      'created_at',
    ],
    skippedColumns: {
      synced_to_cp: 'operational: cell↔control-plane moderation-sync bookkeeping, not portable',
      removed: 'instance/CP-owned moderation state; a fresh instance starts it at the default 0',
      ref:
        'driver-local delete handle (object/disk key). Deliberately NOT carried: the bytes it names ' +
        'live on the SOURCE instance’s disk/bucket, so a reap driven by it on the target would be ' +
        'either a no-op or, worse, aimed at someone else’s object with the same key (#514)',
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

  // A user's OWN configured uploaders (#514). This became exportable the moment
  // the legacy uploads.* user_settings keys were deleted: those keys used to be
  // what carried a user's provider config across an export, and with them gone
  // these rows are the only record of "I upload to my own Zipline".
  //
  // 'partial' because most of the row is deliberately left behind:
  //   - secrets_enc is NOT exported. It's sealed with the SOURCE instance's
  //     LURKER_SECRET_KEY, so on a keyed cell it would be undecryptable garbage on
  //     the target (decryptSecret throws on an unknown key id) — and on a keyless
  //     self-host the envelope is plaintext passthrough, so exporting it would put
  //     the user's catbox userhash / S3 secret key in the clear inside a zip. A
  //     restored uploader therefore arrives credential-less and must be re-entered;
  //     the Uploads pane says so. (Deliberately NOT declared in encryptedColumns:
  //     that would make the exporter decrypt it into data.json, which is the whole
  //     thing we're avoiding.)
  //   - the instance-policy flags are omitted so the DDL defaults apply on insert
  //     (offered_to_users/locked/is_default → 0), which is exactly right for a
  //     personal uploader — an imported row can't smuggle itself in as an offered
  //     instance default. Same trick upload_history uses above.
  // `scope` IS carried (NOT NULL with a CHECK and no default, so omitting it would
  // fail the insert); the exporter only ever selects scope='user' rows, so its
  // value is always the literal 'user'.
  uploader_config: {
    mode: 'partial',
    scope: 'owned_uploaders',
    section: 'data',
    pk: 'id',
    // upload_history.uploader_config_id and the uploads.uploader_id user setting
    // are both rewritten through this map on import.
    rekeyOnImport: true,
    fkRekey: { owner_user_id: 'users' },
    columns: ['id', 'scope', 'owner_user_id', 'driver', 'label', 'config_json', 'created_at'],
    skippedColumns: {
      secrets_enc:
        'credentials sealed with the source instance key: undecryptable on the target when keyed, ' +
        'and plaintext-in-the-zip when not. Re-entered by the user after import (#514)',
      enabled: 'local state; a restored uploader starts enabled (DDL default 1)',
      offered_to_users:
        'instance policy, not user data; DDL default 0 keeps an imported row personal',
      locked: 'instance policy (the hosted operator-managed row); DDL default 0',
      is_default:
        'instance policy; DDL default 0 so an import can never seize the instance default',
      updated_at: 'tracked locally by each instance',
    },
  },

  // ---- skipped ----

  instance_settings: {
    mode: 'skip',
    reason: 'instance-level operational settings (e.g. uploads.allow_user_defined), not user data',
  },

  instance_network: {
    mode: 'skip',
    reason:
      'the networks THIS instance recommends (#298) — admin config, not user data. A user’s own ' +
      'networks live in `networks` and export normally; the presets belong to whichever instance ' +
      'they are imported into, which may recommend something else entirely',
  },

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
  // The three e2e tables carrying sealed key material declare encryptedColumns
  // so the boot backfill (secretBackfill.ts) re-seals any plaintext left from a
  // keyless window — the same treatment networks/channels get. They stay
  // `mode: 'skip'`, so this NEVER decrypts them into the bulk export; the keyring
  // is exported only via the dedicated, explicitly-warned /e2e export.
  e2e_identity: {
    mode: 'skip',
    encryptedColumns: ['privkey'],
    reason:
      'E2E identity private key; cryptographic secret, exported via the dedicated /e2e export',
  },
  e2e_peers: {
    mode: 'skip',
    reason: 'E2E peer TOFU pins; part of the keyring, exported via the dedicated /e2e export',
  },
  e2e_incoming_sessions: {
    mode: 'skip',
    encryptedColumns: ['sk'],
    reason: 'E2E per-sender session keys; cryptographic secrets, exported via /e2e export',
  },
  e2e_outgoing_sessions: {
    mode: 'skip',
    encryptedColumns: ['sk'],
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

// Derived view of the networks `encryptedColumns` declaration above, kept as a
// named export because the runtime CRUD paths in db/networks.ts (read-decrypt,
// write-encrypt) reach for it by name. Deriving it here keeps the schema the
// single source of truth — the declaration and the view can't drift. Channels
// need no analogue: their CRUD encrypts `key` directly without the list.
export const ENCRYPTED_NETWORK_COLUMNS: readonly string[] = EXPORT_TABLES.networks.encryptedColumns;

// { table → encrypted columns } for every table that declares any, regardless of
// export mode. Drives the boot backfill (secretBackfill.ts) so networks,
// channels, and the e2e keyring are all re-sealed from one schema-derived map.
export function encryptedColumnsByTable(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [table, def] of Object.entries(EXPORT_TABLES)) {
    const cols = (def as { encryptedColumns?: readonly string[] }).encryptedColumns;
    if (cols && cols.length > 0) out[table] = [...cols];
  }
  return out;
}

// Insertion order on import. Each table must come after every table it
// references in `fkRekey`. Tables not listed here are inserted in the order
// they appear in EXPORT_TABLES (which already happens to be a valid topo
// order, but listing this explicitly keeps the contract obvious).
export const IMPORT_ORDER = Object.freeze([
  // FK-roots first.
  'networks',
  'buffers',
  'highlight_rules',
  'highlight_rule_networks',
  // Before user_settings (whose `uploads.uploader_id` value is rewritten through
  // this table's id map) and before upload_history (which FK-rekeys against it).
  'uploader_config',
  'user_settings',
  'ignored_masks',
  'user_nick_notes',
  'user_relay_bots',
  'pinned_buffers',
  'nicklist_collapsed',
  'channel_notify_settings',
  'user_drafts',
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
