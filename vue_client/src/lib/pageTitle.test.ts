// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { pageTitle } from './pageTitle.js';

describe('pageTitle', () => {
  it('names a channel and its network', () => {
    expect(pageTitle('buffer', { kind: 'channel', target: '#lurker' }, 'Libera')).toBe(
      '#lurker / Libera - Lurker',
    );
  });

  it('keeps whichever sigil the channel has', () => {
    expect(pageTitle('buffer', { kind: 'channel', target: '&local' }, 'Libera')).toBe(
      '&local / Libera - Lurker',
    );
  });

  it('names a DM by its peer', () => {
    expect(pageTitle('buffer', { kind: 'dm', target: 'amiantos' }, 'Libera')).toBe(
      'amiantos / Libera - Lurker',
    );
  });

  it('gives the members and thread routes their buffer title', () => {
    const buf = { kind: 'channel', target: '#lurker' };
    for (const name of ['buffer-members', 'buffer-thread', 'buffer-threads']) {
      expect(pageTitle(name, buf, 'Libera')).toBe('#lurker / Libera - Lurker');
    }
  });

  it('names a server buffer by its network alone', () => {
    expect(pageTitle('buffer', { kind: 'server', target: ':server:3' }, 'Libera')).toBe(
      'Libera - Lurker',
    );
  });

  it('never prints a server buffer target', () => {
    expect(pageTitle('buffer', { kind: 'server', target: ':server:3' }, null)).toBe('Lurker');
  });

  it('drops the network when it is not known', () => {
    expect(pageTitle('buffer', { kind: 'channel', target: '#lurker' }, null)).toBe(
      '#lurker - Lurker',
    );
  });

  it('is plain Lurker with no buffer, and for the system buffer', () => {
    expect(pageTitle('chat', null, null)).toBe('Lurker');
    expect(pageTitle('buffer', null, null)).toBe('Lurker');
    expect(pageTitle('system', { kind: 'system', target: ':system:' }, null)).toBe('Lurker');
    expect(pageTitle('login', null, null)).toBe('Lurker');
  });

  it('names Settings and Admin', () => {
    expect(pageTitle('settings', null, null)).toBe('Settings - Lurker');
    expect(pageTitle('admin', null, null)).toBe('Admin - Lurker');
  });
});
