// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The message layout as the user picks it: one choice out of three looks,
// over the two settings underneath (look.message.layout and
// look.message.avatars). Avatars only show in the modern layout, so "avatars
// on or off" reads as two modern looks rather than a switch beside the layout.
//
// A phone-width screen is always modern, so there the choice is the two modern
// looks, and picking one never writes the layout: that key is the desktop's,
// and the same settings sync to it.

import type { SettingValue } from '../../../shared/settingsRegistry.js';

export const LAYOUT_KEY = 'look.message.layout';
export const AVATARS_KEY = 'look.message.avatars';

export type LayoutChoice = 'traditional' | 'modern' | 'modern-avatars';

export const LAYOUT_CHOICE_LABELS: Readonly<Record<LayoutChoice, string>> = {
  traditional: 'Traditional',
  modern: 'Modern',
  'modern-avatars': 'Modern with avatars',
};

/** What this screen can draw, in the order offered. */
export function layoutChoices(isMobile: boolean): LayoutChoice[] {
  return isMobile ? ['modern-avatars', 'modern'] : ['traditional', 'modern', 'modern-avatars'];
}

/** The choice the two settings amount to on this screen. */
export function currentLayoutChoice(
  layout: unknown,
  avatars: unknown,
  isMobile: boolean,
): LayoutChoice {
  if (!isMobile && layout !== 'compact') return 'traditional';
  return avatars === true ? 'modern-avatars' : 'modern';
}

/** What a new account is offered before it has picked anything. */
export function firstRunLayoutChoice(isMobile: boolean): LayoutChoice {
  return isMobile ? 'modern-avatars' : 'traditional';
}

/**
 * The settings a pick writes. Traditional says nothing about avatars — they
 * do not show in it — so it leaves that key as it is, except on a first run:
 * there it turns them on, as the same account's phone is modern whatever the
 * desktop is, and a new account's phone starts with avatars.
 */
export function layoutChoiceWrites(
  choice: LayoutChoice,
  opts: { isMobile: boolean; firstRun?: boolean },
): Record<string, SettingValue> {
  const avatars = choice === 'modern-avatars';
  if (opts.isMobile) return { [AVATARS_KEY]: avatars };
  if (choice === 'traditional') {
    return opts.firstRun ? { [LAYOUT_KEY]: 'auto', [AVATARS_KEY]: true } : { [LAYOUT_KEY]: 'auto' };
  }
  return { [LAYOUT_KEY]: 'compact', [AVATARS_KEY]: avatars };
}

/** A new account that skipped the question: the first-run default, written. */
export function skippedLayoutWrites(): Record<string, SettingValue> {
  return { [AVATARS_KEY]: true };
}
