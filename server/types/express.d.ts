// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Ambient augmentation of Express's Request. The auth middleware
// (middleware/auth.ts) resolves the session cookie or bearer token once and
// attaches the account here, along with the credential it came through — a
// session row, or the OAuth token of an app the member approved (#891) — so
// downstream route handlers behind requireAuth can read them directly. All are
// optional at the type level because handlers in front of the middleware see a
// bare request.

import type { User } from '../db/users.js';
import type { Session } from '../db/sessions.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
      apiToken?: { id: number | bigint; scope: string };
      oauthToken?: { id: number; appId: number };
    }
  }
}
