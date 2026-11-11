// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Request, Response, NextFunction } from 'express';
import { timeSyncWork } from '../services/syncWork.js';

// Times the handlers downstream of it, so a request that holds the event loop
// is named on the stall line (services/syncWork.ts). `next()` returns when the
// synchronous part of the chain below has run, which is the part that blocks.
//
// ⚠ Mounted TWICE (app.ts): first of all, and again after the body parsers. A
// parser reads the body asynchronously and calls its own `next()` later, by
// which time the first mount's `next()` has long returned, having timed
// nothing — so a request with a body is timed by the second mount, one without
// by both (the same label twice, which changes nothing: the longest is kept).
// Still out of reach: whatever a route does after its own asynchronous step
// (a multipart upload's handler, an awaited call).
//
// Labelled by route pattern (`/api/networks/:id`), never the URL: a path can
// carry a token.
export function timeHandlers(req: Request, _res: Response, next: NextFunction): void {
  timeSyncWork(
    () =>
      `${req.method} ${req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || 'unrouted'}`,
    next,
  );
}
