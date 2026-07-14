// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * A random id the client mints to correlate one of its own requests with the
 * server's asynchronous answers about it — an ACK for a sent message, the progress
 * frames for an upload (#545).
 *
 * Not a security token: it never authorizes anything, and the server echoes it back
 * untouched. It only has to be unique among one user's own in-flight work.
 *
 * ⚠ The fallback is load-bearing, not defensive clutter: `crypto.randomUUID` is only
 * exposed in SECURE contexts, and Lurker's LAN dev mode (VITE_LAN_HOST) deliberately
 * serves plain HTTP so a phone can reach it without a trusted cert. Calling
 * randomUUID unguarded there is a TypeError, not a degraded id.
 */
export function makeClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
