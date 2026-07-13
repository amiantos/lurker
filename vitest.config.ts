// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitest/config';

// `npm test` runs from the repo root and covers two npm packages: the server
// here, and the Vue client in vue_client/ (which has its own package.json and
// node_modules). They're split into projects so the client's suite resolves its
// own dependencies — notably the SFC compiler, which only exists there. See
// vue_client/vitest.config.ts.
//
// Before component tests existed there was no config at all: every test was
// plain TS, vitest's defaults found them all, and nothing needed a Vue plugin.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['server/**/*.test.ts', 'shared/**/*.test.ts'],
          environment: 'node',
        },
      },
      './vue_client/vitest.config.ts',
    ],
  },
});
