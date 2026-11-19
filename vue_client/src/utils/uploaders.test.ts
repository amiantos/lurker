// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  FileIcon,
  FileImageIcon,
  FileMusicIcon,
  FileTextIcon,
  FileVideoCameraIcon,
} from '@lucide/vue';
import {
  ACCEPTED_FILE_TYPES,
  hasUploaderChoice,
  iconForMime,
  isUploadableType,
} from './uploaders.js';

describe('hasUploaderChoice', () => {
  // The bug this exists to prevent: on app.lurker.chat there is exactly ONE
  // uploader (the locked dropper) and personal uploaders are off, so the settings
  // pane rendered the same destination twice — once by name, once as the "Server
  // default" pseudo-row that resolves to it — and asked the user to choose.
  it('is false on a hosted cell: one uploader, and you cannot add another', () => {
    expect(hasUploaderChoice(1, false)).toBe(false);
  });

  it('is true when you may add your own, even with a single uploader today', () => {
    // The picker still has a job — the list is about to grow.
    expect(hasUploaderChoice(1, true)).toBe(true);
    expect(hasUploaderChoice(0, true)).toBe(true);
  });

  it('is true on a locked-down instance that offers several to pick between', () => {
    expect(hasUploaderChoice(3, false)).toBe(true);
  });
});

describe('iconForMime', () => {
  it('distinguishes the types a thumbnail-less row can be', () => {
    expect(iconForMime('video/mp4')).toBe(FileVideoCameraIcon);
    expect(iconForMime('audio/mpeg')).toBe(FileMusicIcon);
    expect(iconForMime('text/plain')).toBe(FileTextIcon);
    expect(iconForMime('image/png')).toBe(FileImageIcon);
    expect(iconForMime(null)).toBe(FileIcon);
  });

  // #788. JSON is a text file IANA files under `application/`, so a prefix test drops
  // it onto the generic page glyph this function exists to get away from.
  it('gives the text glyph to every dialect the uploader can produce', () => {
    expect(iconForMime('text/markdown')).toBe(FileTextIcon);
    expect(iconForMime('application/json')).toBe(FileTextIcon);
    // Not a blanket application/ pass — that would put the glyph on a PDF.
    expect(iconForMime('application/pdf')).toBe(FileIcon);
  });
});

describe('isUploadableType', () => {
  // Deliberately looser than the server's accepted set: these gates exist to ignore
  // things that obviously aren't uploads, not to enforce policy. The server's 415
  // names the real reason, which beats a drop that silently does nothing.
  it('lets media through for the server to judge', () => {
    expect(isUploadableType('video/x-msvideo')).toBe(true); // server will 415 it, with a reason
    expect(isUploadableType('image/png')).toBe(true);
    expect(isUploadableType('text/plain')).toBe(true);
    expect(isUploadableType('application/pdf')).toBe(false);
  });

  // A dropped `.md` used to be silently ignored here — no upload, no error, nothing
  // (#788). The picker greying it out was the other half of the same gap.
  it('accepts the text dialects a file drop can carry', () => {
    expect(isUploadableType('text/markdown')).toBe(true);
    expect(isUploadableType('application/json')).toBe(true);
    // Any text/* — the server takes signature-less UTF-8 whatever it was called.
    expect(isUploadableType('text/x-python')).toBe(true);
  });

  // ⚠ The gap Copilot caught on #808. The picker path does NOT share this gate
  // (onFileSelected uploads directly), so a dragged `.md` on a platform that registers
  // no mime for it was silently ignored while PICKING the same file worked — and the
  // server's filename fallback, which exists for exactly that platform, never got to
  // see the file at all.
  it('accepts a dialect by extension when the platform reports no mime', () => {
    for (const mime of ['', 'application/octet-stream']) {
      expect(isUploadableType(mime, 'README.md')).toBe(true);
      expect(isUploadableType(mime, 'notes.MARKDOWN')).toBe(true);
      expect(isUploadableType(mime, 'data.json')).toBe(true);
      expect(isUploadableType(mime, 'log.txt')).toBe(true);
    }
  });

  // Bounded to the dialect extensions, NOT "let every unknown type through": a stray
  // drag should still do nothing rather than start an upload that 415s.
  it('still ignores an unknown type that is not a dialect', () => {
    for (const name of ['installer.dmg', 'archive.tar.gz', 'no-extension', 'x.exe']) {
      expect(isUploadableType('', name)).toBe(false);
      expect(isUploadableType('application/octet-stream', name)).toBe(false);
    }
  });

  // The extension is consulted ONLY when the mime says nothing. A type we already
  // refuse is not rescued by naming the file `.md`.
  it('does not let an extension override a mime we refuse', () => {
    expect(isUploadableType('application/pdf', 'notes.md')).toBe(false);
    expect(isUploadableType('application/zip', 'data.json')).toBe(false);
  });

  it('offers the dialects in the file picker, by mime AND by extension', () => {
    // Both are needed: macOS greys out anything the attribute doesn't match, with no
    // "All Files" escape, and platforms disagree about what they call a `.md`.
    for (const token of ['text/markdown', 'application/json', '.md', '.json']) {
      expect(ACCEPTED_FILE_TYPES.split(',')).toContain(token);
    }
  });
});
