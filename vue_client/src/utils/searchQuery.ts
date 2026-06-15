// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Parse the inline message-search syntax:
//   from:nick in:#channel on:network freetext...
// `from:` / `in:` / `on:` tokens are peeled off as structured filters;
// everything else is joined back as the free-text query. A bare prefix with no
// value (`from:`) or an unknown `word:` token is left in the free text — the
// FTS layer handles it harmlessly.

export interface SearchQuery {
  query: string;
  // `from:` may repeat — messages from ANY listed nick (OR), e.g. a friend's alts.
  from: string[];
  in: string;
  on: string;
}

export function parseSearchQuery(raw: unknown): SearchQuery {
  const filters: SearchQuery = { query: '', from: [], in: '', on: '' };
  const free: string[] = [];
  for (const token of String(raw || '')
    .trim()
    .split(/\s+/)) {
    if (!token) continue;
    const m = /^(from|in|on):(.+)$/i.exec(token);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === 'from') filters.from.push(m[2]);
      else filters[key as 'in' | 'on'] = m[2];
    } else {
      free.push(token);
    }
  }
  filters.query = free.join(' ');
  return filters;
}
