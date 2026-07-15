// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getEdition } from '../utils/edition.js';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '../protocol.js';

const router = Router();

// Public, unauthenticated bootstrap config the client can read before login so
// the UI can branch on deployment edition (self-hosted vs hosted node) and other
// instance-level feature flags. Keep this lean and strictly non-sensitive — it is
// served to anyone who hits the origin.
//
// protocolVersion / minProtocolVersion let a native client check compatibility
// BEFORE it opens the WebSocket and render a real "update required" error instead
// of a failed connect (#569). minProtocolVersion is the oldest CLIENT this server
// serves; protocolVersion is what the server itself speaks.
router.get('/', (_req: Request, res: Response) => {
  res.json({
    edition: getEdition(),
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
  });
});

export default router;
