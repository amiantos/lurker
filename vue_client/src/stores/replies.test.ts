// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useRepliesStore } from './replies.js';
import { bufferClosed, bufferRenamed } from '../lib/bufferLifecycle.js';

const REPLY = { messageId: 42, nick: 'alice', type: 'message', text: 'hi' };

describe('pending replies across a buffer’s lifecycle', () => {
  beforeEach(() => setActivePinia(createPinia()));

  // Reopened later, a buffer must not still be "replying to" an old line.
  it('go with a closed buffer', () => {
    const replies = useRepliesStore();
    replies.start('1::#foo', REPLY);
    replies.start('1::#bar', REPLY);
    bufferClosed(1, '#foo');
    expect(replies.forKey('1::#foo')).toBeNull();
    expect(replies.forKey('1::#bar')).toEqual(REPLY);
  });

  it('follow a renamed buffer', () => {
    const replies = useRepliesStore();
    replies.start('1::alice', REPLY);
    bufferRenamed(1, 'alice', 'alice_');
    expect(replies.forKey('1::alice')).toBeNull();
    expect(replies.forKey('1::alice_')).toEqual(REPLY);
  });
});
