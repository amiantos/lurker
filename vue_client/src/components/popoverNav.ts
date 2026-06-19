// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The keyboard-nav API VerticalPopover exposes (and the three pickers forward to
// MessageInput). Declared here rather than read via `InstanceType<typeof
// VerticalPopover>` because VerticalPopover is a generic SFC, which isn't
// constructor-typed — so InstanceType can't be applied to it. The pickers type
// their popover ref as `PopoverNav | null`; the textarea keeps focus while a
// menu is open, so MessageInput drives these from its keydown handler.
export interface PopoverNav {
  // Move the highlight by `delta` visual rows (-1 up, +1 down), clamped.
  moveActive: (delta: number) => void;
  // Pick the currently highlighted row.
  confirmActive: () => void;
  // Whether there are any rows to navigate.
  hasCandidates: () => boolean;
}
