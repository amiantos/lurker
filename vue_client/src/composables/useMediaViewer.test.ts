// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { useMediaViewer } from './useMediaViewer.js';

const item = (n: number) => ({ url: `https://x.test/${n}.webp`, filename: `${n}.png` });
const items = (...ns: number[]) => ns.map(item);

// The composable is a module-level singleton (one lightbox for the whole app), so each
// test has to start from a closed one.
beforeEach(() => useMediaViewer().close());

describe('useMediaViewer — a single file is a gallery of one', () => {
  // The framing the whole design rests on: a file clicked in a message and one  // clicked in the uploads browser reach the same viewer, and the single-image case
  // needs no special path — it just has nowhere to go.
  it('opens one image with no navigation', () => {
    const m = useMediaViewer();
    m.open('https://x.test/solo.webp');

    expect(m.isOpen.value).toBe(true);
    expect(m.url.value).toBe('https://x.test/solo.webp');
    expect(m.count.value).toBe(1);
    expect(m.hasPrev.value).toBe(false);
    expect(m.hasNext.value).toBe(false);
  });

  it('next/prev are inert on a gallery of one', () => {
    const m = useMediaViewer();
    m.open('https://x.test/solo.webp');
    m.next();
    m.prev();
    expect(m.url.value).toBe('https://x.test/solo.webp');
  });
});

describe('useMediaViewer — gallery navigation', () => {
  it('opens at the image that was clicked, not at the start', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 2);
    expect(m.url.value).toBe('https://x.test/3.webp');
    expect(m.index.value).toBe(2);
    expect(m.hasNext.value).toBe(false);
    expect(m.hasPrev.value).toBe(true);
  });

  it('walks forward and back', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 0);
    m.next();
    expect(m.url.value).toBe('https://x.test/2.webp');
    m.next();
    expect(m.url.value).toBe('https://x.test/3.webp');
    m.prev();
    expect(m.url.value).toBe('https://x.test/2.webp');
  });

  it('stops at the ends instead of wrapping', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2), 0);
    m.prev();
    expect(m.index.value).toBe(0); // already at the first
    m.next();
    m.next();
    expect(m.index.value).toBe(1); // already at the last
  });

  it('clamps an out-of-range start index rather than showing nothing', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2), 99);
    expect(m.url.value).toBe('https://x.test/2.webp');
  });

  it('refuses to open an empty gallery', () => {
    const m = useMediaViewer();
    m.openGallery([], 0);
    expect(m.isOpen.value).toBe(false);
  });
});

describe('useMediaViewer — extending the gallery while it is open', () => {
  // The uploads browser pages lazily, so arrowing toward the end of what's loaded has
  // to extend the list UNDER the viewer. The user must not be moved.
  it('keeps the viewer on its image when a page is appended', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 2);

    m.setItems(items(1, 2, 3, 4, 5));

    expect(m.url.value).toBe('https://x.test/3.webp'); // still the same photo
    expect(m.index.value).toBe(2);
    expect(m.hasNext.value).toBe(true); // ...and now there is somewhere to go
  });

  // Position is preserved by URL, not by index, so a list that grows at the FRONT (a
  // fresh upload lands at the top) doesn't silently teleport the user to a different
  // photo — which is a far worse bug than a redundant re-render.
  it('keeps the viewer on its image when a row is prepended', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 0);
    expect(m.url.value).toBe('https://x.test/1.webp');

    m.setItems(items(0, 1, 2, 3));

    expect(m.url.value).toBe('https://x.test/1.webp');
    expect(m.index.value).toBe(1); // followed the image, not the slot
  });

  it('falls back to a valid index when the viewed image disappears', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 2);
    // e.g. the user deleted it, or a filter changed under the gallery.
    m.setItems(items(1, 2));
    expect(m.index.value).toBe(1);
    expect(m.url.value).toBe('https://x.test/2.webp');
  });
});

describe('useMediaViewer — close', () => {
  it('drops the gallery so the next open starts clean', () => {
    const m = useMediaViewer();
    m.openGallery(items(1, 2, 3), 1);
    m.close();

    expect(m.isOpen.value).toBe(false);
    expect(m.url.value).toBeNull();
    expect(m.count.value).toBe(0);
  });
});
