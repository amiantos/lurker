<h1>
  <img src="lurker-icon.png" alt="" width="48" height="48" align="top">&nbsp;&nbsp;Lurker
</h1>

Lurker is a self-hosted modern IRC client with a retro flair, most easily described as "your personal [IRCCloud](https://www.irccloud.com), with [Weechat](https://weechat.org) looks".

Lurker runs as an always-on server that stays connected to IRC on your behalf, keeps full message history, and lets you reattach from any browser — desktop or mobile — picking up exactly where you left off. Open it on as many devices and tabs as you like; read state, settings, and history stay in sync everywhere; when all clients are disconnected, auto-away sets your status, and web push notifications inform you of highlights. Oh, and the icon rules.

⚠️ *This project is under heavy development and some screens are not fully polished!* View the [project kanban](https://kanban.bradroot.me/projects/12/45#share-auth-token=heTq3lrceDTKVlNYHKTH6MPaDqA2pJowusiqETTL) to see what's coming soon. 

# Features
- **Always-on and multi-user.** Each invited user connects to their own set of IRC networks, and Lurker stays connected when they're away.
- **Full history and search.** Every message is stored *and* searchable. Auto-away triggers after your last client disconnects, and smart push notifications fire on highlights.
- **Modern IRC.** Peer presence, automatic nick regain, join/part summarization, tab nickname completion, and a searchable channel browser w/ cache.
- **Image uploads.** Paste, drag, or pick an image; Lurker optimizes it, uploads it to [x0.at](https://x0.at) or [catbox.moe](https://catbox.moe), inserts the link into your message, and keeps a history of all your uploads.
- **Customizable UI.** The beautiful retro terminal-style interface has 40+ settings to customize it how you want, and you can freely pin and rearrange channels and DMs.
- **Installable.** Lurker is a PWA — install it as a native-feeling app on your phone, Mac, or PC straight from the browser.

# Screenshot (as macOS PWA)

<img src="screenshot.png" alt="Lurker IRC client screenshot" width="100%">

# Rave Reviews

- `<cfuser> amiantos: holy shit, you made something better than irccloud`
- `<amigojapan> great, now that amiantos's chat client is catching up to IRC cloud, I think I can switch to it as my daily driver`

# Installation

## Install (Docker — Recommended)
```
cp .env.example .env # set this up
docker-compose up --detach
```

## Manual Install
```
cp .env.example .env # set this up
npm install
npm run client:build
npm start
```

# Stack
- **Server** — Express, `irc-framework`, `ws`, `better-sqlite3`, `sharp`, `web-push`
- **Client** — Vue 3, Vite, Pinia, `vue-router`

## Development
```
npm run install:all
cp .env.example .env   # edit SESSION_SECRET; defaults assume the local hostname below
npm run dev
```

# Community

- Chat in **#lurker** on [Libera.Chat](https://libera.chat).
- Follow what's planned and in progress on the [project kanban](https://kanban.bradroot.me/projects/12/45#share-auth-token=heTq3lrceDTKVlNYHKTH6MPaDqA2pJowusiqETTL).
- Say hi — I'm **amiantos** on Libera.Chat and [MansionNET](https://inthemansion.com).

# License
Elastic License 2.0 — see [LICENSE](LICENSE). Source-available: you can use, copy, modify, and redistribute it, but you may not offer it to third parties as a hosted or managed service.

If you are a cloud hosting provider and wish to offer managed hosting for Lurker to your customers, or charge users for access to your Lurker instance, please contact [Brad Root](mailto:bradroot@me.com).
