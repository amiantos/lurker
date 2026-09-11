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
import retentionRouter from './routes/retention.js';
import highlightRulesRouter from './routes/highlightRules.js';
import highlightsRouter from './routes/highlights.js';
import bookmarksRouter from './routes/bookmarks.js';
import searchRouter from './routes/search.js';
import themesRouter from './routes/themes.js';
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
import linkPreviewRouter from './routes/linkPreview.js';
import nodeRouter from './routes/node.js';
import { oauthRouter, wellKnownRouter } from './routes/oauth.js';
import mcpRouter from './services/mcpServer.js';
import { requireApiAuth } from './middleware/apiAuth.js';
import { isNodeMode } from './utils/edition.js';
import { previewsEnabled } from './utils/previews.js';
import { allowedBrowserOrigins } from './utils/corsOrigins.js';

// body-parser marks its own failures (malformed JSON or form data, a body over
// the limit, an unsupported charset) with a `type` such as 'entity.parse.failed'
// and a 4xx `status`.
function isBodyParseError(err: unknown): err is { status: number } {
  if (!err || typeof err !== 'object') return false;
  const { type, status } = err as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // A body that didn't parse is the client's mistake, not a server fault. The
  // parser attaches the raw body to the error, and that body can be a password or
  // an OAuth code, so it is answered with its 4xx and never logged. This has to
  // live here: the JSON parser runs app-wide, ahead of every router, so an error
  // it raises never reaches a router's own handler.
  if (isBodyParseError(err)) {
    if (res.headersSent) return next(err);
    res.status(err.status).json({ error: 'invalid_request' });
    return;
  }
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
  const corsOrigins = allowedBrowserOrigins();
  // A set-but-unparseable CORS_ORIGIN (e.g. a bare host with no scheme) normalizes
  // to nothing, silently rejecting every cross-origin request. Surface it once at
  // startup rather than leaving the operator to debug a mystery 403/CORS failure.
  if (process.env.CORS_ORIGIN && corsOrigins.length === 0) {
    console.warn(
      `[lurker] CORS_ORIGIN is set ("${process.env.CORS_ORIGIN}") but no valid origin parsed from it — cross-origin requests will be rejected. Each entry needs a scheme, e.g. https://irc.example.com`,
    );
  }
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser(sessionSecret));

  app.use('/api/auth', authRouter);
  app.use('/api/networks', networksRouter);
  app.use('/api/network-presets', networkPresetsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/retention', retentionRouter);
  app.use('/api/highlight-rules', highlightRulesRouter);
  app.use('/api/highlights', highlightsRouter);
  app.use('/api/bookmarks', bookmarksRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/themes', themesRouter);
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
    // /uploads/local was the original mount (#582 dropped the redundant segment).
    // It stays mounted forever as an alias: upload_history.url stores the fully
    // absolutized link and nothing reparses it, so every link already pasted into
    // IRC — including ones read by other clients we can't rewrite — still resolves.
    // The two-segment path can't match the new mount's single-segment '/:key', so
    // order between them doesn't matter.
    app.use('/uploads/local', localUploadsRouter);
    app.use('/uploads', localUploadsRouter);
  }
  app.use('/api/dcc', dccRouter);
  app.use('/api/drafts', draftsRouter);
  app.use('/api/exports', exportsRouter);
  app.use('/api/imports', importRouter);
  app.use('/api/config', configRouter);
  // ⚠ Not mounted at all when the feature is off, so both endpoints 404 rather than existing
  // and refusing. The in-route and resolver guards stay as defence in depth — this is the outer
  // one, and it's what makes "off" mean the surface isn't there.
  if (previewsEnabled()) {
    app.use('/api/link-preview', linkPreviewRouter);
  }

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

  // OAuth sign-in for third-party clients (#891). Standalone only: hosted sign-in
  // happens in front of the cells, so a cell must not mint credentials of its own.
  // Discovery sits under /.well-known and has to be mounted before express.static
  // below, or the SPA fallback answers it with index.html.
  if (!isNodeMode()) {
    app.use('/api/oauth', oauthRouter);
    app.use('/.well-known', wellKnownRouter);
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
  //
  // `assets` is excluded for a different reason: everything under it is a real
  // hashed build artifact served by express.static above, never a client route.
  // Without the exclusion a missing chunk falls through to here and gets
  // index.html back with a 200 and Content-Type: text/html, so the browser
  // reports a confusing module-type refusal instead of a plain 404 — and the
  // client can't cleanly tell "chunk is gone" from "page is fine" (#571).
  //
  // `.well-known` is for machines, never a page. A client probing for a document
  // this server doesn't publish (an MCP client asking for OAuth protected-resource
  // metadata before falling back to the authorization-server document, #891)
  // needs a 404 it can act on, not the SPA's HTML with a 200.
  const clientDist = path.join(import.meta.dirname, '../vue_client/dist');
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|ws|mcp|assets|[.]well-known).*/, (req, res, next) => {
    // The OAuth approval page (#891) must never render inside someone else's
    // frame, where an Approve click could be steered. Scoped to this one path so
    // self-hosters can keep embedding the rest of the app; the page's route forces
    // a full document load when reached client-side, so these always apply to it.
    // Compared the way the client router matches routes (case-insensitive, trailing
    // slash optional), or /OAuth/Authorize/ would render the page without them.
    if (req.path.toLowerCase().replace(/\/+$/, '') === '/oauth/authorize') {
      res.set({
        'Content-Security-Policy': "frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
    }
    res.sendFile(path.join(clientDist, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(errorHandler);

  return app;
}
