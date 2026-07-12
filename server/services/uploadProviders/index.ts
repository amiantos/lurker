// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The driver registry. Each driver is a small module conforming to UploadDriver
// (see types.ts). The old thin `UploadProvider` + `secretsForProvider` switch is
// gone: the secret/non-secret split now derives from each driver's configSchema,
// so there's no three-places coupling to keep in sync.

import * as x0 from './x0.js';
import * as catbox from './catbox.js';
import * as hoarder from './hoarder.js';
import * as local from './local.js';
import * as zipline from './zipline.js';
import * as chibisafe from './chibisafe.js';
import * as s3 from './s3.js';
import type { UploadDriver } from './types.js';

export type {
  ContentClass,
  ConfigField,
  DriverCapabilities,
  UploadMeta,
  UploadResult,
  UploadDriver,
} from './types.js';

const DRIVERS: Record<string, UploadDriver> = {
  [x0.driver]: x0,
  [catbox.driver]: catbox,
  [hoarder.driver]: hoarder,
  [local.driver]: local,
  [zipline.driver]: zipline,
  [chibisafe.driver]: chibisafe,
  [s3.driver]: s3,
};

export const driverIds = Object.keys(DRIVERS);

export function getDriver(id: string): UploadDriver | null {
  return DRIVERS[id] ?? null;
}

/**
 * Split a flat config object into its non-secret and secret halves per a
 * driver's schema. Unknown keys are dropped (schema is the allowlist). Used on
 * write (uploaderConfig) so `config_json` never holds a secret and `secrets_enc`
 * never holds a non-secret.
 */
export function splitConfigBySchema(
  driver: UploadDriver,
  values: Record<string, string>,
): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of driver.configSchema) {
    const v = values[field.key];
    if (v == null) continue;
    if (field.type === 'secret') secrets[field.key] = v;
    else config[field.key] = v;
  }
  return { config, secrets };
}
