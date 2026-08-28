# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# The "bare host" for tools/manual-install-qa: Debian 12 booting systemd as
# PID 1, with Node 24 at /usr/bin — the machine the systemd units in
# docs/MIGRATION_ENGINE.md are written for. Lurker is NOT installed here:
# qa.sh installs it the way the docs say to, at run time, so the image stays
# a plain host and the docs stay the thing under test. No compiler is
# installed on purpose — the docs don't ask for one, so the native modules
# have to arrive as prebuilds or the run fails and the docs are wrong.
#
# Node comes from the official image, pinned to the same digest as the main
# Dockerfile, rather than from a `curl | bash` of NodeSource's setup script:
# nothing remote runs at build time, and the build is reproducible. The
# official image keeps node under /usr/local/bin; a distro package puts it in
# /usr/bin, which is where an operator's unit (`ExecStart=/usr/bin/npm start`)
# expects it — the symlinks below reproduce that layout.
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ENV container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv ca-certificates curl procps iproute2 openssl git \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/bin/node /usr/bin/node \
    && ln -s /usr/local/bin/npm /usr/bin/npm \
    && ln -s /usr/local/bin/npx /usr/bin/npx
# Units that cannot work in a container and would only delay boot or spam the
# journal. `|| true`: a name absent from this Debian is not an error.
RUN systemctl mask \
      systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service systemd-logind.service getty.target \
      console-getty.service systemd-remount-fs.service \
    || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
