import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
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
      password_hash TEXT NOT NULL,
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
      auto_managed_network_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (auto_managed_network_id) REFERENCES networks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_highlight_rules_user ON highlight_rules(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_highlight_rules_auto
      ON highlight_rules(user_id, auto_managed_network_id)
      WHERE auto_managed_network_id IS NOT NULL;

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
  `);
}

function seedInitialUser() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (existing.n > 0) return;
  const username = process.env.INITIAL_USERNAME;
  const password = process.env.INITIAL_PASSWORD;
  if (!username || !password) {
    console.warn('[db] No users exist and INITIAL_USERNAME/INITIAL_PASSWORD are not set — skipping seed.');
    return;
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`[db] Seeded initial user "${username}"`);
}

function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}

migrate();
ensureColumn('messages', 'extra', 'TEXT');
ensureColumn('networks', 'sasl_account', 'TEXT');
ensureColumn('networks', 'sasl_password', 'TEXT');
seedInitialUser();

export default db;
