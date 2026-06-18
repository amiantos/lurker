# Deploy Lurker on DigitalOcean (one-shot)

Stand up a public, HTTPS-enabled Lurker on a fresh DigitalOcean droplet from a single pasted script — no SSH required.

[![Watch the Lurker DigitalOcean deployment walkthrough](assets/yt-tutorial-thumb.png)](https://youtu.be/L730O7KNGlA)

## Steps

1. Create a droplet — the Docker Marketplace image at the smallest size is fine (vanilla Ubuntu 24.04 LTS works too).
2. At droplet creation, expand **Additional Options** and enable **User Scripts** (DigitalOcean's label for cloud-init user data — older guides call it "User data" or "Startup scripts"). Paste in the contents of [`deploy/digitalocean-cloud-init.sh`](../deploy/digitalocean-cloud-init.sh), after filling in the two required values near the top of the script — `LURKER_DOMAIN` (your domain, e.g. `irc.yourdomain.com`) and `ADMIN_EMAIL` (your email address).
3. Once the droplet exists, copy its public IP and add a DNS `A` record pointing your domain at it.
4. Give it a few minutes, then visit your domain.

You don't need the droplet's IP before creating it: the droplet boots and starts Caddy _before_ DNS exists, and Caddy keeps retrying Let's Encrypt until your `A` record resolves — so HTTPS comes up automatically a few minutes after you set the DNS record. (If you'd rather the certificate be ready the moment the droplet boots, reserve a [Reserved IP](https://docs.digitalocean.com/products/networking/reserved-ips/) first, point DNS at it, then create the droplet and assign that Reserved IP.)

Passkeys and web push notifications are configured automatically — the deploy derives the WebAuthn and push settings from your domain and email — so you can enable them per device from Lurker's in-app settings without touching the server.

This deploy script is pinned to `https://github.com/amiantos/lurker` and runs `ghcr.io/amiantos/lurker:latest`.

## Optional IRC bouncer

To let WeeChat/Irssi connect directly to Lurker as an IRC bouncer, set `ENABLE_BOUNCER="true"` near the top of the deploy script. The default public TCP port is `6667`; change `BOUNCER_PORT` if you need a different one.

The bouncer is plain TCP. Clients authenticate with:

```irc
PASS <read-write-api-token>:<network-id>
```

Create the API token in Lurker after your admin account exists. Use a separate WeeChat/Irssi server entry per Lurker network.

Deploy progress is logged to `/var/log/lurker-deploy.log` on the droplet.

## Updating

SSH in (or open the DigitalOcean web console) and run:

```bash
cd /opt/lurker
docker compose pull && docker compose up -d
```

The deploy script records the Caddy overlay in `.env`, so `docker compose` picks it up automatically — no `-f` flags needed. Your `data/` directory is left untouched.

## Going further

For backups, admin-password recovery, and other operational details, see the [self-hosting guide](SELF_HOSTING.md).
