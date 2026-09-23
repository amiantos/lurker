// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A server's unix-seconds timestamp (333, 329, a list entry's set-time) as ISO,
// or null when it isn't one. ⚠ The range check is load-bearing:
// `new Date(ms).toISOString()` THROWS past ±8.64e15 ms, and an IRC handler that
// throws takes the process down, so one bogus `333 me #c x 99999999999999`
// would end every user's session.
export function unixSecondsToIso(value: unknown): string | null {
  const secs = typeof value === 'string' ? Number(value) : value;
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return null;
  const date = new Date(secs * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
