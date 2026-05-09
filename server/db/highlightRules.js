import db from './index.js';

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    pattern: row.pattern,
    kind: row.kind,
    case_sensitive: !!row.case_sensitive,
    enabled: !!row.enabled,
    auto_managed_network_id: row.auto_managed_network_id,
    created_at: row.created_at,
  };
}

export function listRules(userId) {
  const rows = db
    .prepare('SELECT * FROM highlight_rules WHERE user_id = ? ORDER BY id')
    .all(userId);
  return rows.map(rowToRule);
}

export function getRule(id, userId) {
  const row = db
    .prepare('SELECT * FROM highlight_rules WHERE id = ? AND user_id = ?')
    .get(id, userId);
  return rowToRule(row);
}

export function createRule(userId, fields) {
  const { pattern, kind = 'plain', case_sensitive = false, enabled = true } = fields;
  const result = db
    .prepare(`
      INSERT INTO highlight_rules (user_id, pattern, kind, case_sensitive, enabled)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(userId, pattern, kind, case_sensitive ? 1 : 0, enabled ? 1 : 0);
  return getRule(result.lastInsertRowid, userId);
}

export function updateRule(id, userId, fields) {
  const allowed = ['pattern', 'kind', 'case_sensitive', 'enabled'];
  const setClauses = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      let value = fields[key];
      if (key === 'case_sensitive' || key === 'enabled') value = value ? 1 : 0;
      params.push(value);
    }
  }
  if (!setClauses.length) return getRule(id, userId);
  params.push(id, userId);
  db.prepare(`UPDATE highlight_rules SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  return getRule(id, userId);
}

export function deleteRule(id, userId) {
  db.prepare('DELETE FROM highlight_rules WHERE id = ? AND user_id = ?').run(id, userId);
}

export function upsertAutoNickRule(userId, networkId, nick) {
  if (!nick) return null;
  const existing = db
    .prepare('SELECT * FROM highlight_rules WHERE user_id = ? AND auto_managed_network_id = ?')
    .get(userId, networkId);
  if (existing) {
    if (existing.pattern === nick) return rowToRule(existing);
    db.prepare('UPDATE highlight_rules SET pattern = ? WHERE id = ?').run(nick, existing.id);
    return rowToRule({ ...existing, pattern: nick });
  }
  const result = db
    .prepare(`
      INSERT INTO highlight_rules (user_id, pattern, kind, case_sensitive, enabled, auto_managed_network_id)
      VALUES (?, ?, 'plain', 0, 1, ?)
    `)
    .run(userId, nick, networkId);
  return getRule(result.lastInsertRowid, userId);
}
