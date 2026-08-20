// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSplitsStore, MAX_PANES } from './splits.js';
import { useBuffersStore } from './buffers.js';

vi.mock('../composables/useSocket.js', () => ({ socketSend: vi.fn<() => void>() }));

// leaveBuffer is the teardown the pane lifecycle owns — spy on it rather than
// asserting on divider/unread fields, since what matters here is WHICH buffers
// the store decides have left the screen, not what leaving does to them.
function spyOnLeave() {
  const buffers = useBuffersStore();
  return vi.spyOn(buffers, 'leaveBuffer').mockImplementation(() => {});
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('splits layout', () => {
  it('starts empty and takes the first buffer as a single pane', () => {
    const splits = useSplitsStore();
    expect(splits.panes).toEqual([]);
    expect(splits.isSplit).toBe(false);

    splits.show('1::#ops');
    expect(splits.panes).toEqual(['1::#ops']);
    expect(splits.focused).toBe(0);
    expect(splits.isSplit).toBe(false);
  });

  it('adds panes up to the ceiling, focusing each new one', () => {
    const splits = useSplitsStore();
    splits.show('1::#a');
    splits.addPane('1::#b');
    expect(splits.panes).toEqual(['1::#a', '1::#b']);
    expect(splits.focused).toBe(1);
    expect(splits.isSplit).toBe(true);

    splits.addPane('1::#c');
    splits.addPane('1::#d');
    expect(splits.panes).toEqual(['1::#a', '1::#b', '1::#c', '1::#d']);
    expect(splits.focused).toBe(3);
    expect(splits.canAdd).toBe(false);
  });

  // The ceiling is a real constraint, not a soft one: a fifth buffer has to
  // displace something, and it takes the focused pane so the pane the user is
  // looking at is the one that visibly changes.
  it('replaces the focused pane once the ceiling is reached', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    for (const k of ['1::#a', '1::#b', '1::#c', '1::#d']) splits.addPane(k);
    splits.focusPane(1);

    splits.addPane('1::#e');
    expect(splits.panes).toEqual(['1::#a', '1::#e', '1::#c', '1::#d']);
    expect(splits.panes).toHaveLength(MAX_PANES);
    expect(splits.focused).toBe(1);
    // The displaced buffer is the only one that left the screen.
    expect(leave).toHaveBeenCalledExactlyOnceWith('1::#b');
  });

  it('focuses the existing pane instead of opening a buffer twice', () => {
    const splits = useSplitsStore();
    splits.show('1::#a');
    splits.addPane('1::#b');
    splits.focusPane(1);

    splits.addPane('1::#a');
    expect(splits.panes).toEqual(['1::#a', '1::#b']);
    expect(splits.focused).toBe(0);
  });

  // A plain click swaps the pane you're looking at. It must NOT collapse the
  // split — that's what the maximize control is for.
  it('swaps the focused pane on a plain show, leaving the rest alone', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    splits.show('1::#a');
    splits.addPane('1::#b');
    splits.focusPane(0);

    splits.show('1::#c');
    expect(splits.panes).toEqual(['1::#c', '1::#b']);
    expect(splits.focused).toBe(0);
    expect(leave).toHaveBeenCalledExactlyOnceWith('1::#a');
  });

  // The bug the whole leave-lifecycle split exists to prevent: focusing a pane
  // that is already on screen must not tear down the pane you focused away
  // from, because it's still sitting there being read.
  it('tears nothing down when showing a buffer that is already on screen', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    splits.show('1::#a');
    splits.addPane('1::#b');
    splits.focusPane(0);
    leave.mockClear();

    splits.show('1::#b');
    expect(splits.panes).toEqual(['1::#a', '1::#b']);
    expect(splits.focused).toBe(1);
    expect(leave).not.toHaveBeenCalled();
  });
});

describe('splits closing', () => {
  it('collapses the layout in order and tears down the closed buffer', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    for (const k of ['1::#a', '1::#b', '1::#c']) splits.addPane(k);

    splits.closePane(0);
    expect(splits.panes).toEqual(['1::#b', '1::#c']);
    expect(leave).toHaveBeenCalledExactlyOnceWith('1::#a');
  });

  it('keeps focus on the pane that slides into the closed slot', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b', '1::#c']) splits.addPane(k);
    splits.focusPane(2);

    splits.closePane(1);
    expect(splits.panes).toEqual(['1::#a', '1::#c']);
    // #c was at 2 and is now at 1 — focus follows the buffer, not the index.
    expect(splits.focusedKey).toBe('1::#c');
  });

  // Closing the focused pane hands focus to a different buffer, and the shell
  // has to re-activate it — otherwise activeKey is stranded on a buffer no pane
  // shows, which strands the sidebar highlight AND keeps advancing that
  // buffer's read pointer while the user looks at another one. The store's half
  // of that contract is reporting the new focusedKey; DesktopChat's
  // activateFocusedPane() reads it.
  it('reports a new focused buffer after the focused pane closes', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b']) splits.addPane(k);
    splits.focusPane(1);
    expect(splits.focusedKey).toBe('1::#b');

    splits.closePane(1);
    expect(splits.focusedKey).toBe('1::#a');
  });

  it('clamps focus when the focused pane was the last one', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b']) splits.addPane(k);
    splits.focusPane(1);

    splits.closePane(1);
    expect(splits.panes).toEqual(['1::#a']);
    expect(splits.focused).toBe(0);
    expect(splits.focusedKey).toBe('1::#a');
  });

  it('ignores an out-of-range close', () => {
    const splits = useSplitsStore();
    splits.show('1::#a');
    splits.closePane(4);
    splits.closePane(-1);
    expect(splits.panes).toEqual(['1::#a']);
  });

  it('maximizes one pane and leaves the others', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    for (const k of ['1::#a', '1::#b', '1::#c']) splits.addPane(k);

    splits.collapseTo(1);
    expect(splits.panes).toEqual(['1::#b']);
    expect(splits.focused).toBe(0);
    expect(leave.mock.calls.flat().toSorted()).toEqual(['1::#a', '1::#c']);
  });
});

// The splits store keys state by buffer, so it joins the lifecycle sweep in
// lib/bufferLifecycle.ts like every other store that does.
describe('splits buffer lifecycle', () => {
  it('closes the pane of a buffer that went away', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b', '1::#c']) splits.addPane(k);

    splits.dropBuffer(1, '#b');
    expect(splits.panes).toEqual(['1::#a', '1::#c']);
  });

  it('ignores a drop for a buffer no pane is showing', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b']) splits.addPane(k);

    splits.dropBuffer(1, '#zzz');
    expect(splits.panes).toEqual(['1::#a', '1::#b']);
  });

  // The system buffer is permanent — the buffers store refuses to drop it too.
  it('never drops the system pane', () => {
    const splits = useSplitsStore();
    for (const k of [':system:', '1::#a']) splits.addPane(k);

    splits.dropBuffer(null, ':system:');
    expect(splits.panes).toEqual([':system:', '1::#a']);
  });

  // A rename swaps one key for another, so a pane holding the old name would
  // silently stop tracking the conversation it is showing. It keeps its slot
  // and its focus — nothing moved on screen.
  it('follows a rename in place', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    for (const k of ['1::#a', '1::#b', '1::#c']) splits.addPane(k);
    splits.focusPane(1);

    splits.rekeyBuffer(1, '#b', '#b-renamed');
    expect(splits.panes).toEqual(['1::#a', '1::#b-renamed', '1::#c']);
    expect(splits.focused).toBe(1);
    // Same buffer under a new name: nothing left the screen.
    expect(leave).not.toHaveBeenCalled();
  });

  // A merge renames one open buffer onto another that is also open, which would
  // otherwise leave two panes on one conversation.
  it('closes the source pane when a rename merges onto an open buffer', () => {
    const splits = useSplitsStore();
    for (const k of ['1::#a', '1::#b']) splits.addPane(k);

    splits.rekeyBuffer(1, '#a', '#b');
    expect(splits.panes).toEqual(['1::#b']);
  });

  it('ignores a rename for a buffer no pane is showing', () => {
    const splits = useSplitsStore();
    splits.addPane('1::#a');

    splits.rekeyBuffer(1, '#other', '#renamed');
    expect(splits.panes).toEqual(['1::#a']);
  });
});

describe('splits session reset', () => {
  it('drops the layout without running per-buffer teardown', () => {
    const splits = useSplitsStore();
    const leave = spyOnLeave();
    for (const k of ['1::#a', '1::#b']) splits.addPane(k);

    splits.$reset();
    expect(splits.panes).toEqual([]);
    expect(splits.focused).toBe(0);
    // The buffers store is being wiped wholesale by the same reset — reaching
    // into it per-pane would touch state that is already gone.
    expect(leave).not.toHaveBeenCalled();
  });
});
