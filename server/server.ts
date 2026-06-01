// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import 'dotenv/config';
import http from 'http';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';

import authRouter from './routes/auth.js';
import networksRouter from './routes/networks.js';
import settingsRouter from './routes/settings.js';
import highlightRulesRouter from './routes/highlightRules.js';
import highlightsRouter from './routes/highlights.js';
import bookmarksRouter from './routes/bookmarks.js';
import pushRouter from './routes/push.js';
import adminRouter from './routes/admin.js';
import uploadsRouter from './routes/uploads.js';
import draftsRouter from './routes/drafts.js';
import { exportsRouter, importRouter } from './routes/exports.js';
import apiTokensRouter from './routes/apiTokens.js';
import configRouter from './routes/config.js';
import ircManager from './services/ircManager.js';
import { attachWsHub } from './services/wsHub.js';
import './services/verbs/index.js';
import mcpRouter from './services/mcpServer.js';
import { requireApiAuth } from './middleware/apiAuth.js';
import * as systemLog from './services/systemLog.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { resolveSessionSecret } from './utils/sessionSecret.js';
import { getEdition } from './utils/edition.js';

const PORT = Number(process.env.PORT || 8010);
const EDITION = getEdition();
const { secret: SESSION_SECRET, source: sessionSecretSource } = resolveSessionSecret();
if (sessionSecretSource === 'generated') {
  console.log('[lurker] generated new session secret in data/session-secret.key');
}
console.log(`[lurker] edition: ${EDITION}`);

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || 'https://irc.local.bradroot.me:5173';
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(SESSION_SECRET));

app.use('/api/auth', authRouter);
app.use('/api/networks', networksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/highlight-rules', highlightRulesRouter);
app.use('/api/highlights', highlightsRouter);
app.use('/api/bookmarks', bookmarksRouter);
app.use('/api/push', pushRouter);
app.use('/api/admin', adminRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/exports', exportsRouter);
app.use('/api/imports', importRouter);
app.use('/api/api-tokens', apiTokensRouter);
app.use('/api/config', configRouter);

app.use('/mcp', requireApiAuth, mcpRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const clientDist = path.join(import.meta.dirname, '../vue_client/dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|ws).*/, (_req, res, next) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  console.error('[lurker] error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
};
app.use(errorHandler);

const server = http.createServer(app);
attachWsHub(server, SESSION_SECRET);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

systemLog.log({ scope: 'server', text: `Lurker server starting up (edition: ${EDITION})` });

ircManager.initAll();

server.listen(PORT, () => {
  console.log(`[lurker] listening on http://localhost:${PORT}`);
  systemLog.log({ scope: 'server', text: `Listening on port ${PORT}` });
});

function shutdown(signal: string): void {
  console.log(`[lurker] received ${signal}, shutting down`);
  systemLog.log({ scope: 'server', level: 'warn', text: `Received ${signal}, shutting down` });
  ircManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
