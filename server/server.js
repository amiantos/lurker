import 'dotenv/config';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import authRouter from './routes/auth.js';
import networksRouter from './routes/networks.js';
import settingsRouter from './routes/settings.js';
import highlightRulesRouter from './routes/highlightRules.js';
import pushRouter from './routes/push.js';
import ircManager from './services/ircManager.js';
import { attachWsHub } from './services/wsHub.js';
import { purgeExpiredSessions } from './db/sessions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8010);
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('[caint] SESSION_SECRET is required. See .env.example.');
  process.exit(1);
}

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser(SESSION_SECRET));

app.use('/api/auth', authRouter);
app.use('/api/networks', networksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/highlight-rules', highlightRulesRouter);
app.use('/api/push', pushRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const clientDist = path.join(__dirname, '../vue_client/dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api|ws).*/, (req, res, next) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((err, req, res, next) => {
  console.error('[caint] error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
attachWsHub(server, SESSION_SECRET);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

ircManager.initAll();

server.listen(PORT, () => {
  console.log(`[caint] listening on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`[caint] received ${signal}, shutting down`);
  ircManager.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
