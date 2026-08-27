// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A non-negative numeric knob from the environment. Unset or blank → the
// fallback; anything that is not a finite number >= 0 → the fallback. 0 is a
// legitimate value (several knobs read it as "off" or "no cap"), so a caller
// that needs a floor applies it itself.
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
