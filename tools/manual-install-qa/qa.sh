#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# Runs INSIDE the bare host container (see run.sh): performs the manual install
# and the engine switch from docs/MIGRATION_ENGINE.md and asserts what the doc
# claims. The systemd units, the .env lines, the bring-up and the turn-off are
# EXTRACTED FROM THE DOC and run as written (minus `sudo`, which the image
# lacks); the install itself is docs/SELF_HOSTING.md's two commands.
#
# Deliberately neither -e nor pipefail: a failed check must be counted and
# reported, not abort the run — and under pipefail a `… | grep -q` that stops
# reading early turns its producer's SIGPIPE into a spurious failure.
set -u

DOC=/src/docs/MIGRATION_ENGINE.md
ERGO=${ERGO_HOST:-ergo}
API=http://127.0.0.1:8010
JAR=/root/qa.cookies
WATCH=/root/watch.log
NICK=lurkerqa
CHAN='#qa'
PASS=0
FAIL=0

step() { echo; echo "== $*"; }
info() { echo "        $*"; }
ok() { PASS=$((PASS + 1)); echo "  ok    $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
summary() { echo; echo "== $PASS passed, $FAIL failed"; }
die() { echo "  ABORT $*" >&2; summary; exit 1; }
# check <what> <command…> — a check is a command's exit status.
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }
not() { ! "$@"; }
# wait_for <seconds> <command…>
wait_for() {
  local n=$1 i; shift
  for ((i = 0; i < n; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

as_lurker() { runuser -u lurker -- bash -c "cd /opt/lurker && $*"; }
# A unit's journal for its CURRENT invocation only. A restart begins a new one,
# so "the app said X after the restart" has an exact answer.
journal_now() { journalctl --no-pager -o cat _SYSTEMD_INVOCATION_ID="$(systemctl show -p InvocationID --value "$1")"; }
journal_has() { grep -qE "$2" <<<"$(journal_now "$1")"; }
app_up() { curl -fsS "$API/api/auth/setup-status"; }
setup_pending() { app_up | grep -q '"needsSetup":true'; }
held() { curl -fsS http://127.0.0.1:8016/healthz 2>/dev/null | grep -o '"held":[0-9]*' | cut -d: -f2; }
held_is() { [ "$(held)" = "$1" ]; }
engine_pid() { systemctl show -p MainPID --value lurker-engine; }
engine_pid_is() { [ "$(engine_pid)" = "$1" ]; }
engine_active() { systemctl is-active --quiet lurker-engine; }
# Bystander events since a line-count mark: since <mark> <regex>
mark() { wc -l <"$WATCH"; }
since() { tail -n +"$(($1 + 1))" "$WATCH" | grep -qE "$2"; }
loopback_only() { ss -ltn | grep -q '127.0.0.1:8016' && ! ss -ltn | grep -qE '(0\.0\.0\.0|\*|\[::\]):8016'; }
nothing_on_8016() { ! ss -ltn | grep -q ':8016'; }
search_has() { curl -fsS -b "$JAR" "$API/api/search?q=$1" | grep -q "$1"; }
# Anything gitignored that reached the copy — secrets and dependency trees at ANY depth.
leaked() {
  find /opt/lurker \( -name .env -o -name .env.local -o -name node_modules -o -name '*.db' -o -name session-secret.key \) -print -quit | grep -q .
}

# extract_unit <path> — the ```ini block in the doc whose first line is "# <path>".
extract_unit() {
  awk -v want="# $1" '
    /^```ini/ { fence = 1; first = 1; next }
    fence && first { first = 0; if ($0 == want) grab = 1; else fence = 0 }
    fence && /^```/ { fence = 0; grab = 0; next }
    grab { print }
  ' "$DOC"
}
# extract_bash <line-prefix> — the first ```bash block after the line that starts
# with it. A literal prefix, not a regex: awk unescapes -v values, so a `\*` in
# a pattern would silently turn into `*` and match somewhere else in the doc.
extract_bash() {
  awk -v anchor="$1" '
    !armed && index($0, anchor) == 1 { armed = 1; next }
    armed && !fence && /^```bash/ { fence = 1; next }
    fence && /^```/ { exit }
    fence { print }
  ' "$DOC"
}
# run_doc <line-prefix> — run that block as written, minus sudo. A subshell,
# so a `cd` in the block cannot leak into the rig.
run_doc() {
  local block
  block=$(extract_bash "$1" | sed 's/^sudo //')
  [ -n "$block" ] || die "the doc has no bash block after a line starting with '$1'"
  (eval "$block")
}

step "the bare host: a lurker user and a copy of the checkout at /opt/lurker"
useradd --system --create-home --home-dir /opt/lurker --shell /usr/sbin/nologin lurker || die "useradd"
# What a clone would hold, plus uncommitted work: tracked and untracked files
# that are not ignored. Everything .gitignore'd — .env files at ANY depth,
# node_modules, data/, *.db — stays out, which a root-anchored tar exclude
# would not guarantee.
git -C /src -c safe.directory=/src ls-files -co --exclude-standard -z |
  tar -C /src --null -T - -cf - |
  runuser -u lurker -- tar -C /opt/lurker -xf - || die "copying the checkout"
check "package.json landed" test -f /opt/lurker/package.json
check "nothing ignored came along: no .env, node_modules or *.db at any depth" not leaked

step "install, per docs/SELF_HOSTING.md: npm run install:all && npm run client:build"
export npm_config_fund=false npm_config_audit=false npm_config_loglevel=error
as_lurker 'npm run install:all' || die "npm run install:all"
as_lurker 'npm run client:build' || die "npm run client:build"
check "vue_client/dist built" test -f /opt/lurker/vue_client/dist/index.html

step "an existing install: the operator's unit, npm start, identd on the app"
install -m 644 /qa/lurker.service.before /etc/systemd/system/lurker.service
printf 'PORT=8010\nLURKER_IDENTD_ENABLED=true\n' >/opt/lurker/.env
chown lurker:lurker /opt/lurker/.env
systemctl daemon-reload
systemctl enable --now lurker >/dev/null 2>&1
wait_for 60 app_up || die "the app never answered on :8010"
check "app: '[lurker] listening on http://…:8010'" wait_for 5 journal_has lurker '\[lurker\] listening on http://.*:8010'
check "API answers, setup pending" setup_pending
check "app bound :113 itself (identd; capability on the app unit)" wait_for 10 journal_has lurker '\[identd\] listening on :113'

step "first admin and a network on ergo, over the HTTP API"
curl -fsS -c "$JAR" -H 'content-type: application/json' \
  -d '{"username":"qaadmin","password":"correct horse battery staple"}' \
  "$API/api/auth/setup/password" >/dev/null || die "POST /api/auth/setup/password"
curl -fsS -b "$JAR" -H 'content-type: application/json' \
  -d "{\"name\":\"qa\",\"host\":\"$ERGO\",\"port\":6667,\"tls\":false,\"nick\":\"$NICK\",\"autoconnect\":true,\"default_channel\":\"$CHAN\"}" \
  "$API/api/networks" >/dev/null || die "POST /api/networks"

step "a bystander joins $CHAN on ergo and logs every JOIN/QUIT of $NICK"
: >"$WATCH"
node /qa/watcher.mjs watch "$ERGO" 6667 "$CHAN" "$NICK" "$WATCH" &
WATCHER=$!
wait_for 60 since 0 "(JOIN|PRESENT) $NICK" || die "$NICK never showed up in $CHAN"
ok "$NICK is in $CHAN, dialled by the app itself"

step "the switch: doc Steps 1–4, run out of the doc"
extract_unit /etc/systemd/system/lurker-engine.service >/etc/systemd/system/lurker-engine.service
extract_unit /etc/systemd/system/lurker.service >/etc/systemd/system/lurker.service
check "doc still carries the engine unit" grep -q '^ExecStart=.*npm run engine' /etc/systemd/system/lurker-engine.service
check "doc still carries the app unit" grep -q '^Wants=lurker-engine.service' /etc/systemd/system/lurker.service
run_doc '### Step 3' # the two .env lines
check ".env now names the engine" grep -q '^LURKER_ENGINE_URL=tcp://127.0.0.1:8016$' /opt/lurker/.env
M=$(mark)
run_doc '### Step 4' # daemon-reload, stop app, enable+start engine, start app
wait_for 60 app_up || die "the app never came back after the switch"
check "healthz: the engine holds 1 connection" wait_for 60 held_is 1
check "app: 'engine mode: attached to 127.0.0.1:8016'" wait_for 10 journal_has lurker 'engine mode: attached to 127\.0\.0\.1:8016'
check "engine: 'ident: built-in identd on :113'" journal_has lurker-engine 'ident: built-in identd on :113'
check "engine: identd actually bound :113 (capability on the engine unit, app let go first)" journal_has lurker-engine '\[identd\] listening on :113'
check "engine: no 'failed to listen'" not journal_has lurker-engine 'failed to listen'
check "engine listens on loopback only" loopback_only
check "the switch cost one reconnect: the bystander saw a QUIT…" wait_for 60 since "$M" "QUIT $NICK"
check "…and a JOIN" wait_for 60 since "$M" "JOIN $NICK"

step "the feature: an upgrade under the running engine, then systemctl restart lurker"
PID=$(engine_pid)
M=$(mark)
# The doc's upgrade commands minus the git pull (no remote here). Fidelity,
# not evidence: a no-op reconcile and a vite build touch nothing the running
# engine has loaded, so the checks below are decided by systemd alone.
as_lurker 'npm run install:all && npm run client:build' || bad "the doc's upgrade commands under the running engine"
TOKEN="while-down-$RANDOM$RANDOM"
systemctl stop lurker
node /qa/watcher.mjs say "$ERGO" 6667 "$CHAN" "$TOKEN" || bad "the bystander could not speak while the app was down"
# Hold the app down for a deploy-sized moment, so the engine's "away" is a real gap, not a blink.
sleep 3
systemctl start lurker
wait_for 60 app_up || die "the app never came back after the restart"
check "engine PID unchanged across the app restart" engine_pid_is "$PID"
check "healthz: still holding 1" held_is 1
check "app re-attached: 'holding 1 connection(s)'" wait_for 15 journal_has lurker 'attached to 127\.0\.0\.1:8016 .*holding 1 connection'
check "a line said while the app was down was delivered" wait_for 30 search_has "$TOKEN"
check "the bystander saw NO QUIT" not since "$M" "QUIT $NICK"
check "the bystander saw NO JOIN" not since "$M" "JOIN $NICK"
info "engine: $(grep -oE 'attached \(replay [^)]*\)' <<<"$(journal_now lurker-engine)" | tail -1)"

step "turning it off: the doc's block, after putting the app unit back"
M=$(mark)
# "Put the app unit back the way it was" — here, the operator's original unit:
# no Wants=, capability on the app again. The doc's block does the rest.
install -m 644 /qa/lurker.service.before /etc/systemd/system/lurker.service
run_doc '**Turning it off:**'
wait_for 60 app_up || die "the app never came back after turning the engine off"
check "one reconnect: a QUIT when the engine stopped…" wait_for 60 since "$M" "QUIT $NICK"
check "…and a JOIN when the app dialled itself" wait_for 60 since "$M" "JOIN $NICK"
check "the engine stayed down through the app's restart" not engine_active
check "nothing listens on :8016" nothing_on_8016
check "app is not in engine mode" not journal_has lurker 'engine mode'
check "app binds :113 again" wait_for 10 journal_has lurker '\[identd\] listening on :113'

kill "$WATCHER" 2>/dev/null
summary
[ "$FAIL" = 0 ]
