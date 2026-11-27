// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The document title for a location (#1462). Every buffer has its own URL
// (#744), so it gets its own title too: the tab strip, the window switcher and
// the browser's history list then say which conversation an entry is.
//
// Framework-free: the caller (usePageTitle) resolves the route's buffer and
// network and hands them in.

export const APP_TITLE = 'Lurker';

export interface TitleBuffer {
  kind: string;
  target: string;
}

const SUFFIX = ` - ${APP_TITLE}`;

/** `#channel / network - Lurker` for a channel or DM, `network - Lurker` for a
 *  network's server buffer, `Settings - Lurker` and `Admin - Lurker` for those
 *  pages, and plain `Lurker` everywhere else — the buffer list, the system
 *  buffer (which is itself labelled "Lurker"), the signed-out pages, and a
 *  buffer route whose buffer the store doesn't hold (yet). */
export function pageTitle(
  routeName: unknown,
  buffer: TitleBuffer | null,
  networkName: string | null,
): string {
  if (routeName === 'settings') return `Settings${SUFFIX}`;
  if (routeName === 'admin') return `Admin${SUFFIX}`;
  if (!buffer || buffer.kind === 'system') return APP_TITLE;
  if (buffer.kind === 'server') return networkName ? `${networkName}${SUFFIX}` : APP_TITLE;
  return networkName ? `${buffer.target} / ${networkName}${SUFFIX}` : `${buffer.target}${SUFFIX}`;
}
