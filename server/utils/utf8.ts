// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// "Is this text?" — the one definition, shared by the two places that ask.
//
//   SERVE time (routes/localUploads.ts): a magic-byte sniff came back empty, so
//     decide whether to serve the bytes as text/plain (inline) or force a
//     download. It only ever sees the first ~4 KB.
//   UPLOAD time (services/contentClass.ts): decide whether a file with no binary
//     signature is the `text` class. That answer must hold for the WHOLE file, not
//     a window — otherwise "claim text/plain" is a way to smuggle arbitrary bytes
//     past the accepted-type policy as a .txt.
//
// They used to be separate copies inside localUploads.ts, which is exactly how the
// two drift apart.

import fs from 'node:fs';

/** Drop a trailing incomplete UTF-8 multibyte sequence, so a valid text file whose
 *  read window happens to split a character isn't misjudged as binary. Walks back
 *  over continuation bytes (0b10xxxxxx) to the lead byte; if the sequence it starts
 *  runs past the window, trim it. */
export function trimPartialUtf8(buf: Buffer): Buffer {
  for (let i = 1; i <= 3 && buf.length - i >= 0; i++) {
    const b = buf[buf.length - i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte — keep walking back
    const seqLen = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i < seqLen ? buf.subarray(0, buf.length - i) : buf; // incomplete → drop
  }
  return buf;
}

export function isUtf8(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the ENTIRE file valid UTF-8? Streamed in chunks, carrying the partial
 * multibyte sequence across the boundary — reading the file into a Buffer to check
 * would put a 150 MB .txt straight back on the heap, which is the thing #543 spent
 * a whole PR removing.
 *
 * An empty file is not text (nothing to decode, and it's a degenerate upload).
 */
export async function isFileUtf8(path: string): Promise<boolean> {
  let carry = Buffer.alloc(0);
  let sawAnything = false;

  for await (const chunk of fs.createReadStream(path, { highWaterMark: 64 * 1024 })) {
    sawAnything = true;
    const buf: Buffer =
      carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    const complete = trimPartialUtf8(buf);
    if (complete.length > 0 && !isUtf8(complete)) return false;
    carry = Buffer.from(buf.subarray(complete.length));
    // A lead byte promises at most 4 bytes, so a legitimate carry is 1-3 bytes.
    // Anything longer means trimPartialUtf8 found no lead byte to sync on.
    if (carry.length > 3) return false;
  }

  if (!sawAnything) return false;
  // A file that ends mid-sequence is truncated, i.e. not valid UTF-8.
  return carry.length === 0;
}
