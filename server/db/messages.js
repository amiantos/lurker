import db from './index.js';

const insertStmt = db.prepare(`
  INSERT INTO messages (network_id, target, time, type, nick, text, kind, self, extra, matched_rule_id)
  VALUES (@networkId, @target, @time, @type, @nick, @text, @kind, @self, @extra, @matchedRuleId)
`);

export function insertMessage(row) {
  const result = insertStmt.run({
    networkId: row.networkId,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick ?? null,
    text: row.text ?? null,
    kind: row.kind ?? null,
    self: row.self ? 1 : 0,
    extra: row.extra ? JSON.stringify(row.extra) : null,
    matchedRuleId: row.matchedRuleId ?? null,
  });
  return result.lastInsertRowid;
}

function rowToEvent(row) {
  const event = {
    id: row.id,
    networkId: row.network_id,
    target: row.target,
    time: row.time,
    type: row.type,
    nick: row.nick,
    text: row.text,
    kind: row.kind,
    self: !!row.self,
    matched: row.matched_rule_id != null,
    matchedRuleId: row.matched_rule_id,
  };
  if (row.extra) {
    try {
      Object.assign(event, JSON.parse(row.extra));
    } catch (_) { /* ignore malformed */ }
  }
  return event;
}

// `before` paginates backward (returns up to `limit` events with id < before).
// `afterId` does the opposite — used by the WS resume path to ship only the
// gap an existing client missed, instead of re-sending its last 50 known rows.
// Results are always returned oldest-first regardless of which path was taken.
export function listMessages(networkId, target, { before, afterId, limit = 50 } = {}) {
  if (afterId) {
    const rows = db.prepare(
      `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id > ?
       ORDER BY id ASC LIMIT ?`
    ).all(networkId, target, afterId, limit);
    return rows.map(rowToEvent);
  }
  const sql = before
    ? `SELECT * FROM messages WHERE network_id = ? AND target = ? AND id < ? ORDER BY id DESC LIMIT ?`
    : `SELECT * FROM messages WHERE network_id = ? AND target = ? ORDER BY id DESC LIMIT ?`;
  const params = before ? [networkId, target, before, limit] : [networkId, target, limit];
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToEvent).reverse();
}

export function listRecentForBuffers(networkId, targets, perBuffer = 50) {
  const out = {};
  for (const t of targets) {
    out[t] = listMessages(networkId, t, { limit: perBuffer });
  }
  return out;
}

export function listBufferTargets(networkId) {
  return db
    .prepare('SELECT DISTINCT target FROM messages WHERE network_id = ? ORDER BY target')
    .all(networkId)
    .map((r) => r.target);
}

export function countOlder(networkId, target, beforeId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE network_id = ? AND target = ? AND id < ?`
  ).get(networkId, target, beforeId).n;
}

// Types that count as "real content" for the unread badge. Membership churn
// (join/part/quit/kick/nick/mode/topic), MOTD, away markers, and server
// errors are all persisted for the buffer log but shouldn't bump the badge —
// the live unread path in useSocket.applyEvent uses the same allowlist, and
// we need the SQL paths to match so backlog/read-state recomputes don't snap
// the count to an inflated number.
const COUNTABLE_TYPES_SQL = `('message','action','notice')`;

export function countNewer(networkId, target, afterId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND type IN ${COUNTABLE_TYPES_SQL}`
  ).get(networkId, target, afterId || 0).n;
}

// Cheap indexed count of unread highlights since `afterId`. Uses the partial
// idx_messages_matched index — the old scan+decorate approach was replaced
// once match state moved to insert time.
export function countHighlightsNewer(networkId, target, afterId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE network_id = ? AND target = ? AND id > ?
       AND matched_rule_id IS NOT NULL`
  ).get(networkId, target, afterId || 0).n;
}

// Highlight history feed for the /api/highlights endpoint. Scoped to a single
// user via the networks join. Cursor pagination via `before` (a message id);
// returns rows ordered newest-first.
export function listUserHighlights(userId, { before, limit = 50 } = {}) {
  const sql = before
    ? `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
         AND m.id < ?
       ORDER BY m.id DESC
       LIMIT ?`
    : `SELECT m.*, n.name AS network_name
       FROM messages m
       JOIN networks n ON n.id = m.network_id
       WHERE n.user_id = ?
         AND m.matched_rule_id IS NOT NULL
       ORDER BY m.id DESC
       LIMIT ?`;
  const params = before ? [userId, before, limit] : [userId, limit];
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => ({
    ...rowToEvent(row),
    networkName: row.network_name,
  }));
}

const listSpeakersStmt = db.prepare(`
  SELECT nick, MAX(time) AS last_time
  FROM messages
  WHERE network_id = ?
    AND target = ?
    AND type IN ('message', 'action')
    AND self = 0
    AND nick IS NOT NULL
    AND nick <> ''
  GROUP BY LOWER(nick)
  ORDER BY last_time DESC
  LIMIT ?
`);

export function listSpeakers(networkId, target, limit = 128) {
  return listSpeakersStmt.all(networkId, target, limit)
    .map((r) => ({ nick: r.nick, lastTime: Date.parse(r.last_time) || 0 }))
    .filter((s) => s.lastTime > 0);
}
