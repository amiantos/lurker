// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The media viewer's model. It is a GALLERY, and a single file is a gallery of one.
//
// That framing is the whole design. Clicking a link in a message (RenderSegments) and
// clicking a tile in the uploads browser (#547) reach the same viewer; the only
// difference is how many files came along with it. The single-file case therefore needs
// no special path — `hasPrev`/`hasNext` are simply false and the arrows don't render —
// which is why `open()` is just `openGallery()` with one item.
//
// The model is deliberately blind to what KIND each item is (#563). The viewer derives
// that from the URL when it renders, so this stays a list of things to look at, and
// there is no second place that could disagree about what a `.mp4` is.

import { computed, ref } from 'vue';

export interface GalleryItem {
  url: string;
  filename?: string | null;
}

const isOpen = ref(false);
const items = ref<GalleryItem[]>([]);
const index = ref(0);

export function useMediaViewer() {
  const current = computed<GalleryItem | null>(() => items.value[index.value] ?? null);
  // The many call sites that only ever wanted "the image being viewed" keep working.
  const url = computed<string | null>(() => current.value?.url ?? null);
  const count = computed(() => items.value.length);
  const hasPrev = computed(() => index.value > 0);
  const hasNext = computed(() => index.value < items.value.length - 1);

  /** Open a single image — a gallery of one. */
  function open(nextUrl: string): void {
    openGallery([{ url: nextUrl }], 0);
  }

  /** Open a list of images, starting at `startIndex` (the uploads browser). */
  function openGallery(next: GalleryItem[], startIndex = 0): void {
    if (!next.length) return;
    items.value = next;
    index.value = Math.min(Math.max(0, startIndex), next.length - 1);
    isOpen.value = true;
  }

  /**
   * Replace the gallery's contents WITHOUT moving the viewer off the current image.
   *
   * The uploads browser pages lazily, so arrowing toward the end of what's loaded has
   * to be able to extend the list underneath the viewer. The position is preserved by
   * URL rather than by index on purpose: a page appended at the end wouldn't shift
   * anything today, but nothing in the type guarantees that's the only way the list
   * can grow, and silently teleporting the user to a different photo is a much worse
   * bug than a redundant re-render.
   */
  function setItems(next: GalleryItem[]): void {
    const viewing = current.value?.url;
    items.value = next;
    const found = viewing ? next.findIndex((i) => i.url === viewing) : -1;
    index.value = found >= 0 ? found : Math.min(index.value, Math.max(0, next.length - 1));
  }

  function next(): void {
    if (hasNext.value) index.value += 1;
  }

  function prev(): void {
    if (hasPrev.value) index.value -= 1;
  }

  function close(): void {
    isOpen.value = false;
    items.value = [];
    index.value = 0;
  }

  return {
    isOpen,
    url,
    items,
    index,
    current,
    count,
    hasPrev,
    hasNext,
    open,
    openGallery,
    setItems,
    next,
    prev,
    close,
  };
}
