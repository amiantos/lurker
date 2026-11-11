# AGENTS.md

Guidance for AI coding agents (and the humans driving them) contributing to
Lurker. If you're a person, [`README.md`](README.md) is the friendlier intro;
this file is the fast, dense orientation an agent needs to make a correct change
and open a clean PR. Everything here is enforced by CI or by review — following
it is the difference between a merge and a round of change requests.

Lurker is a self-hosted IRC client: an always-on Node server that stays
connected to IRC and keeps full history, a Vue 3 web UI that reattaches from any
browser, a built-in bouncer for other IRC clients, and native iOS and Android
apps that live in their own repos. License is **MPL-2.0** throughout.

Please note that while Lurker is an LLM/Agent friendly project, the project is
under the direction of Brad Root (amiantos), and just because a feature
can be added, does not mean it will be accepted. Lurker is deliberately lo-fi
in many ways, despite the feature set being very modern. So, before you
commit yourself to working on something that excites you in Lurker, be sure to
have a discussion with amiantos in the #lurker IRC channel on Libera.Chat to
make sure it fits the project ethos.

It should also be assumed most GitHub issues are 'assigned' by default to amiantos.
If you wish to work on an issue, be sure to ask him about it in the channel first,
to avoid potentially wasted time. Also note that while I have been saying 'you'
in the last two paragraphs, you should probably let your operator handle the
talking, unless they really would want you to sign onto IRC to try to talk to amiantos
directly. Please let him know you're an agent up-front just to be nice.

## Repository layout

```
server/            TypeScript on Node, run via tsx (no build step)
  server.ts        Process lifecycle: HTTP server, WS hub, IRC manager, identd
  app.ts           Express app construction + route wiring (edition-gated)
  protocol.ts      WS/REST protocol version + compatibility contract for every
                   client (web, iOS, Android) — see docs/CLIENT_PROTOCOL.md
  engine.ts        Entry point of the IRC engine, a SEPARATE process (below)
  engine/          The engine: config, line buffer, wire protocol, upstream
                   dial, topology; version.ts carries a hand-set ENGINE_VERSION
  routes/          One Express router per resource (auth, networks, uploads…)
  services/        IRC manager + connection, WS hub, image pipeline, identd,
                   MCP server, push (web push, APNs, FCM, relay), DCC, bouncer,
                   link-preview client, upload providers
  services/verbs/  Shared ACTION registry (sendMessage, searchMessages, …)
                   consumed by BOTH the WS command path and the MCP server
  db/              better-sqlite3 data access, one module per table
  db/index.ts      The single DB connection + schema migrations
  db/casemapping.ts  Per-network IRC case folding (see gotchas)
  middleware/      auth (session cookie), apiAuth (bearer token), nodeAuth
  utils/           small helpers (edition, ident, secretCrypto, username…)
  types/           ambient *.d.ts shims for untyped deps
  test-utils/      testApp.ts (integration harness), fakeIrcd.ts, the bouncer
                   and engine harnesses, isolateDb.ts
shared/            Code imported by BOTH server and client: settingsRegistry.ts
                   (every user setting), channels.ts (what is a channel), modes,
                   wireBudget, replies, reactions, themePresets, the ignore /
                   highlight / relay parsers, proxy, uploadKinds, wsCloseCodes…
vue_client/        Vue 3 + Vite + Pinia + vue-router SPA
  src/stores/      Pinia stores, one per domain (buffers, auth, settings…)
  src/components/  Vue components (+ settings-panes/, admin-panes/)
  src/composables/ useSocket, useBufferRoute, useContextMenu, …
  src/views/       Login, Chat (Desktop/Mobile), Settings, Admin, InviteAccept,
                   AccountRecovery, OAuthAuthorize
  src/lib/         framework-free logic: commands/ (slash-command parsers),
                   bufferLifecycle, historyPaging, virtualBuffers
docs/              VitePress site (docs.lurker.chat): SELF_HOSTING, DEPLOY,
                   CLIENT_PROTOCOL, IRCV3, MCP, OAUTH, DESIGN_TOKENS, the
                   MIGRATION_* guides, and guide/ (user manual chapters)
tools/             engine-closure.mjs (what "the engine" is, used by CI),
                   fold-buffer-case, recovery-link, gen-emoji-data,
                   manual-install-qa
deploy/            operator deploy scripts (not needed for app dev)
integrations/      autonotes
```

Tests live **next to the code** they cover as `*.test.ts`.

## Setup & dev

- **Node 24** (current LTS) — matches CI and the Docker runtime. `better-sqlite3`
  and `sharp` are native, so stay on 24 to avoid ABI surprises. Track the LTS
  line: odd-numbered majors never become LTS and go EOL within months.
- `npm run install:all` — installs root, `vue_client/` **and** `docs/` deps.
- `cp .env.example .env` — defaults are documented inline.
- `npm run dev` — runs server + client concurrently.
  - ⚠️ The server **auto-connects (by default) on boot to whatever IRC networks are
    in its database**. Don't point a dev instance at networks you don't control, and
    don't assume "the server is running" is a safe way to test — prefer the
    typecheck/lint/test gate below, which needs no live IRC.

## The CI gate — run before every PR

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs these on
every PR to `main`, and **all must pass**:

| Command                    | What it is                         |
| -------------------------- | ---------------------------------- |
| `npm run typecheck`        | server type-check (`tsc`, no emit) |
| `npm run typecheck:client` | client type-check (`vue-tsc`)      |
| `npm run lint`             | **oxlint**                         |
| `npm run format:check`     | **oxfmt**                          |
| `npm test`                 | **Vitest**                         |

`npm run check` bundles the first four. Run it plus `npm test` and you've
reproduced the gate locally.

Two things CI does **not** run on a PR, and that have both broken `main` after a
green gate — run them yourself when your change touches them:

- `npm run client:build` whenever you touched a `.vue` or client CSS file. An
  unused import in a `.vue` file passes `vue-tsc` and fails only here, and a
  nested `&:hover` inside a `:hover` rule hangs the build at 100% CPU with no
  error (so a build that never finishes is a finding, not a slow machine).
- `npm run docs:build` whenever you touched `docs/`. The site builds on push to
  `main`; a bad code span or a colon in frontmatter breaks it after merge.

## Code style & conventions

- **Formatter is `oxfmt`, NOT Prettier.** Run `npm run format`. Do **not** run
  Prettier or ESLint — they fight oxfmt's house style (single quotes, 100-col
  width) and will make `format:check` fail. Linter is `oxlint`.
- **ESM with `.js` import specifiers.** The project is `"type": "module"` with
  `verbatimModuleSyntax`. Import sibling TypeScript files using a `.js`
  extension even though the file on disk is `.ts`:
  ```ts
  import { createUser } from '../db/users.js'; // file is users.ts
  ```
  Omitting the extension, or writing `.ts`, breaks module resolution.
- **`import type` for type-only imports** — required by `verbatimModuleSyntax`.
- **TypeScript `strict` is on** (plus `noImplicitOverride`,
  `noFallthroughCasesInSwitch`). Nothing is compiled by `tsc`: `tsx` runs the
  server, Vite builds the client — `tsc`/`vue-tsc` are type-checkers only.
- **Unused vars:** prefix with `_` to silence the lint rule.
- **License header on every new source file.** MPL-2.0, with the comment syntax
  of the file type:
  ```ts
  // Copyright (c) 2026 Brad Root
  // SPDX-License-Identifier: MPL-2.0
  ```
  (`<!-- … -->` for HTML, `/* … */` for CSS.) The whole tree is MPL-2.0 — no
  other SPDX identifier should appear.
- **Match the surrounding code.** Mirror the existing naming, comment density,
  and idiom of the file you're editing rather than importing your own style.

## Testing

- **Vitest**, tests colocated as `*.test.ts`.
- **Prefer integration tests over unit tests** for routes and services: drive
  the real Express router against a real (temporary) SQLite DB rather than
  mocking. The harness is [`server/test-utils/testApp.ts`](server/test-utils/testApp.ts):
  ```ts
  import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';
  setupTestDb(); // MUST be at module top level, before any db import
  // …in beforeAll: createTestApp({ '/api/foo': fooRouter }), createAuthedAgent(app, user.id)
  ```
  Reserve plain unit tests for genuinely tricky pure logic (parsers, mask
  matching, message splitting).
- **IRC behaviour is tested against `server/test-utils/fakeIrcd.ts`**, a scripted
  ircd, never a real network. Note it never tags numerics with `@time`/`msgid`.
- **Never point tests at `data/`.** `setupTestDb()` creates a throwaway temp DB
  per test file; lean on it. Don't read or write the real `data/` directory.
- **Fixed test ports must be below 32768.** Linux's ephemeral range starts there
  (macOS's at 49152), so a port that is free on a Mac collides with CI's
  parallel runs.

## Architecture notes & gotchas

These are the non-obvious constraints that have bitten changes before:

- **One shared SQLite connection.** `server/db/index.ts` opens a single
  better-sqlite3 connection (WAL, `synchronous=NORMAL`, `busy_timeout=5s`). The
  migrations at module load run under two minutes, and the module ends by
  draining the WAL with passive checkpoints, so a post-migration Litestream
  checkpoint never holds the write lock against the first writers (#748). A
  boot-phase transaction that reads before it writes must be `.immediate()`.
  better-sqlite3 is **synchronous** — long queries block the event loop that
  also serves WebSocket fan-out and IRC sockets. **Do not hold a long-lived
  `.iterate()` streaming cursor:** a streamed read open across concurrent writes
  throws `database connection is busy` and crashes the process. Read large sets
  with keyset pagination — `WHERE id > ? ORDER BY id LIMIT N`, a discrete
  `.all()` per page, yielding with `setImmediate` between pages.
- **Message search runs in its own process.** `services/searchRunner.ts` forks
  `server/searchProcess.ts`, which runs one search statement at a time on a
  read-only connection; a search whose request was abandoned, or that runs past
  the time limit, is ended by killing that process. A process and not a worker
  thread because nothing can interrupt a running better-sqlite3 call
  (`worker.terminate()` waits for it). The server builds the statement (that is
  the access boundary) and maps the rows; keep `searchProcess.ts` free of app
  imports so it starts in milliseconds. New read paths that can walk a large
  part of `messages` belong there too, not on the shared connection.
- **A better-sqlite3 transaction commits on `return`.** Only a `throw` rolls
  back. An early `return` on a validation failure inside `db.transaction(fn)`
  commits everything written before it.
- **No `worker_threads`.** Historically, under `tsx` the `.js`→`.ts` loader did
  not propagate into worker threads, so a TS worker entry failed with
  `Cannot find module` at runtime even though it type-checked. ⚠ A minimal repro
  no longer reproduces this on Node 24 with current tsx, so re-establish the
  failure before relying on this note in either direction. The guidance stands
  regardless: use in-process `setImmediate` chunking for heavy work, which also
  avoids holding a long-lived cursor on the shared SQLite connection (#175).
- **The IRC engine is a separate process that holds the sockets.** With
  `LURKER_ENGINE_URL` set, IRC connections live in `lurker-engine`
  (`server/engine/`, `docker-compose.engine.yml`,
  [`docs/MIGRATION_ENGINE.md`](docs/MIGRATION_ENGINE.md)) and survive app
  restarts. Three rules follow. (1) The engine is a reflex or a relay, **never a
  second writer** of IRC state: it answers PING and records the registration
  burst, and everything with intent (AWAY, JOIN, modes) stays in the app. (2)
  Anything in the engine's import closure (`node tools/engine-closure.mjs files`,
  which includes parts of `shared/` and irc-framework itself) ships as the
  `engine-1` image, and recreating that image drops every held IRC connection on
  every install — batch such changes, and bump `ENGINE_VERSION` in
  `server/engine/version.ts` by hand to the release that moves it or
  `docker-publish` fails. (3) Any IRC-side change must work both with and
  without the engine; the engine harness in `test-utils/` covers the former.
- **A channel is `#`, `&`, `+` or `!` — never just `#`.** Testing for `#` alone
  is the most-repeated bug in the project. Use `isChannelTarget` and
  `stripChannelPrefix` from [`shared/channels.ts`](shared/channels.ts); never
  write a per-call-site prefix test. A _typed_ `#` (a completion trigger, a URL
  fragment) is a literal character and stays `#`.
- **Fold IRC target case per network when matching buffers.** Servers send
  channel and nick names with inconsistent casing, and the fold depends on the
  network's `CASEMAPPING` (`rfc1459` folds `[]\~` to `{}|^`). Never look a
  buffer up by exact key, and never fold with a bare `toLowerCase`: on the
  server use `foldTargetFor(networkId, raw)` /
  `foldTargetWith(mapping, target)` from `server/db/`; on the client use the
  buffers store's `findByTarget` / `findDm`.
- **A default is not a statement.** A missing field that parses to its zero
  value is not the server stating that value. Gate on a presence flag set when
  the field was actually received, not on the value, and not on a neighbouring
  flag that feels equivalent.
- **irc-framework middleware swallows exceptions.** `client.use()` runs each
  middleware inside a `try` that forwards errors to `next`, so a gate placed
  there hides the throw you were testing for. Gate at event registration
  instead.
- **The image pipeline is server-side (`sharp`), not browser canvas** — and it
  **must preserve animation**: never re-encode GIF / animated WebP / APNG.
- **Cross-device features belong on the server.** Presence, read-state sync,
  notifications, away state — anything that must stay consistent across a user's
  tabs and devices lives in the server + WS fan-out, not client-only state.
  (Render-time _display_ filters can be client-side.)
- **Settings are registry-driven.** Add new user settings to
  [`shared/settingsRegistry.ts`](shared/settingsRegistry.ts) (data-only, imported
  by both sides) — don't scatter setting definitions across server and client.
- **Lurker-run services are admin opt-in.** A self-hosted server and its apps
  contact push.lurker.chat (and anything like it later) only while the admin has
  turned it on; the server advertises the service (`relay` in
  `GET /api/push/config`) and enforces the switch on every path. The contact
  itself is the leak, so "the service refuses unpaid instances" is not enough.
- **Two editions.** `LURKER_EDITION` defaults to `standalone` (normal
  self-hosting). `node` is the managed-hosting "cell" edition, gated by operator
  env (orchestrator URL, fleet secret, forced uploader) and isolated in
  `server/app.ts`. Almost all contributions target standalone; you don't need
  any node config to develop. Just don't break the standalone path when touching
  edition-gated surfaces. The bouncer and DCC are standalone features; hosted
  cells don't offer them.
- **The protocol is versioned for the native apps.** `server/protocol.ts` and
  [`docs/CLIENT_PROTOCOL.md`](docs/CLIENT_PROTOCOL.md) are the contract the iOS
  and Android apps build against, and the policy is additive-only: add a field
  or a frame kind and deprecate the old one, never repurpose an existing field's
  meaning or type, and never treat an unknown frame or field as fatal on either
  side. `PROTOCOL_VERSION` bumps only for a change that rule cannot express,
  which is effectively never. The doc moves with every addition.

## UI / design conventions

- **One font size across the entire UI.** Never set `font-size` (sole
  exceptions: `clamp()` on a hero/brand title, and icon sizing through the
  `--icon-*` tokens). Build hierarchy with color, weight, spacing, and layout
  instead.
- **Use design tokens, don't hardcode.** Two tiers (themeable vs internal) —
  spacing scale, z-index ladder, radius, and scrim live in
  `vue_client/src/assets/main.css`. See [`docs/DESIGN_TOKENS.md`](docs/DESIGN_TOKENS.md).
- **Slash commands first.** A feature a power user would reach for gets a
  `/command` (parsed in `vue_client/src/lib/commands/`, listed in `/commands`)
  before, or alongside, a button.

## Contributing & PRs

- Branch off `main` and open your PR against `main`. `main` is protected:
  requires a green CI run (typecheck server + client, lint, format, test) **and**
  a review before it can merge.
- Keep PRs focused on a single change; describe what and why.
- **Security issues:** do not open a public issue — see
  [`SECURITY.md`](SECURITY.md) for private reporting.
- Lurker can be driven programmatically over MCP / HTTP; the API is documented
  in [`docs/MCP.md`](docs/MCP.md).
