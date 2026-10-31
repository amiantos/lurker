// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Words for a restriction set (shared/accountRestrictions.ts), in two voices:
// the admin's, terse, for a tag's tooltip; and the member's, a sentence, for
// the invite landing page. One place, so the Users pane, the Invites pane and
// the landing page never describe the same set three different ways.

import { isUnrestricted, type AccountRestrictions } from '../../../shared/accountRestrictions.js';

/** For an admin: `networks: a, b · no uploads`, or '' for the unrestricted norm. */
export function describeRestrictions(r: AccountRestrictions | null | undefined): string {
  if (!r || isUnrestricted(r)) return '';
  const parts: string[] = [];
  if (r.networks !== null) {
    parts.push(r.networks.length ? `networks: ${r.networks.join(', ')}` : 'no networks');
  }
  if (!r.uploads) parts.push('no uploads');
  return parts.join(' · ');
}

/** For the member: what their account will be able to do, or '' for the norm. */
export function describeRestrictionsForMember(r: AccountRestrictions | null | undefined): string {
  if (!r || isUnrestricted(r)) return '';
  const parts: string[] = [];
  if (r.networks !== null) {
    parts.push(
      r.networks.length
        ? `This account can connect to ${listInWords(r.networks)} only.`
        : 'This account cannot connect to any IRC network yet.',
    );
  }
  if (!r.uploads) parts.push('File uploads are off for this account.');
  return parts.join(' ');
}

function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
