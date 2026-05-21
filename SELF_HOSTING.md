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

Run these from the directory holding your `docker-compose.yml`. If you used the [one-shot DigitalOcean deploy](README.md#deploy-on-digitalocean-one-shot), that's `/opt/lurker` — `cd` there first; the command is identical whether or not you enabled HTTPS.

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

> **Starting from a blank VPS?** If you don't already have a host, the [one-shot DigitalOcean deploy](README.md#deploy-on-digitalocean-one-shot) brings up a fresh droplet with Lurker and automatic HTTPS (via Caddy) from a single pasted script — no SSH, no manual Docker install. The rest of this section covers exposing an instance you're already running.

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

Lurker works fine with just username + password — passkeys are a quality-of-life addition (fingerprint / Face ID / hardware key login). (The [one-shot DigitalOcean deploy](README.md#deploy-on-digitalocean-one-shot) sets these up for you.) To enable them elsewhere, set three environment variables that match the public origin your browsers actually hit:

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

Lurker supports background push notifications for highlights and DMs, delivered to your installed PWA even when the tab is closed. (The [one-shot DigitalOcean deploy](README.md#deploy-on-digitalocean-one-shot) sets `VAPID_SUBJECT` for you.) To enable it elsewhere:

1. Set a valid `VAPID_SUBJECT` (the contact address embedded in outgoing push JWTs — APNs requires a real domain):

   ```yaml
   environment:
     - VAPID_SUBJECT=mailto:you@example.com
   ```

2. Restart Lurker. The first time the push service is used, it generates a VAPID keypair and stores it in `data/lurker.db` (under `app_meta`). The same keypair is reused on subsequent boots so existing subscriptions keep working.

3. From a browser (HTTPS required), open Lurker, "Install" it as a PWA, and enable notifications in the settings.

If you change `VAPID_SUBJECT` later, existing subscriptions continue to work — the subject only affects new push JWTs, not the keypair.

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
