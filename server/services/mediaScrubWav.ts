// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The WAV part of services/mediaScrub.ts (#553).
//
// A WAV is a RIFF file: a 12-byte header, then chunks of a four-character id, a
// 32-bit length and a payload padded to an even length. The format and the samples
// are two of them; the rest is where a recorder writes about itself — `LIST`/`INFO`
// (artist, software, creation date), `bext` (a broadcast recorder's originator,
// date, time and device serial), `iXML` (a field recorder's project and take notes,
// sometimes a location), `id3 `, and XMP in `_PMX`.
//
// `JUNK` is RIFF's padding chunk, so a chunk is neutralized by retyping it to JUNK
// and zeroing it, which leaves the RIFF length and every other chunk where they
// were.

import { MediaScrubError, type ScrubFile } from './mediaScrubIo.js';

// ⚠ An allowlist: what a decoder needs, plus padding. A chunk nobody has heard of
// is more likely to be a recorder's notes than something playback depends on, and
// the failure modes are not symmetric — blanking a sampler's loop points costs a
// loop, keeping a chunk we did not recognize can cost someone their address.
const KEPT = new Set(['fmt ', 'fact', 'data', 'JUNK', 'junk', 'PAD ', 'FLLR']);

const JUNK = Buffer.from('JUNK');

export async function scrubWav(file: ScrubFile): Promise<void> {
  const riff = await file.peek(0, 12);
  if (
    riff.length < 12 ||
    riff.toString('latin1', 0, 4) !== 'RIFF' ||
    riff.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    throw new MediaScrubError('not a WAV file');
  }

  let pos = 12;
  while (pos + 8 <= file.size) {
    const header = await file.peek(pos, 8);
    const id = header.toString('latin1', 0, 4);
    const length = header.readUInt32LE(4);
    const end = pos + 8 + length;

    if (end > file.size) {
      // A recorder that could not seek back writes a `data` length of 0 or
      // 0xFFFFFFFF and stops when the audio does; a recording that was cut off
      // looks the same. Either way the samples run to the end of the file and
      // there is nothing after them to clean.
      if (id === 'data') return;
      throw new MediaScrubError(`malformed chunk "${id}" at offset ${pos}`);
    }

    if (!KEPT.has(id)) {
      await file.write(JUNK, pos);
      await file.zero(pos + 8, end);
    }

    pos = end + (length & 1);
  }
}
