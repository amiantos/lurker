// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Wire-level RPE2E tracing for interop QA. Set LURKER_E2E_DEBUG=1 to log every
// inbound CTCP, decrypt outcome, and outbound handshake reply to the console.
// Shared by the IRC layer (ircConnection + ircManager) so the convention lives
// in one place. The env var is read per call so it can be toggled at runtime.

/**
 * Emit an `[e2e]` trace line when LURKER_E2E_DEBUG=1, otherwise a no-op.
 *
 * Pass a `() => string` thunk for any message whose interpolation is non-trivial
 * (a 140-char body slice, a hostmask) so the string is built ONLY when tracing
 * is on — these calls sit on hot paths (every CTCP/message) where eager
 * formatting would otherwise run unconditionally.
 */
export function e2eDbg(msg: string | (() => string)): void {
  if (process.env.LURKER_E2E_DEBUG !== '1') return;
  console.log(`[e2e] ${typeof msg === 'function' ? msg() : msg}`);
}
