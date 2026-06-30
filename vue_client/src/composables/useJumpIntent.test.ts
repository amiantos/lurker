// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { emitJumpIntent, onJumpIntent } from './useJumpIntent.js';

describe('useJumpIntent', () => {
  it('delivers an emitted payload to a subscriber', () => {
    const seen: unknown[] = [];
    const off = onJumpIntent((p) => seen.push(p));
    emitJumpIntent({ kind: 'jump', networkId: 1, target: '#x', messageId: 42 });
    off();
    expect(seen).toEqual([{ kind: 'jump', networkId: 1, target: '#x', messageId: 42 }]);
  });

  it('stops delivering after the disposer runs', () => {
    const fn = vi.fn<() => void>();
    const off = onJumpIntent(fn);
    off();
    emitJumpIntent({ kind: 'jump', networkId: 1, target: '#x', messageId: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('emitting with no listeners is a no-op', () => {
    expect(() => emitJumpIntent({ kind: 'jump', networkId: 1, target: '#x' })).not.toThrow();
  });

  it('a throwing listener does not block the others', () => {
    const good = vi.fn<() => void>();
    const offBad = onJumpIntent(() => {
      throw new Error('boom');
    });
    const offGood = onJumpIntent(good);
    emitJumpIntent({ kind: 'jump', networkId: 2, target: '#y', messageId: 7 });
    offBad();
    offGood();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
