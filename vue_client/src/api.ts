// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/** An Error thrown by `api()` / `apiMultipart()` on a non-2xx response. */
export interface ApiError extends Error {
  status?: number;
  data?: unknown;
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

// One-shot guard so an unrecoverable 401 can't loop the page reload.
const AUTH_RECOVERY_FLAG = 'lurker:authRecoveryAttempted';

// Public routes that render without a session (mirror router.ts). A background
// 401 while sitting on one of these is the expected "not signed in yet" state,
// NOT a stale session — bouncing would eject an invite/sign-in visitor to
// `/login?next=/` before their page can even mount.
function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/invite/');
}

// Pure decision (exported for tests): a 401 from a normal authed call means the
// session is dead — on a hosted cell the cell has already cleared the stale
// lurker_session + cp_session, so we send the user back to `/` to sign in again.
// Skip the auth / control-plane endpoints (they 401 by design before sign-in),
// skip 401s on a public page (App.vue fires settings/config fetches on every
// route, including /invite — those 401 by design when logged out), and only
// bounce once per tab so a genuinely-unrecoverable 401 falls through to the
// app's normal logged-out handling instead of reloading forever.
export function shouldBounceToLogin(
  url: string,
  status: number,
  alreadyTried: boolean,
  pathname: string,
): boolean {
  if (status !== 401 || alreadyTried) return false;
  if (url.startsWith('/api/auth/') || url.startsWith('/_cp/')) return false;
  if (isPublicPath(pathname)) return false;
  return true;
}

function bounceToLoginOnAuthFailure(url: string, status: number): void {
  let alreadyTried = false;
  try {
    alreadyTried = sessionStorage.getItem(AUTH_RECOVERY_FLAG) === '1';
  } catch {
    return; // no sessionStorage (private-mode edge) → don't risk a reload loop
  }
  if (!shouldBounceToLogin(url, status, alreadyTried, window.location.pathname)) return;
  try {
    sessionStorage.setItem(AUTH_RECOVERY_FLAG, '1');
  } catch {
    /* ignore — best effort */
  }
  window.location.assign('/');
}

function clearAuthRecoveryGuard(): void {
  // A request succeeded → the session works; clear the marker so a later session
  // loss can recover again.
  try {
    sessionStorage.removeItem(AUTH_RECOVERY_FLAG);
  } catch {
    /* ignore */
  }
}

// The API speaks untyped JSON, so the response type defaults to `any`. Callers
// that want a checked shape can pass it explicitly: `api<{ user: User }>(url)`.
export async function api<T = any>(
  url: string,
  { method = 'GET', body, headers }: ApiRequestOptions = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    bounceToLoginOnAuthFailure(url, res.status);
    const message = (data && data.error) || res.statusText || 'request failed';
    const err = new Error(message) as ApiError;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  clearAuthRecoveryGuard();
  return data as T;
}

export interface MultipartOptions {
  onProgress?: (percent: number) => void;
}

// XHR-backed multipart upload so callers get real upload-progress events.
// fetch() can't expose request-side progress in any browser today, hence the
// XHR fallback. Returns a Promise that resolves to the parsed JSON body.
export function apiMultipart<T = any>(
  url: string,
  formData: FormData,
  { onProgress }: MultipartOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.upload.addEventListener('progress', (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    });
    xhr.addEventListener('load', () => {
      const text = xhr.responseText || '';
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        clearAuthRecoveryGuard();
        resolve(data as T);
      } else {
        bounceToLoginOnAuthFailure(url, xhr.status);
        const message = (data && data.error) || xhr.statusText || 'upload failed';
        const err = new Error(message) as ApiError;
        err.status = xhr.status;
        err.data = data;
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('network error')));
    xhr.addEventListener('abort', () => reject(new Error('upload aborted')));
    xhr.send(formData);
  });
}
