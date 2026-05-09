import { socketSend, onSocketOpen } from './useSocket.js';

let wired = false;
let lastVisible = null;

function currentVisible() {
  if (typeof document === 'undefined') return false;
  return !document.hidden;
}

function report() {
  const visible = currentVisible();
  if (visible === lastVisible) return;
  lastVisible = visible;
  socketSend({ type: 'presence', visible });
}

export function startPresenceReporter() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', report);
  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  // The server forgets per-socket presence when a WS closes. Re-report on
  // every fresh socket open so reconnects don't leave the user appearing
  // hidden when they're actually looking at the page.
  onSocketOpen(() => {
    lastVisible = null;
    report();
  });
}

export function reportNow() {
  lastVisible = null;
  report();
}
