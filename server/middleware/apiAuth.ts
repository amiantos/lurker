// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request, Response, NextFunction } from 'express';
import { findActiveByHash, hashToken, touchLastUsed } from '../db/apiTokens.js';
import { findTokenByRaw, touchTokenLastUsed } from '../db/oauth.js';
import { findUserById } from '../db/users.js';

// Authentication for the MCP endpoint. Two bearer credentials work here:
//
//   - An API token, minted in Settings, carrying its own scope ('read' or
//     'read-write') in req.apiToken.
//   - An OAuth access token (#891) for an app the member approved in the
//     browser. It has the access of a password sign-in, so the MCP server treats
//     it as read-write. MCP clients find the OAuth server through its discovery
//     document after this endpoint's 401; refusing the token they come back with
//     would send them round the approval again and again.
//
// `req.user` is populated to the same shape requireAuth sets so handlers can't
// tell the credential apart; `req.session` is intentionally absent.
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const raw = match[1];

  const tokenRow = findActiveByHash(hashToken(raw));
  if (tokenRow) {
    const user = findUserById(tokenRow.userId);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.user = user;
    req.apiToken = { id: tokenRow.id, scope: tokenRow.scope };
    touchLastUsed(tokenRow.id);
    next();
    return;
  }

  const oauth = findTokenByRaw(raw);
  const user = oauth ? findUserById(oauth.userId) : undefined;
  if (!oauth || !user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  req.oauthToken = { id: oauth.id, appId: oauth.appId };
  touchTokenLastUsed(oauth.id);
  next();
}
