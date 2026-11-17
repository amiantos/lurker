// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach, vi } from 'vitest';
import { instanceJitsiUrl } from './jitsi.js';

const before = process.env.LURKER_JITSI_URL;
afterEach(() => {
  if (before === undefined) delete process.env.LURKER_JITSI_URL;
  else process.env.LURKER_JITSI_URL = before;
  vi.restoreAllMocks();
});

describe('instanceJitsiUrl', () => {
  it('is null when unset', () => {
    delete process.env.LURKER_JITSI_URL;
    expect(instanceJitsiUrl()).toBeNull();
  });

  it('answers the server in the form a room name appends to', () => {
    process.env.LURKER_JITSI_URL = ' https://meet.example.org/ ';
    expect(instanceJitsiUrl()).toBe('https://meet.example.org');
  });

  it('is null for a value that is not a URL, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.LURKER_JITSI_URL = 'meet.example.org';
    expect(instanceJitsiUrl()).toBeNull();
    expect(instanceJitsiUrl()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('LURKER_JITSI_URL');
  });
});
