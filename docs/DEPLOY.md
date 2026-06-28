# Deploying the docs site

The Lurker docs are a [VitePress](https://vitepress.dev) site living in this
`docs/` folder. They build to static files and are served from Cloudflare at
**docs.lurker.chat**, mirroring how the marketing site is deployed.

This file is operator notes — it is excluded from the published site.

## Local development

```sh
# from the repo root
npm run docs:dev      # live-reloading dev server
npm run docs:build    # production build → docs/.vitepress/dist
npm run preview --prefix docs   # preview the built site
```

First run needs deps: `npm install --prefix docs` (or `npm run install:all`).

## One-time Cloudflare setup (operator)

Use **Cloudflare Workers Builds** (Git integration), the same model as
`lurker-marketing`:

1. Create a Worker connected to the `amiantos/lurker` repo.
2. **Root directory:** `docs`
3. **Build command:** `npm ci && npm run build`
4. **Deploy command:** `npx wrangler deploy` (reads `docs/wrangler.jsonc`,
   serving `.vitepress/dist`).
5. Add a custom domain / route for **docs.lurker.chat** and point DNS at the
   Worker.

After that, every push to `main` that touches `docs/**` rebuilds and redeploys.

## CI

`.github/workflows/docs.yml` builds the site on every PR that touches `docs/**`,
so broken links or build errors are caught before merge. It does not deploy —
Cloudflare owns deployment.

## Follow-ups

- Tighten a `Content-Security-Policy` in `public/_headers` (needs testing
  against VitePress's same-origin JS).
- Phase 3: generate the slash-command reference from the app's command
  definitions so it can't drift.
