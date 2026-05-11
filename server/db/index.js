import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/caint.db');
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
ensureColumn('messages', 'extra', 'TEXT');
ensureColumn('networks', 'sasl_account', 'TEXT');
ensureColumn('networks', 'sasl_password', 'TEXT');
dropColumnIfExists('users', 'password_hash');

// Persist which rule matched each message so the highlights modal can read
// from disk instead of scanning whatever happens to be loaded in client memory.
// Partial index keeps it cheap — only matched rows live in the index.
ensureColumn('messages', 'matched_rule_id', 'INTEGER');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_matched
         ON messages(network_id, target, id DESC)
         WHERE matched_rule_id IS NOT NULL`);

// Migrate highlight_rules from the old (user_id, auto_managed_network_id)
// model — which produced a duplicate rule for every network sharing a nick —
// to a many-to-many junction. Backfill is idempotent; safe to run every boot.
ensureColumn('highlight_rules', 'auto_managed', 'INTEGER NOT NULL DEFAULT 0');

const hasLegacyAutoColumn = columnExists('highlight_rules', 'auto_managed_network_id');

if (hasLegacyAutoColumn) {
  // Tag the new auto_managed flag from the old column, then mirror each old
  // (rule, network) pairing into the junction table.
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
// canonical row, then delete the duplicates. Idempotent — running on a clean
// set is a no-op.
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
// ALTER TABLE DROP COLUMN on a column that's part of an FK definition. Rebuild
// the table without the column (and without the legacy index that referenced
// it) using the standard SQLite rebuild dance. Foreign keys are disabled
// during the swap so the cascade from highlight_rule_networks.rule_id doesn't
// wipe the junction when we drop the old table. ids are preserved, so junction
// rows continue to point at the right rules.
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

// Indexes after any potential rebuild (rebuild drops the table and all its
// indexes; CREATE IF NOT EXISTS handles both fresh and rebuilt paths).
db.exec(`CREATE INDEX IF NOT EXISTS idx_highlight_rules_user ON highlight_rules(user_id)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_rule_unique
         ON highlight_rules(user_id, pattern, case_sensitive)
         WHERE auto_managed = 1`);

export default db;
