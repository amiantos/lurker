// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared shapes for the uploader-management UI (#514). The server projects these
// from each driver's own `configSchema`, so the client renders a form for a
// driver it has never heard of — adding a driver is a server-only change.
//
// The one invariant worth restating here, because it shapes every component that
// touches these types: A SECRET VALUE NEVER TRAVELS TO THE CLIENT. A secret field
// is described by the schema and reported as set-or-not via `secretsSet`; its
// value is only ever write-only. Anything that renders a `secret` field must
// therefore treat "empty" as "leave what's stored alone", not "clear it".

export interface UploaderConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret';
  required: boolean;
  default?: string;
  description: string;
}

export interface UploaderDriver {
  driver: string;
  label: string;
  configSchema: UploaderConfigField[];
  // May a NEW uploader of this driver be stood up? The server sends every driver
  // (you need a schema to render an edit form for a row you already own — e.g. a
  // `hoarder` row migrated off the legacy settings, which is editable but not
  // creatable), so the "add an uploader" menu filters on this rather than on
  // whatever happens to be in the list.
  creatable: boolean;
}

/** One configured uploader, as the user-facing API projects it. */
export interface Uploader {
  id: number;
  driver: string;
  label: string;
  scope: 'user' | 'instance';
  enabled: boolean;
  editable: boolean;
  // Present only on rows the caller may edit (their own).
  config?: Record<string, string>;
  secretsSet?: Record<string, boolean>;
}

/** An instance uploader as the ADMIN API projects it (adds the policy flags). */
export interface AdminUploader extends Omit<Uploader, 'editable'> {
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
  offeredToUsers: boolean;
  locked: boolean;
  isDefault: boolean;
  // Seeded by the boot reconcile (x0 / catbox / local disk): can be disabled, but
  // not deleted — it would just come back. The server refuses either way; this is
  // so the UI doesn't offer a button that 409s.
  builtIn: boolean;
}

/** Blank form values for a driver, honoring each field's declared default. */
export function emptyValues(driver: UploaderDriver): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of driver.configSchema) out[f.key] = f.default ?? '';
  return out;
}

/**
 * Form values seeded from an existing uploader. Secrets come back EMPTY on
 * purpose — the server never sent us the value, and an empty secret on submit
 * means "keep the stored one" (see updateUploaderConfig). So an edit that doesn't
 * touch the secret field round-trips it untouched.
 */
export function valuesFrom(
  driver: UploaderDriver,
  config: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of driver.configSchema) {
    out[f.key] = f.type === 'secret' ? '' : (config[f.key] ?? f.default ?? '');
  }
  return out;
}

/** Required fields still blank — used to disable the submit button. `existing`
 *  relaxes the check for secrets that are already stored. */
export function missingRequired(
  driver: UploaderDriver,
  values: Record<string, string>,
  secretsSet: Record<string, boolean> = {},
): boolean {
  return driver.configSchema.some((f) => {
    if (!f.required) return false;
    if (f.type === 'secret' && secretsSet[f.key]) return false; // already stored
    return !String(values[f.key] ?? '').trim();
  });
}

// What the upload route accepts today: images (optimized by the sharp pipeline)
// and text/plain (passthrough). ONE definition, so the file picker's `accept` and
// the drag-drop gate can't drift apart — they had, and the picker was the stricter
// of the two: it listed images only, so a .txt could not be selected at all on
// macOS (non-matching files are greyed out, with no "All Files" escape) even
// though the server has always taken one.
//
// #515 replaces this with the effective accepted set projected from the server,
// once media lands and "what's allowed" stops being a constant.
export const ACCEPTED_FILE_TYPES = 'image/*,text/plain,.txt';

export function isUploadableType(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'text/plain';
}
