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
  SettingDependency,
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
export function optionVisible(
  opt: SettingOption,
  ctx: Pick<VisibilityContext, 'isNode'> & { features?: Partial<Record<'linkPreviews', boolean>> },
): boolean {
  if (opt.selfHostedOnly && ctx.isNode) return false;
  // A feature the instance hasn't enabled has no server behind it, so its settings are hidden
  // rather than rendered inert.
  if (opt.requiresFeature && ctx.features?.[opt.requiresFeature] !== true) return false;
  return true;
}

// How deep a dependsOn chain we follow before giving up. Real chains are two
// links (`consolidate_max_names → consolidate_joins → chat.events`); the cap is
// purely so a registry edit that accidentally makes a cycle greys a row out
// instead of hanging the settings pane.
const MAX_DEPENDENCY_DEPTH = 8;

/**
 * How a dependency clause's key is resolved to its registry option. Injectable
 * purely so the depth cap is testable: with the real registry the cap is
 * unreachable (there is no cycle, and a test asserts every clause names a real
 * key), which would leave the fail-closed path below asserted only in a comment.
 */
export type OptionLookup = (key: string) => SettingOption | null | undefined;

/**
 * Whether a setting currently DOES anything, per its `dependsOn` clauses.
 *
 * Clauses are ORed: the option is live if any one of them holds. Resolution is
 * transitive — an option whose dependency is itself inactive is inactive too —
 * so the registry states each link once instead of restating the whole chain on
 * every leaf.
 *
 * Inactive is a rendering state, never a storage one: the value is kept and
 * still returned, because flipping the condition back has to restore what the
 * user had rather than a pile of defaults.
 *
 * `read` supplies effective values (i.e. `settingsStore.effective`).
 */
export function optionEnabled(
  opt: SettingOption,
  read: (key: string) => SettingValue | undefined,
  depth = 0,
  lookup: OptionLookup = getOption,
): boolean {
  if (!opt.dependsOn?.length) return true;
  if (depth >= MAX_DEPENDENCY_DEPTH) return false;
  return opt.dependsOn.some((dep) => {
    if (!dep.in.includes(read(dep.key) as SettingValue)) return false;
    const parent = lookup(dep.key);
    // A clause naming a key that isn't in the registry can't be evaluated any
    // further; the value check above is all we have, and it passed.
    return parent ? optionEnabled(parent, read, depth + 1, lookup) : true;
  });
}

/**
 * The clauses actually standing between this setting and being live.
 *
 * NOT simply `opt.dependsOn`. Because `optionEnabled` is transitive, a clause can
 * fail with its own value already satisfied — the parent it names is itself
 * inactive. Reporting that clause verbatim sends the user to a row that already
 * reads the way the hint demands, with no way forward (and the editor disabled,
 * so they can't even poke at it). So: report the clauses the user can act on,
 * and when every failure is transitive, report what the PARENTS need instead.
 */
function unmetClauses(
  opt: SettingOption,
  read: (key: string) => SettingValue | undefined,
  depth = 0,
  lookup: OptionLookup = getOption,
): SettingDependency[] {
  if (!opt.dependsOn?.length || depth >= MAX_DEPENDENCY_DEPTH) return [];
  const actionable: SettingDependency[] = [];
  const blockedParents: SettingOption[] = [];
  for (const dep of opt.dependsOn) {
    const parent = lookup(dep.key);
    // Wrong value → the user changes this one. That's the actionable case.
    if (!dep.in.includes(read(dep.key) as SettingValue)) {
      actionable.push(dep);
      continue;
    }
    // Right value, but the row it names is greyed out too — recurse past it.
    if (parent && !optionEnabled(parent, read, depth + 1, lookup)) blockedParents.push(parent);
  }
  if (actionable.length) return actionable;
  const inherited = blockedParents.flatMap((parent) =>
    unmetClauses(parent, read, depth + 1, lookup),
  );
  // Two parents can bottom out on the same root clause (both consolidation keys
  // hang off the same tier pair); say it once.
  const seen = new Set<string>();
  return inherited.filter((dep) => {
    const id = `${dep.key}=${dep.in.join('|')}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Human-readable "why is this greyed out, and what do I change" line.
 *
 * Deliberately shows dotted keys rather than labels: the settings pane already
 * prints the key under every headline, so this reads as an instruction you can
 * act on rather than a riddle about which row to find.
 */
/**
 * What the Settings pane actually needs: '' when the setting is live, otherwise
 * the line to show under a greyed-out row.
 *
 * Composed here rather than at the call site because the two resolvers have to
 * agree and they bail differently. `optionEnabled` returns false at the depth
 * cap; `dependencyHint` returns '' at the same cap, having nothing to name. A
 * caller that greys the row on "hint is non-empty" would then render a row it
 * knows is inactive as fully live — a registry cycle would produce a control
 * that looks usable and isn't. Fail closed instead.
 */
export function dependencyStateFor(
  opt: SettingOption,
  read: (key: string) => SettingValue | undefined,
  lookup: OptionLookup = getOption,
): string {
  if (optionEnabled(opt, read, 0, lookup)) return '';
  return dependencyHint(opt, read, lookup) || 'Inactive — its dependencies could not be resolved.';
}

export function dependencyHint(
  opt: SettingOption,
  read: (key: string) => SettingValue | undefined,
  lookup: OptionLookup = getOption,
): string {
  const clauses = unmetClauses(opt, read, 0, lookup).map((dep) => {
    const values = dep.in.map((v) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)));
    return `${dep.key} = ${values.join(' or ')}`;
  });
  if (!clauses.length) return '';
  return `Inactive — needs ${clauses.join(', or ')}.`;
}
