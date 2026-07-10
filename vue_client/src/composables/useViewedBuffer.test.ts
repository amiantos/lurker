// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isBufferViewed,
  releaseViewedBuffer,
  resetViewedBuffers,
  retainViewedBuffer,
} from './useViewedBuffer.js';

beforeEach(() => {
  resetViewedBuffers();
});

describe('viewed buffers', () => {
  it('reports a retained buffer as viewed and a released one as not', () => {
    expect(isBufferViewed('1::#a')).toBe(false);
    retainViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(true);
    releaseViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(false);
  });

  it('tracks several buffers at once — the windowed case', () => {
    retainViewedBuffer('1::#a');
    retainViewedBuffer('1::#b');
    expect(isBufferViewed('1::#a')).toBe(true);
    expect(isBufferViewed('1::#b')).toBe(true);

    releaseViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(false);
    expect(isBufferViewed('1::#b')).toBe(true);
  });

  // Two panes on the same buffer, or a remount that registers the new message
  // list before the old one tears down. The first release must not blind the
  // survivor — this is why it's a refcount and not a Set.
  it('stays viewed until the last viewer releases', () => {
    retainViewedBuffer('1::#a');
    retainViewedBuffer('1::#a');
    releaseViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(true);
    releaseViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(false);
  });

  it('ignores null keys and over-releasing', () => {
    retainViewedBuffer(null);
    releaseViewedBuffer(null);
    releaseViewedBuffer('1::#never');
    expect(isBufferViewed('1::#never')).toBe(false);

    retainViewedBuffer('1::#a');
    releaseViewedBuffer('1::#a');
    releaseViewedBuffer('1::#a');
    retainViewedBuffer('1::#a');
    expect(isBufferViewed('1::#a')).toBe(true);
  });

  it('resetViewedBuffers drops everything (logout)', () => {
    retainViewedBuffer('1::#a');
    retainViewedBuffer('1::#b');
    resetViewedBuffers();
    expect(isBufferViewed('1::#a')).toBe(false);
    expect(isBufferViewed('1::#b')).toBe(false);
  });
});
