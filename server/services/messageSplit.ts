// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Mirrors irc-framework's outgoing splitter (client.sendMessage / client.action)
// so we can publish self-message events that match exactly what peers receive
// on the wire — one event per PRIVMSG sent. Without this, the sender's buffer
// shows a single long line while everyone else sees N chunks.
//
// We reuse irc-framework's own lineBreak() rather than reimplementing the
// byte/word/grapheme/codepoint cascade, so the split outcome is guaranteed to
// agree with what client.say()/client.action() actually transmits. The import
// reaches into the package's src/ tree — there's no exports map, so the path
// is stable for now; if a future irc-framework adds one, this will fail loudly
// at import time rather than silently diverging.
//
// Defaults match irc-framework: message_max_length=350 for PRIVMSG, and
// 350 - ('ACTION'.length + 3) = 341 for CTCP ACTION (the 3 covers the type
// name's leading space and the two \x01 SOH chars).
import { lineBreak } from 'irc-framework/src/linebreak.js';

export const MESSAGE_MAX_BYTES = 350;
const ACTION_MAX_BYTES = MESSAGE_MAX_BYTES - ('ACTION'.length + 3);

function chunk(text: string, bytes: number): string[] {
  return [
    ...lineBreak(text, {
      bytes,
      allowBreakingWords: true,
      allowBreakingGraphemes: true,
    }),
  ];
}

// Split a PRIVMSG body the way irc-framework would: first on line breaks
// (each becomes its own series of wire messages — \n inside a PRIVMSG is
// illegal anyway), then byte-chunk each line.
export function splitSay(text: string | null | undefined): string[] {
  if (text == null || text === '') return [];
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    out.push(...chunk(line, MESSAGE_MAX_BYTES));
  }
  return out;
}

// CTCP ACTION doesn't pre-split on newlines (matching irc-framework). The
// budget is tighter to leave room for the wrapping \x01ACTION ... \x01.
export function splitAction(text: string | null | undefined): string[] {
  if (text == null || text === '') return [];
  return chunk(text, ACTION_MAX_BYTES);
}

// One PRIVMSG inside a `draft/multiline` batch. `concat` true means the line
// re-joins the previous one with NO newline — used when a single logical line
// overflowed the per-message byte budget and had to be split across the wire.
// The receiver reassembles by joining with '\n' except where concat is set.
export interface MultilineWireMessage {
  content: string;
  concat: boolean;
}

// Split a multi-line body into the sequence of PRIVMSGs that make up a
// `draft/multiline` batch. Unlike splitSay, we PRESERVE interior blank lines (an
// empty PRIVMSG with a trailing `:` round-trips as a blank line) so a pasted
// paragraph's breaks survive intact. Leading/trailing blank lines are trimmed,
// though — they'd otherwise send a spurious empty message that the legacy
// splitSay path drops, making the two send paths disagree at newline edges
// (#381 review). Each source line is byte-chunked the same way the wire splitter
// does; the 2nd+ chunk of an over-long line carries concat so the receiver glues
// it back without inserting a newline mid-line. The whole-batch max-bytes /
// max-lines budget is enforced by partitionMultiline, not here.
export function splitMultiline(text: string | null | undefined): MultilineWireMessage[] {
  if (text == null || text === '') return [];
  const out: MultilineWireMessage[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') {
      out.push({ content: '', concat: false });
      continue;
    }
    chunk(line, MESSAGE_MAX_BYTES).forEach((part, i) => {
      out.push({ content: part, concat: i > 0 });
    });
  }
  // Drop blank wire messages at the edges (a concat continuation is never empty,
  // so the !concat guard is belt-and-suspenders).
  while (out.length > 0 && out[0].content === '' && !out[0].concat) out.shift();
  while (out.length > 0 && out[out.length - 1].content === '' && !out[out.length - 1].concat) {
    out.pop();
  }
  return out;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export interface MultilineLimits {
  maxBytes: number;
  maxLines: number;
}

// Partition a multi-line body into one-or-more draft/multiline batches, each
// within the server's advertised max-lines (count of wire PRIVMSGs) and
// max-bytes (sum of content bytes). A logical line that had to be byte-split
// into concat continuations is kept whole inside a single batch WHEN IT FITS —
// but a single line bigger than one whole batch is torn across batches at wire
// boundaries rather than packed into one over-budget batch. Overflowing a batch
// would make the server reject it (`FAIL BATCH MULTILINE_MAX_BYTES`) and drop
// the message entirely while we've already echoed it locally — silent data loss
// (#381 review). Returns one WireMessage[] per batch — a body that fits is a
// single batch (one logical message), a larger one becomes N batches instead of
// degrading to N raw lines.
export function partitionMultiline(
  text: string | null | undefined,
  limits: MultilineLimits,
): MultilineWireMessage[][] {
  const wires = splitMultiline(text);
  if (wires.length === 0) return [];
  // Re-group wire messages into logical lines (a head plus its concat tail).
  const logical: MultilineWireMessage[][] = [];
  for (const w of wires) {
    if (!w.concat || logical.length === 0) logical.push([w]);
    else logical[logical.length - 1].push(w);
  }
  const batches: MultilineWireMessage[][] = [];
  let cur: MultilineWireMessage[] = [];
  let curBytes = 0;
  const flush = (): void => {
    if (cur.length > 0) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
  };
  for (const line of logical) {
    const lineBytes = line.reduce((n, w) => n + byteLen(w.content), 0);
    // Close the current batch if appending this whole line would overflow it.
    if (
      cur.length > 0 &&
      (cur.length + line.length > limits.maxLines || curBytes + lineBytes > limits.maxBytes)
    ) {
      flush();
    }
    if (line.length <= limits.maxLines && lineBytes <= limits.maxBytes) {
      // Fits in one batch — keep the (possibly concat-split) line whole.
      cur.push(...line);
      curBytes += lineBytes;
    } else {
      // Bigger than a whole batch on its own — tear it across batches at wire
      // boundaries so no single batch exceeds the server's budget. A wire
      // message is ≤350B, so it can exceed maxBytes only if the server set
      // max-bytes below a full wire line; re-chunk it smaller in that case so a
      // batch never overflows. (The caller gates max-bytes < 350 to the legacy
      // splitter, so this is a belt-and-suspenders.)
      flush();
      const pieces = line.flatMap((w) =>
        byteLen(w.content) > limits.maxBytes
          ? chunk(w.content, limits.maxBytes).map((c, i) => ({
              content: c,
              concat: i > 0 || w.concat,
            }))
          : [w],
      );
      for (const w of pieces) {
        const wBytes = byteLen(w.content);
        if (
          cur.length > 0 &&
          (cur.length + 1 > limits.maxLines || curBytes + wBytes > limits.maxBytes)
        ) {
          flush();
        }
        cur.push(w);
        curBytes += wBytes;
      }
    }
  }
  flush();
  return batches;
}

// True when `text` carries a newline that isn't just a leading/trailing edge —
// i.e. it would actually become a multi-line draft/multiline send once
// splitMultiline trims edge blanks. The send path gates multiline on this (not a
// bare newline test) so "hello\n" stays a single-line legacy send and the server
// agrees with the client's multilineMessageCount, which trims the same way. (#381)
export function hasInteriorNewline(text: string): boolean {
  return /\r\n|\n|\r/.test(text.replace(/^(?:\r\n|\r|\n)+/, '').replace(/(?:\r\n|\r|\n)+$/, ''));
}

// Inverse of the receiver's reassembly: collapse a batch's wire messages back
// into the display text a multiline-capable peer would show (join with '\n'
// except across concat continuations). Used for the sender's local echo so each
// self bubble matches what the channel sees, one per batch. (#381)
export function reassembleMultiline(wires: MultilineWireMessage[]): string {
  let text = '';
  wires.forEach((w, i) => {
    if (i === 0) text = w.content;
    else text += w.concat ? w.content : `\n${w.content}`;
  });
  return text;
}
