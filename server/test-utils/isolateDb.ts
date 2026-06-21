// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

// Side-effect module: redirect the db layer at a throwaway file. Import this
// FIRST — before any module that reaches db/index.js — in test files that
// statically value-import db-touching code. db/index.js opens its SQLite file
// at module-load time, and a top-level `process.env.DATABASE_PATH = …`
// statement in the test runs *after* its static imports are evaluated, far too
// late to redirect it (this is exactly how ircConnection.test.ts leaked
// "Joined #anime" rows into the operator's real data/lurker.db). Tests that use
// the dynamic-import pattern (set the env, then `await import(...)`) don't need
// this. Idempotent: an already-set DATABASE_PATH wins.
if (!process.env.DATABASE_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  // Remove the throwaway dir when this file's tests finish, matching the afterAll
  // cleanup the dynamic-import test files do — otherwise repeated local runs
  // leave lurker-test-* dirs behind in the OS temp dir. Only the dir we created:
  // if DATABASE_PATH was already set we never reach here. (This module is
  // imported at a test file's top level, so the hook registers on that file's
  // root suite; the open better-sqlite3 handle is fine — unlinking an open file
  // is valid and the fd closes at process exit, same as systemMessages.test.ts.)
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}
