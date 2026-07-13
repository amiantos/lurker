// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared driver contract for the uploader. A *driver* is the mechanism that
// gets bytes to a destination (x0/catbox/hoarder today; local/s3 later); a
// *configured uploader* (uploader_config row) is a named instance of a driver
// with its settings filled in. Kept in its own module so both index.ts (the
// registry) and the individual driver modules can import the types without an
// import cycle.

import type { UploadSource } from './source.js';

export type ContentClass = 'image' | 'text' | 'binary';

/** One field a driver needs configured. `secret` fields are encrypted at rest
 *  and never projected to the client. This single declaration drives the admin
 *  form, the secret/non-secret split, and the client-safe projection. */
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'secret';
  required: boolean;
  default?: string;
  description: string;
}

export interface DriverCapabilities {
  // true → the driver returns a public URL on another origin (x0/catbox/hoarder/
  // s3). false → WE serve the bytes (local) and the route builds the URL.
  storesRemotely: boolean;
  // Can the driver remove stored bytes given a ref? Deletability of a specific
  // upload is decided at capture time: upload() returns a ref only when that
  // upload can actually be deleted later (e.g. catbox omits it for anonymous
  // uploads). The full row predicate is deletableWith() in resolve.ts —
  // supportsDelete AND canDeleteWith(config) AND ref present — since a config
  // can lose the credential delete() needs after refs were captured. x0 has no
  // delete API at all; hosted dropper deletion stays CP-mediated (CP #55).
  supportsDelete: boolean;
  // true only where WE construct the storage key (s3, local — none in P0). The
  // preserve-original-filename option (#517) is a no-op where the remote host
  // names the file.
  mintsKeys: boolean;
  // Defense-in-depth; the effective gate is instance policy ∩ this.
  acceptsContentClasses: ContentClass[];
  // local, s3 — never offered on the hosted fleet.
  selfHostOnly?: boolean;
  // May a human stand up a new instance of this driver in the management UI
  // (#514)? Not derivable, so it's declared: `x0` and `local` are zero-config
  // singletons whose seeded instance row IS the driver (a second row would be
  // byte-identical), and `hoarder` is the operator/seed-managed hosted dropper
  // that decision 12 retired from the self-host menu. Existing rows of a
  // non-creatable driver keep working — this gates the "add an uploader" list
  // only. Defaults to false so a new driver has to opt in deliberately.
  creatable?: boolean;
}

export interface UploadMeta {
  filename: string;
  mime: string;
  // Forward-looking classification the route always supplies; optional because no
  // P0 driver consumes it (the local/s3 drivers will branch on it later).
  contentClass?: ContentClass;
  // Hint forwarded to the in-house dropper so a thumbnail lands under a
  // `thumbs/` prefix. Hosts that don't understand it ignore the extra field.
  kind?: 'thumb';
}

export interface UploadResult {
  url: string;
  // Opaque delete handle (object key / disk key); absent when not deletable.
  ref?: string;
  bytes?: number;
}

export interface UploadDriver {
  driver: string; // stable id, matches uploader_config.driver
  label: string; // default human label
  capabilities: DriverCapabilities;
  configSchema: ConfigField[];
  // The bytes arrive as an UploadSource (source.ts), not a Buffer: a passthrough
  // upload can be hundreds of megabytes and lives in a temp file, which the driver
  // streams rather than reads. A driver must NOT readAll() it on the upload path —
  // that reintroduces exactly the heap blowup #543 removed.
  upload(
    source: UploadSource,
    meta: UploadMeta,
    config: Record<string, string>,
  ): Promise<UploadResult>;
  // Present iff capabilities.supportsDelete. CONTRACT: must be idempotent —
  // "already gone" resolves rather than throws, because the route drops the DB
  // row only after delete() succeeds, so a delete whose response was lost gets
  // retried against bytes that are already destroyed. Failures throw with the
  // PROVIDER_CONFIG / PROVIDER_AUTH / PROVIDER_ERROR code taxonomy; never
  // resolve on an ambiguous outcome (a resolved delete() is the route's license
  // to destroy the only record of the file).
  delete?(ref: string, config: Record<string, string>): Promise<void>;
  // Optional per-config refinement of supportsDelete: can delete() work with
  // THIS config right now? (catbox: only with a userhash.) Absent → yes.
  // Deletability of a row = supportsDelete ∧ canDeleteWith(config) ∧ ref
  // present — see deletableWith() in resolve.ts, the one shared predicate.
  canDeleteWith?(config: Record<string, string>): boolean;
}
