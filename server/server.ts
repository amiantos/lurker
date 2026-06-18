// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import 'dotenv/config';
import http from 'http';

import { buildApp } from './app.js';
import ircManager from './services/ircManager.js';
import { attachWsHub } from './services/wsHub.js';
import './services/verbs/index.js';
import { getNodeSecret } from './middleware/nodeAuth.js';
import { nodeUploadConfigured } from './services/uploadProviders/nodeUpload.js';
import * as systemLog from './services/systemLog.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { backfillEncryptNetworkSecrets } from './db/networks.js';
import { resolveSessionSecret } from './utils/sessionSecret.js';
import { getEdition, isNodeMode } from './utils/edition.js';
import { startOrchestratorClient, stopOrchestratorClient } from './services/orchestratorClient.js';
import { startModerationReporter, stopModerationReporter } from './services/moderationReport.js';
import { startIdentd, stopIdentd, isIdentdEnabled, identdPort } from './services/identd.js';
import { startBouncerServer, stopBouncerServer } from './services/bouncerServer.js';
import {
  recoverInterruptedExports,
  startExportSweeper,
  shutdownExportJobs,
} from './services/exportJobs.js';

const PORT = Number(process.env.PORT || 8010);
const BOUNCER_PORT = process.env.LURKER_BOUNCER_PORT
  ? Number(process.env.LURKER_BOUNCER_PORT)
  : null;
const BOUNCER_HOST = process.env.LURKER_BOUNCER_HOST || '127.0.0.1';
const EDITION = getEdition();
const { secret: SESSION_SECRET, source: sessionSecretSource } = resolveSessionSecret();
if (sessionSecretSource === 'generated') {
  console.log('[lurker] generated new session secret in data/session-secret.key');
}
console.log(`[lurker] edition: ${EDITION}`);
if (isNodeMode() && !getNodeSecret()) {
  console.warn(
    '[lurker] node edition is active but LURKER_NODE_SECRET is unset — the node control API will reject every request (503) until it is configured',
  );
}
if (isNodeMode() && !nodeUploadConfigured()) {
  console.warn(
    '[lurker] node edition is active but LURKER_NODE_UPLOAD_URL / LURKER_NODE_UPLOAD_API_KEY are unset — image and text uploads will fail (400) until they are configured',
  );
}
if (isNodeMode() && !isIdentdEnabled()) {
  console.warn(
    '[lurker] node edition is active but LURKER_IDENTD_ENABLED is unset — IRC networks cannot attribute individual users; they will appear with an unverified ~ident behind the cell IP',
  );
}

const app = buildApp(SESSION_SECRET);
const server = http.createServer(app);
attachWsHub(server, SESSION_SECRET);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

systemLog.log({ scope: 'server', text: `Lurker server starting up (edition: ${EDITION})` });

// Built-in identd (opt-in via LURKER_IDENTD_ENABLED). A multi-user gateway
// needs it so IRC networks can attribute each user behind the shared IP; bind
// it before connections register their idents.
if (isIdentdEnabled()) {
  startIdentd(identdPort());
}

// Wrap any plaintext network secrets at rest now that the DB schema is ready
// and before IRC connects. No-op unless LURKER_SECRET_KEY is configured (hosted
// cells); self-host instances keep secrets in plaintext.
const wrapped = backfillEncryptNetworkSecrets();
if (wrapped.encrypted > 0) {
  console.log(`[lurker] encrypted ${wrapped.encrypted} network-secret row(s) at rest`);
  systemLog.log({ scope: 'server', text: `Encrypted ${wrapped.encrypted} network-secret row(s)` });
}

ircManager.initAll();

if (BOUNCER_PORT && Number.isInteger(BOUNCER_PORT) && BOUNCER_PORT > 0) {
  startBouncerServer({ host: BOUNCER_HOST, port: BOUNCER_PORT });
} else if (process.env.LURKER_BOUNCER_PORT) {
  console.warn('[lurker] LURKER_BOUNCER_PORT is set but is not a valid TCP port; bouncer disabled');
}

// Fail any export job a prior crash/restart left mid-flight, drop partial
// artifacts + expired ones, then sweep finished exports on an interval.
recoverInterruptedExports();
startExportSweeper();

// In node edition, start reporting to the orchestrator (register on boot +
// heartbeat on an interval). No-op in standalone or when unconfigured.
startOrchestratorClient();

// In node edition, periodically reconcile any upload moderation records that
// didn't reach the control plane at upload time. No-op in standalone.
startModerationReporter();

server.listen(PORT, () => {
  console.log(`[lurker] listening on http://localhost:${PORT}`);
  systemLog.log({ scope: 'server', text: `Listening on port ${PORT}` });
});

function shutdown(signal: string): void {
  console.log(`[lurker] received ${signal}, shutting down`);
  systemLog.log({ scope: 'server', level: 'warn', text: `Received ${signal}, shutting down` });
  stopOrchestratorClient();
  stopModerationReporter();
  stopIdentd();
  void stopBouncerServer().finally(() => {
    shutdownExportJobs();
    ircManager.shutdown();
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
