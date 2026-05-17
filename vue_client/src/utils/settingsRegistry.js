// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

// Client-side wrapper around the shared settings registry. Re-exports the
// data + shared helpers and adds getDefault(), the lookup pattern the
// Settings UI uses to seed inputs before the user-saved values arrive.

import {
  REGISTRY,
  getOption,
  defaultsAsObject,
  CATEGORIES,
  GROUPS,
} from '../../../shared/settingsRegistry.js';

export { REGISTRY, getOption, defaultsAsObject, CATEGORIES, GROUPS };

export function getDefault(key) {
  const opt = getOption(key);
  return opt ? opt.default : undefined;
}
