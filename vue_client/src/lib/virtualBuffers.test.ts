// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  SYSTEM_KEY,
  FRIENDS_KEY,
  VIRTUAL_BUFFERS,
  isVirtualKey,
  virtualConfig,
} from './virtualBuffers.js';

describe('virtualBuffers', () => {
  it('registers system + friends with their render modes and no input/nicklist', () => {
    expect(VIRTUAL_BUFFERS[SYSTEM_KEY]).toMatchObject({
      key: SYSTEM_KEY,
      renderMode: 'console',
      hasNicklist: false,
      hasInput: false,
    });
    expect(VIRTUAL_BUFFERS[FRIENDS_KEY]).toMatchObject({
      key: FRIENDS_KEY,
      renderMode: 'overview',
      hasNicklist: false,
      hasInput: false,
    });
  });

  it('uses flat sentinel keys so the `${networkId}::${target}` parsers ignore them', () => {
    expect(SYSTEM_KEY.includes('::')).toBe(false);
    expect(FRIENDS_KEY.includes('::')).toBe(false);
  });

  it('isVirtualKey recognizes registered keys and rejects everything else', () => {
    expect(isVirtualKey(SYSTEM_KEY)).toBe(true);
    expect(isVirtualKey(FRIENDS_KEY)).toBe(true);
    expect(isVirtualKey('1::#chan')).toBe(false);
    expect(isVirtualKey(':highlights:')).toBe(false); // not registered yet
    expect(isVirtualKey('')).toBe(false);
    expect(isVirtualKey(null)).toBe(false);
    expect(isVirtualKey(undefined)).toBe(false);
  });

  it('does not treat inherited Object prototype keys as virtual', () => {
    // isVirtualKey uses hasOwnProperty, so 'constructor'/'toString' are not virtual.
    expect(isVirtualKey('constructor')).toBe(false);
    expect(isVirtualKey('toString')).toBe(false);
  });

  it('virtualConfig returns the frozen config for a virtual key, null otherwise', () => {
    expect(virtualConfig(FRIENDS_KEY)).toBe(VIRTUAL_BUFFERS[FRIENDS_KEY]);
    expect(virtualConfig('1::#chan')).toBeNull();
    expect(virtualConfig(null)).toBeNull();
    expect(virtualConfig(undefined)).toBeNull();
  });

  it('the registry is frozen', () => {
    expect(Object.isFrozen(VIRTUAL_BUFFERS)).toBe(true);
  });
});
