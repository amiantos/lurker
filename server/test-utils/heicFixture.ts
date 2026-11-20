// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/**
 * A real HEVC-coded HEIC, 711 bytes: 96x64, a green band across the top eight rows,
 * red below it on the left half and blue on the right.
 *
 * Written by an actual HEIF encoder (Windows' own, through
 * Windows.Graphics.Imaging.BitmapEncoder), not assembled by hand: what the tests
 * need from it is a real HEVC bitstream, the thing sharp's prebuilt libvips reads
 * the header of and cannot decode, and nothing in this repo can produce one. It
 * carries an `Exif` item, as a camera's would.
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
