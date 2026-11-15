// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  LAYOUT_SETTING_KEY,
  RENAMED_SETTING_KEYS,
  currentLayoutValue,
  currentSettingKey,
  currentSettingWrite,
  withCurrentSettingKeys,
} from './settingsRenames.js';
import { REGISTRY } from './settingsRegistry.js';

const known = new Set(REGISTRY.map((o) => o.key));

describe('renamed setting keys', () => {
  it('maps every old key to one the registry has, and no old key is still in it', () => {
    expect(Object.keys(RENAMED_SETTING_KEYS).length).toBeGreaterThan(0);
    for (const [oldKey, newKey] of Object.entries(RENAMED_SETTING_KEYS)) {
      expect([newKey, known.has(newKey)]).toEqual([newKey, true]);
      expect([oldKey, known.has(oldKey)]).toEqual([oldKey, false]);
    }
  });

  it('leaves no setting named for the old layouts', () => {
    expect([...known].filter((key) => /compact|standard/.test(key))).toEqual([]);
  });

  it('answers the current key, and any other key as it is', () => {
    expect(currentSettingKey('look.message.compact.indent')).toBe('look.message.modern.indent');
    expect(currentSettingKey('look.message.modern.indent')).toBe('look.message.modern.indent');
    expect(currentSettingKey('look.color.bg')).toBe('look.color.bg');
    expect(currentSettingKey('toString')).toBe('toString');
  });

  it('re-keys a map, the new key winning where both are there', () => {
    expect(
      withCurrentSettingKeys({
        'look.color.bg': '#000',
        'look.message.compact.indent': 3,
        'look.buffer.time_format_compact': 'HH',
      }),
    ).toEqual({
      'look.color.bg': '#000',
      'look.message.modern.indent': 3,
      'look.buffer.time_format_modern': 'HH',
    });
    expect(
      withCurrentSettingKeys({
        'look.message.modern.indent': 1,
        'look.message.compact.indent': 3,
      }),
    ).toEqual({ 'look.message.modern.indent': 1 });
    expect(withCurrentSettingKeys({})).toEqual({});
  });
});

describe('the layout value', () => {
  const layout = REGISTRY.find((o) => o.key === LAYOUT_SETTING_KEY)!;

  it('is modern for compact and for modern', () => {
    expect(currentLayoutValue('compact')).toBe('modern');
    expect(currentLayoutValue('modern')).toBe('modern');
  });

  it('is nothing, so the default, for every other old choice', () => {
    for (const was of ['auto', 'standard', '', 7, null, undefined]) {
      expect(currentLayoutValue(was)).toBeNull();
    }
    expect(layout.default).toBe('traditional');
  });

  // A choice somebody made, not an absence: an import keeps it.
  it('is traditional for traditional', () => {
    expect(currentLayoutValue('traditional')).toBe('traditional');
  });

  it('only ever answers with a choice the registry offers', () => {
    expect(layout.type === 'enum' && layout.choices).toEqual(['traditional', 'modern']);
    expect(layout.type === 'enum' && layout.choices).toContain(currentLayoutValue('compact'));
  });
});

describe('a write from a client built before the rename', () => {
  it('lands under the current key', () => {
    expect(currentSettingWrite('look.message.compact.indent', 2)).toEqual([
      'look.message.modern.indent',
      2,
    ]);
    expect(currentSettingWrite('look.font.size', 14)).toEqual(['look.font.size', 14]);
  });

  it('spells an old layout as the one it is now', () => {
    expect(currentSettingWrite(LAYOUT_SETTING_KEY, 'compact')).toEqual([
      LAYOUT_SETTING_KEY,
      'modern',
    ]);
    for (const was of ['auto', 'standard']) {
      expect(currentSettingWrite(LAYOUT_SETTING_KEY, was)).toEqual([
        LAYOUT_SETTING_KEY,
        'traditional',
      ]);
    }
    // Not a layout at all: left for validation to refuse.
    expect(currentSettingWrite(LAYOUT_SETTING_KEY, 'sideways')).toEqual([
      LAYOUT_SETTING_KEY,
      'sideways',
    ]);
  });

  it('points an old avatar set id at the set it became', () => {
    expect(currentSettingWrite('look.avatars.set', 'plain-light')).toEqual([
      'look.avatars.set',
      'plain',
    ]);
    expect(currentSettingWrite('look.avatars.set', 'initial-dark')).toEqual([
      'look.avatars.set',
      'initial',
    ]);
    expect(currentSettingWrite('look.avatars.set', '12')).toEqual(['look.avatars.set', '12']);
  });
});
