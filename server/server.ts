// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// FIRST import on purpose: it installs the dead-pty stdout/stderr guards as an
// import side effect (#442), and module evaluation follows import-declaration
// order — dotenv's injection banner and the db module's boot-migration logs
// write to stdout during the import phase, before any statement in this file
// runs. Moving this down (or installing from this file's body, as a previous
// revision did) re-opens the boot-time crash window this exists to close.
import { onStdioSuppressed, installFatalExceptionExit } from './utils/processGuards.js';
import 'dotenv/config';
import http from 'http';

import { buildApp } from './app.js';
import ircManager from './services/ircManager.js';
import {
  EngineLink,
  engineConfigured,
  startEngineLink,
  stopEngineLink,
} from './services/engineLink.js';
import { attachWsHub } from './services/wsHub.js';
import './services/verbs/index.js';
import { getNodeSecret } from './middleware/nodeAuth.js';
import { nodeUploadConfigured } from './services/uploadProviders/nodeUpload.js';
import * as systemLog from './services/systemLog.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { sweepExpiredPreviews } from './db/linkPreviews.js';
import { sweepPreviewCache } from './services/previewCache/index.js';
import { startRetentionSweeper } from './services/retentionSweeper.js';
import { listGrandfatheredUsernames } from './db/users.js';
import { backfillEncryptColumns } from './db/secretBackfill.js';
import { assertPushCredentials } from './services/push/credentials.js';
import { resolveSessionSecret } from './utils/sessionSecret.js';
import { getEdition, isNodeMode } from './utils/edition.js';
import { warnRetiredPreviewEnv } from './utils/previews.js';
import { startOrchestratorClient, stopOrchestratorClient } from './services/orchestratorClient.js';
import { startModerationReporter, stopModerationReporter } from './services/moderationReport.js';
import {
  startIdentd,
  stopIdentd,
  isIdentdEnabled,
  identdPort,
  identdBindHost,
  isOidentdFileEnabled,
  initOidentdFile,
  stopOidentdFile,
} from './services/identd.js';
import {
  startBouncer,
  stopBouncer,
  isBouncerEnabled,
  bouncerPort,
  bouncerBindHost,
} from './services/bouncer.js';
import {
  recoverInterruptedExports,
  startExportSweeper,
  shutdownExportJobs,
} from './services/exportJobs.js';
import { startIgnoreSweeper, stopIgnoreSweeper } from './services/ignoreSweeper.js';
import { sweepTempUploads } from './routes/uploads.js';
import { startEventLoopMonitor, stopEventLoopMonitor } from './services/eventLoopMonitor.js';
import restoreGate from './services/restoreGate.js';
import * as systemMessages from './db/systemMessages.js';

// Wired here rather than inside processGuards (which must stay import-free —
// see its header): both records target the DB-backed system log, which only
// exists once the import phase is over. The breadcrumb makes "console logging
// stopped" (dead pty, or the consumer of `npm start | tee` exiting)
// discoverable instead of a silent weeks-long gap in the log file.
onStdioSuppressed((detail) => {
  systemLog.log({
    scope: 'server',
    level: 'warn',
    text: `Console stream write failed (${detail}) — stdout/stderr logging is suspended; the system log is unaffected`,
  });
});

// Fatal exceptions (and, under Node's default mode, unhandled rejections)
// still exit — see installFatalExceptionExit for the ordering contract. The
// record writes via systemMessages.insert directly, NOT systemLog.log: log()
// synchronously runs the full wsHub fan-out (per-user reads, frame queuing)
// for frames the exit(1) is about to discard mid-crash.
installFatalExceptionExit((text) =>
  systemMessages.insert({
    userId: null,
    ts: new Date().toISOString(),
    level: 'error',
    scope: 'server',
    source: 'server',
    text,
  }),
);

const PORT = Number(process.env.PORT || 8010);
// Optional bind address for the web/API server (HOST). Unset keeps upstream
// behaviour (listen on all interfaces); set HOST=127.0.0.1 to keep Lurker
// private behind a local reverse proxy / tunnel such as cloudflared.
const HOST = process.env.HOST?.trim() || undefined;
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
// Engine mode (LURKER_ENGINE_URL): the IRC sockets live in a separate process
// that survives this one. Start the link now; NOT awaited, so a down engine
// can't hold the HTTP listener hostage — connections simply wait for it. A
// refusal (wrong secret, protocol major) turns engine mode off for this run,
// loudly, whenever it happens; identd then has to start here after all.
if (engineConfigured()) {
  void startEngineLink();
  EngineLink.shared().once('refused', () => {
    console.warn(
      '[lurker] engine refused — starting the ident services in this process instead. Note that :113 is normally published on the engine container, so they may not be reachable until the engine is fixed.',
    );
    startIdentServices();
  });
}

if (isNodeMode() && !engineConfigured() && !isIdentdEnabled() && !isOidentdFileEnabled()) {
  console.warn(
    '[lurker] node edition is active but neither LURKER_IDENTD_ENABLED nor LURKER_OIDENTD_FILE is set — IRC networks cannot attribute individual users; they will appear with an unverified ~ident behind the cell IP',
  );
}
// Not gated on edition: a self-hoster upgrading from 2.1.1 is exactly who this is for.
warnRetiredPreviewEnv();

const app = buildApp(SESSION_SECRET);
const server = http.createServer(app);
attachWsHub(server, SESSION_SECRET);

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

// link_previews is a cache with a TTL, so lapsed rows have to actually go — without this it
// only ever grows. Deliberately NOT gated on previewsEnabled(): an operator who turns the
// feature off still has whatever it cached while it was on, and that should still expire.
sweepExpiredPreviews();
setInterval(sweepExpiredPreviews, 60 * 60 * 1000).unref();

// The BYTE cache's index needs the same treatment, and for `s3` it is not merely
// hygiene: nothing else bounds that table, and a row that outlives its object has
// `toDescriptor` minting a public URL that 404s for everyone. `void` because the
// sweep touches a bucket-backed backend and answers with a count nobody waits on;
// it swallows its own failures, like every other path in that module.
void sweepPreviewCache();
setInterval(() => void sweepPreviewCache(), 60 * 60 * 1000).unref();

// History retention (lurker-dev/RETENTION_PLAN.md). Self-scheduling rather than a fixed
// interval — a tick that found a backlog comes back in seconds — and started
// unconditionally: with no ceiling and no user opt-in, the boot-seeded first
// pass is one budgeted, yielding walk of owner/cap lookups that drains to
// nothing, and every tick after it is a no-op over an empty dirty set.
startRetentionSweeper();

systemLog.log({ scope: 'server', text: `Lurker server starting up (edition: ${EDITION})` });

// Watch for synchronous event-loop stalls (a heavy client-connect snapshot on
// slow storage can starve IRC socket I/O and trip ping timeouts, dropping every
// network at once). Console-only; read via `docker logs`. See eventLoopMonitor.
// The stall line names the engine-restore refreshes in flight, if any — the
// known heavy hitter after a re-attach (#842).
startEventLoopMonitor({ context: () => restoreGate.describeInFlight() });

// Built-in identd (opt-in via LURKER_IDENTD_ENABLED). A multi-user gateway
// needs it so IRC networks can attribute each user behind the shared IP; bind
// it before connections register their idents.
// In engine mode the engine answers :113 (the socket 4-tuples are its), so
// both ident modes are its to run; the same variables on this process are
// ignored rather than fought over — unless the engine refuses us later, in
// which case they start here then (see the 'refused' hook above).
function startIdentServices(): void {
  if (isIdentdEnabled()) startIdentd(identdPort(), identdBindHost());
  if (isOidentdFileEnabled()) {
    if (isIdentdEnabled()) {
      console.warn(
        '[lurker] both LURKER_IDENTD_ENABLED and LURKER_OIDENTD_FILE are set — Lurker will bind :113 AND maintain the oidentd file; running both is usually unintended, pick one',
      );
    }
    initOidentdFile();
  }
}
if (!engineConfigured()) startIdentServices();

// Parse any native push credentials now, so a misconfiguration is a failed boot
// with a name attached rather than a silent non-delivery. Unset is normal and
// passes: a self-hosted server holds no Apple/Google key and uses Web Push.
// Deliberately loud — at delivery time the same error is swallowed as a failed
// push and nobody ever sees it (#490).
assertPushCredentials();

// Wrap any plaintext secret columns at rest now that the DB schema is ready and
// before IRC connects — network secrets, +k channel keys, and the RPE2E keyring
// (identity privkey + session keys), all driven by the encryptedColumns
// declarations in db/exportSchema.ts. No-op unless LURKER_SECRET_KEY is
// configured (hosted cells); self-host instances keep secrets in plaintext.
const wrapped = backfillEncryptColumns();
if (wrapped.encrypted > 0) {
  console.log(`[lurker] encrypted ${wrapped.encrypted} secret column value(s) at rest`);
  systemLog.log({ scope: 'server', text: `Encrypted ${wrapped.encrypted} secret column value(s)` });
}

// Name any account whose username couldn't be created under today's rules — a
// space, or a case-twin of another account. They keep working (grandfathered),
// but the operator should learn about them here rather than from a user who
// can't tell which of two lookalike accounts is theirs. Silent on the
// overwhelmingly common instance where every name already conforms.
const legacyNames = listGrandfatheredUsernames();
if (legacyNames.length > 0) {
  console.warn(
    `[lurker] ${legacyNames.length} account name(s) predate the username rules and are ` +
      'grandfathered (they keep logging in with them): ' +
      legacyNames.map((u) => `#${u.id} "${u.username}" — ${u.why}`).join('; '),
  );
}

ircManager.initAll();

// Built-in IRC bouncer (opt-in via LURKER_BOUNCER_ENABLED): lets ordinary IRC
// clients attach to the always-on connections ircManager just established,
// ZNC-style. Started after initAll so an attaching client finds its network.
if (isBouncerEnabled()) {
  // Async because first-boot self-signed TLS generation is; not on the web
  // server's critical path, so start it in the background.
  startBouncer(bouncerPort(), bouncerBindHost()).catch((err) => {
    console.error(`[bouncer] failed to start: ${(err as Error).message}`);
  });
}

// Fail any export job a prior crash/restart left mid-flight, drop partial
// artifacts + expired ones, then sweep finished exports on an interval.
recoverInterruptedExports();
startExportSweeper();

// Prune expired -time ignore rules on an interval (#301).
startIgnoreSweeper();

// In node edition, start reporting to the orchestrator (register on boot +
// heartbeat on an interval). No-op in standalone or when unconfigured.
startOrchestratorClient();

// In node edition, periodically reconcile any upload moderation records that
// didn't reach the control plane at upload time. No-op in standalone.
startModerationReporter();

// Uploads stream through a temp file, and the request handler removes it on every
// exit — except a crash mid-upload, which is what this cleans up (#543).
void sweepTempUploads().catch((err: unknown) => {
  console.warn('[lurker] upload temp sweep failed:', (err as Error).message);
});

server.listen(PORT, HOST, () => {
  console.log(`[lurker] listening on http://${HOST || '0.0.0.0'}:${PORT}`);
  systemLog.log({ scope: 'server', text: `Listening on port ${PORT}` });
});

function shutdown(signal: string): void {
  console.log(`[lurker] received ${signal}, shutting down`);
  systemLog.log({ scope: 'server', level: 'warn', text: `Received ${signal}, shutting down` });
  stopOrchestratorClient();
  stopModerationReporter();
  stopIdentd();
  stopOidentdFile();
  stopBouncer();
  shutdownExportJobs();
  stopIgnoreSweeper();
  stopEventLoopMonitor();
  ircManager.shutdown();
  stopEngineLink();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
