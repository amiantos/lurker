// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  REGISTRY,
  categoryVisible,
  optionVisible,
  optionEnabled,
  dependencyHint,
  dependencyStateFor,
} from './settingsRegistry.js';
import type { SettingOption, SettingValue } from '../../../shared/settingsRegistry.js';

const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;
const opt = (key: string) => REGISTRY.find((o) => o.key === key)!;

/** An effective-value reader over an override map, defaulting to the registry. */
function reader(overrides: Record<string, SettingValue>) {
  return (key: string): SettingValue | undefined =>
    key in overrides ? overrides[key] : REGISTRY.find((o) => o.key === key)?.default;
}

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
    // The OAuth server (#891) exists in standalone edition only.
    expect(categoryVisible(cat('authorized-apps'), standalone)).toBe(true);
    expect(categoryVisible(cat('authorized-apps'), node)).toBe(false);
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

  it('hides a requiresFeature setting unless the instance advertises the feature', () => {
    // Unlike selfHostedOnly — a cosmetic gate on a knob that still works — a flagged-off
    // feature has no routes mounted at all, so the toggle would be inert. Both directions
    // asserted: an absent flag object must read as off, not as unknown-so-show.
    for (const key of ['chat.inline_media.enabled', 'chat.link_previews.enabled']) {
      expect(optionVisible(opt(key), { isNode: false })).toBe(false);
      expect(optionVisible(opt(key), { isNode: false, features: {} })).toBe(false);
      expect(optionVisible(opt(key), { isNode: false, features: { linkPreviews: false } })).toBe(
        false,
      );
      expect(optionVisible(opt(key), { isNode: false, features: { linkPreviews: true } })).toBe(
        true,
      );
    }
  });

  it('leaves settings with no requiresFeature untouched by the flags', () => {
    expect(optionVisible(opt('chat.image_modal.enabled'), { isNode: false, features: {} })).toBe(
      true,
    );
  });
});

describe('optionEnabled (#666)', () => {
  it('leaves settings without dependencies alone', () => {
    expect(optionEnabled(opt('chat.events'), reader({}))).toBe(true);
  });

  it('ORs its clauses — one device class still using events keeps modifiers live', () => {
    // Why the clauses are ORed rather than ANDed: a phone set to `none` must not
    // grey out the consolidation knobs a desktop is actively using.
    const phoneOnly = reader({ 'chat.events': 'all', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_joins'), phoneOnly)).toBe(true);

    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_joins'), bothOff)).toBe(false);
  });

  it('resolves transitively through a chain', () => {
    // consolidate_max_names names only consolidate_joins; the tier condition has
    // to arrive through it, or the registry would restate the whole chain on
    // every leaf.
    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_max_names'), bothOff)).toBe(false);

    // Its own direct dependency failing is enough on its own.
    const consolidationOff = reader({ 'chat.consolidate_joins': false });
    expect(optionEnabled(opt('chat.consolidate_max_names'), consolidationOff)).toBe(false);

    expect(optionEnabled(opt('chat.consolidate_max_names'), reader({}))).toBe(true);
  });

  it('gates the smart-filter tuning on some device being on the smart tier', () => {
    // Default is `all` on both keys, so the tuning starts inactive — it was
    // reachable-but-inert before the tier, which is the confusion #666 names.
    expect(optionEnabled(opt('chat.smart_filter_delay'), reader({}))).toBe(false);

    const mobileSmart = reader({ 'chat.events.mobile': 'smart' });
    for (const key of [
      'chat.smart_filter_delay',
      'chat.smart_filter_join',
      'chat.smart_filter_quit',
      'chat.smart_filter_nick',
      'chat.smart_filter_mode',
      'chat.smart_filter_join_unmask',
    ]) {
      expect(optionEnabled(opt(key), mobileSmart)).toBe(true);
    }
  });

  it('keeps the event-display modifiers tied to the tier, not to consolidation', () => {
    // show_event_host decorates the INDIVIDUAL lines, which is exactly what
    // survives when consolidation is off — so turning consolidation off must
    // not grey it out.
    const consolidationOff = reader({ 'chat.consolidate_joins': false });
    expect(optionEnabled(opt('chat.show_event_host'), consolidationOff)).toBe(true);
    expect(optionEnabled(opt('chat.show_join_account'), consolidationOff)).toBe(true);

    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.show_event_host'), bothOff)).toBe(false);
  });

  it('points every dependency clause at a real registry key', () => {
    // A typo here fails OPEN — the clause can't be resolved further and passes —
    // so nothing would visibly break, which is exactly why it needs asserting.
    const keys = new Set(REGISTRY.map((o) => o.key));
    for (const option of REGISTRY) {
      for (const dep of option.dependsOn ?? []) {
        expect(keys, `${option.key} depends on unknown ${dep.key}`).toContain(dep.key);
      }
    }
  });

  it('bottoms out rather than recursing forever on a cycle', () => {
    const cyclic = {
      ...opt('chat.consolidate_joins'),
      key: 'x.a',
      dependsOn: [{ key: 'x.a', in: [true] }],
    } as SettingOption;
    // getOption('x.a') finds nothing (it isn't in the registry), so the clause
    // resolves on its value check alone — the depth cap is the backstop for a
    // cycle made of keys that ARE registered.
    expect(optionEnabled(cyclic, () => true)).toBe(true);
  });
});

describe('dependencyHint', () => {
  it('names the keys and values that would wake the setting up', () => {
    expect(dependencyHint(opt('chat.smart_filter_delay'), reader({}))).toBe(
      'Inactive — needs chat.events = smart, or chat.events.mobile = smart.',
    );
  });

  it('renders booleans as on/off rather than true/false', () => {
    expect(
      dependencyHint(
        opt('chat.consolidate_max_names'),
        reader({ 'chat.consolidate_joins': false }),
      ),
    ).toBe('Inactive — needs chat.consolidate_joins = on.');
  });

  it('walks past a dependency that is itself inactive', () => {
    // The dead end this exists to prevent: with both tiers on `none`,
    // consolidate_max_names is greyed out even though chat.consolidate_joins —
    // the only key its own clause names — reads `on`. Pointing at that row would
    // send the user somewhere that already looks correct, with its editor
    // disabled so they can't even try. Name the tier instead.
    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(dependencyHint(opt('chat.consolidate_max_names'), bothOff)).toBe(
      'Inactive — needs chat.events = all or smart, or chat.events.mobile = all or smart.',
    );
  });

  it('prefers the clause the user can actually act on', () => {
    // Consolidation is off AND the tiers are off. The nearer, directly-actionable
    // clause wins — turning consolidation back on is a step the user can take.
    const both = reader({
      'chat.consolidate_joins': false,
      'chat.events': 'none',
      'chat.events.mobile': 'none',
    });
    expect(dependencyHint(opt('chat.consolidate_max_names'), both)).toBe(
      'Inactive — needs chat.consolidate_joins = on.',
    );
  });

  it('is empty for a setting with no dependencies', () => {
    expect(dependencyHint(opt('chat.events'), reader({}))).toBe('');
  });

  it('is empty for a setting whose dependencies are satisfied', () => {
    expect(dependencyHint(opt('chat.consolidate_max_names'), reader({}))).toBe('');
  });
});

describe('dependencyStateFor', () => {
  it('is empty for a live setting and explains an inactive one', () => {
    expect(dependencyStateFor(opt('chat.consolidate_max_names'), reader({}))).toBe('');
    expect(
      dependencyStateFor(
        opt('chat.consolidate_max_names'),
        reader({ 'chat.consolidate_joins': false }),
      ),
    ).toBe('Inactive — needs chat.consolidate_joins = on.');
  });

  it('fails CLOSED when the resolvers give up, rather than rendering a live row', () => {
    // A registry cycle drives both resolvers into the depth cap, where they bail
    // DIFFERENTLY: `optionEnabled` returns false, `dependencyHint` returns ''
    // because there is no clause left to name. The pane greys a row on "hint is
    // non-empty", so composing the two naively would mark this row inactive and
    // then draw it fully usable — a control that looks like it works and doesn't.
    //
    // The cycle has to be resolvable, or it isn't a cycle: an unregistered key
    // resolves on its value check alone and passes. Hence the injected lookup —
    // the real REGISTRY has no cycle, which is exactly why this branch would
    // otherwise be asserted only in a comment.
    const a = {
      ...opt('chat.consolidate_joins'),
      key: 'x.a',
      dependsOn: [{ key: 'x.b', in: [true] }],
    } as SettingOption;
    const b = {
      ...opt('chat.consolidate_joins'),
      key: 'x.b',
      dependsOn: [{ key: 'x.a', in: [true] }],
    } as SettingOption;
    const lookup = (key: string) => ({ 'x.a': a, 'x.b': b })[key];
    const readTrue = () => true;

    // Both halves of the trap, asserted so a change to either shows up here.
    expect(optionEnabled(a, readTrue, 0, lookup)).toBe(false);
    expect(dependencyHint(a, readTrue, lookup)).toBe('');
    // ...and the composition that has to survive them disagreeing.
    expect(dependencyStateFor(a, readTrue, lookup)).toBe(
      'Inactive — its dependencies could not be resolved.',
    );
  });
});
