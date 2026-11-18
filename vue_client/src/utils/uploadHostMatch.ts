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
// links, not a gate on uploads: a format someone pastes from elsewhere may play
// perfectly well in a browser, and refusing to show it because *we* have no metadata
// scrubber for it would be enforcing our upload policy on other people's links.
// `.mkv` is here on the same terms as everything else — the element gets to try, and
// a browser that cannot play Matroska lands on the viewer's "open in browser" card.
// ⚠ `.3gp`/`.3g2` sit under video even though the ones we see most are audio-only
// (a Samsung voice memo — see contentClass.ts). Two reasons: the container sniffs as
// `video/3gpp` and can legitimately carry a picture, and the failure modes aren't
// symmetric — a <video> element playing audio-only content still plays it, just with a
// black frame, while an <audio> element on a real 3gp clip would silently drop the
// video. It also keeps them consistent with `.mp4`, which already renders through
// <video> when it happens to be audio-only.
const EXTENSIONS: Record<MediaKind, readonly string[]> = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'],
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.ogv', '.3gp', '.3g2'],
  audio: ['.mp3', '.m4a', '.ogg', '.oga', '.opus', '.wav', '.flac'],
  // ⚠ `.md` and `.json` are deliberately ABSENT, though the uploader mints both
  // (#788). This table judges ARBITRARY chat links by extension, and those two are
  // overwhelmingly PAGE urls rather than raw files — a GitHub blob, a docs page, an
  // API endpoint. Listing them costs twice over, on links that have nothing to do
  // with us: `RenderSegments.isViewableUrl` would swallow the click on
  // `…/blob/main/README.md` and land the user on the viewer's "could not read this
  // file" card instead of GitHub, and `previewUrls` would count the same link as
  // media, so it silently loses its preview card for anyone running link previews
  // without inline media.
  //
  // `.txt` earns its place because a `.txt` url is almost always the file itself.
  // The failure modes aren't symmetric: a wrong guess here breaks a link the user
  // did not upload, while the cost of omitting them is only that OUR OWN `.md`
  // opens in a browser tab. Re-add them keyed on the url being one of the user's
  // upload hosts — this module's name is aspirational, no such check exists yet —
  // never on the extension alone.
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
