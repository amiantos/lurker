// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { DEFAULT_JITSI_URL, jitsiRoomUrl, normalizeJitsiBase } from './jitsi.js';

describe('normalizeJitsiBase', () => {
  it.each([
    ['https://meet.example.org', 'https://meet.example.org'],
    ['  https://meet.example.org/  ', 'https://meet.example.org'],
    ['https://example.org/jitsi//', 'https://example.org/jitsi'],
    ['http://jitsi.lan:8443', 'http://jitsi.lan:8443'],
    ['https://meet.example.org/?lang=en#config', 'https://meet.example.org'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeJitsiBase(raw)).toBe(want);
  });

  it.each([
    '',
    '   ',
    'meet.example.org',
    'javascript:alert(1)',
    'ftp://meet.example.org',
    'https://user:pw@meet.example.org',
    null,
    undefined,
    42,
  ])('refuses %j', (raw) => {
    expect(normalizeJitsiBase(raw)).toBeNull();
  });
});

describe('jitsiRoomUrl', () => {
  it('uses the public server when nothing is set', () => {
    expect(jitsiRoomUrl('abc', '', null)).toBe(`${DEFAULT_JITSI_URL}/lurker-abc`);
  });

  it("uses the instance's server when the user set none", () => {
    expect(jitsiRoomUrl('abc', '', 'https://meet.example.org/')).toBe(
      'https://meet.example.org/lurker-abc',
    );
  });

  it("puts the user's server ahead of the instance's", () => {
    expect(jitsiRoomUrl('abc', 'https://mine.example', 'https://meet.example.org')).toBe(
      'https://mine.example/lurker-abc',
    );
  });

  it('falls through a value that is not a URL', () => {
    expect(jitsiRoomUrl('abc', 'nope', 'https://meet.example.org')).toBe(
      'https://meet.example.org/lurker-abc',
    );
    expect(jitsiRoomUrl('abc', 'nope', 'also nope')).toBe(`${DEFAULT_JITSI_URL}/lurker-abc`);
  });
});
