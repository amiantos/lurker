// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useNetworksStore } from '../stores/networks.js';
import { useSettingsStore } from '../stores/settings.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useToastsStore } from '../stores/toasts.js';
import { useOnboarding } from './useOnboarding.js';
import { startPresenceReporter, reportNow } from './usePresence.js';
import { attentionSettingChanged, onAttentionChange } from './useAttention.js';
import { registerSW, onSWPushMessage } from './usePush.js';
import { onJumpIntent } from './useJumpIntent.js';
import { connected } from './useSocket.js';
import { startAppBadge } from './useAppBadge.js';
import { startBufferHydration } from './useBufferHydration.js';
import { whenReady } from './deferredReady.js';
import type { Router } from 'vue-router';
import { useRouter } from 'vue-router';
import type { JumpTarget } from './useJumpToMessage.js';

// Module singleton, like the presence reporter: wired once across the
// Desktop<->Mobile shell swap.
let attentionWired = false;

// The bus/notification payload is a jump target plus a `kind` discriminator
// shared with the service-worker message channel; it IS what jump() consumes.
export interface JumpPayload extends JumpTarget {
  kind: string;
}

export interface ChatBootstrapOptions {
  onJump?: (data: JumpPayload) => void;
}

/** Drop the consumed deep-link params, leaving path and hash alone.
 *
 *  Goes through the ROUTER, not raw replaceState. A raw call updates the
 *  address bar while vue-router's own recorded location keeps the consumed
 *  `?msg` — and that stale location is what gets written into history.state.back
 *  on the next push, which Settings captures as its return target. Clicking
 *  "← back" from Settings then navigated to the un-stripped URL and re-fired the
 *  jump, defeating the "strip it so a refresh doesn't re-jump" guarantee.
 *
 *  The hash is carried through explicitly: to router.replace an absent `hash`
 *  on a location object means "no hash", not "keep the current one", so the
 *  raw-replaceState code this replaced preserved the fragment and the plain
 *  form silently dropped it. */
function stripQuery(router: Router, params: URLSearchParams): void {
  void router.replace({
    query: Object.fromEntries(params.entries()),
    hash: window.location.hash,
  });
}

/** The buffer id a `/buffer/<id>` path names, or null for any other route.
 *  Deliberately strict: a non-integer segment is "not a buffer route", never
 *  NaN, which downstream `== null` checks would wave through. */
function bufferIdFromPath(pathname: string): number | null {
  const m = /^\/buffer\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  // NOT decodeURIComponent: a buffer id is an integer, so there is nothing to
  // decode — and a mangled link like `/buffer/%` reaches the client verbatim
  // (the SPA fallback serves it, and vue-router swallows its own decode error),
  // where decoding threw URIError inside this synchronous setup path and left
  // the whole chat shell unrendered. Number() on anything unexpected is NaN,
  // which is already the "not a buffer route" answer.
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

// `/buffer/<id>?msg=<id>` — useBufferRoute owns activating the buffer, so the
// only thing left here is the message to scroll to. Resolving the id needs the
// same wait as the legacy form (buffers arrive over the WS after the route
// does), but NOT the same failure toast: useBufferRoute is watching the same id
// and already reports it, so this one gives up quietly rather than double-
// toasting the one event.
function consumeRouteJump(
  bufferId: number,
  params: URLSearchParams,
  buffers: ReturnType<typeof useBuffersStore>,
  router: Router,
  onJump: (data: JumpPayload) => void,
): () => void {
  const noop = (): void => {};
  const msg = params.get('msg');
  // A plain /buffer/<id> carries no intent — and therefore gets NO strip: the
  // unconditional version issued a do-nothing same-location replace through
  // the router pipeline on every bookmark, refresh and shell swap.
  if (msg == null || msg === '') return noop;
  // Strip ?msg immediately so a manual refresh doesn't re-jump — a malformed
  // one included, consumed to nothing rather than left to re-parse. The PATH
  // stays: it's the buffer the user is now looking at, not a consumed intent.
  params.delete('msg');
  stripQuery(router, params);
  const messageId = Number(msg);
  if (!Number.isFinite(messageId)) return noop;

  // byId (not the module-level bufferKeyForId index) so the wait below is
  // reactive — see the note on the store getter. The record already carries
  // networkId/target, so there is no key to take apart.
  const resolve = (): JumpPayload | null => {
    const buf = buffers.byId(bufferId);
    // networkId null == an app-scoped buffer (the system console), which has no
    // per-message jump.
    if (!buf || buf.networkId == null) return null;
    return { kind: 'jump', networkId: buf.networkId, target: buf.target, messageId };
  };
  return whenReady(
    () => connected.value && resolve() != null,
    () => {
      // The wait can outlive the user's patience. If they navigated anywhere
      // else in-shell during it — back to the list, another buffer, /system —
      // the disposer never ran (all chat routes share one shell), and firing
      // now would yank them to the link's buffer and detach it for an intent
      // they've moved past. The route is the truth about where they are;
      // useBufferRoute's parallel wait re-checks its own the same way.
      const current = router.currentRoute.value;
      if (current.name !== 'buffer' || current.params.id !== String(bufferId)) return;
      const payload = resolve();
      if (payload) onJump(payload);
    },
  );
}

// The service worker can only hand a launched-from-closed PWA its jump target
// through the URL (a postMessage would race the not-yet-registered listener and
// be dropped). Two forms exist:
//
//   /buffer/<id>?msg=<id>      current (#744) — a real route. useBufferRoute
//                              activates the buffer; all this has to recover is
//                              the message to scroll to.
//   /?net&buf&msg              legacy. A service worker updates on its own
//                              schedule, so an installed client keeps minting
//                              this form until its worker rolls over — this
//                              branch has to stay for at least a release, and
//                              is removable once that's had time to propagate.
//
// Either way: recover the intent, strip it so a refresh doesn't re-jump, and
// fire it through the same onJump the warm push path uses once the app can
// actually honor it. Returns a disposer for the deferred-readiness watch/timer.
export function consumeColdStartJump(
  buffers: ReturnType<typeof useBuffersStore>,
  router: Router,
  onJump: (data: JumpPayload) => void,
): () => void {
  const noop = (): void => {};
  // new URLSearchParams(string) never throws, so no guard is needed.
  const params = new URLSearchParams(window.location.search);
  const routeBufferId = bufferIdFromPath(window.location.pathname);
  const net = params.get('net');
  const buf = params.get('buf');
  if (routeBufferId != null)
    return consumeRouteJump(routeBufferId, params, buffers, router, onJump);
  if (!net || !buf) return noop;
  const networkId = Number(net);
  if (!Number.isFinite(networkId)) return noop;

  const msg = params.get('msg');
  // Strip the deep-link params immediately so a manual refresh doesn't re-jump.
  params.delete('net');
  params.delete('buf');
  params.delete('msg');
  stripQuery(router, params);

  // Validate msg the same way as networkId: a malformed ?msg=foo must become a
  // null "open the conversation" intent, not NaN — NaN slips past the
  // `messageId == null` check downstream and anchors loadAround on NaN.
  const parsed = msg != null && msg !== '' ? Number(msg) : null;
  const messageId = parsed != null && Number.isFinite(parsed) ? parsed : null;

  const payload: JumpPayload = { kind: 'jump', networkId, target: buf, messageId };
  return whenReady(
    () => connected.value && buffers.isOpen(networkId, buf),
    () => onJump(payload),
    () => {
      // The buffer never re-opened (e.g. a channel/DM closed before the app was
      // killed). The URL is already stripped, so without this the intent would
      // vanish silently. Surface it instead of leaving the user on the default
      // screen wondering why the notification did nothing.
      useToastsStore().push({
        kind: 'info',
        title: messageId != null ? 'Couldn’t open that message' : 'Couldn’t open that conversation',
        body: '',
        ttlMs: 5000,
      });
    },
  );
}

// Shared post-login bootstrap for the chat shells (Desktop + Mobile).
// onJump receives { networkId, target, messageId } from any of the three jump
// entry points — a clicked push notification (warm via postMessage, cold via the
// launch URL) or an in-app toast click (#444). Each shell wires up its own handler
// since the mobile shell also needs to advance its screen state.
export function useChatBootstrap({ onJump }: ChatBootstrapOptions = {}): void {
  const networks = useNetworksStore();
  const settings = useSettingsStore();
  const buffers = useBuffersStore();
  const router = useRouter();
  const onboarding = useOnboarding();
  const disposers: Array<() => void> = [];

  // Wire all three jump entry points synchronously in setup so onBeforeUnmount
  // can always dispose them. Registering after the onMounted await would race a
  // fast shell unmount (Desktop<->Mobile viewport swap): cleanup would run with
  // an empty disposer list, then the awaited continuation would add listeners
  // that never get torn down — leaking them and double-firing every later jump.
  if (onJump) {
    disposers.push(
      onSWPushMessage((data) => {
        const d = data as any;
        if (d?.kind === 'jump') onJump(d as JumpPayload);
      }),
    );
    disposers.push(onJumpIntent(onJump));
    disposers.push(consumeColdStartJump(buffers, router, onJump));
  }

  onMounted(async () => {
    // Both of these have to have *answered* before the first-run flow can tell a
    // new account apart from a slow one — see useOnboarding.evaluate(). Settling
    // rather than awaiting in sequence keeps a settings hiccup from holding up
    // the networks fetch the rest of bootstrap depends on; evaluate() reads the
    // stores' `loaded` flags and simply does nothing if either never landed.
    const settingsReady = settings.loaded ? Promise.resolve() : settings.fetchAll().catch(() => {});
    // Swallowed deliberately: an unguarded reject here would abort the whole
    // onMounted, taking the presence reporter, the app badge and the service-worker
    // registration down with it — a transient /api/networks blip must not cost the
    // session all of that. The stores' `loaded` flags carry the failure instead, so
    // evaluate() below simply declines to open (fail closed) rather than mistaking
    // an errored fetch for "this user has no networks".
    await networks.fetchAll().catch(() => {});
    void settingsReady.then(() => onboarding.evaluate());
    startPresenceReporter();
    reportNow();
    // Leaving this client ends the visit to the active buffer; coming back
    // catches its read state up.
    if (!attentionWired) {
      attentionWired = true;
      onAttentionChange((attended) => {
        if (attended) buffers.resumeReading();
        else buffers.pauseReading();
      });
      watch(() => settings.effective('client.idle.delay_seconds'), attentionSettingChanged);
    }
    // Keep the active buffer's message list hydrated across reconnects and
    // send failures (idempotent module singleton, like the presence reporter —
    // survives the Desktop<->Mobile shell swap without double-registering).
    startBufferHydration();
    // Mirror the unread-highlight total onto the PWA app icon (#451). Idempotent
    // and feature-detected — a no-op where the Badging API is unavailable.
    startAppBadge();
    // Register unconditionally so a previously-subscribed device can still
    // receive push events without re-opening Settings. Per-client subscribe
    // is gated by an explicit Settings button (see usePush.enable()).
    registerSW().catch(() => {
      /* ignore */
    });
  });

  // The viewport-driven shell swap (Desktop <-> Mobile) remounts this composable;
  // without cleanup the old listeners would linger and double-fire every jump.
  onBeforeUnmount(() => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  });
}
