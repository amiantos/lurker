// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Engine-side configuration. All LURKER_ENGINE_* — the app side reads its own two
// (LURKER_ENGINE_URL / LURKER_ENGINE_SECRET) in services/engineTransport.ts.

import { parseHostPort } from './protocol.js';

export interface EngineConfig {
  listenHost: string;
  listenPort: number;
  secret: string;
  // Per-connection backlog ceiling, and the ceiling across every connection.
  bufferBytes: number;
  bufferTotalBytes: number;
  // A session no app has claimed for this long is ended: the backstop for an
  // app that never comes back, or one this engine refused (a protocol-major
  // mismatch), whose sessions would otherwise sit on the network as ghosts.
  orphanMs: number;
  // A session no app has claimed for this long is marked AWAY on the network,
  // so someone messaging it gets an answer instead of silence. 0 disables.
  awayAfterMs: number;
}

const MiB = 1024 * 1024;

function envBytes(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  // Digits only — a suffixed value would parse to its leading digits and
  // silently mean something other than what was typed.
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of bytes (got "${raw}")`);
  const n = Number(raw);
  if (n < 64 * 1024) {
    throw new Error(`${name} must be at least 65536 bytes to hold a single IRC burst (got ${raw})`);
  }
  return n;
}

function envMs(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a whole number of milliseconds (got "${raw}")`);
  return Number(raw);
}

export function loadEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const secret = (env.LURKER_ENGINE_SECRET || '').trim();
  if (!secret) {
    throw new Error(
      'LURKER_ENGINE_SECRET is required — the app authenticates to the engine with it; set the same value on both',
    );
  }
  // Loopback by DEFAULT. The engine's secret is the only thing between a
  // reachable engine and every connection it holds, so the safe default is the
  // one that cannot be reached from another host at all — the ordinary
  // self-host runs the engine beside the app.
  //
  // ⚠ Containers do not share a network namespace, so an engine in its own
  // container must be told to bind wider or its sibling app cannot reach it:
  // docker-compose.engine.yml sets LURKER_ENGINE_LISTEN for exactly that, and
  // publishes no port. Widening this default to save that one line would
  // silently expose every bare-metal engine instead.
  const listen = parseHostPort(env.LURKER_ENGINE_LISTEN || '', { host: '127.0.0.1', port: 8016 });
  const bufferBytes = envBytes('LURKER_ENGINE_BUFFER_BYTES', 4 * MiB);
  const bufferTotalBytes = envBytes('LURKER_ENGINE_BUFFER_TOTAL_BYTES', 256 * MiB);
  return {
    listenHost: listen.host,
    listenPort: listen.port,
    secret,
    bufferBytes,
    bufferTotalBytes: Math.max(bufferTotalBytes, bufferBytes),
    orphanMs: envMs('LURKER_ENGINE_ORPHAN_MS', 60 * 60 * 1000),
    // Long enough that an ordinary deploy (seconds) never trips it, short
    // enough that someone messaging into a dead app finds out in the same
    // conversation. The sweep runs every 30 s, so that is the granularity.
    awayAfterMs: envMs('LURKER_ENGINE_AWAY_AFTER_MS', 5 * 60 * 1000),
  };
}
