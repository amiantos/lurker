// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { subscribeErrorMessage } from './usePush.js';

// What Chrome rejects pushManager.subscribe() with when Google's push service
// is unreachable. A DOMException is an Error with its own `name`.
function abortError(message: string): Error {
  return new DOMException(message, 'AbortError');
}

describe('subscribeErrorMessage', () => {
  it('explains an AbortError as an unreachable push service, keeping the browser text', () => {
    const msg = subscribeErrorMessage(abortError('Registration failed - push service error'));
    expect(msg).toContain("couldn't reach its push service");
    expect(msg).toContain('DNS filter');
    expect(msg).toContain('(Registration failed - push service error)');
  });

  it('points Brave at its own setting', () => {
    const msg = subscribeErrorMessage(abortError('Registration failed - push service error'), true);
    expect(msg).toContain('Use Google services for push messaging');
    expect(msg).not.toContain('DNS filter');
  });

  it('omits the parenthetical when the browser gave no text', () => {
    expect(subscribeErrorMessage(abortError(''))).toMatch(/blocking it\.$/);
  });

  it('passes any other error through untouched', () => {
    const err = new DOMException('Registration failed - permission denied', 'NotAllowedError');
    expect(subscribeErrorMessage(err)).toBe('Registration failed - permission denied');
    expect(subscribeErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back when there is nothing to show', () => {
    expect(subscribeErrorMessage(undefined)).toBe('failed to enable');
  });
});
