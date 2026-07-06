// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The single notion of "what is a channel prefix" for the client's join paths.
// IRC channels start with one of #, &, +, ! (RFC 2811); a bare, prefix-less
// name is what people usually type, so prepend the common `#`. Callers own
// their own input validation (whitespace, empty, lone-prefix) — this only
// settles the prefix. Shared by the Join Channel modal, the channel-list
// browser, and the `/join` command so all three normalize identically (#496).
export function ensureChannelPrefix(name: string): string {
  return /^[#&+!]/.test(name) ? name : `#${name}`;
}
