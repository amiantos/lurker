// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { EventEmitter } from 'events';
import { validate, getOption } from './settingsRegistry.js';
import {
  setUserSetting,
  deleteUserSetting,
  getUserSettings,
} from '../db/settings.js';

function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

class SettingsService extends EventEmitter {
  // changes: { [key]: rawValue }
  // Returns { ok: true, values } on full success or { ok: false, error, key } on first invalid entry.
  update(userId, changes) {
    const validated = {};
    for (const [key, raw] of Object.entries(changes)) {
      const result = validate(key, raw);
      if (!result.ok) return { ok: false, error: result.error, key };
      validated[key] = result.value;
    }
    for (const [key, value] of Object.entries(validated)) {
      const opt = getOption(key);
      // Setting a key back to its default is semantically "no override";
      // drop the row so isModified() reflects that everywhere.
      if (opt && valuesEqual(value, opt.default)) {
        deleteUserSetting(userId, key);
      } else {
        setUserSetting(userId, key, value);
      }
    }
    if (Object.keys(validated).length > 0) {
      this.emit('event', { userId, changes: validated });
    }
    return { ok: true, values: getUserSettings(userId) };
  }

  reset(userId, key) {
    const opt = getOption(key);
    if (!opt) return { ok: false, error: `unknown setting: ${key}` };
    deleteUserSetting(userId, key);
    this.emit('event', { userId, changes: { [key]: opt.default } });
    return { ok: true, values: getUserSettings(userId) };
  }
}

const settingsService = new SettingsService();
export default settingsService;
