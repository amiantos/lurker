// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paneFor,
  registerPane,
  resetPanes,
  unregisterPane,
  type PaneApi,
} from './usePaneRegistry.js';

function api(): PaneApi {
  return { focusInput: vi.fn<() => void>(), scrollByPage: vi.fn<() => void>() };
}

beforeEach(resetPanes);

describe('pane registry', () => {
  it('hands back the pane registered for a buffer', () => {
    const a = api();
    registerPane('1::#a', a);
    expect(paneFor('1::#a')).toBe(a);
    expect(paneFor('1::#b')).toBeNull();
  });

  // The shortcuts ask for the FOCUSED buffer's pane, and that key is null
  // before anything is active.
  it('reports null for no buffer', () => {
    expect(paneFor(null)).toBeNull();
  });

  it('drops a pane on unregister', () => {
    const a = api();
    registerPane('1::#a', a);
    unregisterPane('1::#a', a);
    expect(paneFor('1::#a')).toBeNull();
  });

  // A pane repoints at another buffer without remounting, so it registers under
  // the new key and then releases the old one. Releasing by key alone would let
  // that teardown delete a registration it no longer owns — and if the two keys
  // ever coincide, blind deletion drops the LIVE pane and the shortcuts stop
  // reaching it.
  it('ignores an unregister from a handle that no longer owns the key', () => {
    const live = api();
    const stale = api();
    registerPane('1::#a', live);

    unregisterPane('1::#a', stale);
    expect(paneFor('1::#a')).toBe(live);
  });

  it('lets a repointed pane keep only its new key', () => {
    const pane = api();
    registerPane('1::#a', pane);

    // BufferPane's watcher releases the old key then claims the new one. The
    // identity guard above is what makes that order a free choice rather than a
    // constraint, so assert the outcome, not the sequence.
    unregisterPane('1::#a', pane);
    registerPane('1::#b', pane);

    expect(paneFor('1::#a')).toBeNull();
    expect(paneFor('1::#b')).toBe(pane);
  });

  it('clears every pane on reset', () => {
    registerPane('1::#a', api());
    registerPane('1::#b', api());
    resetPanes();
    expect(paneFor('1::#a')).toBeNull();
    expect(paneFor('1::#b')).toBeNull();
  });
});
