// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { CATEGORIES, REGISTRY, categoryVisible, optionVisible } from './settingsRegistry.js';

const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;
const opt = (key: string) => REGISTRY.find((o) => o.key === key)!;

describe('categoryVisible', () => {
  const standalone = { isNode: false };
  const node = { isNode: true };

  // Instance administration now lives entirely in the /admin panel, so Settings
  // holds nothing an admin sees and a regular user doesn't — the whole adminOnly
  // dimension (and the "users" category that was its only user) is gone.
  it('no longer carries an admin-only category', () => {
    expect(CATEGORIES.some((c) => c.id === 'users')).toBe(false);
  });

  // The behavioural half of the above: role is no longer an input at all, so on a
  // standalone box every category is visible to everyone. Asserted through the
  // function (not just the data) so re-introducing a role gate inside
  // categoryVisible would fail here rather than pass quietly.
  it('shows every non-node-restricted category regardless of role', () => {
    const hidden = CATEGORIES.filter(
      (c) => !c.selfHostedOnly && !categoryVisible(c, standalone),
    ).map((c) => c.id);
    expect(hidden).toStrictEqual([]);
  });

  it('hides selfHostedOnly categories in node edition only', () => {
    expect(categoryVisible(cat('api-tokens'), standalone)).toBe(true);
    expect(categoryVisible(cat('api-tokens'), node)).toBe(false);
  });

  it('shows ordinary categories in both editions', () => {
    expect(categoryVisible(cat('appearance'), standalone)).toBe(true);
    expect(categoryVisible(cat('appearance'), node)).toBe(true);
  });
});

describe('optionVisible', () => {
  it('hides selfHostedOnly settings in node edition, shows them standalone', () => {
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: false })).toBe(true);
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.quality'), { isNode: true })).toBe(false);
  });

  it('hides the cost/abuse pipeline knobs in node edition (operator-controlled)', () => {
    // dimension / quality / max size are enforced server-side in node edition
    // (A8); the tenant must not be able to set them, here or via the API.
    expect(optionVisible(opt('uploads.image.max_dimension'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.quality'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: true })).toBe(false);
    // ...but they stay visible on a self-hosted box.
    expect(optionVisible(opt('uploads.image.quality'), { isNode: false })).toBe(true);
  });

  it('keeps paste-to-upload (a client UX pref, not a cost knob) visible in node edition', () => {
    expect(optionVisible(opt('uploads.paste.enabled'), { isNode: true })).toBe(true);
  });
});
