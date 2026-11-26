// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { is12Hour, theirTimeTitle, timeInZone, zonesBut } from './timeZone.js';

// Loose on separators and locale spelling, strict on the clock.
const clock = (s: string | null) => (s ?? '').replace(/ /g, ' ');

describe('timeInZone', () => {
  it("reads a moment on another zone's clock, with the weekday", () => {
    // 2026-11-26 is a Thursday; 23:30 UTC is already Friday in Tokyo.
    const when = '2026-11-26T23:30:00Z';
    expect(clock(timeInZone(when, 'Europe/Berlin'))).toMatch(/Fri.*00:30|Fri.*0:30/);
    expect(clock(timeInZone(when, 'America/Los_Angeles'))).toMatch(/Thu.*15:30/);
    expect(clock(timeInZone(when, 'Asia/Tokyo'))).toMatch(/Fri.*08:30|Fri.*8:30/);
  });

  it('follows daylight saving in the zone, not ours', () => {
    // Berlin: UTC+2 in July, UTC+1 in January.
    expect(clock(timeInZone('2026-07-01T12:00:00Z', 'Europe/Berlin'))).toMatch(/14:00/);
    expect(clock(timeInZone('2026-01-01T12:00:00Z', 'Europe/Berlin'))).toMatch(/13:00/);
  });

  it('can read as a 12-hour clock', () => {
    expect(clock(timeInZone('2026-07-01T12:00:00Z', 'Europe/Berlin', true))).toMatch(/2:00.PM/i);
  });

  it('is nothing for a zone or a time it cannot use', () => {
    expect(timeInZone('2026-07-01T12:00:00Z', 'Mars/Olympus_Mons')).toBeNull();
    expect(timeInZone('2026-07-01T12:00:00Z', '')).toBeNull();
    expect(timeInZone('2026-07-01T12:00:00Z', null)).toBeNull();
    expect(timeInZone('not a time', 'Europe/Berlin')).toBeNull();
    expect(timeInZone(undefined, 'Europe/Berlin')).toBeNull();
  });
});

describe('theirTimeTitle', () => {
  it('names whose clock and which zone', () => {
    expect(clock(theirTimeTitle('bob', '2026-07-01T12:00:00Z', 'Europe/Berlin') ?? '')).toMatch(
      /^bob's time: Wed.*14:00 \(Europe\/Berlin\)$/,
    );
    expect(theirTimeTitle('bob', '2026-07-01T12:00:00Z', undefined)).toBeUndefined();
  });
});

describe('is12Hour', () => {
  it('follows the timestamp format', () => {
    expect(is12Hour('HH:mm:ss')).toBe(false);
    expect(is12Hour('h:mm a')).toBe(true);
    expect(is12Hour('')).toBe(false);
  });
});

describe('zonesBut', () => {
  const zones = ['Africa/Kampala', 'Europe/Berlin', 'Etc/UTC', 'UTC'];
  it('drops the zone the field already holds, whatever its case', () => {
    expect(zonesBut(zones, ' africa/kampala ')).toEqual(['Europe/Berlin', 'Etc/UTC', 'UTC']);
    // Only an exact match: another zone that contains the text stays.
    expect(zonesBut(zones, 'UTC')).toEqual(['Africa/Kampala', 'Europe/Berlin', 'Etc/UTC']);
  });
  it('offers everything while the field is empty or mid-word', () => {
    expect(zonesBut(zones, '')).toEqual(zones);
    expect(zonesBut(zones, 'Africa/Kam')).toEqual(zones);
  });
});
