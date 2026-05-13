import { describe, it, expect } from 'vitest';
import { computeFallbackNick } from './ircConnection.js';

describe('computeFallbackNick', () => {
  it('appends 1..9 in order', () => {
    expect(computeFallbackNick('bob', 0)).toBe('bob1');
    expect(computeFallbackNick('bob', 1)).toBe('bob2');
    expect(computeFallbackNick('bob', 8)).toBe('bob9');
  });

  it('returns null once the ladder is exhausted', () => {
    expect(computeFallbackNick('bob', 9)).toBeNull();
    expect(computeFallbackNick('bob', 100)).toBeNull();
  });

  it('rejects negative indices', () => {
    expect(computeFallbackNick('bob', -1)).toBeNull();
  });

  it('returns null for missing base', () => {
    expect(computeFallbackNick('', 0)).toBeNull();
    expect(computeFallbackNick(null, 0)).toBeNull();
    expect(computeFallbackNick(undefined, 0)).toBeNull();
  });

  it('preserves nicks that already end in digits', () => {
    expect(computeFallbackNick('bob1', 0)).toBe('bob11');
    expect(computeFallbackNick('bob1', 8)).toBe('bob19');
  });
});
