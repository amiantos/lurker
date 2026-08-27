// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// WebSocket close codes Lurker defines for itself. 4000–4999 is the range the
// RFC reserves for applications, so these can never collide with a protocol or
// browser-generated code.
//
// Shared because a close code is only useful if both ends agree on it: the
// server states WHY it closed, and the client decides what to do about it. An
// ordinary drop and a deliberate eviction look identical otherwise, which is
// how an evicted tab ends up reconnecting forever against a /ws that will
// answer 401 for the rest of its life.

/**
 * The account's sessions were revoked while this socket was open — account
 * recovery (#855). The session row behind this socket is gone, so reconnecting
 * can only 401: the client must stop trying and send the user to sign in.
 */
export const WS_CLOSE_SESSION_REVOKED = 4001;
