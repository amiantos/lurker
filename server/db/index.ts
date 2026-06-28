// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { isNodeMode } from '../utils/edition.js';
import { foldBufferCase } from './foldBufferCase.js';

// Guardrail: under vitest, refuse to fall back to the real database. A test
// that forgets to isolate DATABASE_PATH would otherwise open data/lurker.db and
// write into it — exactly how ircConnection.test.ts leaked "Joined #anime" rows
// into the operator's prod DB. Fail loud instead of silently polluting.
// (server/test-utils/isolateDb.ts is the fix for static-import test files.)
if (process.env.VITEST && !process.env.DATABASE_PATH) {
  throw new Error(
    'db/index.ts: refusing to open the production database (data/lurker.db) under test. ' +
      'Set DATABASE_PATH to an isolated path — import server/test-utils/isolateDb.ts first, ' +
      'or use the set-env-then-dynamic-import pattern.',
  );
}
const dbPath = process.env.DATABASE_PATH || path.join(import.meta.dirname, '../../data/lurker.db');
// Absolute path to the SQLite file, exported so the export worker can open its
// own readonly connection to the exact same database (and so exportJobs can
// site the data/exports/ artifact dir next to it) without re-deriving the path.
export const DATABASE_FILE = dbPath;
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
// WAL leaves synchronous at FULL, which fsyncs on every auto-commit write — and
// better-sqlite3 is synchronous on the main thread, so that fsync blocks the same
// event loop serving WS fan-out, IRC socket reads, and HTTP. NORMAL is safe under
// WAL (a power-loss can lose only the last transaction, never corrupt the file)
// and lifts the fsync off the hot path — the dominant win for a cell absorbing a
// netsplit's burst of membership-churn inserts, which arrive correlated across
// every tenant on the same network at once.
db.pragma('synchronous = NORMAL');
// Don't let a transient lock (a WAL checkpoint, or any future second connection)
// surface as an immediate SQLITE_BUSY throw — wait up to 5s for it to clear.
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS networks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 6697,
      tls INTEGER NOT NULL DEFAULT 1,
      trusted_certificates INTEGER NOT NULL DEFAULT 1,
      nick TEXT NOT NULL,
      username TEXT,
      realname TEXT,
      server_password TEXT,
      autoconnect INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_networks_user ON networks(user_id);

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      joined INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (network_id, name),
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channels_network ON channels(network_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      nick TEXT,
      text TEXT,
      kind TEXT,
      self INTEGER NOT NULL DEFAULT 0,
      extra TEXT,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_buffer ON messages(network_id, target, id DESC);

    -- network_id is nullable: NULL keys the app-scoped system buffer (#355),
    -- which has no network. The composite PK stays (network buffers dedupe on it,
    -- and migrations like foldBufferCase use it as an ON CONFLICT target), but a
    -- composite PK treats a NULL network_id as distinct — so the system buffer's
    -- row is instead deduped by the coalesced index idx_buffer_reads_key (created
    -- near the end of this file), which the runtime upserts target.
    CREATE TABLE IF NOT EXISTS buffer_reads (
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      target TEXT NOT NULL,
      last_read_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_before_message_id INTEGER,
      cleared_at TEXT,
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_buffer_reads_user ON buffer_reads(user_id);

    -- User-level self-presence state. /away applies across every IRC connection
    -- the user has, so the truth lives once per user. The completed-pair shape
    -- (both away_datetime and back_datetime set, kept until the next /away) is
    -- what lets a returning client render both markers — "you went away here"
    -- and "you came back here" — anchored by message timestamps. auto_set
    -- preserves the manual-vs-auto distinction across server restarts so the
    -- reconnect re-assert and the auto-clear-on-socket-return paths keep
    -- working correctly after a process bounce.
    CREATE TABLE IF NOT EXISTS user_away_state (
      user_id INTEGER PRIMARY KEY,
      away_datetime TEXT,
      back_datetime TEXT,
      away_message TEXT,
      auto_set INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS closed_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_closed_buffers_user ON closed_buffers(user_id);

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- A highlight rule marks a matching message (line accent + sidebar dot).
    -- pattern is the keyword/regex (NULL for a pure mask rule); mask is an
    -- optional nick!user@host glob that highlights every message from matching
    -- senders; channels is an optional CSV scope. Network scope lives in the
    -- highlight_rule_networks junction (no rows = global). kind is the unified
    -- substr / full / regex vocabulary shared with ignore rules (glob rows still
    -- match for back-compat).
    CREATE TABLE IF NOT EXISTS highlight_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pattern TEXT,
      mask TEXT COLLATE NOCASE,
      channels TEXT,
      kind TEXT NOT NULL DEFAULT 'full',
      case_sensitive INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      auto_managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_highlight_rules_user ON highlight_rules(user_id);

    -- Auto-nick rules can be claimed by multiple networks (one rule per
    -- (user, nick) pattern, attached to every network that uses that nick).
    CREATE TABLE IF NOT EXISTS highlight_rule_networks (
      rule_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      PRIMARY KEY (rule_id, network_id),
      FOREIGN KEY (rule_id) REFERENCES highlight_rules(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_highlight_rule_networks_network
      ON highlight_rule_networks(network_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS input_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_input_history_buffer
      ON input_history(user_id, network_id, target, id DESC);

    CREATE TABLE IF NOT EXISTS invite_tokens (
      token TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL,
      expires_at TEXT,
      used_by_user_id INTEGER,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invite_tokens_unused
      ON invite_tokens(token) WHERE used_by_user_id IS NULL;

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

    -- Per-network cache of /LIST results. Populated by ircConnection on each
    -- explicit refresh, then served as paginated search slices via wsHub.
    -- COLLATE NOCASE on name handles ASCII channel-name search; topic uses
    -- LIKE COLLATE NOCASE without an index (≤low thousands of rows per
    -- network after the network_id filter, scan is fine).
    CREATE TABLE IF NOT EXISTS chanlist_channels (
      network_id INTEGER NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      topic TEXT,
      num_users INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (network_id, name),
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chanlist_users
      ON chanlist_channels(network_id, num_users DESC);

    CREATE TABLE IF NOT EXISTS chanlist_meta (
      network_id INTEGER PRIMARY KEY,
      fetched_at TEXT,
      in_progress INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );

    -- Per-user log of every successful image upload. Thumbnail is a 128² JPEG
    -- generated at upload time and served back via /api/uploads/:id/thumb,
    -- so the recent-uploads modal stays cheap even if the original lives on a
    -- third-party host. provider is the upload destination ('hoarder', 'catbox',
    -- 'x0') so the modal can label rows and so we know whether to attempt any
    -- provider-side delete (none today; tracked as a follow-up).
    CREATE TABLE IF NOT EXISTS upload_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT,
      mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      thumbnail BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_upload_history_user
      ON upload_history(user_id, id DESC);

    -- Per-(network, nick) presence state for DM peers. Single row per peer
    -- holding only the most recent transition event (state) and when it
    -- happened (state_at). state is one of: online, offline, away, back.
    -- Marker rendering is singular — whichever transition fired last wins.
    -- nick collates NOCASE so WHOIS case-flips dont fragment.
    CREATE TABLE IF NOT EXISTS peer_presence_state (
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      state TEXT NOT NULL,
      state_at TEXT NOT NULL,
      PRIMARY KEY (network_id, nick),
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );

    -- Per-(user, network) pinned buffer list. Pinned channels/DMs float to the
    -- top of the sidebar in user-controlled order; position is a dense integer
    -- scoped per (user_id, network_id), rewritten in full on each reorder so we
    -- don't have to chase sparse gaps. Pin survives part (the channel stays in
    -- the sidebar) but not close — the client filters the pinned section by
    -- open buffers, so a row without an open buffer is invisible and would
    -- desync the client's pin set from ours. Close-buffer therefore implies
    -- unpin (see wsHub close-buffer handler).
    CREATE TABLE IF NOT EXISTS pinned_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_buffers_user_net
      ON pinned_buffers(user_id, network_id, position);

    -- Per-(user, network, channel) override for the desktop nicklist's
    -- collapsed state. Only channels the user has explicitly toggled get a
    -- row; absent a row the global look.layout.show_member_list default
    -- applies. collapsed is 1 (hidden) or 0 (shown).
    CREATE TABLE IF NOT EXISTS nicklist_collapsed (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      collapsed INTEGER NOT NULL,
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );

    -- Per-(user, network, channel) notification settings. Today only the
    -- always_notify flag lives here ("treat every message in this channel
    -- like a highlight for push/toast purposes"); future per-channel notify
    -- prefs (mute, sound override, etc.) can be added as columns. Absent a
    -- row, all flags default to 0.
    CREATE TABLE IF NOT EXISTS channel_notify_settings (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      notify_always INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );

    -- Slack-style per-buffer draft storage. Each row is the half-typed input
    -- for one (user, network, target). Sparse — only buffers with a non-empty
    -- body have a row; clearing the draft (send, manual clear, or empty body
    -- after edits) deletes the row outright. updated_at is the last-write-wins
    -- key for resolving cross-device races. Cascades on user and network so
    -- account/network deletion cleans up implicitly.
    CREATE TABLE IF NOT EXISTS user_drafts (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_drafts_user ON user_drafts(user_id);

    -- Per-user ignore list, irssi-style (issue #301, scoping #350). network_id
    -- NULL = a global rule that applies on every network (the default); a real
    -- network_id scopes the rule to that one network. A rule AND-s optional
    -- dimensions: mask (NULL/'*' = anyone; a bare nick globs the nick,
    -- a nick!user@host form globs the hostmask), channels (NULL = all buffers;
    -- else CSV of channel globs), pattern (NULL = any text; matched per
    -- pattern_kind 'substr'|'full'|'regex'), and levels (CSV of event-type
    -- tokens, e.g. 'ALL' or 'JOINS,PARTS,QUITS' or 'PUBLIC,NOHIGHLIGHT'). is_except
    -- makes a longest-mask-wins whitelist rule; expires_at auto-removes it.
    -- mask collates NOCASE so /ignore Bozo and /ignore bozo fold together. No
    -- UNIQUE constraint: the same mask may carry different levels/channels.
    CREATE TABLE IF NOT EXISTS ignored_masks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER,
      mask TEXT COLLATE NOCASE,
      channels TEXT,
      pattern TEXT,
      pattern_kind TEXT NOT NULL DEFAULT 'substr',
      levels TEXT NOT NULL DEFAULT 'ALL',
      is_except INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ignored_masks_user_net
      ON ignored_masks(user_id, network_id);

    -- Per-(user, network, nick) free-form notes about a contact — "lives in
    -- Berlin", spouse's name, whatever the operator wants to remember about
    -- the person behind a nick. nick collates NOCASE so case-flips don't
    -- fragment; same nick on different networks gets its own row because
    -- the people may not be the same.
    CREATE TABLE IF NOT EXISTS user_nick_notes (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      note TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, nick),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_nick_notes_user_net
      ON user_nick_notes(user_id, network_id);

    -- Per-(user, network, nick) relay-bot marks (#277). A marked nick is a
    -- relay / bridge bot; the client re-attributes its messages to the speaker
    -- embedded in the envelope, e.g. [Discord] <alice> hi. Row presence is the
    -- mark; the pattern column is an optional custom template (empty = built-in
    -- defaults). Same NOCASE / per-network keying as notes.
    CREATE TABLE IF NOT EXISTS user_relay_bots (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      pattern TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, nick),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_relay_bots_user_net
      ON user_relay_bots(user_id, network_id);

    -- Friends / watch-list. A "contact" is a person, network-agnostic: it carries
    -- the display name and the per-contact "toast me when they come online" flag.
    -- contact_targets is the watch list — which (network, nick) to follow for
    -- this person. A contact can have several nicks per network (alts/ghosts/
    -- bouncer connections) and nicks across networks, so the key includes nick.
    -- nick collates NOCASE; is_primary marks the one DM that opens on click.
    -- Both cascade on user/network delete.
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      notify_online INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

    CREATE TABLE IF NOT EXISTS contact_targets (
      contact_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (contact_id, network_id, nick),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contact_targets_net_nick
      ON contact_targets(network_id, nick);

    -- Per-(user, message) bookmarks. Operator hits "Save" on a message in the
    -- context menu to pin it for later recall via the bookmarks modal. The
    -- message_id FK cascades, so bookmarks evaporate when their underlying
    -- network/buffer is deleted — no orphan rows pointing at vanished history.
    -- Authorization on insert is enforced at the query layer (the message must
    -- belong to one of the caller's networks).
    CREATE TABLE IF NOT EXISTS user_bookmarks (
      user_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, message_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_bookmarks_user_msg
      ON user_bookmarks(user_id, message_id DESC);

    -- Per-user bearer tokens for the HTTP API + MCP server. token_hash is the
    -- hex SHA-256 of the raw token; the raw value is shown once at creation
    -- time and never stored. scope is 'read' (read-only verbs) or 'read-write'
    -- (also allows send/set verbs). Revocation is soft via revoked_at so the
    -- admin UI can still display the token name in the historical list.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

    -- Per-user data-export jobs. A request to export account data spawns a
    -- background worker (separate readonly SQLite connection) that builds the
    -- .lurk archive to disk under data/exports/<token>.lurk; the row tracks
    -- status/progress/artifact so a "ready" export survives reloads and an
    -- interrupted job is recoverable after a restart. status is one of
    -- 'pending' | 'running' | 'done' | 'error'. token names the on-disk file
    -- (unguessable); the download endpoint still gates on session + ownership.
    -- expires_at drives the TTL sweep; the artifact is deleted once it lapses.
    -- Not part of the export contract (instance-local operational state) — see
    -- the 'skip' entry in db/exportSchema.ts.
    CREATE TABLE IF NOT EXISTS data_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      include_messages INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      processed_rows INTEGER NOT NULL DEFAULT 0,
      filename TEXT,
      file_path TEXT,
      byte_size INTEGER,
      token TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      expires_at TEXT,
      downloaded_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_data_exports_user ON data_exports(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_data_exports_expires ON data_exports(expires_at);

    -- Durable backing store for the system buffer (the "Lurker" sidebar header,
    -- issue #355). A line is either GLOBAL (user_id NULL — broadcast to every
    -- connected user, e.g. "server starting up" or a future admin/control-plane
    -- notice) or PER-USER (user_id set — that account's own lifecycle log:
    -- network connect/disconnect, joins, presence batches). Deliberately a
    -- separate table from the chat-message store: no FTS, no highlight/ignore
    -- matching, no read-state — an operational log, not chat. source tags origin
    -- (server | client | admin | control-plane) so the client can style/route
    -- and so the broadcast follow-up can mark control-plane lines. fields is an
    -- optional JSON blob. Retention is count-capped per scope (see
    -- db/systemMessages.ts), so the table stays small even on a busy cell — and
    -- a persisted global line is still visible to users who connect after it was
    -- written, which is what an admin notice wants. (See db/systemMessages.ts;
    -- separate from the messages table on purpose.)
    CREATE TABLE IF NOT EXISTS system_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ts TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      scope TEXT NOT NULL DEFAULT 'lurker',
      source TEXT NOT NULL DEFAULT 'server',
      text TEXT NOT NULL DEFAULT '',
      fields TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_system_messages_recent ON system_messages(user_id, id);

    -- RPE2E end-to-end-encryption keyring (issue #382). Secrets — the identity
    -- private key and the session keys — are stored as secretCrypto envelopes
    -- (TEXT, the same lk1.* at-rest scheme as network credentials); public
    -- material (pubkeys, fingerprints) is BLOB with a length CHECK so a
    -- truncated/corrupt restore fails loud here, not deep in crypto. The
    -- identity is per-ACCOUNT (one keypair shared across a user's networks, so a
    -- peer verifies the fingerprint once); everything else is scoped per (user,
    -- network) since IRC handles and channels are network-specific. IRC-target
    -- columns (handle / channel / scope / last_handle / last_nick) are
    -- COLLATE NOCASE per house style — servers send inconsistent casing, so the
    -- composite PKs dedupe and lookups fold case (the E2eManager still owns the
    -- exact on-the-wire casing that goes into the AAD). See server/db/e2e.ts.
    CREATE TABLE IF NOT EXISTS e2e_identity (
      user_id INTEGER PRIMARY KEY,
      pubkey BLOB NOT NULL CHECK (length(pubkey) = 32),
      privkey TEXT NOT NULL,
      fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 16),
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS e2e_peers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 16),
      pubkey BLOB NOT NULL CHECK (length(pubkey) = 32),
      last_handle TEXT COLLATE NOCASE,
      last_nick TEXT COLLATE NOCASE,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      global_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (global_status IN ('pending', 'trusted', 'revoked')),
      PRIMARY KEY (user_id, network_id, fingerprint),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_e2e_peers_handle
      ON e2e_peers(user_id, network_id, last_handle);
    CREATE TABLE IF NOT EXISTS e2e_incoming_sessions (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      handle TEXT NOT NULL COLLATE NOCASE,
      channel TEXT NOT NULL COLLATE NOCASE,
      fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 16),
      sk TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'trusted', 'revoked')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, network_id, handle, channel),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_e2e_incoming_channel
      ON e2e_incoming_sessions(user_id, network_id, channel);
    CREATE TABLE IF NOT EXISTS e2e_outgoing_sessions (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      channel TEXT NOT NULL COLLATE NOCASE,
      sk TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      pending_rotation INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, network_id, channel),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS e2e_channel_config (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      channel TEXT NOT NULL COLLATE NOCASE,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'normal'
        CHECK (mode IN ('auto-accept', 'normal', 'quiet')),
      PRIMARY KEY (user_id, network_id, channel),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS e2e_autotrust (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      scope TEXT NOT NULL COLLATE NOCASE,
      handle_pattern TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, network_id, scope, handle_pattern),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS e2e_outgoing_recipients (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      channel TEXT NOT NULL COLLATE NOCASE,
      handle TEXT NOT NULL COLLATE NOCASE,
      fingerprint BLOB NOT NULL CHECK (length(fingerprint) = 16),
      first_sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, network_id, channel, handle),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_e2e_recipients_handle
      ON e2e_outgoing_recipients(user_id, network_id, handle);
  `);
}

/** A row from `PRAGMA table_info(<table>)`. */
interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function ensureColumn(table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
  return !!cols.find((c) => c.name === column);
}

// Recovery for pre-role SELF-HOSTED installs: if no admin exists, promote the
// earliest user so a single-user install that pre-dates the role column keeps
// control. Deliberately SKIPPED in node edition — a cell is managed by the
// orchestrator and has no operator-admin, so auto-promoting a tenant would
// breach the hosted tenant/admin boundary (a tenant must never become admin).
export function backfillFirstAdmin(): void {
  if (isNodeMode()) return;
  const adminCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  ).n;
  if (adminCount === 0) {
    // Promote the earliest-created user (id ASC) if any exist.
    db.exec(`UPDATE users SET role = 'admin'
             WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)`);
  }
}

migrate();

// One-shot rebuild for peer_presence_state schema change. Old layout had
// four separate datetime columns (offline/online/away/back); replaced with
// a single (state, state_at) pair so the client can render exactly one
// marker per peer (the most recent transition). The table only holds
// transient live state, so dropping it is safe — next IRC connect rebuilds
// it from JOIN/WHOIS events.
if (columnExists('peer_presence_state', 'offline_datetime')) {
  db.exec(`DROP TABLE peer_presence_state`);
  db.exec(`
    CREATE TABLE peer_presence_state (
      network_id INTEGER NOT NULL,
      nick TEXT NOT NULL COLLATE NOCASE,
      state TEXT NOT NULL,
      state_at TEXT NOT NULL,
      PRIMARY KEY (network_id, nick),
      FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
  `);
}
// away_message column: the message the peer set with /away, surfaced in the
// marker. Nullable; only meaningful when state='away'.
ensureColumn('peer_presence_state', 'away_message', 'TEXT');

// Per-channel "mute" for the buffer list: suppresses the plain-unread signal
// (count + row color + off-screen unread arrow) for this channel without
// touching highlights or notifications. Display-only — the server stores and
// syncs it but never acts on it. Sits in channel_notify_settings alongside
// notify_always; a row now persists if EITHER flag is set (see channelNotify.ts).
ensureColumn('channel_notify_settings', 'muted', 'INTEGER NOT NULL DEFAULT 0');

ensureColumn('messages', 'extra', 'TEXT');
// nick!user@host of the sender, captured at ingest so client-side hostmask
// ignore filters can match incoming and persisted messages. NULL for system
// events that have no sender and for rows that pre-date this column.
ensureColumn('messages', 'userhost', 'TEXT');
ensureColumn('networks', 'sasl_account', 'TEXT');
ensureColumn('networks', 'sasl_password', 'TEXT');
ensureColumn('networks', 'trusted_certificates', 'INTEGER NOT NULL DEFAULT 1');
// Newline-delimited raw IRC commands fired after RPL_WELCOME, IRCCloud-style.
// Supports `WAIT <seconds>` lines that pause before the next command.
ensureColumn('networks', 'connect_commands', 'TEXT');
// Per-user sidebar order. Dense integers (0..n-1) maintained on every
// create/reorder; ties fall back to id ASC so freshly migrated rows stay in
// their original creation order. See schemaVersion < 6 backfill below.
ensureColumn('networks', 'position', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'password_hash', 'TEXT');
ensureColumn('users', 'last_seen_at', 'TEXT');
// Account access state, orthogonal to role. A paused account keeps all its data
// but is disconnected from IRC and barred from reconnecting or sending — it can
// still browse history read-only. Set by the operator (standalone) or by the
// control plane (node edition) when a hosted account is suspended / past-due /
// canceled; the cell stays billing-blind and only mirrors this one verdict.
ensureColumn('users', 'is_paused', 'INTEGER NOT NULL DEFAULT 0');

// Roles: 'admin' can manage invites and other users; 'user' is everyone else.
// On a fresh install the first user (created via /api/auth/setup) is promoted
// to admin by routes/auth.js. On an existing single-user install pre-dating
// this column, backfill that lone user to admin so they retain control.
ensureColumn('users', 'role', `TEXT NOT NULL DEFAULT 'user'`);
backfillFirstAdmin();

// Persist which rule matched each message so the highlights modal can read
// from disk instead of scanning whatever happens to be loaded in client memory.
// Partial index keeps it cheap — only matched rows live in the index.
ensureColumn('messages', 'matched_rule_id', 'INTEGER');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_matched
         ON messages(network_id, target, id DESC)
         WHERE matched_rule_id IS NOT NULL`);

// Per-(network, target) alt-row parity, computed at insert time so the client
// can stripe chat lines without doing its own counting. Only chat-shaped types
// (message/action/notice) flip the bit; system events store 0 and are never
// styled with .line.alt. See schemaVersion < 2 backfill below.
ensureColumn('messages', 'alt', 'INTEGER NOT NULL DEFAULT 0');

// Sender matched the network owner's ignore list at insert time. Stamped on
// the row so countNewer/countHighlightsNewer can exclude ignored senders
// without doing a JS-side mask scan over every unread row — the client's
// render-time ignore filter only covers what's already on screen, so badge
// counts (and the highlights modal) needed their own path. Set once at
// insert; never recomputed. Old rows default to 0, which is conservative —
// they remain visible/countable, matching pre-fix behavior.
ensureColumn('messages', 'from_ignored', 'INTEGER NOT NULL DEFAULT 0');

// Per-(user, buffer) /clear marker. cleared_before_message_id is the highest
// message id hidden from the live view; messages with id > it remain visible.
// cleared_at is the wall-clock time the user issued /clear (shown in the
// divider). Both NULL means the buffer has never been cleared (or the user
// undid the clear). Stored on buffer_reads so the per-buffer state stays in
// one row — close-buffer doesn't touch buffer_reads, so the clear survives
// reopen.
ensureColumn('buffer_reads', 'cleared_before_message_id', 'INTEGER');
ensureColumn('buffer_reads', 'cleared_at', 'TEXT');

// Node-edition uploads store the thumbnail as a remote CDN object under a
// `thumbs/` prefix instead of an inline BLOB, so it doesn't bloat the cell DB
// (and every D3 R2 backup snapshot). Standalone leaves this NULL and keeps the
// BLOB. When set, it's the public thumbnail URL; when NULL, the API falls back
// to serving the BLOB via /api/uploads/:id/thumb.
ensureColumn('upload_history', 'thumbnail_url', 'TEXT');

// Node edition reports each upload to the control plane's moderation index. This
// flag tracks whether that report landed; a periodic flush retries rows still at
// 0 so a CP outage never silently drops a record. Standalone leaves it at 0 and
// never reads it — the flush is node-gated, so it has no effect there.
ensureColumn('upload_history', 'synced_to_cp', 'INTEGER NOT NULL DEFAULT 0');

// Set when the control plane takes the upload down for moderation. The row stays
// (so the owner sees a "removed by moderation" tombstone instead of a dead
// image), but the bytes are gone from storage. Standalone never sets it.
ensureColumn('upload_history', 'removed', 'INTEGER NOT NULL DEFAULT 0');

// Schema versioning lets us retire one-shot recovery blocks once every
// production DB has run through them. Bump SCHEMA_VERSION when adding a new
// recovery block, and delete blocks for versions far enough in the past.
const SCHEMA_VERSION = 13;
const schemaVersionRow = db
  .prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`)
  .get() as { value: string } | undefined;
const schemaVersion = schemaVersionRow ? parseInt(schemaVersionRow.value, 10) || 0 : 0;

if (schemaVersion < 1) {
  // Migrate highlight_rules from the old (user_id, auto_managed_network_id)
  // model — which produced a duplicate rule for every network sharing a nick —
  // to a many-to-many junction. No-op on fresh installs.
  ensureColumn('highlight_rules', 'auto_managed', 'INTEGER NOT NULL DEFAULT 0');

  const hasLegacyAutoColumn = columnExists('highlight_rules', 'auto_managed_network_id');

  if (hasLegacyAutoColumn) {
    db.exec(`UPDATE highlight_rules
             SET auto_managed = 1
             WHERE auto_managed_network_id IS NOT NULL AND auto_managed = 0`);
    db.exec(`INSERT OR IGNORE INTO highlight_rule_networks (rule_id, network_id)
             SELECT id, auto_managed_network_id
             FROM highlight_rules
             WHERE auto_managed_network_id IS NOT NULL`);
  }

  // Collapse duplicate auto rules: keep the lowest id per (user, pattern,
  // case_sensitive), rewire any junction entries from the duplicates to the
  // canonical row, then delete the duplicates.
  db.exec(`
    WITH canonical AS (
      SELECT MIN(id) AS keep_id, user_id, pattern, case_sensitive
      FROM highlight_rules
      WHERE auto_managed = 1
      GROUP BY user_id, pattern, case_sensitive
    )
    UPDATE highlight_rule_networks
    SET rule_id = (
      SELECT c.keep_id FROM canonical c
      JOIN highlight_rules r ON r.user_id = c.user_id
                            AND r.pattern = c.pattern
                            AND r.case_sensitive = c.case_sensitive
      WHERE r.id = highlight_rule_networks.rule_id
    )
    WHERE rule_id IN (
      SELECT r.id FROM highlight_rules r
      JOIN canonical c ON r.user_id = c.user_id
                      AND r.pattern = c.pattern
                      AND r.case_sensitive = c.case_sensitive
      WHERE r.auto_managed = 1 AND r.id <> c.keep_id
    )
  `);

  db.exec(`DELETE FROM highlight_rules
           WHERE auto_managed = 1
             AND id NOT IN (
               SELECT MIN(id) FROM highlight_rules
               WHERE auto_managed = 1
               GROUP BY user_id, pattern, case_sensitive
             )`);

  // The legacy column had a foreign key to networks(id), and SQLite refuses to
  // ALTER TABLE DROP COLUMN on a column that's part of an FK definition.
  // Foreign keys are disabled during the swap so the cascade from
  // highlight_rule_networks.rule_id doesn't wipe the junction when we drop the
  // old table. ids are preserved, so junction rows continue to point correctly.
  if (hasLegacyAutoColumn) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS uq_highlight_rules_auto`);
      db.exec(`
        CREATE TABLE highlight_rules_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          pattern TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'plain',
          case_sensitive INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          auto_managed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO highlight_rules_new
          (id, user_id, pattern, kind, case_sensitive, enabled, auto_managed, created_at)
        SELECT
          id, user_id, pattern, kind, case_sensitive, enabled, auto_managed, created_at
        FROM highlight_rules
      `);
      db.exec(`DROP TABLE highlight_rules`);
      db.exec(`ALTER TABLE highlight_rules_new RENAME TO highlight_rules`);
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

if (schemaVersion < 2) {
  // Backfill messages.alt for existing rows. Walk every chat-shaped row in id
  // order, keeping a per-(network_id, target) parity that flips on each one;
  // system events keep alt=0. Fresh installs hit zero rows and finish instantly.
  const stripedRows = db
    .prepare(
      `SELECT id, network_id, target FROM messages
              WHERE type IN ('message', 'action', 'notice')
              ORDER BY id ASC`,
    )
    .all() as Array<{ id: number; network_id: number; target: string }>;
  const setAlt = db.prepare(`UPDATE messages SET alt = ? WHERE id = ?`);
  const backfill = db.transaction(() => {
    const parity = new Map<string, number>();
    for (const row of stripedRows) {
      const key = `${row.network_id}\0${row.target}`;
      const next = (parity.get(key) ?? 1) ^ 1;
      parity.set(key, next);
      setAlt.run(next, row.id);
    }
  });
  backfill();
}

if (schemaVersion < 3) {
  // Full-text search index over message bodies. External-content FTS5 table —
  // it stores only the inverted index and points back at messages by rowid, so
  // the text isn't duplicated. Triggers keep it in sync; messages are
  // insert-only in normal use, but a network deletion cascades DELETEs, so the
  // delete/update triggers matter too. Backfill indexes every existing row.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);
  // Index every existing row, NULL text included. The insert trigger does the
  // same for new rows; keeping the backfill consistent with it means the
  // delete/update triggers (which replay old.text) always have a matching
  // index entry to remove — skipping NULL rows here would desync an
  // external-content FTS5 table and risk index corruption on later deletes.
  db.exec(`INSERT INTO messages_fts(rowid, text) SELECT id, text FROM messages`);
}

if (schemaVersion < 4) {
  // Rename the existing in-client toast setting key to a unified-intent name.
  // The old key gated only the in-client toast while push fired implicitly,
  // so it was misleading. The new key governs the user's intent ("notify me
  // about highlights") and the existing visibility gate picks toast vs push.
  // Migration is value-preserving: read old → write new → drop old, per user.
  const oldKey = 'notifications.highlight.toast.enabled';
  const newKey = 'notifications.highlight.enabled';
  const oldRows = db
    .prepare(`SELECT user_id, value FROM user_settings WHERE key = ?`)
    .all(oldKey) as Array<{ user_id: number; value: string }>;
  const renameKey = db.transaction((rows: Array<{ user_id: number; value: string }>) => {
    const upsert = db.prepare(`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (user_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    for (const row of rows) upsert.run(row.user_id, newKey, row.value);
    db.prepare(`DELETE FROM user_settings WHERE key = ?`).run(oldKey);
  });
  renameKey(oldRows);
}

if (schemaVersion < 5) {
  // Drop NOT NULL on upload_history.thumbnail so text uploads (which have no
  // thumbnail) can be recorded. SQLite can't ALTER COLUMN, so rebuild the
  // table and copy rows over. Indexes are recreated below.
  const needsRebuild = (() => {
    const cols = db.prepare(`PRAGMA table_info(upload_history)`).all() as TableInfoRow[];
    const thumb = cols.find((c) => c.name === 'thumbnail');
    return !!thumb && thumb.notnull === 1;
  })();
  if (needsRebuild) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_upload_history_user`);
      db.exec(`
        CREATE TABLE upload_history_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          provider TEXT NOT NULL,
          url TEXT NOT NULL,
          filename TEXT,
          mime TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          thumbnail BLOB,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO upload_history_new
          (id, user_id, provider, url, filename, mime, byte_size, width, height, thumbnail, created_at)
        SELECT
          id, user_id, provider, url, filename, mime, byte_size, width, height, thumbnail, created_at
        FROM upload_history
      `);
      db.exec(`DROP TABLE upload_history`);
      db.exec(`ALTER TABLE upload_history_new RENAME TO upload_history`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_upload_history_user
               ON upload_history(user_id, id DESC)`);
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

if (schemaVersion < 6) {
  // Seed networks.position so existing rows keep their original (id-asc) order
  // in the sidebar after the column lands. Per-user numbering: each user's
  // networks renumber 0..n-1 independently so reorders never collide across
  // accounts. Fresh installs see no rows here.
  const users = db.prepare(`SELECT DISTINCT user_id AS userId FROM networks`).all() as Array<{
    userId: number;
  }>;
  const listForUser = db.prepare(`SELECT id FROM networks WHERE user_id = ? ORDER BY id ASC`);
  const setPos = db.prepare(`UPDATE networks SET position = ? WHERE id = ?`);
  const seed = db.transaction(() => {
    for (const { userId } of users) {
      let i = 0;
      for (const row of listForUser.all(userId) as Array<{ id: number }>) {
        setPos.run(i, row.id);
        i += 1;
      }
    }
  });
  seed();
}

if (schemaVersion < 7) {
  // Issue #112 backfill: before this version, close-buffer left the
  // pinned_buffers row intact. The client filters the pinned section by open
  // buffers, so the orphan was invisible — but it made the client's pin set
  // smaller than the server's, and the next reorder failed the set-match
  // check in reorderPins and snapped back. Drop the orphans (target also in
  // closed_buffers), then renumber positions per (user, network) so they
  // stay dense (0..n-1) as the rest of the code assumes.
  db.exec(`
    DELETE FROM pinned_buffers
    WHERE EXISTS (
      SELECT 1 FROM closed_buffers c
      WHERE c.user_id = pinned_buffers.user_id
        AND c.network_id = pinned_buffers.network_id
        AND c.target = pinned_buffers.target
    )
  `);
  db.exec(`
    WITH renum AS (
      SELECT user_id, network_id, target,
             ROW_NUMBER() OVER (
               PARTITION BY user_id, network_id
               ORDER BY position ASC, target ASC
             ) - 1 AS new_pos
      FROM pinned_buffers
    )
    UPDATE pinned_buffers
    SET position = (
      SELECT new_pos FROM renum
      WHERE renum.user_id = pinned_buffers.user_id
        AND renum.network_id = pinned_buffers.network_id
        AND renum.target = pinned_buffers.target
    )
  `);
}

if (schemaVersion < 9) {
  // Issue #268/#289/#327 repair: a server relaying a different case than we
  // joined/opened with (DALnet's registered #Christian vs the #christian we
  // joined; a DM peer presented as `bob` vs the `Bob` we /query'd) forked a
  // second, metadata-less buffer keyed by the stray case. The live paths now
  // fold case forward; this one-shot merges any already-forked buffers into
  // their canonical case across every target-keyed table. Canonical = the case
  // variant carrying the most messages — i.e. the buffer you actually used. Ties
  // (equal counts) break by `target ASC`, purely for determinism. A target that
  // never drifted (a single case) maps to itself and is left untouched, so
  // #idleRPG stays #idleRPG. The ':'-virtual buffers are never folded; fresh
  // installs match no rows. scope 'all' covers channels AND DMs (and &/+/!
  // channels): the DM fork was found later (#289/#327) but the affected DBs are
  // still pre-9, so folding everything here cleans them on upgrade without a
  // separate migration. The logic lives in foldBufferCase() so the operator
  // script (tools/fold-buffer-case.ts) re-runs the exact same merge on demand.
  // report:false skips the human-facing fork summary (two extra `messages`
  // scans) the migration would only discard.
  foldBufferCase(db, { scope: 'all', report: false });
}

if (schemaVersion < 10) {
  // Issue #301: overhaul the ignore system to irssi's model. The old
  // ignored_masks held a single NOT NULL `mask` under a
  // UNIQUE(user_id,network_id,mask) constraint. The new shape adds optional
  // channels/pattern/pattern_kind/levels/is_except/expires_at, makes mask
  // nullable (NULL = anyone), and drops the UNIQUE so one mask can carry
  // different levels/channels. Changing a constraint requires a table rebuild.
  // Every legacy row becomes an ALL-level, no-pattern, all-channel rule — i.e.
  // "hide everything from this mask", exactly what it meant before. FKs are
  // toggled off during the swap so the cascade doesn't fire on DROP; id and
  // created_at are preserved. Fresh installs already have the new shape (the
  // CREATE TABLE in migrate() ran first) and this copies zero rows.
  const hasLegacyShape =
    columnExists('ignored_masks', 'mask') && !columnExists('ignored_masks', 'levels');
  if (hasLegacyShape) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_ignored_masks_user_net`);
      db.exec(`
        CREATE TABLE ignored_masks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          network_id INTEGER NOT NULL,
          mask TEXT COLLATE NOCASE,
          channels TEXT,
          pattern TEXT,
          pattern_kind TEXT NOT NULL DEFAULT 'substr',
          levels TEXT NOT NULL DEFAULT 'ALL',
          is_except INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO ignored_masks_new
          (id, user_id, network_id, mask, channels, pattern, pattern_kind, levels, is_except, expires_at, created_at)
        SELECT
          id, user_id, network_id, mask, NULL, NULL, 'substr', 'ALL', 0, NULL, created_at
        FROM ignored_masks
      `);
      db.exec(`DROP TABLE ignored_masks`);
      db.exec(`ALTER TABLE ignored_masks_new RENAME TO ignored_masks`);
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

if (schemaVersion < 11) {
  // Issue #350: make ignore scoping global-by-default. network_id was NOT NULL
  // (every rule tied to one network); now NULL means a global rule that applies
  // on every network. SQLite can't drop a NOT NULL via ALTER, so rebuild the
  // table — same swap shape as the #301 migration. Existing rows keep their
  // network_id verbatim (they stay network-scoped; nothing silently becomes
  // global), only the column constraint changes. Fresh installs already have the
  // nullable shape from the CREATE TABLE above, so detect the old NOT NULL via
  // table_info and skip the rebuild when it's already nullable (copies zero work).
  const netCol = (db.prepare(`PRAGMA table_info(ignored_masks)`).all() as TableInfoRow[]).find(
    (c) => c.name === 'network_id',
  );
  if (netCol && netCol.notnull === 1) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_ignored_masks_user_net`);
      db.exec(`
        CREATE TABLE ignored_masks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          network_id INTEGER,
          mask TEXT COLLATE NOCASE,
          channels TEXT,
          pattern TEXT,
          pattern_kind TEXT NOT NULL DEFAULT 'substr',
          levels TEXT NOT NULL DEFAULT 'ALL',
          is_except INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO ignored_masks_new
          (id, user_id, network_id, mask, channels, pattern, pattern_kind, levels, is_except, expires_at, created_at)
        SELECT
          id, user_id, network_id, mask, channels, pattern, pattern_kind, levels, is_except, expires_at, created_at
        FROM ignored_masks
      `);
      db.exec(`DROP TABLE ignored_masks`);
      db.exec(`ALTER TABLE ignored_masks_new RENAME TO ignored_masks`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_ignored_masks_user_net ON ignored_masks(user_id, network_id)`,
      );
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

// Issue #355: buffer_reads.network_id must be nullable so the app-scoped system
// buffer (no network) can key on it; uniqueness moved to the coalesced index
// idx_buffer_reads_key (a composite PK treats a NULL network_id as distinct and
// wouldn't dedupe the system row). SQLite can't drop NOT NULL / a PK in place, so
// rebuild; rows copy verbatim (real rows keep their network_id and stay unique
// under the coalesced key). Gated on the live column shape — NOT a
// schema_version — so it's idempotent and self-heals a DB left half-migrated (a
// version-gated block can't fix a DB already stamped past it). Runs once, then
// the notnull check no-ops. Placed after the ensureColumn block above so the
// cleared_* columns exist to copy.
{
  const nrCol = (db.prepare(`PRAGMA table_info(buffer_reads)`).all() as TableInfoRow[]).find(
    (c) => c.name === 'network_id',
  );
  if (nrCol && nrCol.notnull === 1) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_buffer_reads_user`);
      db.exec(`
        CREATE TABLE buffer_reads_new (
          user_id INTEGER NOT NULL,
          network_id INTEGER,
          target TEXT NOT NULL,
          last_read_message_id INTEGER NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          cleared_before_message_id INTEGER,
          cleared_at TEXT,
          PRIMARY KEY (user_id, network_id, target),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO buffer_reads_new
          (user_id, network_id, target, last_read_message_id, updated_at,
           cleared_before_message_id, cleared_at)
        SELECT user_id, network_id, target, last_read_message_id, updated_at,
           cleared_before_message_id, cleared_at
        FROM buffer_reads
      `);
      db.exec(`DROP TABLE buffer_reads`);
      db.exec(`ALTER TABLE buffer_reads_new RENAME TO buffer_reads`);
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

// Issue #349 highlight overhaul: `pattern` must be nullable so a pure -mask
// rule (highlight everyone matching a nick!user@host) can carry no keyword, and
// the table gains `mask` + `channels` scope columns. SQLite can't drop a NOT
// NULL in place, so rebuild. The copy remaps the retired kind 'plain' (which
// meant whole-word) to the unified 'full'. Shape-gated on pattern's notnull flag
// — idempotent, self-heals a half-migrated DB, and won't touch a DB already on
// the new shape. FKs off during the swap so the cascade from
// highlight_rule_networks.rule_id doesn't wipe the junction; ids are preserved.
{
  const patternCol = (
    db.prepare(`PRAGMA table_info(highlight_rules)`).all() as TableInfoRow[]
  ).find((c) => c.name === 'pattern');
  if (patternCol && patternCol.notnull === 1) {
    const rebuild = db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS idx_highlight_rules_user`);
      db.exec(`DROP INDEX IF EXISTS idx_auto_rule_unique`);
      db.exec(`
        CREATE TABLE highlight_rules_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          pattern TEXT,
          mask TEXT COLLATE NOCASE,
          channels TEXT,
          kind TEXT NOT NULL DEFAULT 'full',
          case_sensitive INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          auto_managed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO highlight_rules_new
          (id, user_id, pattern, mask, channels, kind, case_sensitive, enabled, auto_managed, created_at)
        SELECT
          id, user_id, pattern, NULL, NULL,
          CASE WHEN kind = 'plain' THEN 'full' ELSE kind END,
          case_sensitive, enabled, auto_managed, created_at
        FROM highlight_rules
      `);
      db.exec(`DROP TABLE highlight_rules`);
      db.exec(`ALTER TABLE highlight_rules_new RENAME TO highlight_rules`);
    });
    const prevFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      rebuild();
    } finally {
      db.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
    }
  }
}

if (schemaVersion < SCHEMA_VERSION) {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

// Indexes after any potential rebuild (rebuild drops the table and all its
// indexes; CREATE IF NOT EXISTS handles both fresh and rebuilt paths).
db.exec(`CREATE INDEX IF NOT EXISTS idx_highlight_rules_user ON highlight_rules(user_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_rule_unique
         ON highlight_rules(user_id, pattern, case_sensitive)
         WHERE auto_managed = 1`);
// The schemaVersion < 10 rebuild drops this; recreate for both fresh and
// rebuilt paths (migrate() ran before the rebuild, so its CREATE is stale here).
db.exec(`CREATE INDEX IF NOT EXISTS idx_ignored_masks_user_net
         ON ignored_masks(user_id, network_id)`);

// #355 buffer_reads uniqueness: coalesced so a NULL network_id (the app-scoped
// system buffer) dedupes on upsert; a plain composite index would treat NULL as
// distinct. Created here (not in migrate()) so it survives the schemaVersion < 12
// rebuild and applies to fresh installs alike. idx_buffer_reads_user is also
// recreated since the rebuild drops it.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_buffer_reads_key
         ON buffer_reads(user_id, IFNULL(network_id, 0), target)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_buffer_reads_user ON buffer_reads(user_id)`);

export default db;
