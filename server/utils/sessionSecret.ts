// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Resolves the session-signing secret in this priority order:
//   1. SESSION_SECRET environment variable (operator-supplied).
//   2. A `session-secret.key` file alongside the SQLite DB.
//   3. Auto-generated 64-byte random secret, written to (2) for future boots.
//
// (3) is the Postalgic-style zero-config path: an operator who just does
// `docker compose up -d` ends up with a secret that survives container
// rebuilds because it lives in the mounted data volume.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { resolveDataDir } from './dataDir.js';

const SECRET_FILENAME = 'session-secret.key';

export function resolveSessionSecret({ dataDir = resolveDataDir() }: { dataDir?: string } = {}): {
  secret: string;
  source: 'env' | 'file' | 'generated';
  path?: string;
} {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0) return { secret: fromEnv, source: 'env' };

  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, SECRET_FILENAME);

  if (fs.existsSync(secretPath)) {
    const stored = fs.readFileSync(secretPath, 'utf8').trim();
    if (stored.length > 0) return { secret: stored, source: 'file', path: secretPath };
  }

  const generated = crypto.randomBytes(64).toString('base64');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return { secret: generated, source: 'generated', path: secretPath };
}
