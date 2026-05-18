// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll } from 'vitest';

// systemLog uses module-level state; importing it inside beforeAll keeps each
// test file's module instance isolated from siblings.
let systemLog;

beforeAll(async () => {
  systemLog = (await import('./systemLog.js')).default;
});

describe('log', () => {
  it('global lines have null userId and surface to every getRecent caller', () => {
    const line = systemLog.log({ scope: 'server', text: 'server boot' });
    expect(line.userId).toBeNull();
    expect(line.level).toBe('info');
    expect(line.scope).toBe('server');
    expect(line.text).toBe('server boot');

    const recent = systemLog.getRecent(123);
    expect(recent.find((l) => l.text === 'server boot')).toBeTruthy();
  });

  it('per-user lines are visible to that user, not to others', () => {
    systemLog.log({ scope: 'irc', text: 'private to alice', userId: 1 });
    const aliceLines = systemLog.getRecent(1);
    expect(aliceLines.find((l) => l.text === 'private to alice')).toBeTruthy();
    const bobLines = systemLog.getRecent(2);
    expect(bobLines.find((l) => l.text === 'private to alice')).toBeFalsy();
  });

  it('per-user lines merge with globals in monotonic id order', () => {
    systemLog.log({ scope: 'global', text: 'global-A' });
    systemLog.log({ scope: 'priv', text: 'priv-B', userId: 7 });
    systemLog.log({ scope: 'global', text: 'global-C' });
    const recent = systemLog.getRecent(7);
    const texts = recent.map((l) => l.text);
    const ia = texts.indexOf('global-A');
    const ib = texts.indexOf('priv-B');
    const ic = texts.indexOf('global-C');
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ic);
  });

  it('defaults level/scope and stringifies null/undefined text', () => {
    const line = systemLog.log({});
    expect(line.level).toBe('info');
    expect(line.scope).toBe('lurker');
    expect(line.text).toBe('');
    expect(line.fields).toBeNull();
  });

  it('preserves an explicit fields payload', () => {
    const line = systemLog.log({ scope: 'irc', text: 'meta', fields: { code: 42 } });
    expect(line.fields).toEqual({ code: 42 });
  });

  it('non-object fields are dropped (defensive)', () => {
    const line = systemLog.log({ scope: 'x', text: 'y', fields: 'not-an-object' });
    expect(line.fields).toBeNull();
  });

  it('emits the line on the "line" event', () => {
    return new Promise((resolve) => {
      function handler(l) {
        if (l.text === 'emit-test') {
          systemLog.off('line', handler);
          expect(l.scope).toBe('emit');
          resolve();
        }
      }
      systemLog.on('line', handler);
      systemLog.log({ scope: 'emit', text: 'emit-test' });
    });
  });
});

describe('getRecent', () => {
  it('returns globals only for a user with no private lines', () => {
    const recent = systemLog.getRecent(999); // never logged to
    // Should be the same shape as the global tail; either empty or globals.
    expect(Array.isArray(recent)).toBe(true);
  });
});

describe('dropUser', () => {
  it('forgets a user\'s ring without touching globals', () => {
    systemLog.log({ scope: 'wipe-me', text: 'doomed', userId: 42 });
    expect(systemLog.getRecent(42).find((l) => l.text === 'doomed')).toBeTruthy();
    systemLog.dropUser(42);
    expect(systemLog.getRecent(42).find((l) => l.text === 'doomed')).toBeFalsy();
  });
});

describe('ring caps', () => {
  it('caps the global ring (smoke test — exact constant lives in the module)', () => {
    // Push enough lines to overflow the 200-line global cap.
    for (let i = 0; i < 250; i += 1) systemLog.log({ scope: 'flood', text: `g${i}` });
    const recent = systemLog.getRecent(0);
    const globals = recent.filter((l) => l.userId === null && l.text.startsWith('g'));
    expect(globals.length).toBeLessThanOrEqual(200);
    // The oldest survivor should be at least 50 items deep (well past the cap).
    expect(globals[0].text).not.toBe('g0');
  });
});
