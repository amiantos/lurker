import { EventEmitter } from 'events';
import {
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  upsertAutoNickRule,
} from '../db/highlightRules.js';
import { compileRules } from './highlightEngine.js';

const ALLOWED_KINDS = new Set(['plain', 'glob', 'regex']);
const MAX_PATTERN_LENGTH = 256;

function validatePattern(pattern) {
  if (typeof pattern !== 'string') return 'pattern must be a string';
  const trimmed = pattern.trim();
  if (!trimmed) return 'pattern is required';
  if (trimmed.length > MAX_PATTERN_LENGTH) return `pattern exceeds ${MAX_PATTERN_LENGTH} chars`;
  return null;
}

function validateKind(kind) {
  if (!ALLOWED_KINDS.has(kind)) return 'kind must be plain, glob, or regex';
  return null;
}

function validateRegex(pattern) {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return `invalid regex: ${e.message}`;
  }
}

class HighlightRulesService extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map();
  }

  list(userId) {
    return listRules(userId);
  }

  get(id, userId) {
    return getRule(id, userId);
  }

  create(userId, fields) {
    const pattern = (fields.pattern || '').trim();
    const kind = fields.kind || 'plain';
    const patternErr = validatePattern(pattern);
    if (patternErr) return { ok: false, error: patternErr };
    const kindErr = validateKind(kind);
    if (kindErr) return { ok: false, error: kindErr };
    if (kind === 'regex') {
      const regexErr = validateRegex(pattern);
      if (regexErr) return { ok: false, error: regexErr };
    }
    const rule = createRule(userId, {
      pattern,
      kind,
      case_sensitive: !!fields.case_sensitive,
      enabled: fields.enabled !== false,
    });
    this._invalidate(userId);
    return { ok: true, rule };
  }

  update(id, userId, fields) {
    const existing = getRule(id, userId);
    if (!existing) return { ok: false, error: 'rule not found', status: 404 };
    const isAutoManaged = existing.auto_managed_network_id != null;
    const update = {};
    if ('pattern' in fields) {
      if (isAutoManaged) return { ok: false, error: 'cannot edit pattern of auto-managed rule', status: 400 };
      const pattern = (fields.pattern || '').trim();
      const patternErr = validatePattern(pattern);
      if (patternErr) return { ok: false, error: patternErr };
      update.pattern = pattern;
    }
    if ('kind' in fields) {
      if (isAutoManaged) return { ok: false, error: 'cannot edit kind of auto-managed rule', status: 400 };
      const kindErr = validateKind(fields.kind);
      if (kindErr) return { ok: false, error: kindErr };
      update.kind = fields.kind;
    }
    if ('case_sensitive' in fields) {
      if (isAutoManaged) return { ok: false, error: 'cannot edit case_sensitive of auto-managed rule', status: 400 };
      update.case_sensitive = !!fields.case_sensitive;
    }
    if ('enabled' in fields) update.enabled = !!fields.enabled;

    const finalKind = update.kind || existing.kind;
    const finalPattern = update.pattern ?? existing.pattern;
    if (finalKind === 'regex') {
      const regexErr = validateRegex(finalPattern);
      if (regexErr) return { ok: false, error: regexErr };
    }
    const rule = updateRule(id, userId, update);
    this._invalidate(userId);
    return { ok: true, rule };
  }

  remove(id, userId) {
    const existing = getRule(id, userId);
    if (!existing) return { ok: false, error: 'rule not found', status: 404 };
    if (existing.auto_managed_network_id != null) {
      return { ok: false, error: 'cannot delete auto-managed rule', status: 400 };
    }
    deleteRule(id, userId);
    this._invalidate(userId);
    return { ok: true };
  }

  upsertAutoNickRule(userId, networkId, nick) {
    if (!nick) return null;
    const rule = upsertAutoNickRule(userId, networkId, nick);
    this._invalidate(userId);
    return rule;
  }

  getCompiled(userId) {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const rules = listRules(userId);
    const compiled = compileRules(rules);
    this.cache.set(userId, compiled);
    return compiled;
  }

  _invalidate(userId) {
    this.cache.delete(userId);
    this.emit('change', { userId });
  }
}

const highlightRulesService = new HighlightRulesService();
export default highlightRulesService;
