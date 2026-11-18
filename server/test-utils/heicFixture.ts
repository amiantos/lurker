// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * A real HEVC-coded HEIC, 711 bytes: 96x64, a green band across the top eight rows,
 * red below it on the left half and blue on the right.
 *
 * Written by an actual HEIF encoder (Windows' own, through
 * Windows.Graphics.Imaging.BitmapEncoder), not assembled by hand — a HEIC is only
 * worth testing with if a real HEVC bitstream is inside it, and nothing in this
 * repo can produce one: sharp's libheif has neither an HEVC encoder nor a decoder,
 * which is the whole reason services/heicDecode.ts exists. It carries an `Exif`
 * item, as a camera's would.
 *
 * The picture is asymmetric on both axes on purpose, so a decode that came back
 * flipped, rotated, or with red and blue swapped fails a pixel check.
 */
export const HEIC_WIDTH = 96;
export const HEIC_HEIGHT = 64;

export const heicFixture = (): Buffer =>
  Buffer.from(
    'AAAAIGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZk1pSEIAAAF6bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAA' +
      'AAAAAAAAAAAOcGl0bQAAAAAAAQAAADhpaW5mAAAAAAACAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAAFWluZmUCAAABAAIAAEV4' +
      'aWYAAAAALGlsb2MAAAAARAAAAgABAAAAAQAAAeIAAACfAAIAAAABAAACgQAAAEYAAADBaXBycAAAAKNpcGNvAAAAFGlzcGUA' +
      'AAAAAAAAYAAAAEAAAAB3aHZjQwEBQAAAALAAAAAAAAPwAPz9+PgBAAsDoAABABhAAQwB//8BQAAAAwCwAAADAAADAAMqAkCh' +
      'AAEAKkIBAQFAAAADALAAAAMAAAMAA6AwgQXKk7cuTcBDQIEAAAMAZAAAAwBkCKIAAQAHRAHAcYCbIAAAABBwaXhpAAAAAAMI' +
      'CAgAAAAWaXBtYQAAAAAAAAABAAEDAYIDAAAAGmlyZWYAAAAAAAAADmNkc2MAAgABAAEAAABAZnJlZQAAAAAAAAAAAAAAAAAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7W1kYXQAAACbKAGvC8Dk0ATU9y2eZTWm8qFo' +
      'WReGscMmdQCFvfVa+abQ1Yv4FPyGAHd5Cb8Hf15ITbtRXwF5P5L/uOp7lu27Kok/936f8X1c3SdLcspj5HJw2v7A9z+yftNf' +
      'h3uHmSNCbgFgMGcSOszme0rec/WeNQaLfMxmuyk38Vme4adCFrIMu+Dxh2oP6FFPYoZt5dzs+u08l9tHVAAAPWAAAAAASUkq' +
      'AAgAAAADABoBBQABAAAAMgAAABsBBQABAAAAOgAAACgBAwABAAAAAgAAAAAAAABgAAAAAQAAAGAAAAABAAAA',
    'base64',
  );

/** Which of the fixture's three colours an RGB(A) pixel is nearest. HEVC is lossy,
 *  so the test is "clearly this one", not an exact value. */
export function heicColourAt(
  pixels: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
): 'red' | 'green' | 'blue' {
  const at = (y * width + x) * channels;
  const [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
  if (g > r && g > b) return 'green';
  return r > b ? 'red' : 'blue';
}
