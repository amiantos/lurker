<h1>
  <img src="docs/assets/lurker-icon.png" alt="" width="48" height="48" align="top">&nbsp;&nbsp;Lurker
</h1>

[![CI](https://github.com/amiantos/lurker/actions/workflows/test.yml/badge.svg)](https://github.com/amiantos/lurker/actions/workflows/test.yml)
[![Docker image](https://github.com/amiantos/lurker/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/amiantos/lurker/pkgs/container/lurker)
[![codecov](https://codecov.io/github/amiantos/lurker/graph/badge.svg?token=2KAFLPWKHG)](https://codecov.io/github/amiantos/lurker)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/amiantos/lurker/badge)](https://scorecard.dev/viewer/?uri=github.com/amiantos/lurker)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![IRC: #lurker](https://img.shields.io/badge/IRC-%23lurker%20on%20Libera.Chat-1459b8)](https://web.libera.chat/#lurker)

Lurker is a beautiful self-hosted IRC client with a retro aesthetic and modern conveniences.

# Features

- **Always-on and multi-user.** Each invited user connects to their own set of IRC networks, and Lurker stays connected when they're away. Admins can restrict which networks users can connect to, and make channel recommendations for newcomers.
- **Fully working search.** Search your message history, filter by nick, channel, or network; and jump to any message instantly, no matter how old it is.
- **Modern conveniences.** Peer presence, automatic nick regain, join/part summarization, smart nickname completion, message drafts, saved messages, user notes, and more.
- **Image uploads.** Paste an image into the input box, and Lurker optimizes it, sanitizes it, and uploads it to local storage, S3, Zipline, Chibisafe, or external services like x0.at or catbox.moe.
- **Customizable UI.** The beautiful retro terminal-style PWA interface has 40+ settings to customize it how you want.
- **Native Apps.** Lurker has official native apps [for iOS](https://github.com/amiantos/lurker-ios) (in beta) and Android (coming soon). There's also third party clients like [Spooky](https://github.com/JawshTheDark/lurker-android-upstream) (Android), [Scully](https://github.com/JawshTheDark/scully) (GTK4), and [luir](https://luir.org) (TUI), which bring their own flavor to Lurker.
- **Built-in soju-compatible bouncer.** Don't want to use the Lurker clients? Then don't. Lurker has a ZNC and soju-compatible bouncer built in, complete with `soju.im/bouncer-networks` support so you can use any client you want.
- **Inline link & media previews.** Links, images, _and_ videos get proper preview images in every client. Implemented as a separate container, to isolate malicious links from your users' data. (Optional, requires `lurker-previews` container.)
- **Decoupled IRC connections.** Say goodbye to disconnect/reconnect floods when updating Lurker — a secondary container keeps the connections alive while the service restarts. (Optional, requires `lurker-engine` container.)

# Screenshot (PWA)

<img src="docs/assets/screenshot.png" alt="Lurker IRC client screenshot" width="100%">

# Screenshot (iOS)

<img src="docs/assets/ios-screenshots.png" alt="Lurker IRC client screenshot on iOS" width="100%">

# Rave Reviews

- `<cfuser> amiantos: holy shit, you made something better than irccloud`
- `<amigojapan> great, now that amiantos's chat client is catching up to IRC cloud, I think I can switch to it as my daily driver`
- `<skdoo> amiantos makes cool shit`
- `<jadeia> lurker is really nice. this is streets ahead of irccloud in terms of design and ease of use.`
- `<helsinski> Lurker iOS is certainly shaping up to be real good.`
- `<quark> These days I am only using Lurker. Desktop and mobile.`
- `<CrashOverripe> Lurker solves most of my IRC problems - very happy you decided to take it on as more than just a solution for yourself.`
- `<Samien> Ever since I started using [Lurker], things have become so much more convenient. I can use IRC anytime, anywhere—whether at the office, at home, or on the metro—without any restrictions. and it's far way better than irc cloud`

# Installation

## Quick Start

Docker is the officially supported way to run Lurker. Get started by downloading the example `docker-compose.yml` file.

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

Then open <http://localhost:8015> and create your admin account.

## Next Steps

View [the full self-hosted guide](https://docs.lurker.chat/SELF_HOSTING) for information on enabling identd, media previews, web push notifications, and connection decoupling.

There's also a [one-shot DigitalOcean deploy script](https://github.com/amiantos/lurker/blob/main/deploy/digitalocean-cloud-init.sh) which comes out of the box with all of this set up for you. If you're a smartypants, that script can teach you everything you need to know to deploy a production-quality Lurker instance.

# Lurker.Chat Service

Just want to use Lurker, without hosting it yourself?

It's **$5/month** for a single user account on an officially managed Lurker instance at [Lurker.Chat](https://lurker.chat).

# Documentation

- [https://docs.lurker.chat](https://docs.lurker.chat)

# Community

- Chat in **#lurker** on [Libera.Chat](https://libera.chat).
- If you're a human being, be sure to read the [Code of Conduct](https://github.com/amiantos/lurker/blob/main/CODE_OF_CONDUCT.md).
- If you're an AI agent, be sure to read [AGENTS.md](https://github.com/amiantos/lurker/blob/main/AGENTS.md).

# License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).
