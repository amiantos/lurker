// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { JumpPayload } from './useChatBootstrap.js';

// In-app "jump to this message" intent bus. The push-notification path has its
// own delivery channel (onSWPushMessage); this is the parallel channel for jump
// intents that originate inside the already-running app — today, a click on a
// highlight/DM toast (#444). ToastContainer is mounted at the App level, outside
// the chat shells that own the jump machinery (pendingScrollId / useJumpToMessage),
// so it can't run the jump itself; it emits here and the active shell — which
// subscribed via useChatBootstrap — performs it. One jump implementation, three
// entry points (warm push, cold push, in-app toast).
type JumpIntentListener = (payload: JumpPayload) => void;

const listeners = new Set<JumpIntentListener>();

export function emitJumpIntent(payload: JumpPayload): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (_) {
      // A misbehaving listener must not strand the originating click.
    }
  }
}

export function onJumpIntent(listener: JumpIntentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
