// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  currentLayoutChoice,
  firstRunLayoutChoice,
  layoutChoices,
  layoutChoiceWrites,
  skippedLayoutWrites,
} from './layoutChoice.js';
import { REGISTRY } from '../../../shared/settingsRegistry.js';

describe('layoutChoices', () => {
  it('offers three looks on a desktop and the two modern ones on a phone', () => {
    expect(layoutChoices(false)).toEqual(['traditional', 'modern', 'modern-avatars']);
    expect(layoutChoices(true)).toEqual(['modern-avatars', 'modern']);
  });

  it('starts a new account on one of the looks its screen offers', () => {
    for (const isMobile of [false, true]) {
      expect(layoutChoices(isMobile)).toContain(firstRunLayoutChoice(isMobile));
    }
    expect(firstRunLayoutChoice(false)).toBe('traditional');
    expect(firstRunLayoutChoice(true)).toBe('modern-avatars');
  });
});

describe('currentLayoutChoice', () => {
  it('reads the desktop from the layout, then the avatars', () => {
    expect(currentLayoutChoice('auto', false, false)).toBe('traditional');
    expect(currentLayoutChoice('auto', true, false)).toBe('traditional');
    expect(currentLayoutChoice(undefined, true, false)).toBe('traditional');
    expect(currentLayoutChoice('compact', false, false)).toBe('modern');
    expect(currentLayoutChoice('compact', true, false)).toBe('modern-avatars');
  });

  it('reads a phone from the avatars alone: it is modern whatever the layout says', () => {
    expect(currentLayoutChoice('auto', true, true)).toBe('modern-avatars');
    expect(currentLayoutChoice('auto', false, true)).toBe('modern');
    expect(currentLayoutChoice('compact', true, true)).toBe('modern-avatars');
    expect(currentLayoutChoice('compact', undefined, true)).toBe('modern');
  });

  it('only ever answers with a look the screen offers', () => {
    for (const isMobile of [false, true]) {
      for (const layout of ['auto', 'compact']) {
        for (const avatars of [false, true]) {
          expect(layoutChoices(isMobile)).toContain(currentLayoutChoice(layout, avatars, isMobile));
        }
      }
    }
  });
});

describe('layoutChoiceWrites', () => {
  it('writes both keys for a modern look on a desktop', () => {
    expect(layoutChoiceWrites('modern', { isMobile: false })).toEqual({
      'look.message.layout': 'compact',
      'look.message.avatars': false,
    });
    expect(layoutChoiceWrites('modern-avatars', { isMobile: false })).toEqual({
      'look.message.layout': 'compact',
      'look.message.avatars': true,
    });
  });

  it('leaves the avatars alone for Traditional, which does not show them', () => {
    expect(layoutChoiceWrites('traditional', { isMobile: false })).toEqual({
      'look.message.layout': 'auto',
    });
  });

  it('never writes the layout from a phone', () => {
    for (const firstRun of [false, true]) {
      expect(layoutChoiceWrites('modern', { isMobile: true, firstRun })).toEqual({
        'look.message.avatars': false,
      });
      expect(layoutChoiceWrites('modern-avatars', { isMobile: true, firstRun })).toEqual({
        'look.message.avatars': true,
      });
    }
  });

  it('turns avatars on for a first-run Traditional, for the phone it will be opened on', () => {
    expect(layoutChoiceWrites('traditional', { isMobile: false, firstRun: true })).toEqual({
      'look.message.layout': 'auto',
      'look.message.avatars': true,
    });
    // Plain Modern is the one pick that says no avatars.
    expect(
      layoutChoiceWrites('modern', { isMobile: false, firstRun: true })['look.message.avatars'],
    ).toBe(false);
    expect(skippedLayoutWrites()).toEqual({ 'look.message.avatars': true });
  });

  it('reads back as the look that was picked', () => {
    for (const isMobile of [false, true]) {
      for (const choice of layoutChoices(isMobile)) {
        const w = layoutChoiceWrites(choice, { isMobile });
        expect(
          currentLayoutChoice(
            w['look.message.layout'] ?? 'auto',
            w['look.message.avatars'] ?? false,
            isMobile,
          ),
        ).toBe(choice);
      }
    }
  });

  it('writes only values the registry takes', () => {
    const layout = REGISTRY.find((o) => o.key === 'look.message.layout')!;
    expect(layout.type === 'enum' && layout.choices).toEqual(['auto', 'compact']);
    expect(layout.default).toBe('auto');
    expect(REGISTRY.find((o) => o.key === 'look.message.avatars')!.default).toBe(false);
  });
});
