// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isChunkLoadError,
  safeSessionStorage,
  shouldReloadFor,
  RELOAD_WINDOW_MS,
} from './chunkReload.js';

describe('isChunkLoadError', () => {
  // The real strings each engine produces. If a browser rewords one of these
  // the route goes back to silently dying, so pin them.
  it.each([
    'Failed to fetch dynamically imported module: https://lurker.chat/assets/Settings-CT7MEjB_.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of 'text/html'.",
  ])('detects %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it('ignores unrelated navigation errors', () => {
    expect(isChunkLoadError(new Error('Navigation aborted'))).toBe(false);
    expect(isChunkLoadError(new Error('Redirected when going from / to /settings'))).toBe(false);
  });

  it('tolerates non-Error and empty values', () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
  });
});

describe('shouldReloadFor', () => {
  let storage: Storage;

  beforeEach(() => {
    const map = new Map<string, string>();
    storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  it('allows the first attempt for a path', () => {
    expect(shouldReloadFor('/settings', 1000, storage)).toBe(true);
  });

  it('refuses a second attempt for the same path inside the window', () => {
    expect(shouldReloadFor('/settings', 1000, storage)).toBe(true);
    expect(shouldReloadFor('/settings', 1000 + RELOAD_WINDOW_MS - 1, storage)).toBe(false);
  });

  it('allows a retry once the window has passed', () => {
    expect(shouldReloadFor('/settings', 1000, storage)).toBe(true);
    expect(shouldReloadFor('/settings', 1000 + RELOAD_WINDOW_MS, storage)).toBe(true);
  });

  it('does not let one dead route block a different one', () => {
    expect(shouldReloadFor('/settings', 1000, storage)).toBe(true);
    expect(shouldReloadFor('/settings', 1500, storage)).toBe(false);
    expect(shouldReloadFor('/admin', 1600, storage)).toBe(true);
  });

  it('allows the reload when storage is unavailable', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    expect(shouldReloadFor('/settings', 1000, hostile)).toBe(true);
  });

  it('ignores a corrupt stored attempt', () => {
    storage.setItem('lurker:chunk-reload', 'not json');
    expect(shouldReloadFor('/settings', 1000, storage)).toBe(true);
  });

  it('allows the reload when storage is null', () => {
    expect(shouldReloadFor('/settings', 1000, null)).toBe(true);
  });
});

// This suite runs in the node project (no DOM by design — see
// vue_client/vitest.config.ts), so `window` is stubbed per-case rather than
// pulling in happy-dom for what is pure logic.
describe('safeSessionStorage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the handle when storage is reachable', () => {
    const handle = {} as Storage;
    vi.stubGlobal('window', { sessionStorage: handle });
    expect(safeSessionStorage()).toBe(handle);
  });

  it('returns null when merely READING window.sessionStorage throws', () => {
    // Safari with cookies blocked throws a SecurityError on the property
    // access itself, not on getItem/setItem. If the caller reaches for
    // window.sessionStorage directly, the throw escapes the whole onError
    // handler and NO recovery runs at all — on iOS Safari, which is where a
    // PWA is most likely to lose a chunk to begin with. Regression guard for
    // that call-site mistake (PR #600 review).
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    expect(safeSessionStorage()).toBeNull();
    expect(() => shouldReloadFor('/settings', 1000, safeSessionStorage())).not.toThrow();
    // ...and having swallowed it, we still recover rather than giving up.
    expect(shouldReloadFor('/settings', 1000, safeSessionStorage())).toBe(true);
  });

  it('returns null when there is no window at all', () => {
    expect(safeSessionStorage()).toBeNull();
  });
});
