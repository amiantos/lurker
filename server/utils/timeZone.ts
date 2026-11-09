// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Wall-clock helpers for a user's IANA time zone (the `system.timezone`
// setting): the auto-away message's timestamp and push's quiet hours.

export function isValidTimeZone(tz: unknown): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Called without `new` purely for validation — it throws RangeError on an
    // unknown time zone, which the catch below turns into a false return.
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts (year/month/day/hour/minute/second) of `date` in the given
// IANA timezone, or in the server's local zone when `timeZone` is falsy/invalid.
export function wallClockParts(date: Date, timeZone: string | null): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  // Some locales render midnight as "24" instead of "00"; normalize so the
  // offset math below doesn't blow up on Date.UTC.
  if (out.hour === '24') out.hour = '00';
  return out;
}

export function tzOffsetMinutes(date: Date, timeZone: string | null): number {
  if (!timeZone) return -date.getTimezoneOffset();
  const p = wallClockParts(date, timeZone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// "2026-05-09 15:30:00-0500" — a moment as text for a line the server writes
// (an auto-away message, who set a topic), where no client is there to put it
// in the reader's own format. In `timeZone` (the user's system.timezone) when
// that is a zone, otherwise the server's.
export function wallClockStamp(date: Date, timeZone: unknown): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : null;
  const p = wallClockParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? '+' : '-';
  const aoff = Math.abs(off);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${sign}${pad2(Math.floor(aoff / 60))}${pad2(aoff % 60)}`;
}
