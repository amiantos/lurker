import db from './index.js';

function rowToSub(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    user_agent: row.user_agent,
    enabled: !!row.enabled,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

export function listEnabledForUser(userId) {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? AND enabled = 1')
    .all(userId)
    .map(rowToSub);
}

export function listAllForUser(userId) {
  return db
    .prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map(rowToSub);
}

export function getByEndpoint(endpoint) {
  return rowToSub(db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint));
}

export function upsertSubscription(userId, { endpoint, p256dh, auth, userAgent }) {
  const existing = getByEndpoint(endpoint);
  if (existing) {
    db.prepare(`
      UPDATE push_subscriptions
      SET user_id = ?, p256dh = ?, auth = ?, user_agent = COALESCE(?, user_agent),
          enabled = 1, last_seen_at = datetime('now')
      WHERE endpoint = ?
    `).run(userId, p256dh, auth, userAgent || null, endpoint);
    return getByEndpoint(endpoint);
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, endpoint, p256dh, auth, userAgent || null);
  return getByEndpoint(endpoint);
}

export function deleteByEndpoint(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

export function deleteById(id) {
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
}

export function touchSubscription(id) {
  db.prepare("UPDATE push_subscriptions SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

// app_meta single-key store for VAPID config
export function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}
