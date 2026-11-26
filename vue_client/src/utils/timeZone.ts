// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A moment as somebody else's clock shows it (#1450): the user's time zone
// from their metadata (`lurker.chat/tz`), or one set on them (#1449).

// A formatter per zone and clock style: building one is the costly part, and a
// buffer asks for the same few zones on every row.
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string, hour12: boolean): Intl.DateTimeFormat | null {
  const key = `${hour12 ? 12 : 24}|${zone}`;
  let fmt = formatters.get(key);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        // Not `hour12: false`, which some engines print midnight as 24:00 for.
        hourCycle: hour12 ? 'h12' : 'h23',
      });
    } catch {
      // A zone the server's runtime knows and this browser doesn't.
      fmt = null;
    }
    formatters.set(key, fmt);
  }
  return fmt;
}

/** Whether a timestamp format (utils/timestamp.ts) reads as a 12-hour clock. */
export function is12Hour(format: string | null | undefined): boolean {
  return /h/.test(format ?? '');
}

/**
 * The weekday and time of `when` in `zone` ("Thu 18:34"), or null when either
 * is unusable. The weekday is always there: across zones it is often not ours.
 */
export function timeInZone(
  when: string | number | Date | null | undefined,
  zone: string | null | undefined,
  hour12 = false,
): string | null {
  if (!zone || when == null || when === '') return null;
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return null;
  return formatterFor(zone, hour12)?.format(date) ?? null;
}

/** A line's time on its author's clock, for the timestamp's tooltip. */
export function theirTimeTitle(
  name: string,
  when: string | number | Date | null | undefined,
  zone: string | null | undefined,
  hour12 = false,
): string | undefined {
  const time = timeInZone(when, zone, hour12);
  return time ? `${name}'s time: ${time} (${zone})` : undefined;
}

/** Every zone this browser knows, for a picker; empty on one too old to say. */
export function knownTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** This device's own zone, or null when the browser won't say. */
export function deviceTimeZone(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
