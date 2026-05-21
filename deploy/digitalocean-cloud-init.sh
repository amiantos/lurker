#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: Elastic-2.0
#
# Lurker — DigitalOcean one-shot deploy (cloud-init user-data)
# ============================================================
#
# Paste the ENTIRE contents of this file into the "User Scripts" field when
# creating a DigitalOcean droplet (under "Additional Options"). That field is
# DigitalOcean's label for cloud-init user data; older guides call it "User
# data" or "Startup scripts". On first boot the droplet will, with no SSH:
#
#   * install Docker + the Compose plugin (skipped if already present, so
#     this works on both the Docker Marketplace image and vanilla Ubuntu)
#   * fetch Lurker, front it with Caddy for automatic HTTPS (Let's Encrypt),
#     and start everything under Docker Compose
#   * configure passkeys and web push — HTTPS makes both possible, so the
#     instance comes up feature-complete with no post-install server admin
#   * add a small swapfile on low-RAM droplets and configure the firewall
#
# Everything is logged to /var/log/lurker-deploy.log — view that from the
# DigitalOcean droplet console if a deploy doesn't come up as expected.
#
# ─── Required: fill in BOTH values before pasting ───────────────────────────
#
# This deploy always serves Lurker over HTTPS. HTTPS isn't a nicety here — it
# is what makes passkeys, web push, and secure browser sessions work — so
# there is no plain-HTTP option, and both values below are required. The
# script aborts if either is left blank.

# The public domain Lurker will be served on, e.g. "irc.example.com".
# Caddy obtains a Let's Encrypt certificate for it automatically. Once the
# droplet exists, point a DNS A record for this domain at the droplet's IP
# (the deploy log prints it); Caddy keeps retrying until that record resolves.
LURKER_DOMAIN=""

# Your email address. It is used for two things, both of which need a real,
# reachable address: the Let's Encrypt certificate contact (renewal and
# expiry notices), and the contact embedded in web-push messages, which
# Apple, Google, and Mozilla's push services require.
ADMIN_EMAIL=""

# ─── No edits needed below this line ────────────────────────────────────────

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/amiantos/lurker/main"
INSTALL_DIR="/opt/lurker"
DEPLOY_LOG="/var/log/lurker-deploy.log"

# cloud-init runs headless, so mirror all output into a log file that can be
# read back later from the droplet console.
exec > >(tee -a "$DEPLOY_LOG") 2>&1

log() { echo "[lurker-deploy $(date -u +%H:%M:%S)] $*"; }

log "=== Lurker deploy started $(date -u +%FT%TZ) ==="

# Both settings are mandatory. Fail early and loudly — before installing
# anything — rather than half-deploying; the log is the only place this
# message will surface, since cloud-init runs with no console.
require_config() {
  local missing=0
  if [ -z "$LURKER_DOMAIN" ]; then
    log "ERROR: LURKER_DOMAIN is empty — set it near the top of this script."
    missing=1
  fi
  if [ -z "$ADMIN_EMAIL" ]; then
    log "ERROR: ADMIN_EMAIL is empty — set it near the top of this script."
    missing=1
  fi
  if [ "$missing" -ne 0 ]; then
    log "Aborting: LURKER_DOMAIN and ADMIN_EMAIL are both required."
    exit 1
  fi
}

# ── Prerequisites ───────────────────────────────────────────────────────────

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi
  log "Installing curl..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed ($(docker --version)) — skipping install."
    return
  fi
  log "Docker not found — installing via the official convenience script."
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
}

# On the Docker Marketplace image the daemon may still be settling when
# cloud-init runs; wait for it rather than assuming the socket is ready.
wait_for_docker() {
  log "Waiting for the Docker daemon..."
  local i
  for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon is ready."
      return
    fi
    sleep 2
  done
  log "ERROR: Docker daemon did not become ready within 60s."
  exit 1
}

# Prefer the Compose v2 plugin; fall back to the legacy v1 binary for older
# images. Every compose invocation below goes through this wrapper.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    log "ERROR: no Docker Compose (v2 plugin or v1 binary) found."
    exit 1
  fi
}

# ── Host setup ──────────────────────────────────────────────────────────────

# The cheapest droplets ship 512MB–1GB of RAM; a small swapfile keeps the
# image pull and Node runtime comfortable.
ensure_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -ge 2000000 ]; then
    log "RAM is $((mem_kb / 1024))MB (>= 2GB) — no swapfile needed."
    return
  fi
  if swapon --show 2>/dev/null | grep -q .; then
    log "Swap already active — leaving it alone."
    return
  fi
  log "RAM is $((mem_kb / 1024))MB (< 2GB) — adding a 1GB swapfile."
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
}

# UFW: open SSH *first* so a bad rule can't lock us out, then HTTP/HTTPS for
# Caddy. Lurker's own 8015 is never published on the host (the Caddy overlay
# drops that binding), so it stays internal to the Docker network.
#
# Note: Docker publishes container ports straight into iptables, bypassing
# UFW — so the `ufw deny 8015` below is only belt-and-suspenders; the real
# isolation comes from docker-compose.caddy.yml not binding 8015 at all.
configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    log "ufw not installed — skipping firewall configuration."
    return
  fi
  log "Configuring UFW firewall (SSH allowed first)..."
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw deny 8015/tcp
  ufw --force enable
  ufw status verbose || true
}

# ── Deploy ──────────────────────────────────────────────────────────────────

deploy() {
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  log "Fetching compose files and Caddyfile..."
  curl -fsSL -o docker-compose.yml "$REPO_RAW/docker-compose.yml"
  curl -fsSL -o docker-compose.caddy.yml "$REPO_RAW/docker-compose.caddy.yml"
  curl -fsSL -o Caddyfile "$REPO_RAW/deploy/Caddyfile"

  # Compose interpolates LURKER_DOMAIN/ADMIN_EMAIL into docker-compose.caddy.yml
  # — Caddy reads them for TLS, Lurker reads them for passkeys and push.
  # COMPOSE_FILE records the overlay so plain `docker compose` commands —
  # including future `pull` + `up -d` updates — pick up Caddy automatically.
  cat > .env <<EOF
LURKER_DOMAIN=${LURKER_DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL}
COMPOSE_FILE=docker-compose.yml:docker-compose.caddy.yml
EOF

  compose pull
  compose up -d
  compose ps
}

# ── Run ─────────────────────────────────────────────────────────────────────

require_config
ensure_curl
install_docker
wait_for_docker
ensure_swap
deploy
configure_firewall

PUBLIC_IP=$(curl -fsS --max-time 5 \
  http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
  2>/dev/null || echo "this droplet's public IP")

log "=== Lurker deploy finished $(date -u +%FT%TZ) ==="
log "Lurker is running. Point a DNS A record for ${LURKER_DOMAIN} at"
log "${PUBLIC_IP} if you haven't already — Caddy retries Let's Encrypt"
log "until it resolves, then https://${LURKER_DOMAIN} serves over HTTPS."
log "Passkeys and web push are pre-configured; once you've created your"
log "admin account, opt in per device from Lurker's settings."
