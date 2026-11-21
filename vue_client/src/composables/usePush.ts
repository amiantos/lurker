// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { api } from '../api.js';

type SWMessageListener = (data: unknown) => void;

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
const messageListeners = new Set<SWMessageListener>();

export function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  if (registrationPromise) return registrationPromise;
  registrationPromise = navigator.serviceWorker
    .register('/sw.js')
    .then(async () => {
      const reg = await navigator.serviceWorker.ready;
      navigator.serviceWorker.addEventListener('message', onSWMessage);
      // Tell the server we're alive so last_seen_at reflects actual
      // activity rather than the moment of last push delivery (which
      // only fires when no client is visible — the opposite of "active").
      heartbeat().catch(() => {
        /* ignore */
      });
      return reg;
    })
    .catch((err) => {
      console.warn('[push] service worker registration failed:', err);
      registrationPromise = null;
      return null;
    });
  return registrationPromise;
}

async function heartbeat(): Promise<void> {
  const endpoint = await getCurrentEndpoint();
  if (!endpoint) return;
  await api('/api/push/heartbeat', { method: 'POST', body: { endpoint } });
}

function onSWMessage(event: MessageEvent): void {
  const data = event.data;
  if (!data) return;
  for (const listener of messageListeners) {
    try {
      listener(data);
    } catch (_) {
      /* ignore */
    }
  }
}

export function onSWPushMessage(listener: SWMessageListener): () => void {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export async function ensurePermission(): Promise<string> {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

// What to show when pushManager.subscribe() rejects. An AbortError is the
// browser failing to register with its own push service (Google's for Chrome,
// Mozilla's for Firefox), which happens before this server is involved, so the
// browser's text ("Registration failed - push service error") sends people to
// their server config when the cause is on their machine or network. Brave
// ships with Google's push service turned off, so it gets its own hint.
export function subscribeErrorMessage(err: unknown, isBrave = false): string {
  const detail = err instanceof Error ? err.message : '';
  if (!(err instanceof Error) || err.name !== 'AbortError') return detail || 'failed to enable';
  const hint = isBrave
    ? 'Brave couldn\'t reach its push service. Turn on "Use Google services for push messaging" in brave://settings/privacy and restart Brave.'
    : "This browser couldn't reach its push service. A DNS filter, ad blocker or firewall may be blocking it.";
  return detail ? `${hint} (${detail})` : hint;
}

export async function enable(): Promise<PushSubscription> {
  if (!isSupported()) throw new Error('push not supported in this browser');
  const reg = await registerSW();
  if (!reg) throw new Error('service worker failed to register');
  const permission = await ensurePermission();
  if (permission !== 'granted') throw new Error(`notification permission ${permission}`);
  const { publicKey } = await api<{ publicKey: string }>('/api/push/config');
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
    });
  } catch (err) {
    throw new Error(subscribeErrorMessage(err, 'brave' in navigator), { cause: err });
  }
  const json = sub.toJSON();
  await api('/api/push/subscriptions', {
    method: 'POST',
    body: {
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
    },
  });
  return sub;
}

export async function disable(): Promise<void> {
  if (!isSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    await api('/api/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: sub.endpoint },
    });
  } catch (_) {
    /* ignore */
  }
  await sub.unsubscribe();
}

// Returns this client's current push endpoint, or null if not subscribed.
// Used by the Settings UI to identify which row in the subscriptions list
// represents "this device" vs other registered devices.
export async function getCurrentEndpoint(): Promise<string | null> {
  if (!isSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  try {
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint || null;
  } catch {
    return null;
  }
}
