// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// The client's test project. Separate from vite.config.ts (the dev-server/build
// config, which carries mkcert and proxy settings tests have no use for) and
// from the root config, which owns the server suite.
//
// It has to live here, not at the root: vue_client is its own npm package with
// its own node_modules, so `vue` and @vitejs/plugin-vue only resolve from inside
// it. Running the client suite as a root-level project would either fail to
// resolve the SFC compiler or load a second copy of Vue.
//
// This is what was missing. Until component tests existed every client test was
// plain TS — stores, pure utils — so nothing imported a .vue file and nobody
// noticed the SFC compiler was never wired into the test run. That's the gap two
// Tab-completion bugs shipped through: neither was reachable from a unit test of
// the candidate builders, because both only manifested in response to a key event.
export default defineConfig({
  plugins: [vue()],
  test: {
    name: 'client',
    include: ['src/**/*.test.ts'],
    // Node stays the default — the store and pure-util suites are the bulk of
    // this project and don't want a DOM. Component tests opt in per-file with a
    // `// @vitest-environment happy-dom` docblock.
    environment: 'node',
  },
});
