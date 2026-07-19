// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import mkcert from 'vite-plugin-mkcert';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBase = env.VITE_API_BASE || 'http://localhost:8010';
  // WebAuthn requires HTTPS for any non-localhost hostname. mkcert generates a
  // locally-trusted cert so the dev hostname (mapped to 127.0.0.1 in /etc/hosts)
  // works without browser warnings.
  const host = env.VITE_DEV_HOST || 'irc.local.bradroot.me';
  // Opt-in LAN mode for testing on a phone: `VITE_LAN_HOST=Xerxes.local npm
  // run dev` binds to 0.0.0.0 over plain HTTP, skipping mkcert so the device
  // doesn't need to trust a local CA. Password login still works; WebAuthn
  // and Service Worker / push features do not (they require a secure context).
  const lanHost = env.VITE_LAN_HOST;
  // mkcert is dev-server-only HTTPS tooling — it has no business loading under
  // vitest, and historically its native cert generation could crash the test
  // process when the config was resolved from inside vue_client/. Vitest sets
  // VITEST=true before resolving the config, so skip the plugin then; tests
  // never need a cert.
  const underTest = !!process.env.VITEST;

  return {
    plugins: lanHost || underTest ? [vue()] : [vue(), mkcert()],
    // Build-time constant so the About panel can show the app version without
    // an API round-trip.
    define: {
      APP_VERSION: JSON.stringify(pkg.version),
    },
    server: {
      host: lanHost ? true : host,
      port: 5173,
      allowedHosts: lanHost ? true : undefined,
      // Allow imports from the repo root (one level up from vue_client/),
      // so client code can import the shared settings registry directly
      // instead of maintaining a mirrored copy.
      fs: {
        allow: ['..'],
      },
      proxy: {
        '/api': {
          target: apiBase,
          changeOrigin: true,
        },
        // The local-disk uploader serves files from the backend at /uploads
        // (and the legacy /uploads/local alias, which this prefix also covers).
        // Proxy it so a PUBLIC_BASE_URL pointed at the dev origin (5173) resolves
        // pasted upload links through here instead of hitting the SPA fallback.
        '/uploads': {
          target: apiBase,
          changeOrigin: true,
        },
        '/ws': {
          target: apiBase.replace(/^http/, 'ws'),
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
