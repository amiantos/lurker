// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * What kind of thing a URL points at, judged by its extension.
 *
 * This is the media viewer's gate (#563): it decides whether clicking a link in a
 * message opens the in-app viewer instead of ejecting you to a new tab, and which
 * element the viewer renders.
 *
 * ⚠ The extension is all we have. These are arbitrary URLs from a chat message — no
 * HEAD request, no mime — so a `.mp4` served as something else will simply fail to
 * play and land on the viewer's "open in browser" card. That's the right failure: the
 * cost of guessing wrong is one dead lightbox, and the cost of NOT guessing is that
 * every image in every channel goes back to opening in a new tab.
 */
export type MediaKind = 'image' | 'video' | 'audio' | 'text';

// Deliberately WIDER than what the uploader accepts. The viewer is a renderer of
// links, not a gate on uploads: a .webm or .flac someone pastes from elsewhere plays
// perfectly well in a browser, and refusing to show it because *we* can't yet scrub its
// metadata (#553) would be enforcing our upload policy on other people's links.
const EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'],
  video: ['.mp4', '.mov', '.m4v', '.webm'],
  audio: ['.mp3', '.m4a', '.ogg', '.oga', '.wav', '.flac'],
  text: ['.txt'],
};

export function mediaKindForUrl(rawUrl: string): MediaKind | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const path = parsed.pathname.toLowerCase();
  for (const [kind, exts] of Object.entries(EXTENSIONS)) {
    // `${ext}/` as well as endsWith: some hosts hang a transform path off the file
    // (…/photo.jpg/large), and that's still a photo.
    if (exts.some((ext) => path.endsWith(ext) || path.includes(`${ext}/`))) {
      return kind as MediaKind;
    }
  }
  return null;
}

export function isImageUrl(rawUrl: string): boolean {
  return mediaKindForUrl(rawUrl) === 'image';
}
