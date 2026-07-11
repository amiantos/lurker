// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildObjectKey, sanitizeSegment, randomId } from './objectKey.js';

describe('sanitizeSegment', () => {
  it('keeps the safe alphabet verbatim', () => {
    expect(sanitizeSegment('Q3-report_v2.png')).toBe('Q3-report_v2.png');
  });
  it('replaces unsafe characters with a dash', () => {
    expect(sanitizeSegment('a b/c*d')).toBe('a-b-c-d');
  });
  it('drops dot-only segments to the fallback (traversal-proof)', () => {
    expect(sanitizeSegment('..')).toBe('file');
    expect(sanitizeSegment('.')).toBe('file');
  });
  it('empty → fallback', () => {
    expect(sanitizeSegment('')).toBe('file');
  });
  it('trims leading/trailing separators', () => {
    expect(sanitizeSegment('--x--')).toBe('x');
  });
  it('caps length', () => {
    expect(sanitizeSegment('a'.repeat(200)).length).toBe(96);
  });
  it('honors a custom fallback', () => {
    expect(sanitizeSegment('...', 'img')).toBe('img');
  });
});

describe('buildObjectKey', () => {
  it('default shape is {random}.{ext}', () => {
    expect(buildObjectKey({ ext: 'jpg' })).toMatch(/^[0-9a-f]{12}\.jpg$/);
  });
  it('applies a prefix', () => {
    expect(buildObjectKey({ prefix: 'thumbs', ext: 'jpg' })).toMatch(/^thumbs\/[0-9a-f]{12}\.jpg$/);
  });
  it('preserve shape is {random}/{sanitized-basename}.{ext}', () => {
    expect(buildObjectKey({ ext: 'png', originalBasename: 'Q3 Report.png' })).toMatch(
      /^[0-9a-f]{12}\/Q3-Report\.png$/,
    );
  });
  it('takes the extension from the pipeline output, never the claimed name', () => {
    // A user's .html basename is preserved but the served extension is the
    // validated pipeline ext — never becomes .html.
    expect(buildObjectKey({ ext: 'jpg', originalBasename: 'evil.html' })).toMatch(/\/evil\.jpg$/);
  });
  it('a traversal attempt in the name cannot escape the key', () => {
    const k = buildObjectKey({ ext: 'png', originalBasename: '../../etc/passwd' });
    expect(k).not.toContain('..');
    // Exactly two segments: the locating random id and one decorative name.
    expect(k.split('/')).toHaveLength(2);
  });
  it('randomId is 12 hex chars (48 bits)', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{12}$/);
  });
  it('caps an over-long extension so the key stays servable', () => {
    // The local serve route's key regex accepts at most 16 ext chars; a key we
    // mint must never exceed that or the file we wrote becomes un-servable.
    expect(buildObjectKey({ ext: 'x'.repeat(40) })).toMatch(/^[0-9a-f]{12}\.x{16}$/);
  });
});
