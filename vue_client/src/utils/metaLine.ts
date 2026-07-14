// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * The separator between the facts on a secondary line — a notification's
 * "libera • #general", a highlight rule's "QUACK! • whole word • #chan", an upload's
 * "2h ago • 412 KB".
 *
 * A bullet, not the middot (·) this used to be: these lines are rendered in muted grey
 * by definition, and at that weight a middot all but vanishes — it reads as a speck
 * rather than a separator.
 *
 * ⚠ Not used for the `/help` command examples in MessageInput. Those are monospace,
 * terminal-shaped text where a middot between example commands reads correctly and a
 * bullet would look like a list marker. Same glyph, different job.
 */
export const META_SEPARATOR = '•';

/**
 * Join the parts of a meta line, dropping the ones that aren't there.
 *
 * Built in JS rather than as adjacent template spans because Vue's whitespace
 * condensing strips the gaps between those, and the separator needs its spaces.
 */
export function joinMeta(parts: Array<string | number | false | null | undefined>): string {
  return parts.filter(Boolean).join(` ${META_SEPARATOR} `);
}
