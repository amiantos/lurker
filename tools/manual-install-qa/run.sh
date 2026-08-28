#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# Lurker — manual-install QA: prove "Running without Docker" in
# docs/MIGRATION_ENGINE.md on a real systemd host
# ==================================================================
#
#   tools/manual-install-qa/run.sh          # build, run, tear down; exit 0 = every check passed
#   tools/manual-install-qa/run.sh --keep   # leave the containers up afterwards, to poke at
#
# Boots a throwaway Debian 12 container with systemd as PID 1 and Node 24 from
# NodeSource (the "bare host") plus a stock ergo IRC server, then runs qa.sh
# inside the host. qa.sh installs Lurker FROM THIS CHECKOUT exactly the way the
# docs say — a lurker user, /opt/lurker, `npm run install:all`, `npm run
# client:build`, `npm start` from a unit — creates an admin and a network over
# the HTTP API, and walks the engine switch with the systemd units, the .env
# lines, the bring-up and the turn-off EXTRACTED FROM THE DOC and run as
# written — so an edit to the doc is what gets tested.
#
# With a bystander client sitting in the channel on ergo, it proves that:
#   * before the switch, the app itself binds :113 (identd) and holds IRC;
#   * the switch costs exactly one reconnect — a QUIT and a JOIN;
#   * after it, `systemctl restart lurker` costs NONE: the engine's PID never
#     changes, and a line said while the app was down is delivered when it
#     returns. The doc's upgrade commands (npm install + client build, minus
#     the git pull) run under the live engine first — for fidelity, not as
#     evidence: nothing the engine has loaded is touched by them;
#   * turning the engine off round-trips: one reconnect, ident back on the app.
#
# Needs Docker (Desktop is fine) and roughly ten minutes the first time; the
# host image is cached after that. The host runs --privileged (systemd needs
# it) and is torn down on exit unless --keep. It touches nothing of yours: its
# own compose project name and network, no volumes, and the checkout is mounted
# read-only and copied without data/, .env or node_modules.
set -euo pipefail
cd "$(dirname "$0")"

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

PROJECT=lurker-manual-install-qa
compose() { docker compose -p "$PROJECT" -f docker-compose.yml "$@"; }

cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo
    echo "--keep: containers left up."
    echo "  docker compose -p $PROJECT -f $PWD/docker-compose.yml exec host bash"
    echo "  docker compose -p $PROJECT -f $PWD/docker-compose.yml down -v"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== building the bare host image"
compose build host
echo "== booting host + ergo"
compose up -d --force-recreate

printf '== waiting for systemd'
state=''
for _ in $(seq 1 60); do
  state=$(compose exec -T host systemctl is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  printf .
  sleep 1
done
echo " $state"
case "$state" in
  running | degraded) ;;
  *)
    echo "systemd did not come up (state: '$state')" >&2
    compose logs host
    exit 1
    ;;
esac

set +e
compose exec -T host bash /qa/qa.sh
rc=$?
set -e
if [ $rc -ne 0 ]; then
  echo
  echo "== FAILED (exit $rc) — last 80 journal lines of both units:"
  compose exec -T host journalctl -u lurker -u lurker-engine --no-pager -n 80 || true
fi
exit $rc
