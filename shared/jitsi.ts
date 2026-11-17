// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Where `/jitsi` starts a call (#527). A Jitsi Meet server, public or
// self-hosted, opens a room at `<base>/<room name>`, so a base URL is all that
// tells them apart.
//
// Three places can name one, most specific first: the user's own setting
// (`chat.jitsi_url`), the instance's (LURKER_JITSI_URL, advertised as
// `jitsiUrl` in GET /api/config), and the public server.

export const DEFAULT_JITSI_URL = 'https://meet.jit.si';

/**
 * A Jitsi base URL in the one form a room name is appended to: http(s), no
 * query or fragment, no trailing slash. Null for anything else, an empty
 * value included, so the caller falls through to the next source.
 */
export function normalizeJitsiBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The room URL `/jitsi` posts. */
export function jitsiRoomUrl(roomId: string, userBase: unknown, instanceBase: unknown): string {
  const base =
    normalizeJitsiBase(userBase) ?? normalizeJitsiBase(instanceBase) ?? DEFAULT_JITSI_URL;
  return `${base}/lurker-${roomId}`;
}
