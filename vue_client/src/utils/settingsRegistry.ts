// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Client-side wrapper around the shared settings registry. Re-exports the
// data + shared helpers and adds getDefault(), the lookup pattern the
// Settings UI uses to seed inputs before the user-saved values arrive.

import {
  REGISTRY,
  getOption,
  defaultsAsObject,
  CATEGORIES,
  GROUPS,
} from '../../../shared/settingsRegistry.js';
import type {
  SettingValue,
  SettingOption,
  SettingCategory,
} from '../../../shared/settingsRegistry.js';

export { REGISTRY, getOption, defaultsAsObject, CATEGORIES, GROUPS };

export function getDefault(key: string): SettingValue | undefined {
  const opt = getOption(key);
  return opt ? opt.default : undefined;
}

/** Edition context that decides which settings surfaces are visible. */
export interface VisibilityContext {
  isNode: boolean;
}

/**
 * Whether a settings category shows in the sidebar. `selfHostedOnly` categories
 * are hidden in the hosted (node) edition, where the operator — not the tenant —
 * owns them.
 *
 * There is deliberately no admin dimension here any more: instance administration
 * lives entirely in the /admin panel, so Settings holds nothing an admin sees and
 * a regular user doesn't.
 */
export function categoryVisible(cat: SettingCategory, ctx: VisibilityContext): boolean {
  if (cat.selfHostedOnly && ctx.isNode) return false;
  return true;
}

/** Whether an individual registry setting renders, given the edition. */
export function optionVisible(opt: SettingOption, ctx: Pick<VisibilityContext, 'isNode'>): boolean {
  if (opt.selfHostedOnly && ctx.isNode) return false;
  return true;
}
