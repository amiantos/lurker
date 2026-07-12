// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { CATEGORIES, REGISTRY, categoryVisible, optionVisible } from './settingsRegistry.js';

const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;
const opt = (key: string) => REGISTRY.find((o) => o.key === key)!;

describe('categoryVisible', () => {
  const standalone = { isAdmin: false, isNode: false, newAdminPanel: false };
  const node = { isAdmin: false, isNode: true, newAdminPanel: false };

  it('hides adminOnly categories from non-admins, shows them to admins', () => {
    expect(
      categoryVisible(cat('users'), { isAdmin: false, isNode: false, newAdminPanel: false }),
    ).toBe(false);
    expect(
      categoryVisible(cat('users'), { isAdmin: true, isNode: false, newAdminPanel: false }),
    ).toBe(true);
  });

  it('removes adminOnly categories from Settings when the admin panel is enabled', () => {
    // They relocate to the dedicated /admin panel, so even an admin no longer
    // sees them in the Settings sidebar.
    expect(
      categoryVisible(cat('users'), { isAdmin: true, isNode: false, newAdminPanel: true }),
    ).toBe(false);
  });

  it('hides selfHostedOnly categories in node edition only', () => {
    expect(categoryVisible(cat('api-tokens'), standalone)).toBe(true);
    expect(categoryVisible(cat('api-tokens'), node)).toBe(false);
    // selfHostedOnly is independent of role — a node-edition admin still can't
    // see it (the route isn't mounted there anyway).
    expect(
      categoryVisible(cat('api-tokens'), { isAdmin: true, isNode: true, newAdminPanel: false }),
    ).toBe(false);
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
