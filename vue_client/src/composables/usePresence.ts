// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { socketSend, onSocketOpen } from './useSocket.js';
import { isAttended, onAttentionChange, startAttention } from './useAttention.js';

let wired = false;
let lastVisible: boolean | null = null;

// "Visible" on the wire means someone is at this client: the page is showing
// and has had recent input (useAttention). A tab left in front on a machine
// nobody is at stops claiming it, so push and auto-away stop waiting on it.
function currentVisible() {
  if (typeof document === 'undefined') return false;
  return isAttended();
}

function report() {
  const visible = currentVisible();
  if (visible === lastVisible) return;
  lastVisible = visible;
  socketSend({ type: 'presence', visible });
}

export function startPresenceReporter(): void {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  startAttention();
  onAttentionChange(report);
  // The server forgets per-socket presence when a WS closes. Re-report on
  // every fresh socket open so reconnects don't leave the user appearing
  // hidden when they're actually looking at the page.
  onSocketOpen(() => {
    lastVisible = null;
    report();
  });
}

export function reportNow(): void {
  lastVisible = null;
  report();
}

// Forget the cached "last reported visible" value so the first report after a
// session reset always sends a fresh state. The DOM listeners stay wired —
// they're idempotent and have nothing to do with which user is signed in.
export function resetPresence(): void {
  lastVisible = null;
}
