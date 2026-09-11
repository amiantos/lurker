// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The IRC engine: a second entrypoint in the same image (`tsx server/engine.ts`)
// that holds the IRC sockets so the app process (`server/server.ts`) can be
// redeployed without dropping them. It has no database, no credentials, and no
// idea who its connections belong to — see server/engine/protocol.ts for the
// contract and docs/SELF_HOSTING.md for how to run it.

// First import on purpose, as in server.ts: the fatal-exception guard has to be
// in place before anything else evaluates.
import { installFatalExceptionExit } from './utils/processGuards.js';
import 'dotenv/config';
import { loadEngineConfig } from './engine/config.js';
import { EngineServer } from './engine/server.js';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from './engine/protocol.js';
import { ENGINE_VERSION } from './engine/version.js';
import { APP_VERSION } from './utils/userAgent.js';
import {
  startIdentd,
  stopIdentd,
  identdPort,
  identdBindHost,
  isIdentdEnabled,
  isOidentdFileEnabled,
  initOidentdFile,
  stopOidentdFile,
} from './services/identd.js';

// There is no durable log here — the guard's own console.error is the record.
installFatalExceptionExit(() => {});

let config;
try {
  config = loadEngineConfig();
} catch (err) {
  console.error(`[engine] ${(err as Error).message}`);
  process.exit(1);
}

// identd is keyed on the socket 4-tuple, so whichever process holds the sockets
// must answer :113 — in this topology, this one. Same two modes as the app.
if (isIdentdEnabled()) startIdentd(identdPort(), identdBindHost());
if (isOidentdFileEnabled()) {
  if (isIdentdEnabled()) {
    console.warn(
      '[engine] both LURKER_IDENTD_ENABLED and LURKER_OIDENTD_FILE are set — running both is usually unintended, pick one',
    );
  }
  initOidentdFile();
}

const engine = new EngineServer({
  secret: config.secret,
  bufferBytes: config.bufferBytes,
  bufferTotalBytes: config.bufferTotalBytes,
  orphanMs: config.orphanMs,
  version: ENGINE_VERSION,
});

// Say which ident mode this process resolved, because the variables that
// choose it are easy to leave on the wrong container: an operator whose identd
// silently ended up nowhere finds out here, not from ~ident on the network.
const identMode = isIdentdEnabled()
  ? `built-in identd on :${identdPort()}`
  : isOidentdFileEnabled()
    ? 'oidentd file mode'
    : 'none (LURKER_IDENTD_ENABLED / LURKER_OIDENTD_FILE unset here — the network sees ~ident)';
console.log(`[engine] ident: ${identMode}`);

void (async () => {
  try {
    const { host, port } = await engine.listen(config.listenPort, config.listenHost);
    console.log(
      `[engine] listening on ${host}:${port} — engine ${ENGINE_VERSION}, protocol ${PROTOCOL_MAJOR}.${PROTOCOL_MINOR}, lurker ${APP_VERSION}; per-connection buffer ${config.bufferBytes} bytes, total ${config.bufferTotalBytes}`,
    );
  } catch (err) {
    console.error(
      `[engine] failed to listen on ${config.listenHost}:${config.listenPort}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
})();

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  const held = engine.connectionCount();
  console.log(
    `[engine] received ${signal}, shutting down — ${held} IRC connection(s) will drop; the app reconnects them`,
  );
  void engine.shutdown('Lurker engine restarting').then(() => {
    stopIdentd();
    stopOidentdFile();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
