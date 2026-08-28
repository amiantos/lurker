# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# The "bare host" for tools/manual-install-qa: Debian 12 booting systemd as
# PID 1, with Node 24 from NodeSource at /usr/bin — the machine the systemd
# units in docs/MIGRATION_ENGINE.md are written for. Lurker is NOT installed
# here: qa.sh installs it the way the docs say to, at run time, so the image
# stays a plain host and the docs stay the thing under test. No compiler is
# installed on purpose — the docs don't ask for one, so the native modules
# have to arrive as prebuilds or the run fails and the docs are wrong.
FROM debian:bookworm-slim
ENV container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv ca-certificates curl gnupg procps iproute2 openssl git \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# Units that cannot work in a container and would only delay boot or spam the
# journal. `|| true`: a name absent from this Debian is not an error.
RUN systemctl mask \
      systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service systemd-logind.service getty.target \
      console-getty.service systemd-remount-fs.service \
    || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
