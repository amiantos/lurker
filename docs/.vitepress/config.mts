// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitepress';

// Lurker documentation site. The VitePress root is the repo's `docs/` folder,
// so the existing self-hosting markdown stays valid GitHub-rendered docs AND
// becomes site pages — no moved files, no duplication. Internal-only docs are
// kept out of the public build via `srcExclude`.
export default defineConfig({
  title: 'Lurker',
  description: 'The Lurker manual — using, self-hosting, and extending your always-on IRC client.',
  cleanUrls: true,
  lastUpdated: true,
  // Dead-link checking stays ON (it guards the guide pages). These two patterns
  // exempt links in the existing self-hosting docs that are written for someone
  // browsing the repo on GitHub, not the built site: dev-server URLs, and
  // repo-relative links to non-doc files (deploy scripts, integrations/).
  ignoreDeadLinks: [/^https?:\/\/localhost/, /\.\.\/(deploy|integrations)\//],
  // Internal references and the deploy runbook stay GitHub-only, not public pages.
  srcExclude: ['DESIGN_TOKENS.md', 'DEPLOY.md'],
  head: [['link', { rel: 'icon', href: '/assets/lurker-icon.png' }]],
  themeConfig: {
    logo: '/assets/lurker-icon.png',
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Self-Hosting', link: '/SELF_HOSTING' },
      { text: 'App', link: 'https://app.lurker.chat' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'User Guide',
          items: [
            { text: 'What is Lurker?', link: '/guide/' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'The Interface', link: '/guide/interface' },
            { text: 'Slash Commands', link: '/guide/slash-commands' },
            { text: 'Notifications', link: '/guide/notifications' },
            { text: 'Encryption (E2E)', link: '/guide/encryption' },
          ],
        },
      ],
      '/': [
        {
          text: 'Self-Hosting & Operations',
          items: [
            { text: 'Self-Hosting Lurker', link: '/SELF_HOSTING' },
            { text: 'Deploy on DigitalOcean', link: '/digitalocean' },
          ],
        },
        {
          text: 'Developers',
          items: [
            { text: 'Client Protocol & API', link: '/CLIENT_PROTOCOL' },
            { text: 'MCP & HTTP API', link: '/MCP' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/amiantos/lurker' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/amiantos/lurker/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MPL-2.0 License.',
      copyright: 'Copyright © 2026 Brad Root',
    },
  },
});
