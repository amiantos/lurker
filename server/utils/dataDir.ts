// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single source of truth for Lurker's data directory — the persistent volume
// that holds the SQLite DB and the files that live beside it (session secret,
// bouncer cert, local uploads). Resolved from DATABASE_PATH when set (the
// production/Docker path), else a repo-relative ./data for local dev. Computed
// from THIS module's location so every caller agrees regardless of where it sits
// in the tree — previously each site re-derived it with its own `..` depth.

import path from 'path';

export function resolveDataDir(): string {
  if (process.env.DATABASE_PATH) return path.dirname(process.env.DATABASE_PATH);
  return path.join(import.meta.dirname, '../../data');
}
