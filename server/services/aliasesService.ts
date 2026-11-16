// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { deleteAlias, getAlias, listAliases, setAlias, updateAlias } from '../db/aliases.js';
import { normalizeAliasBody, normalizeAliasName, type Alias } from '../../shared/aliases.js';

// Command aliases (#276). The server stores and validates them; expanding one
// is the client's job, where the commands themselves run. emit('change') drives
// the cross-device `aliases-changed` frame (wsHub).

type Failure = { ok: false; error: string; status: number };
type Result = { ok: true; alias: Alias } | Failure;

const bad = (error: string, status = 400): Failure => ({ ok: false, error, status });

class AliasesService extends EventEmitter {
  list(userId: number): Alias[] {
    return listAliases(userId);
  }

  /** Define an alias, or replace the one of that name: `/alias name body`. */
  set(userId: number, rawName: unknown, rawBody: unknown): Result & { created?: boolean } {
    const name = normalizeAliasName(typeof rawName === 'string' ? rawName : '');
    if (!name.ok) return bad(name.error);
    const body = normalizeAliasBody(typeof rawBody === 'string' ? rawBody : '');
    if (!body.ok) return bad(body.error);
    const created = getAlias(userId, name.name) === null;
    setAlias(userId, name.name, body.body);
    this.emit('change', { userId });
    return { ok: true, alias: { name: name.name, body: body.body }, created };
  }

  /** Edit one in place: a new name, a new body, or both. */
  update(userId: number, rawName: string, fields: { name?: unknown; body?: unknown }): Result {
    const current = normalizeAliasName(rawName);
    const existing = current.ok ? getAlias(userId, current.name) : null;
    if (!existing) return bad('no such alias', 404);
    let name = existing.name;
    let body = existing.body;
    if ('name' in fields) {
      const next = normalizeAliasName(typeof fields.name === 'string' ? fields.name : '');
      if (!next.ok) return bad(next.error);
      name = next.name;
    }
    if ('body' in fields) {
      const next = normalizeAliasBody(typeof fields.body === 'string' ? fields.body : '');
      if (!next.ok) return bad(next.error);
      body = next.body;
    }
    if (!updateAlias(userId, existing.name, { name, body })) {
      return bad(`there is already an alias called /${name}`, 409);
    }
    this.emit('change', { userId });
    return { ok: true, alias: { name, body } };
  }

  remove(userId: number, rawName: string): { ok: true } | Failure {
    const name = normalizeAliasName(rawName);
    if (!name.ok || !deleteAlias(userId, name.name)) return bad('no such alias', 404);
    this.emit('change', { userId });
    return { ok: true };
  }
}

const aliasesService = new AliasesService();
export default aliasesService;
