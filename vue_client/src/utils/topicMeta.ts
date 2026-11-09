// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { formatDateTime } from './timestamp.js';

/**
 * "Set by alice · Nov 9, 2026, 3:04 PM" — who set a topic and when, as Channel
 * Settings and /topic both say it. Either half can be missing (some servers
 * send a 333 with the time alone); with neither there is no line.
 */
export function topicSetLine(by?: string | null, at?: string | null): string {
  if (!by && !at) return '';
  return [by ? `Set by ${by}` : 'Set', at ? formatDateTime(at) : ''].filter(Boolean).join(' · ');
}
