// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A non-negative integer knob from the environment. Unset or blank → the
// fallback; anything that is not a whole number >= 0 → the fallback too, so
// a misconfiguration ("0.5", "abc", "-1") does not turn into a truncated
// timer or a cap of 1.5 that admits 2. 0 is a legitimate value (several knobs
// read it as "off" or "no cap"), so a caller that needs a floor applies it
// itself.
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
