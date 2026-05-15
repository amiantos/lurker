// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/lurker.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
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

    CREATE TABLE IF NOT EXISTS buffer_reads (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      last_read_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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

    CREATE TABLE IF NOT EXISTS highlight_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pattern TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'plain',
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
      thumbnail BLOB NOT NULL,
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
    -- don't have to chase sparse gaps. Pin survives part/close — the row is
    -- only removed by an explicit unpin (or user/network deletion via cascade).
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
  `);
}

function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

function dropColumnIfExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return !!cols.find((c) => c.name === column);
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

ensureColumn('messages', 'extra', 'TEXT');
ensureColumn('networks', 'sasl_account', 'TEXT');
ensureColumn('networks', 'sasl_password', 'TEXT');
ensureColumn('users', 'password_hash', 'TEXT');
ensureColumn('users', 'last_seen_at', 'TEXT');

// Roles: 'admin' can manage invites and other users; 'user' is everyone else.
// On a fresh install the first user (created via /api/auth/setup) is promoted
// to admin by routes/auth.js. On an existing single-user install pre-dating
// this column, backfill that lone user to admin so they retain control.
ensureColumn('users', 'role', `TEXT NOT NULL DEFAULT 'user'`);
const adminCount = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
if (adminCount === 0) {
  // Promote the earliest-created user (id ASC) if any exist.
  db.exec(`UPDATE users SET role = 'admin'
           WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)`);
}

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

// Schema versioning lets us retire one-shot recovery blocks once every
// production DB has run through them. Bump SCHEMA_VERSION when adding a new
// recovery block, and delete blocks for versions far enough in the past.
const SCHEMA_VERSION = 4;
const schemaVersionRow = db
  .prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`)
  .get();
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
    .prepare(`SELECT id, network_id, target FROM messages
              WHERE type IN ('message', 'action', 'notice')
              ORDER BY id ASC`)
    .all();
  const setAlt = db.prepare(`UPDATE messages SET alt = ? WHERE id = ?`);
  const backfill = db.transaction(() => {
    const parity = new Map();
    for (const row of stripedRows) {
      const key = `${row.network_id} ${row.target}`;
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
    .all(oldKey);
  const renameKey = db.transaction((rows) => {
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

if (schemaVersion < SCHEMA_VERSION) {
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(SCHEMA_VERSION));
}

// Indexes after any potential rebuild (rebuild drops the table and all its
// indexes; CREATE IF NOT EXISTS handles both fresh and rebuilt paths).
db.exec(`CREATE INDEX IF NOT EXISTS idx_highlight_rules_user ON highlight_rules(user_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_rule_unique
         ON highlight_rules(user_id, pattern, case_sensitive)
         WHERE auto_managed = 1`);

export default db;
