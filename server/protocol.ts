// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// WebSocket + REST protocol version and the compatibility contract every client
// — the web app and the native iOS/Android apps — relies on.
//
// Why this exists: the Vue client and the server ship from one repo in lockstep,
// so an unversioned protocol has cost nothing. A native binary in an App Store
// breaks that permanently — old clients hit new servers (the user hasn't
// updated), and new clients hit old servers (a self-hosted instance the operator
// hasn't upgraded). Both become normal operating conditions, so both sides need
// a version they can negotiate on. Adding this is cheap now and impossible to
// add cleanly once a binary is in someone's hands (see #569).
//
// The compatibility policy — a guarantee, not a nicety:
//   1. Additive-only. New verbs, new frame `kind`s, and new fields on existing
//      frames may be added freely. An existing field's meaning or type is NEVER
//      repurposed; to change a shape, add a new field/kind and deprecate the old.
//   2. Unknown is never fatal. Neither side may crash or mis-parse on something
//      it doesn't recognize, and both tolerate unknown fields. Concretely: the
//      client DROPS an unrecognized frame `kind` (already its behavior — this
//      makes it a promise, not an accident), and the server answers an
//      unrecognized verb with a non-fatal `error` frame rather than closing the
//      socket (see handleClientMessage's default case). Either way an old client
//      can talk to a newer server and vice-versa.
//   3. PROTOCOL_VERSION only bumps on a change rule (1) cannot express — i.e.
//      effectively never. MIN_PROTOCOL_VERSION is the oldest client this server
//      still serves; a client that announces an older version on the upgrade is
//      told to update (HTTP 426) instead of being handed a snapshot it would
//      mis-render.
//
// The server advertises PROTOCOL_VERSION in GET /api/config (so a client can
// check before opening the socket) and in the `snapshot` frame. A client
// announces the version it speaks with `?v=<n>` on the /ws upgrade.

export const PROTOCOL_VERSION = 1;

// Oldest client protocol version this server will accept on the WS upgrade.
// Equal to PROTOCOL_VERSION today (nothing to deprecate yet); raise it only when
// an old client genuinely can no longer be served correctly.
export const MIN_PROTOCOL_VERSION = 1;
