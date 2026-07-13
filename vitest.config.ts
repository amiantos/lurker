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
          // Catch-all, minus the client — deliberately not a list of the
          // directories that happen to hold tests today. A project that includes
          // only known paths doesn't *skip* a test file added outside them, it
          // never collects it, and the run still reports all-green. Everything
          // that isn't the client's belongs to this project.
          include: ['**/*.{test,spec}.ts'],
          exclude: ['**/node_modules/**', 'vue_client/**'],
          environment: 'node',
        },
      },
      './vue_client/vitest.config.ts',
    ],
  },
});
