// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-component state for what the user is currently composing. Lives in a
// module-level reactive ref so MessageInput (the writer) and StatusBar (the
// reader) can stay decoupled — no provide/inject, no Pinia store, no prop
// drilling. There's only ever one input field on screen at a time, so a
// singleton is the right shape.
//
// `chunks` is the estimated number of IRC PRIVMSGs the current text would
// produce on the wire. 0 = empty, 1 = single line, ≥2 = the SPLIT/FLOOD
// indicator should appear. `isAction` flips when the user has typed /me so
// downstream code can pick the tighter ACTION byte budget if it wants.
// `multiline` is true when the draft will be sent as draft/multiline batches
// (the network negotiated the cap and the body has an interior newline, or is
// one line too long for a single PRIVMSG). In that mode `chunks` is the batch
// (message) count, not the wire-PRIVMSG count:
// StatusBar shows 1 → a neutral MULTILINE chip and 2+ → MULTILINE ×N escalating
// to warn/bad. The legacy SPLIT/FLOOD wording is used only when `multiline` is
// false. (#381)
// `typedLines` is how many newline-separated lines the body has on the wire
// path, for the split gate's "two lines you typed need no confirming" rule
// (#1119); 0 on the multiline path and for anything that isn't a PRIVMSG body.

import { reactive, readonly } from 'vue';

export interface ComposingState {
  chunks: number;
  isAction: boolean;
  multiline?: boolean;
  typedLines?: number;
}

const state = reactive<Required<ComposingState>>({
  chunks: 0,
  isAction: false,
  typedLines: 0,
  multiline: false,
});

export function setComposingState({
  chunks,
  isAction,
  multiline = false,
  typedLines = 0,
}: ComposingState): void {
  state.chunks = chunks;
  state.isAction = isAction;
  state.multiline = multiline;
  state.typedLines = typedLines;
}

export function useComposing(): Readonly<ComposingState> {
  return readonly(state);
}
