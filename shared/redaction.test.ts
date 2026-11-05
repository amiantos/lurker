// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { redactionLabel } from './redaction.js';

describe('redactionLabel', () => {
  const t = '2026-11-05T00:00:00.000Z';

  it('says "message deleted" for the author’s own deletion, whatever the nick’s case', () => {
    expect(redactionLabel({ by: 'bob', time: t }, 'bob')).toBe('message deleted');
    expect(redactionLabel({ by: 'Bob', time: t }, 'bob')).toBe('message deleted');
  });

  it('names someone else who deleted it', () => {
    expect(redactionLabel({ by: 'opal', time: t }, 'bob')).toBe('message deleted by opal');
  });

  it('adds the reason when one came', () => {
    expect(redactionLabel({ by: 'bob', reason: 'typo', time: t }, 'bob')).toBe(
      'message deleted: typo',
    );
    expect(redactionLabel({ by: 'opal', reason: 'no spam', time: t }, 'bob')).toBe(
      'message deleted by opal: no spam',
    );
  });

  it('names nobody when the REDACT carried no source, or the line no author', () => {
    expect(redactionLabel({ by: '', time: t }, 'bob')).toBe('message deleted');
    expect(redactionLabel({ by: 'opal', time: t }, null)).toBe('message deleted by opal');
  });
});
