// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  paneFor,
  registerPane,
  resetPanes,
  unregisterPane,
  type PaneApi,
} from './usePaneRegistry.js';

const makeApi = (): PaneApi => ({
  focusInput: vi.fn<() => void>(),
  scrollByPage: vi.fn<(dir: number) => void>(),
});

beforeEach(() => {
  resetPanes();
});

describe('pane registry', () => {
  it('resolves a registered pane by buffer key', () => {
    const api = makeApi();
    registerPane('1::#a', api);
    expect(paneFor('1::#a')).toBe(api);
    expect(paneFor('1::#b')).toBeNull();
    expect(paneFor(null)).toBeNull();
  });

  it('ignores a null key rather than registering an unreachable pane', () => {
    registerPane(null, makeApi());
    expect(paneFor(null)).toBeNull();
  });

  // The single-pane shell keeps one BufferPane across buffer switches, so its
  // registration has to move with the key. Regression: registering once at
  // mount left the registry empty (activeKey is null at that point) and broke
  // type-ahead focus and PageUp/PageDown.
  it('follows a pane across a key change', () => {
    const api = makeApi();
    registerPane(null, api);
    expect(paneFor(':system:')).toBeNull();

    registerPane(':system:', api);
    expect(paneFor(':system:')).toBe(api);

    unregisterPane(':system:', api);
    registerPane('1::#a', api);
    expect(paneFor(':system:')).toBeNull();
    expect(paneFor('1::#a')).toBe(api);
  });

  // A remount can register the new pane before the old one tears down; the old
  // unmount must not delete the newcomer's registration.
  it('unregister is identity-checked', () => {
    const oldApi = makeApi();
    const newApi = makeApi();
    registerPane('1::#a', oldApi);
    registerPane('1::#a', newApi);

    unregisterPane('1::#a', oldApi);
    expect(paneFor('1::#a')).toBe(newApi);

    unregisterPane('1::#a', newApi);
    expect(paneFor('1::#a')).toBeNull();
  });

  it('resetPanes drops everything (logout)', () => {
    registerPane('1::#a', makeApi());
    resetPanes();
    expect(paneFor('1::#a')).toBeNull();
  });
});
