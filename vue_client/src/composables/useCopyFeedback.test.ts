// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCopyFeedback } from './useCopyFeedback.js';

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText } },
    configurable: true,
  });
});
afterEach(() => vi.useRealTimers());

describe('useCopyFeedback', () => {
  it('copies the text and flashes a confirmation that expires', async () => {
    const c = useCopyFeedback(1500);
    expect(await c.copy('https://x.test/a.webp')).toBe(true);

    expect(writeText).toHaveBeenCalledWith('https://x.test/a.webp');
    expect(c.isCopied()).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(c.isCopied()).toBe(false);
  });

  // The reason `key` exists: one instance serves a whole grid, and only the tile that
  // was actually copied may tick.
  it('confirms only the key that was copied', async () => {
    const c = useCopyFeedback();
    await c.copy('https://x.test/7.webp', 7);

    expect(c.isCopied(7)).toBe(true);
    expect(c.isCopied(8)).toBe(false);
    expect(c.isCopied()).toBe(false); // the unkeyed default is a key like any other
  });

  it('moves the confirmation when a second thing is copied', async () => {
    const c = useCopyFeedback();
    await c.copy('a', 1);
    await c.copy('b', 2);

    expect(c.isCopied(1)).toBe(false);
    expect(c.isCopied(2)).toBe(true);
  });

  // The image viewer resets on navigation: arrowing to the next photo while the tick
  // is still up would leave a green check sitting over a link the user has NOT copied.
  it('can drop the confirmation early', async () => {
    const c = useCopyFeedback();
    await c.copy('a');
    expect(c.copied.value).toBe(true);

    c.reset();
    expect(c.copied.value).toBe(false);

    // The pending timer must not resurrect anything — or fire on a stale key later.
    vi.advanceTimersByTime(5000);
    expect(c.copied.value).toBe(false);
  });

  // The Clipboard API rejects without a user gesture and is absent outside secure
  // contexts entirely (LAN dev mode serves plain HTTP). A failed convenience must not
  // claim success, and must not throw at the call site either.
  it('reports failure without throwing, and shows no confirmation', async () => {
    writeText.mockRejectedValue(new Error('not allowed'));
    const c = useCopyFeedback();

    await expect(c.copy('a')).resolves.toBe(false);
    expect(c.copied.value).toBe(false);
  });
});
