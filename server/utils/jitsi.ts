// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { normalizeJitsiBase } from '../../shared/jitsi.js';

let warned = false;

/**
 * The operator's Jitsi Meet server for /jitsi (LURKER_JITSI_URL, #527), or null
 * when none is named. Sent to signed-in clients in the `snapshot` frame, not in
 * the public GET /api/config: it may be a server nobody outside should learn of.
 */
export function instanceJitsiUrl(): string | null {
  const raw = process.env.LURKER_JITSI_URL?.trim();
  if (!raw) return null;
  const base = normalizeJitsiBase(raw);
  if (!base && !warned) {
    warned = true;
    console.warn(
      `[lurker] LURKER_JITSI_URL is not a usable Jitsi address (${raw}); expected ` +
        'https://host[/path] with no query or fragment. /jitsi will use meet.jit.si.',
    );
  }
  return base;
}
