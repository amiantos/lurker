# Self-Hosting Lurker

This guide walks through running your own Lurker server, from the first `docker compose up -d` through optional features like passkeys, push notifications, and exposing your instance to the internet over HTTPS.

If you just want the TL;DR, the [Quickstart](#quickstart) gets you a working instance on `http://localhost:8015` in two commands.

---

## Quickstart

You need Docker (with the Compose plugin). On a fresh machine:

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

That's it. Open <http://localhost:8015> in your browser and follow the first-run wizard to create your admin account (username + password). You're now connected to a Lurker server that will stay running across reboots; pair it with one or more IRC networks from the in-app settings.

All persistent state lives in a `./data/` directory next to your `docker-compose.yml` — back that up to back up Lurker.

## First-run wizard

The very first time you open the app it'll prompt you to create the initial admin user. You pick a username and a password (8+ characters). That user is automatically promoted to `admin`, which means they can:

- Invite additional users (each user gets their own IRC networks, history, and settings)
- Reset their own password from the settings panel
- Eventually manage the system from the admin panel

Lurker is multi-user — anyone you invite gets their own private set of networks. There is no public sign-up; new accounts can only be created through admin-issued invite links.

## Updating

```bash
docker compose pull
docker compose up -d
```

Run these from the directory holding your `docker-compose.yml`. If you used the [one-shot DigitalOcean deploy](digitalocean.md), that's `/opt/lurker` — `cd` there first; the command is identical whether or not you enabled HTTPS.

Lurker auto-migrates its SQLite schema on boot, so updates are a pull + restart. The `data/` directory is not touched.

If something goes wrong, your `data/` directory still has your last-known-good state — back it up before major updates if you want a clean rollback path.

## Backups

Everything Lurker persists lives in `./data/`:

- `lurker.db` (and `-shm`, `-wal` files) — IRC history, settings, users, etc.
- `session-secret.key` — the secret used to sign session cookies. Backing this up means existing browser sessions survive a restore.

A `cp -r data/ data-backup-$(date +%F)/` (with the server stopped, to avoid copying mid-write WAL files) is sufficient. If you need a hot copy, use the SQLite `.backup` command:

```bash
docker exec lurker sqlite3 /app/data/lurker.db ".backup '/app/data/lurker-snapshot.db'"
```

Then copy `data/lurker-snapshot.db` out.

---

## Exposing Lurker to the internet (recommended: Cloudflare Tunnel)

Lurker is a single-user-per-account always-on IRC client — most operators want to reach it from their phone or laptop while away from home. The simplest, most reliable way to do this is a **Cloudflare Tunnel** (`cloudflared`). You get:

- A public HTTPS URL on a domain you already own (terminated at Cloudflare's edge — no certificate management on your end)
- No port forwarding, no router configuration, no inbound firewall holes
- Works behind CGNAT, on a residential network, or anywhere with outbound HTTPS
- Free for personal use

> **Starting from a blank VPS?** If you don't already have a host, the [one-shot DigitalOcean deploy](digitalocean.md) brings up a fresh droplet with Lurker and automatic HTTPS (via Caddy) from a single pasted script — no SSH, no manual Docker install. The rest of this section covers exposing an instance you're already running.

### Setup

1. **Own a domain on Cloudflare.** You don't need to buy one through Cloudflare, but the DNS does need to be managed there. (Cloudflare's free plan is fine.)

2. **Create the tunnel** in the Cloudflare dashboard:
   - Go to **Zero Trust → Networks → Tunnels → Create a tunnel**, pick "Cloudflared", name it `lurker`, and copy the install command Cloudflare gives you. The command embeds a token tied to this tunnel.

3. **Add `cloudflared` to your `docker-compose.yml`** alongside Lurker:

   ```yaml
   services:
     lurker:
       # ... existing config ...

     cloudflared:
       image: cloudflare/cloudflared:latest
       container_name: lurker-tunnel
       restart: unless-stopped
       command: tunnel run
       environment:
         - TUNNEL_TOKEN=eyJ...your-token-here...
   ```

   Then `docker compose up -d`. The tunnel container will phone home to Cloudflare and stay connected.

4. **Route a hostname to Lurker.** Back in the Cloudflare dashboard, under your tunnel's "Public Hostname" tab, add:
   - **Subdomain**: `lurker` (or whatever you want)
   - **Domain**: pick one of your zones
   - **Service**: `http://lurker:8015` (the container talks to Lurker over Docker's internal network)

   Cloudflare provisions DNS automatically. Within a minute, `https://lurker.example.com` resolves and serves your Lurker instance over HTTPS.

5. **Update Lurker's environment** so passkeys and push notifications know about the public hostname (see [Optional features](#optional-features) below). At minimum, if you plan to enable passkeys:

   ```yaml
   environment:
     # ... existing config ...
     - WEBAUTHN_RP_ID=lurker.example.com
     - WEBAUTHN_RP_NAME=Lurker
     - WEBAUTHN_ORIGIN=https://lurker.example.com
   ```

   Then `docker compose up -d` to apply.

### Alternative: any reverse proxy

If you already run Caddy, Traefik, nginx, or another reverse proxy with an automatic-TLS story, point it at `http://localhost:8015` (or attach Lurker to your proxy network) and you're done. Lurker behaves like any other HTTP service — it doesn't need to know it's behind a proxy. The only thing it cares about for passkeys / push is that the public origin matches `WEBAUTHN_ORIGIN`.

---

## Optional features

### Passkeys (WebAuthn)

Lurker works fine with just username + password — passkeys are a quality-of-life addition (fingerprint / Face ID / hardware key login). (The [one-shot DigitalOcean deploy](digitalocean.md) sets these up for you.) To enable them elsewhere, set three environment variables that match the public origin your browsers actually hit:

```yaml
environment:
  - WEBAUTHN_RP_ID=lurker.example.com # hostname only, no scheme, no port
  - WEBAUTHN_RP_NAME=Lurker
  - WEBAUTHN_ORIGIN=https://lurker.example.com # full origin, scheme + port
```

`WEBAUTHN_ORIGIN` can be comma-separated if you log in from multiple URLs (e.g. a dev hostname and your public Cloudflare URL).

Restart Lurker, log in with your password, then visit **Settings → Passkeys** and register one. Passkeys require HTTPS for any non-localhost hostname — browsers won't allow the WebAuthn ceremony otherwise.

**Lost your passkey?** Just log in with your password and remove the dead passkey from the settings panel.

### Web Push notifications

Lurker supports background push notifications for highlights and DMs, delivered to your installed PWA even when the tab is closed. (The [one-shot DigitalOcean deploy](digitalocean.md) sets `VAPID_SUBJECT` for you.) To enable it elsewhere:

1. Set a valid `VAPID_SUBJECT` (the contact address embedded in outgoing push JWTs — APNs requires a real domain):

   ```yaml
   environment:
     - VAPID_SUBJECT=mailto:you@example.com
   ```

2. Restart Lurker. The first time the push service is used, it generates a VAPID keypair and stores it in `data/lurker.db` (under `app_meta`). The same keypair is reused on subsequent boots so existing subscriptions keep working.

3. From a browser (HTTPS required), open Lurker, "Install" it as a PWA, and enable notifications in the settings.

If you change `VAPID_SUBJECT` later, existing subscriptions continue to work — the subject only affects new push JWTs, not the keypair.

### File uploads on your own disk

By default, images you paste or drop into the message box are uploaded to a third-party host (x0.at). If you'd rather keep them on your own server, pick **local** in **Settings → Uploads**. Lurker then writes the file to disk and serves it back from your own instance, and the link it pastes into IRC points at you — no third party involved.

Files land in `uploads/` next to the SQLite database (so they're on your mounted volume and already covered by the [backup](#backups) advice above). Point them somewhere else with:

```yaml
environment:
  - LOCAL_UPLOADS_DIR=/data/uploads
```

The link Lurker pastes into IRC has to be an **absolute** URL, or nobody else can open it. Lurker works the origin out from the incoming request, which is right for most reverse-proxy setups. If your links come out with the wrong hostname or scheme, pin it explicitly:

```yaml
environment:
  - PUBLIC_BASE_URL=https://lurker.example.com
```

::: warning Cloudflare users: turn off Hotlink Protection
If you expose Lurker through Cloudflare (including a [Cloudflare Tunnel](#exposing-lurker-to-the-internet-recommended-cloudflare-tunnel)), **Hotlink Protection will break local uploads.** It's a Cloudflare feature that blocks image files whenever they're loaded from a page on another domain — which is exactly what an uploaded image _is_ once you share the link on IRC. Cloudflare returns a `403` at the edge and the request never reaches Lurker, so the image loads for you but is broken for everyone else.

Fix it in the Cloudflare dashboard under **Scrape Shield → Hotlink Protection → Off**. If you want to keep it on for the rest of your site, leave it enabled and add a **Configuration Rule** that turns it off just for your uploads:

- **When incoming requests match:** `URI Path` `starts with` `/uploads/local/`
- **Then the settings are:** `Hotlink Protection` → `Off`

See [Uploaded images are broken for other people](#uploaded-images-are-broken-for-other-people-403) if you've already hit this.
:::

### Secure cookies

Lurker's session cookies are **not** flagged `Secure` by default. This sounds wrong but is correct for the common self-hosted shapes:

- LAN / Tailscale / `*.local` hostnames over plain HTTP — browsers drop Secure cookies on non-localhost HTTP origins
- Cloudflare Tunnel, reverse proxies, etc. — the _browser_ sees HTTPS, but the container sees plain HTTP from the proxy, so even with TLS in front the cookie travels cleartext over Docker's internal network (which is fine — that traffic never leaves the host)

If you genuinely serve Lurker over end-to-end HTTPS (Express terminating TLS directly), set:

```yaml
environment:
  - COOKIE_SECURE=true
```

### Custom session secret

By default Lurker generates a random 64-byte secret on first boot and writes it to `data/session-secret.key` (mode `0600`). All session cookies are signed with it. If you'd rather supply your own (e.g. pulled from a secrets manager), set:

```yaml
environment:
  - SESSION_SECRET=replace-me-with-a-long-random-string
```

When set, the env var takes precedence and the file is ignored.

### Outbound contact info (User-Agent)

When Lurker talks to external services (image hosts, link previews, etc.) and replies to CTCP VERSION on IRC, it identifies itself with a User-Agent string. Set `USER_AGENT_CONTACT` to a `mailto:` or URL so the operators of those services can reach _you_ if your instance misbehaves:

```yaml
environment:
  - USER_AGENT_CONTACT=https://lurker.example.com
```

Unset, it falls back to the upstream project link.

### IRC bouncer (attach from other IRC clients)

Lurker can act as a bouncer (ZNC- and soju-compatible): enable the built-in IRC listener and any ordinary IRC client (WeeChat, irssi, Textual, HexChat, …) can attach to the same always-on connection your web UI uses — same nick, same channels, recent history replayed on attach, and anything you send from the client lands in your Lurker history and web tabs too. Detaching never disconnects you from IRC.

```yaml
environment:
  - LURKER_BOUNCER_ENABLED=true
  - LURKER_BOUNCER_PORT=6667 # remember to publish this port in docker-compose
```

Point your IRC client at the host/port with a **server password** of:

- `username:secret` — when you have one network configured
- `username/networkname:secret` — to pick one of several (the network's name as shown in the web UI, or its numeric id)

The secret can be your Lurker account password, but a **read-write API token** (web UI → **Settings → API tokens**) is the better choice — IRC clients store the server password in plaintext config files, and a token can be revoked without changing your password.

Modern IRCv3 clients (Halloy, gamja, Goguma, …) get more than the server-password floor above:

- **SASL** — log in with the same credential via SASL PLAIN instead of a server password.
- **Network discovery** (`soju.im/bouncer-networks`) — the client lists and binds your networks itself, so you don't hardcode `username/networkname`; connect as just `username` and pick from the list.
- **On-demand scrollback** (`draft/chathistory`) — page back through history on demand instead of relying only on the fixed replay-on-attach.

These are negotiated automatically; plain clients that don't support them keep working over the server-password path.

#### TLS

Plain-text IRC would send that credential across the wire in the clear, so **the bouncer speaks TLS by default** — you don't have to do anything to get an encrypted connection. Connect in your IRC client's **TLS/SSL** mode. There are three ways the cert is sourced:

- **Self-signed (default, zero setup).** With no cert configured, Lurker generates a self-signed cert on first boot and persists it next to the database (so it survives container rebuilds). It's the ZNC model: the wire is encrypted, and to also protect against man-in-the-middle you **pin the certificate's fingerprint** in your client. Lurker prints the SHA-256 fingerprint at startup — in the container logs and in the in-app **system buffer** — e.g. `TLS certificate fingerprint (SHA-256): AB:CD:…`. Most clients (WeeChat, irssi, Textual, …) let you pin that fingerprint; do it once and any impostor cert is rejected thereafter.

- **Your own Let's Encrypt cert (browser-trusted, no pinning).** If you want a cert clients trust without pinning, get one for a hostname (e.g. `irc.example.com`) with certbot and point Lurker at the PEM files — bind-mount them into the container and set:

  ```yaml
  environment:
    - LURKER_BOUNCER_TLS_CERT=/certs/fullchain.pem
    - LURKER_BOUNCER_TLS_KEY=/certs/privkey.pem
  ```

  Note the bouncer is raw IRC over TCP, so your **HTTP reverse proxy (Caddy/Cloudflare) can't front it** — the bouncer terminates its own TLS. Lurker re-reads the cert files periodically and hot-swaps a renewed cert, so certbot renewals need no restart.

- **Plain-text (opt-in, private networks only).** If — and only if — you keep the listener private (`LURKER_BOUNCER_BIND=127.0.0.1` behind an SSH tunnel, or a VPN/Tailscale interface), you can turn TLS off with `LURKER_BOUNCER_TLS=off`. On a non-loopback bind without TLS, Lurker logs a loud security warning. Don't do this on a public address.

Repeated failed logins from an address are throttled automatically.

Playback replays the last 50 lines per joined channel (plus your 20 most recently active DMs) on attach; tune with `LURKER_BOUNCER_PLAYBACK` (0 disables, max 1000). Clients that negotiate IRCv3 `server-time` get real timestamps on replayed lines.

Known limitations (shared-connection bouncer semantics): replies to one attached client's WHOIS/LIST are visible to all attached clients on that network; Lurker-side ignore rules don't filter the live relay; and on end-to-end encrypted channels an attached client sees the wire ciphertext for incoming messages.

---

## Troubleshooting

### Forgot the admin password

The cleanest path is to invite a second admin from your phone if you're still logged in there, then have them reset things from the admin panel.

If you're locked out everywhere, the fallback is to clear the password hash directly with sqlite and re-bootstrap. With the server stopped:

```bash
docker compose down
sqlite3 data/lurker.db "DELETE FROM users WHERE username = 'your-username';"
docker compose up -d
```

This destroys that user's account and history. If you were the only user, the next visit will return you to the first-run wizard so you can create a fresh admin. (A proper password-reset CLI is on the roadmap.)

### Port 8015 already in use

Edit the `ports:` line in your `docker-compose.yml` — the first number is the host port:

```yaml
ports:
  - '9999:8015'
```

Now Lurker is reachable on `http://localhost:9999`.

### Reverse-proxy / CORS errors

If you're seeing browser console errors about CORS, your browser is hitting a different origin than what Lurker expects. The bundled image serves both the API and the UI from the same port, so the default no-`CORS_ORIGIN` config is correct for almost everyone. Only set `CORS_ORIGIN` if you're running the Vue dev server (`npm run dev`) against a containerized API, or doing something similarly unusual.

### Uploaded images are broken for other people (403)

Symptom: you're using the **local** uploader, and an uploaded image loads fine when you open the link in a new tab, but shows as broken when it's embedded — in someone else's client, or in Lurker's own image viewer on a different domain.

That asymmetry is the tell. Opening a link directly and embedding it on a page are different requests: the embedded one carries a `Referer` header naming the page it's embedded on. **Cloudflare's Hotlink Protection blocks image files whose `Referer` is a different domain**, returning a `403` at the edge before the request ever reaches Lurker.

Confirm it with two `curl`s against the same URL, where the _only_ difference is the `Referer` header:

```bash
# 1. No referer → 200, and Lurker serves the image
curl -sS -o /dev/null -D - \
  https://lurker.example.com/uploads/local/<key>.<ext> \
  | grep -iE '^HTTP/|^content-type:'
#   HTTP/2 200
#   content-type: image/webp     ← or image/jpeg, depending on the upload

# 2. Cross-domain referer → 403, and your image never gets served
curl -sS -o /dev/null -D - -H 'Referer: https://example.org/' \
  https://lurker.example.com/uploads/local/<key>.<ext> \
  | grep -iE '^HTTP/|^content-type:|^vary:'
#   HTTP/2 403
#   content-type: text/plain; charset=UTF-8
#   vary: referer
```

If adding a `Referer` is all it takes to flip a `200` into a `403`, that's Hotlink Protection. The `403` comes back as `text/plain` (Cloudflare's block page) rather than your image, and `vary: referer` is Cloudflare telling you the decision was made on the referer.

> Don't try to tell the two apart by looking for `server: cloudflare` — Cloudflare proxies the _successful_ response too, so that header is on both. The status flip is the signal.

Turn Hotlink Protection off (or scope it around `/uploads/local/`) — see [File uploads on your own disk](#file-uploads-on-your-own-disk).

### Container logs

```bash
docker compose logs -f lurker
```

Will stream Lurker's stdout, including connection events, push delivery results, and any tracebacks.

---

## Advanced: docker-compose.override.yml

Compose auto-merges a `docker-compose.override.yml` file (gitignored, never committed) on top of the main `docker-compose.yml`. This is the clean way to add your own settings without touching the upstream file — useful if you want to `git pull` updates without conflicts.

A starter template is checked in as `docker-compose.override.yml.example`. Copy it to `docker-compose.override.yml` and edit. The example shows the pattern the upstream maintainer uses (pulling secrets from a `.env` file, attaching to an external reverse-proxy network).

---

## Running without Docker

If you'd rather run Lurker directly on a host:

```bash
git clone https://github.com/amiantos/lurker.git
cd lurker
npm run install:all
npm run client:build
npm start
```

The server listens on port 8010 by default. Configure with the same envvars described above (set them in a `.env` file next to `package.json`, or export them in your shell). Use a process supervisor (`systemd`, `pm2`, etc.) to keep it running.
