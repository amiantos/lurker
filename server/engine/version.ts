// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine's own version: the Lurker release that last changed it. Set by
// hand rather than read from package.json, because the engine is the process
// that does NOT move with the app — a later image or checkout carries the same
// engine, and it should keep saying which one (Settings → About shows it beside
// the app's version).
//
// ⚠ A release that changes the engine sets this to that release's version.
// "Changes the engine" is whatever docker-publish.yml diffs to decide that
// `engine-<major>` moves, and that workflow refuses to publish a moved tag
// whose ENGINE_VERSION doesn't match the release — a forgotten bump fails the
// release build rather than shipping an engine that names the wrong version.
export const ENGINE_VERSION = '2.3.0';
