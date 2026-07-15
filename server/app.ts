// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Express app construction, split out from server.ts so the route wiring can be
// built and exercised in isolation (integration tests) without booting the HTTP
// server, WebSocket hub, or IRC manager. server.ts owns the process lifecycle;
// this module owns "what routes exist and how requests are handled" — including
// the edition-aware gating of operator-only surfaces.

import express from 'express';
import type { Express, ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';

import authRouter from './routes/auth.js';
import networksRouter from './routes/networks.js';
import networkPresetsRouter from './routes/networkPresets.js';
import settingsRouter from './routes/settings.js';
import highlightRulesRouter from './routes/highlightRules.js';
import highlightsRouter from './routes/highlights.js';
import bookmarksRouter from './routes/bookmarks.js';
import pushRouter from './routes/push.js';
import adminRouter from './routes/admin.js';
import uploadsRouter from './routes/uploads.js';
import uploadersRouter from './routes/uploaders.js';
import localUploadsRouter from './routes/localUploads.js';
import dccRouter from './routes/dcc.js';
import draftsRouter from './routes/drafts.js';
import { exportsRouter, importRouter } from './routes/exports.js';
import apiTokensRouter from './routes/apiTokens.js';
import configRouter from './routes/config.js';
import nodeRouter from './routes/node.js';
import mcpRouter from './services/mcpServer.js';
import { requireApiAuth } from './middleware/apiAuth.js';
import { isNodeMode } from './utils/edition.js';
import { allowedBrowserOrigins } from './utils/corsOrigins.js';

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  console.error('[lurker] error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
};

/**
 * Build the fully-wired Express app. `sessionSecret` keys cookie-parser for the
 * signed `lurker_session` cookie (the same secret server.ts hands to the WS
 * hub). Route gating reads the cached edition, so set LURKER_EDITION before the
 * first getEdition() call.
 */
export function buildApp(sessionSecret: string): Express {
  const app = express();

  // CORS_ORIGIN is a comma-separated allowlist, normalized to URL origins (see
  // utils/corsOrigins). The WS upgrade origin check reads the same source, so the
  // HTTP and WebSocket layers agree exactly on what's allowed.
  app.use(cors({ origin: allowedBrowserOrigins(), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(sessionSecret));

  app.use('/api/auth', authRouter);
  app.use('/api/networks', networksRouter);
  app.use('/api/network-presets', networkPresetsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/highlight-rules', highlightRulesRouter);
  app.use('/api/highlights', highlightsRouter);
  app.use('/api/bookmarks', bookmarksRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/uploaders', uploadersRouter);
  // Public (no-auth) serving of local-driver files. Off /api by design: the URL
  // is opened by anyone the uploader shares it with, protected only by its
  // non-guessable key. Mounted before the SPA fallback so it wins the route.
  // Self-host only — the `local` driver isn't offered on the (ephemeral) hosted
  // fleet, so the route would only ever 404 there; don't expose it at all.
  if (!isNodeMode()) {
    app.use('/uploads/local', localUploadsRouter);
  }
  app.use('/api/dcc', dccRouter);
  app.use('/api/drafts', draftsRouter);
  app.use('/api/exports', exportsRouter);
  app.use('/api/imports', importRouter);
  app.use('/api/config', configRouter);

  // The HTTP API-token feature and the MCP server are the two ends of the same
  // bearer-token model: /api/api-tokens (session-cookie auth) mints the tokens,
  // and /mcp (bearer auth) consumes them. The hosted service routes a customer
  // to their cell by the cp_session cookie, but a bearer client carries no such
  // cookie — so /mcp can't be addressed through the per-cell proxy, which makes
  // the tokens unusable there. Disable both in node edition (A7); A3 hides the
  // matching UI. Standalone keeps them fully featured.
  if (!isNodeMode()) {
    app.use('/api/api-tokens', apiTokensRouter);
    app.use('/mcp', requireApiAuth, mcpRouter);
  }

  // Orchestrator-only control surface. Mounted exclusively in node edition so a
  // standalone self-hosted instance never exposes it at all.
  if (isNodeMode()) {
    app.use('/api/node', nodeRouter);
  }

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // SPA fallback for client-side routes. `mcp` joins `api`/`ws` in the exclusion
  // so that in node edition — where /mcp isn't mounted — a stray GET /mcp 404s
  // instead of being served index.html; it's a disabled endpoint, not a page.
  // (In standalone the mounted /mcp middleware handles it before this anyway.)
  const clientDist = path.join(import.meta.dirname, '../vue_client/dist');
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws|mcp).*/, (_req, res, next) => {
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);

  return app;
}
