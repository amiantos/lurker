import { api } from '../api.js';

let registrationPromise = null;
let currentSubscription = null;
const messageListeners = new Set();

export function isSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerSW() {
  if (!isSupported()) return null;
  if (registrationPromise) return registrationPromise;
  registrationPromise = navigator.serviceWorker.register('/sw.js')
    .then(async () => {
      const reg = await navigator.serviceWorker.ready;
      navigator.serviceWorker.addEventListener('message', onSWMessage);
      return reg;
    })
    .catch((err) => {
      console.warn('[push] service worker registration failed:', err);
      registrationPromise = null;
      return null;
    });
  return registrationPromise;
}

function onSWMessage(event) {
  const data = event.data;
  if (!data) return;
  for (const listener of messageListeners) {
    try { listener(data); } catch (_) { /* ignore */ }
  }
}

export function onSWPushMessage(listener) {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export async function ensurePermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.requestPermission();
}

export async function enable() {
  if (!isSupported()) throw new Error('push not supported in this browser');
  const reg = await registerSW();
  if (!reg) throw new Error('service worker failed to register');
  const permission = await ensurePermission();
  if (permission !== 'granted') throw new Error(`notification permission ${permission}`);
  const { publicKey } = await api('/api/push/config');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = sub.toJSON();
  await api('/api/push/subscriptions', {
    method: 'POST',
    body: {
      endpoint: json.endpoint,
      keys: json.keys,
      userAgent: navigator.userAgent,
    },
  });
  currentSubscription = sub;
  return sub;
}

export async function disable() {
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
  } catch (_) { /* ignore */ }
  await sub.unsubscribe();
  currentSubscription = null;
}

export async function syncWithSetting(enabled) {
  if (!isSupported()) return;
  if (enabled) {
    try {
      await enable();
    } catch (e) {
      console.warn('[push] enable failed:', e?.message || e);
    }
  } else {
    await disable();
  }
}
