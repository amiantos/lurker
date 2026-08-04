# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0

# Stage 1: Build Vue client
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS vue-builder

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
# Pinned to node:22 specifically (rather than lts) because better-sqlite3
# 11.x ships prebuilds for Node 22 but not Node 24 (which the lts tag
# currently resolves to). Bump when better-sqlite3 catches up.
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS server-deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Stage 3: Runtime image
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

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
