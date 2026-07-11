// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Shared driver contract for the uploader. A *driver* is the mechanism that
// gets bytes to a destination (x0/catbox/hoarder today; local/s3 later); a
// *configured uploader* (uploader_config row) is a named instance of a driver
// with its settings filled in. Kept in its own module so both index.ts (the
// registry) and the individual driver modules can import the types without an
// import cycle.

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
  // Can the stored bytes be removed given a ref? All P0 drivers: false (external
  // forwarders don't offer delete; hosted takedown stays CP/admin-key-only).
  supportsDelete: boolean;
  // true only where WE construct the storage key (s3, local — none in P0). The
  // preserve-original-filename option (#517) is a no-op where the remote host
  // names the file.
  mintsKeys: boolean;
  // Defense-in-depth; the effective gate is instance policy ∩ this.
  acceptsContentClasses: ContentClass[];
  // local, s3 — never offered on the hosted fleet.
  selfHostOnly?: boolean;
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
  upload(buffer: Buffer, meta: UploadMeta, config: Record<string, string>): Promise<UploadResult>;
  // Present iff capabilities.supportsDelete.
  delete?(ref: string, config: Record<string, string>): Promise<void>;
}
