<h1>
  <img src="docs/assets/lurker-icon.png" alt="" width="48" height="48" align="top">&nbsp;&nbsp;Lurker
</h1>

[![CI](https://github.com/amiantos/lurker/actions/workflows/test.yml/badge.svg)](https://github.com/amiantos/lurker/actions/workflows/test.yml)
[![Docker image](https://github.com/amiantos/lurker/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/amiantos/lurker/pkgs/container/lurker)
[![codecov](https://codecov.io/github/amiantos/lurker/graph/badge.svg?token=2KAFLPWKHG)](https://codecov.io/github/amiantos/lurker)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/amiantos/lurker/badge)](https://scorecard.dev/viewer/?uri=github.com/amiantos/lurker)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![IRC: #lurker](https://img.shields.io/badge/IRC-%23lurker%20on%20Libera.Chat-1459b8)](https://web.libera.chat/#lurker)

Lurker is a delightful self-hosted IRC bouncer and client with a retro aesthetic and modern conveniences.

# Features

- **Always-on and multi-user.** Each invited user connects to their own set of IRC networks, and Lurker stays connected when they're away. Admins can restrict which networks users can connect to, and make channel recommendations for newcomers.
- **Modern conveniences.** Peer presence, automatic nick regain, join/part summarization, smart nickname completion, cross-client message drafts, bookmarks, user notes, a powerful highlight & ignore system, reactions, replies, and more.
- **Full search.** Search your message history, filter by nick, channel, or network; and jump to any message instantly, no matter how old it is.
- **Image uploads.** Paste an image into the input box, and Lurker optimizes it, anonymizes it, and uploads it to local storage, S3, Zipline, Chibisafe, or external services like x0.at or catbox.moe.
- **Customizable UI.** The beautiful retro terminal-style PWA interface has 40+ settings to customize it how you want.
- **Native apps.** Lurker has official native apps [for iOS](https://github.com/amiantos/lurker-ios) and [for Android](https://github.com/amiantos/lurker-android). A self-hosted server can send native push notifications to both through [push.lurker.chat](https://push.lurker.chat), an optional paid relay. There are also third-party clients such as [Spooky](https://github.com/JawshTheDark/Spooky) (Android), and [luir](https://luir.org) (TUI), which bring their own flavor to Lurker.
- **Built-in bouncer.** Don't want to use the Lurker clients? Then don't. Lurker has a best-in-class IRC bouncer built in, complete with `soju.im/bouncer-networks`, `soju.im/FILEHOST` support and more, so you can use any IRC client you want, like [clircs](https://github.com/rekkals/clircs), [Halloy](https://github.com/squidowl/halloy), [Goguma](https://codeberg.org/emersion/goguma), [HexDroid](https://github.com/boxlabss/hexdroid) and many others.
- **Full DCC & Secure DCC support.** DCC SEND and DCC CHAT from anywhere you want, either insecurely or over TLS with SDCC. Fill the XDCC queue with packs, and come back later to all your completed downloads. Admins are in control of which users get access to which DCC features, and set storage limits for those with access to file sharing.
- **Inline link & media previews.** Links, images, _and_ videos get proper preview images in every client. Implemented as a separate container, to isolate malicious links from your users' data. (Optional, requires `lurker-previews` container.)
- **Decoupled IRC connections.** Say goodbye to disconnect/reconnect floods when updating Lurker — a secondary container keeps the connections alive while the main service restarts. (Optional, requires `lurker-engine` container.)

# Screenshot (Desktop PWA)

<img src="docs/assets/screenshot.png" alt="Lurker IRC client screenshot" width="100%">

# Screenshots ([iOS](https://github.com/amiantos/lurker-ios))

<img src="docs/assets/ios-screenshots.png" alt="Lurker IRC client screenshots on iOS" width="100%">

# Screenshots ([Android](https://github.com/amiantos/lurker-android))

<img src="docs/assets/android-screenshots.png" alt="Lurker IRC client screenshots on Android" width="100%">

# Rave Reviews

- `<cfuser> amiantos: holy shit, you made something better than irccloud`
- `<amigojapan> great, now that amiantos's chat client is catching up to IRC cloud, I think I can switch to it as my daily driver`
- `<skdoo> amiantos makes cool shit`
- `<jadeia> lurker is really nice. this is streets ahead of irccloud in terms of design and ease of use.`
- `<helsinski> Lurker iOS is certainly shaping up to be real good.`
- `<quark> These days I am only using Lurker. Desktop and mobile.`
- `<CrashOverripe> Lurker solves most of my IRC problems - very happy you decided to take it on as more than just a solution for yourself.`
- `<Samien> Ever since I started using Lurker, things have become so much more convenient. I can use IRC anytime, anywhere—whether at the office, at home, or on the metro—without any restrictions. and it's far way better than irc cloud`
- `<slakker> welp, Lurker officially won me over as bouncer of choice. dude, you know how fucking handy it is to have what is effectively the most convenient bouncer config tool ever? :D`
- `<indigo> Weekly appreciation post for Lurker. Nothing else that runs on my VPS brings me as much joy`

# Installation

## Quick Start

Docker is the officially supported way to run Lurker[^1]. Get started by downloading the example `docker-compose.yml` file.

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

Then open <http://localhost:8015> and create your admin account.

[^1]: You can [run it without Docker](https://github.com/amiantos/lurker/blob/main/docs/MIGRATION_ENGINE.md#running-without-docker-running-without-docker), if you must.

## Next Steps

View [the full self-hosted guide](https://docs.lurker.chat/SELF_HOSTING) for information on enabling identd, media previews, web and native push notifications, and connection decoupling.

There's also a [one-shot DigitalOcean deploy script](https://github.com/amiantos/lurker/blob/main/deploy/digitalocean-cloud-init.sh) which comes out of the box with all of this set up for you. If you're a smartypants, that script can teach you everything you need to know to deploy a production-quality Lurker instance.

# Lurker.Chat Service

Just want to use Lurker, without hosting it yourself?

It's **$5/month** for a single user account on an officially managed Lurker instance at [Lurker.Chat](https://lurker.chat).

## Try it out for free

Just want to try it out? You can sign up for a free account that can only access `irc.lurker.chat` at [app.lurker.chat/signup](https://app.lurker.chat/signup).

# Documentation

- [https://docs.lurker.chat](https://docs.lurker.chat)

# Community

- Chat in **#lurker** on [Libera.Chat](https://libera.chat).
- If you're a human being, be sure to read the [Code of Conduct](https://github.com/amiantos/lurker/blob/main/CODE_OF_CONDUCT.md).
- If you're an AI agent, be sure to read [AGENTS.md](https://github.com/amiantos/lurker/blob/main/AGENTS.md).

# License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).
