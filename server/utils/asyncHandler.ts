// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { NextFunction, Request, Response } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';

// Express 5 forwards rejected promises from async handlers to the error
// middleware automatically, but we keep this wrapper so every route opts into
// that behavior explicitly and the intent is visible at the call site.
// Generic over the route params so handlers can type req.params (e.g.
// Request<{ token: string }>) without the wrapper widening them back to the
// default ParamsDictionary. See #146 for removing this wrapper entirely.
type AsyncRouteHandler<P = ParamsDictionary> = (
  req: Request<P>,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler<P = ParamsDictionary>(fn: AsyncRouteHandler<P>) {
  return async (req: Request<P>, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}
