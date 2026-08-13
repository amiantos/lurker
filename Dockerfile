# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0

# Stage 1: Build Vue client
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS vue-builder

WORKDIR /app/vue_client

COPY vue_client/package*.json ./
RUN npm ci

COPY vue_client/ ./
# Vue and server both import shared/settingsRegistry.js via relative paths,
# so the shared/ tree has to land at /app/shared regardless of which stage
# is doing the work.
COPY shared/ /app/shared/
# vue_client/tsconfig.json extends ../tsconfig.base.json; Vite reads the
# resolved tsconfig during build, so the base file has to land at /app too.
COPY tsconfig.base.json /app/tsconfig.base.json
RUN npm run build

# Stage 2: Install server dependencies
#
# Using debian-slim (glibc) rather than alpine (musl) so better-sqlite3 and
# sharp can install from their published linux-x64 / linux-arm64 prebuilds
# instead of compiling from source. Compiling native modules under QEMU when
# multi-arch building on a single-arch GHA runner is glacial (or hangs
# outright), and the prebuild path sidesteps it entirely.
#
# Track the current LTS line explicitly (24, EOL 2028-04-30) rather than the
# `lts` tag or the newest tag. Odd-numbered majors (23, 25, ...) never become
# LTS and go EOL in months, so "newest" is actively wrong here.
#
# Both native modules stay on the prebuild path at 24: better-sqlite3 12.x
# publishes ABI-137 builds for linux-x64 and linux-arm64, and sharp 0.35 uses
# N-API platform packages, which are ABI-independent.
#
# The digest is refreshed by dependabot; see .github/dependabot.yml, which
# also explains why tag bumps here are deliberately not automated.
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS server-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Stage 3: Runtime image
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY tsconfig*.json ./
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=vue-builder /app/vue_client/dist ./vue_client/dist

RUN mkdir -p /app/data

EXPOSE 8015

# The server runs directly from TypeScript via tsx (no build step). tsx is a
# runtime dependency, so it lands in the production node_modules above.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server/server.ts"]
