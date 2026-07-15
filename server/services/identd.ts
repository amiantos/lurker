// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A minimal built-in identd (RFC 1413). When a multi-user Lurker connects many
// users to a network from one IP, the network can't tell them apart unless an
// identd vouches for each connection's ident. This server answers the IRC
// server's port-113 callback by mapping the connection's *local source port* to
// the ident Lurker registered for it (see ircConnection.ts).
//
// Opt-in via LURKER_IDENTD_ENABLED — binding :113 is privileged and most
// single-user self-hosts don't need it; the hosted (node) edition turns it on
// per cell. Mirrors The Lounge's built-in identd: to avoid running as root you
// can set LURKER_IDENTD_PORT to a high port and have the host's oidentd forward
// to it (:113 must be reachable by the IRC server either way).

import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// One registered outbound IRC connection's identity. Keyed by a unique id, NOT
// the local port: two simultaneous connections may legally share a local source
// port (TCP only requires the full 4-tuple to be unique), so keying on the port
// alone lets one clobber the other's ident — and closing one would delete the
// other's still-live mapping. Module-scoped so the connection layer and the
// server share one map.
export interface IdentEntry {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  ident: string;
}

const idents = new Map<number, IdentEntry>();
let nextIdentId = 0;

// ---------------------------------------------------------------------------
// Outcome metrics
// ---------------------------------------------------------------------------

// The residual ident failures are otherwise invisible: when a query matched no
// live 4-tuple the old code answered NO-USER and logged nothing, so there was no
// way to tell a registration race (the query beat our own connect callback
// through the event loop) from a connection that never reached us. These
// counters — surfaced in `docker logs` by the periodic summary in startIdentd —
// make the served / rescued / missed split greppable in prod.
interface IdentdMetrics {
  accepted: number; // inbound :113 connections accepted
  queries: number; // well-formed query lines parsed
  served: number; // answered USERID on the first lookup
  rescued: number; // answered USERID only after waiting out the registration race
  silentMiss: number; // no 4-tuple match even after the grace window — answered NO-USER
  addrMiss: number; // ports matched a live connection but the source address did not
  invalid: number; // malformed or out-of-range query line
  noData: number; // connection closed/timed out before sending a query line
  graceSkipped: number; // grace window declined because too many were already pending
  abandoned: number; // a parsed query whose socket closed mid-grace before a verdict
}

const metrics: IdentdMetrics = {
  accepted: 0,
  queries: 0,
  served: 0,
  rescued: 0,
  silentMiss: 0,
  addrMiss: 0,
  invalid: 0,
  noData: 0,
  graceSkipped: 0,
  abandoned: 0,
};

export function getIdentdMetrics(): Readonly<IdentdMetrics> {
  return { ...metrics };
}

// Tests reset between cases; production never calls this.
export function resetIdentdMetrics(): void {
  for (const k of Object.keys(metrics) as (keyof IdentdMetrics)[]) metrics[k] = 0;
}

// Grace window for the registration race. The IRC server fires its :113 callback
// the instant it accepts our TCP connection, which can beat our own 'raw socket
// connected' handler (where registerIdent runs) through a busy event loop — a
// reconnect storm right after a deploy is the worst case. RFC 1413 servers wait
// seconds for a reply (DALnet observed at ~30s, solanum similar), so on a TOTAL
// miss we hold the socket and re-check briefly instead of answering NO-USER at
// once. A first-lookup hit still answers instantly; only the failure path waits.
// GRACE_MAX_PENDING bounds how many sockets a :113 scan can pin open.
const GRACE_MS = 1500;
const GRACE_STEP_MS = 150;
const GRACE_MAX_PENDING = 256;
let gracePending = 0;

// Throttle for the silent-miss warning so a :113 scan can't flood the log; the
// counter still increments on every miss, only the log line is rate-limited.
let lastSilentMissWarnAt = 0;

// Collapse IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4 so an address compares
// equal whether the kernel reported it mapped (common on dual-stack listeners) or
// bare — otherwise the inbound query address and the stored outbound address can
// disagree on representation alone and never match.
function normalizeAddress(address: string | undefined | null): string {
  if (!address) return '';
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return m && net.isIPv4(m[1]) ? m[1] : address;
}

// Register an outbound connection's identity. Returns a handle used later to
// unregister this exact entry (or 0 when the entry is unusable). Addresses are
// normalized up front so lookups match regardless of v4/v6-mapped representation.
export function registerIdent(entry: IdentEntry): number {
  if (!(entry.localPort > 0) || !entry.ident) return 0;
  const id = ++nextIdentId;
  idents.set(id, {
    localAddress: normalizeAddress(entry.localAddress),
    localPort: entry.localPort,
    remoteAddress: normalizeAddress(entry.remoteAddress),
    remotePort: entry.remotePort,
    ident: entry.ident,
  });
  // The oidentd shared-daemon file (if enabled) renders this same map; a new
  // entry must reach it before the IRC server queries the host daemon.
  scheduleOidentdRefresh();
  return id;
}

export function unregisterIdent(id: number | null): void {
  if (!id) return;
  idents.delete(id);
  scheduleOidentdRefresh();
}

// Resolve the ident for an RFC 1413 query. The identifying tuple is BOTH
// addresses and BOTH ports, not just the ports. Matching ports alone (a) returns
// the wrong user when two connections share a local port and (b) lets anyone who
// can reach :113 enumerate every active ident by scanning local ports against
// 6667/6697 (TheLounge GHSA-g49q-jw42-6x85). Requiring the querier's address to
// be the server the connection actually goes to closes both. `addrMiss` flags the
// diagnostic case where the ports matched a live connection but the address did
// not.
//
// The cost of that strictness, accepted deliberately: a network whose ident
// callback originates from a different IP than its IRC listener (a
// multi-homed/load-balanced ircd, or one behind its own NAT) won't match, so its
// users go unverified. There is no fallback that ignores the address without
// reopening the enumeration hole. Mainstream ircds (solanum/charybdis/InspIRCd)
// call back from the accepting socket's IP, so this is rare — and noteAddrMiss()
// escalates loudly when it does happen, rather than failing silently.
function lookupIdent(
  lport: number,
  rport: number,
  localAddress: string,
  remoteAddress: string,
): { ident?: string; addrMiss: boolean } {
  // Linear scan, deliberately: N is the cell's live-connection count, which is
  // capacity-capped (NODE_CAPACITY) and dwarfed by each query's TCP-accept + parse
  // cost, so a query flood is bounded by connection volume (a firewall/rate-limit
  // concern), not by this. An index would add register/unregister bookkeeping to
  // keep in sync — the very dual-state that the port-only bug came from.
  let addrMiss = false;
  for (const e of idents.values()) {
    if (e.localPort !== lport || e.remotePort !== rport) continue;
    if (e.localAddress === localAddress && e.remoteAddress === remoteAddress) {
      return { ident: e.ident, addrMiss: false };
    }
    addrMiss = true;
  }
  return { addrMiss };
}

// True for loopback / RFC 1918 / link-local / IPv6 ULA & link-local — the address
// families a NAT gateway (notably Docker's bridge gateway, typically 172.x)
// substitutes for a real public source. Inputs are already normalized, so
// v4-mapped IPv6 has been collapsed to plain IPv4 before we get here.
export function isPrivateAddress(address: string): boolean {
  if (!address) return false;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 127 || // loopback
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (Docker's default bridge)
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 169 && b === 254) // 169.254.0.0/16 link-local
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || /^fe[89ab]/.test(v6);
}

// A query whose ports match a live connection but whose source address doesn't is
// usually harmless — a :113 scan the address check correctly refuses. But the same
// signal also marks the two wholesale failures that are hardest to diagnose from
// scattered warns, so on the FIRST such miss we escalate once with a message
// tailored to the likely cause:
//   - a PRIVATE/loopback source means the container isn't seeing real inbound IPs
//     (e.g. Docker routing :113 through its userland proxy, so every callback
//     looks like it came from the bridge gateway);
//   - a PUBLIC source that still doesn't match points at the network's ident
//     callback originating from a different IP than the server we connected to (a
//     multi-homed/load-balanced ircd; see lookupIdent) — those users can't be
//     verified, and there's no fallback that wouldn't reopen :113 enumeration.
// Escalating on any miss (not just the private one) is what surfaces the public
// case, which is the wholesale failure with no otherwise-obvious cause; the
// once-per-process gate keeps a stray scan hit from becoming log spam.
let wholesaleFailureWarned = false;
let lastAddrMissWarnAt = 0;
function noteAddrMiss(lport: number, rport: number, queryRemoteAddress: string): void {
  // Rate-limit the per-miss warn (a :113 scan hitting a live connection's ports
  // from the wrong address could otherwise flood it); the addrMiss counter at the
  // call site stays unthrottled.
  const now = Date.now();
  if (now - lastAddrMissWarnAt > 10_000) {
    lastAddrMissWarnAt = now;
    console.warn(
      `[identd] ${lport},${rport} matched a live connection but query address ${queryRemoteAddress} did not — answering NO-USER`,
    );
  }
  if (wholesaleFailureWarned) return;
  wholesaleFailureWarned = true;
  if (isPrivateAddress(queryRemoteAddress)) {
    console.error(
      `[identd] idents are failing wholesale: a :113 callback came from ${queryRemoteAddress}, a private address — this container is not seeing IRC servers' real source IPs. Docker is most likely routing :113 through its userland proxy instead of preserving the source. Fix: run the cell with network_mode: host.`,
    );
  } else {
    console.error(
      `[identd] a :113 callback from ${queryRemoteAddress} did not match the server it was issued for. If a whole network's users show as unverified, that network's ident daemon likely originates from a different IP than its IRC listener (multi-homed/load-balanced); the enumeration-safe 4-tuple match cannot answer those.`,
    );
  }
}

interface GraceConfig {
  graceMs: number;
  graceStepMs: number;
  graceMaxPending: number;
}

// RFC 1413 reply lines. The query echoes its own port pair back ahead of the
// verdict, so both halves carry <lport>, <rport>.
const useridReply = (lport: number, rport: number, ident: string): string =>
  `${lport}, ${rport} : USERID : UNIX : ${ident}\r\n`;
const noUserReply = (lport: number, rport: number): string =>
  `${lport}, ${rport} : ERROR : NO-USER\r\n`;

// RFC 1413: the querying server sends "<our-port> , <their-port>"; we reply
// "<our-port>, <their-port> : USERID : UNIX : <ident>" or ERROR : NO-USER. The
// query connection's own addresses complete the 4-tuple we match on. A TOTAL
// miss (no entry with these ports) is treated as a possible registration race
// and given the grace window; an ADDRESS mismatch is the enumeration-refusal
// case and answered NO-USER at once (see lookupIdent / noteAddrMiss).
function handleConnection(socket: net.Socket, cfg: GraceConfig): void {
  metrics.accepted++;
  // Keep the idle timeout safely above the grace window so a raised graceMs can't
  // let the socket time out mid-rescue.
  socket.setTimeout(Math.max(10_000, cfg.graceMs + 1_000));
  const queryLocalAddress = normalizeAddress(socket.localAddress);
  const queryRemoteAddress = normalizeAddress(socket.remoteAddress);
  let buf = '';
  let answered = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCounted = false;

  // Release this socket's grace slot exactly once (the slot-leak defense). The
  // pendingCounted guard makes repeat calls — from finish() and the abandonment
  // paths — no-ops, so gracePending can't drift and wedge the window shut.
  const releasePending = (): void => {
    if (pendingCounted) {
      gracePending--;
      pendingCounted = false;
    }
  };

  // Single exit: clear any pending grace timer, release the slot, reply.
  const finish = (line: string): void => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    releasePending();
    socket.end(line);
  };

  socket.on('data', (chunk: Buffer) => {
    if (answered) return;
    buf += chunk.toString('latin1');
    const nl = buf.indexOf('\n');
    if (nl === -1) {
      // Junk flood with no newline — bail. Mark answered + count as invalid (not
      // a silent probe) so it doesn't pollute noData, which is the starvation
      // signal we read for the DALnet-class follow-up.
      if (buf.length > 100) {
        answered = true;
        metrics.invalid++;
        socket.destroy();
      }
      return;
    }
    const m = /^\s*(\d{1,5})\s*,\s*(\d{1,5})/.exec(buf.slice(0, nl));
    if (!m) {
      answered = true;
      metrics.invalid++;
      finish('0, 0 : ERROR : INVALID-PORT\r\n');
      return;
    }
    answered = true;
    const lport = Number(m[1]);
    const rport = Number(m[2]);
    // `\d{1,5}` lets a 5-digit value like 99999 through; an out-of-range port can
    // never identify a real connection, so reject it as INVALID-PORT up front
    // rather than letting it fall into the grace window and burn a grace slot
    // (and a held socket) for a scanner.
    if (lport < 1 || lport > 65535 || rport < 1 || rport > 65535) {
      metrics.invalid++;
      finish(`${lport}, ${rport} : ERROR : INVALID-PORT\r\n`);
      return;
    }
    metrics.queries++;

    const first = lookupIdent(lport, rport, queryLocalAddress, queryRemoteAddress);
    if (first.ident) {
      metrics.served++;
      finish(useridReply(lport, rport, first.ident));
      return;
    }
    if (first.addrMiss) {
      metrics.addrMiss++;
      noteAddrMiss(lport, rport, queryRemoteAddress);
      finish(noUserReply(lport, rport));
      return;
    }
    // Total miss: most likely our outbound registration hasn't landed yet.
    // Decline the wait under overload so a scan can't pin sockets open.
    if (gracePending >= cfg.graceMaxPending) {
      // Deliberate backpressure, NOT a race loss — kept out of silentMiss (and
      // thus the win-rate) so a :113 scan can't make the race look like it's
      // failing.
      metrics.graceSkipped++;
      finish(noUserReply(lport, rport));
      return;
    }
    gracePending++;
    pendingCounted = true;
    const startedAt = Date.now();
    const recheck = (): void => {
      graceTimer = null;
      if (socket.destroyed) {
        // Peer abandoned the query mid-wait. Meter it (it was counted in
        // `queries`) and release the slot.
        if (pendingCounted) metrics.abandoned++;
        releasePending();
        return;
      }
      const again = lookupIdent(lport, rport, queryLocalAddress, queryRemoteAddress);
      if (again.ident) {
        metrics.rescued++;
        console.log(
          `[identd] ${lport},${rport} matched after ${Date.now() - startedAt}ms — outbound registration landed late (connect race); answering USERID`,
        );
        finish(useridReply(lport, rport, again.ident));
        return;
      }
      if (again.addrMiss) {
        // A late same-port/different-address registration. Count it, but do NOT
        // run noteAddrMiss here: only a FIRST-lookup addrMiss is a trustworthy
        // wholesale-failure signal — escalating from this benign connect-race
        // artifact would cry wolf and burn the once-per-process alarm.
        metrics.addrMiss++;
        finish(noUserReply(lport, rport));
        return;
      }
      if (Date.now() - startedAt >= cfg.graceMs) {
        metrics.silentMiss++;
        const now = Date.now();
        if (now - lastSilentMissWarnAt > 10_000) {
          lastSilentMissWarnAt = now;
          console.warn(
            `[identd] no live connection for ${lport},${rport} from ${queryRemoteAddress} after ${cfg.graceMs}ms — answering NO-USER (silentMiss=${metrics.silentMiss})`,
          );
        }
        finish(noUserReply(lport, rport));
        return;
      }
      graceTimer = setTimeout(recheck, cfg.graceStepMs);
    };
    graceTimer = setTimeout(recheck, cfg.graceStepMs);
  });

  socket.on('timeout', () => socket.destroy());
  socket.on('close', () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    // A grace-pending socket closing before a verdict was abandoned mid-wait.
    if (pendingCounted) metrics.abandoned++;
    releasePending();
    // Accepted but never delivered a query line — the starvation/connectivity
    // signature, distinct from a query we did answer with NO-USER.
    if (!answered) metrics.noData++;
  });
  socket.on('error', () => {});
}

/** Build (but don't listen on) an identd server. Exposed for tests, which pass
 * a short grace window to keep the race cases fast and deterministic. */
export function createIdentdServer(opts: Partial<GraceConfig> = {}): net.Server {
  const cfg: GraceConfig = {
    graceMs: opts.graceMs ?? GRACE_MS,
    graceStepMs: opts.graceStepMs ?? GRACE_STEP_MS,
    graceMaxPending: opts.graceMaxPending ?? GRACE_MAX_PENDING,
  };
  // allowHalfOpen: true is REQUIRED for the grace window. RFC 1413 queriers
  // commonly half-close (shutdown(SHUT_WR)) right after writing the query; with
  // the net default (false) that inbound FIN auto-ends our writable side, so a
  // grace-delayed socket.end(reply) — fired a tick or more later — is silently
  // discarded and the rescued user stays unverified. We always close explicitly
  // (every path goes through finish()/destroy(), backstopped by the idle
  // timeout), so holding the writable side open across the peer's half-close is
  // safe.
  return net.createServer({ allowHalfOpen: true }, (socket) => handleConnection(socket, cfg));
}

let server: net.Server | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;

// Roll the outcome counters into one greppable line every 10 minutes, but only
// when something happened since the last tick — an idle cell stays quiet. This
// is how the race/miss rate becomes observable in prod without per-query spam.
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000;

function startSummary(): void {
  if (summaryTimer) return;
  // Seed from the current cumulative total so the first tick after a restart
  // doesn't replay stale totals as if they were new activity.
  let prevAccepted = metrics.accepted;
  summaryTimer = setInterval(() => {
    if (metrics.accepted === prevAccepted) return;
    prevAccepted = metrics.accepted;
    // "race win-rate" = of the queries matching a real connection we could win or
    // lose (served+rescued vs silentMiss), how many we answered. Deliberately
    // excludes addrMiss / noData / graceSkipped (scans + backpressure) so they
    // can't drag the headline number — every raw counter is on the same line.
    const resolved = metrics.served + metrics.rescued + metrics.silentMiss;
    const winRate = resolved
      ? `${Math.round(((metrics.served + metrics.rescued) / resolved) * 100)}%`
      : 'n/a';
    console.log(
      `[identd] stats: accepted=${metrics.accepted} queries=${metrics.queries} served=${metrics.served} rescued=${metrics.rescued} silentMiss=${metrics.silentMiss} addrMiss=${metrics.addrMiss} invalid=${metrics.invalid} noData=${metrics.noData} graceSkipped=${metrics.graceSkipped} abandoned=${metrics.abandoned} — race win-rate ${winRate}`,
    );
  }, SUMMARY_INTERVAL_MS);
  // Don't let the summary timer keep the process alive on its own.
  summaryTimer.unref();
}

export function startIdentd(port: number, bindHost?: string): void {
  if (server) return;
  const srv = createIdentdServer();
  srv.on('error', (err: Error) => {
    // A failed bind (EACCES without the privilege to bind :113, or EADDRINUSE)
    // must not take down the whole server — log and carry on without identd. If
    // the error arrives after we were already listening, close the listener so
    // it can't keep accepting connections once we drop our reference to it.
    console.error(`[identd] failed to listen on :${port}: ${err.message}`);
    if (srv.listening) srv.close();
    if (server === srv) server = null;
  });
  const onListen = () => {
    // Bracket notation is IPv6-only; an IPv4 bind host must print bare.
    const where = bindHost ? (net.isIPv6(bindHost) ? `[${bindHost}]:` : `${bindHost}:`) : ':';
    console.log(
      `[identd] listening on ${where}${port} — verifying idents against the full RFC 1413 4-tuple, with a ${GRACE_MS}ms grace window to absorb the connect/registration race; relies on the container seeing IRC servers' real inbound source IPs (Docker bridge preserves them; if idents fail wholesale, run with network_mode: host)`,
    );
    // Only once we're actually listening — a failed bind shouldn't leave a stray
    // interval ticking for a service that never came up.
    startSummary();
  };
  if (bindHost) srv.listen(port, bindHost, onListen);
  else srv.listen(port, onListen);
  server = srv;
}

export function stopIdentd(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}

export function isIdentdEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LURKER_IDENTD_ENABLED || '').trim());
}

export function identdPort(): number {
  const p = Number(process.env.LURKER_IDENTD_PORT);
  return Number.isInteger(p) && p > 0 ? p : 113;
}

// Optional bind address for the identd listener (LURKER_IDENTD_BIND). A
// multi-homed host can pin the identd to a single local address (e.g. a
// dedicated IPv6) so it coexists with another ident daemon serving the host's
// other addresses — each answers :113 on its own IP. Unset (the default) binds
// every interface.
export function identdBindHost(): string | undefined {
  const host = (process.env.LURKER_IDENTD_BIND || '').trim();
  return host || undefined;
}

// ---------------------------------------------------------------------------
// oidentd shared-daemon mode (LURKER_OIDENTD_FILE)
// ---------------------------------------------------------------------------
//
// The alternative to binding :113 ourselves: maintain an oidentd config file
// that a host-installed oidentd reads and answers from. For running Lurker on a
// box that already has an ident daemon (a shell host, seedbox, shared server)
// without fighting over the privileged port. Mirrors The Lounge's `oidentd:`
// option. The two modes are independent and driven by the SAME `idents` map —
// the in-process server answers :113 from it; here we render it to a file.

// Expand a leading `~` so LURKER_OIDENTD_FILE can be given as e.g. ~/.oidentd.conf.
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function oidentdFilePath(): string | undefined {
  const raw = (process.env.LURKER_OIDENTD_FILE || '').trim();
  return raw ? expandHome(raw) : undefined;
}

export function isOidentdFileEnabled(): boolean {
  return !!oidentdFilePath();
}

// deriveIdent output is already ident-safe (alnum/underscore), but escape
// defensively so a backslash or double-quote from any future ident source can't
// terminate the quoted string early and inject a second oidentd directive.
function escapeReply(ident: string): string {
  return ident.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const OIDENTD_HEADER =
  '# Generated by Lurker — do not edit; overwritten on every IRC (dis)connect.\n';

// Render the current ident map as an oidentd user-config file: one line per live
// connection in the full 4-tuple `to/fport/from/lport` form (NOT port-only), so
// the host daemon answers exactly the connections we vouch for and no :113 scan
// can enumerate idents by port alone — the same enumeration defense as the
// in-process lookupIdent 4-tuple match. Addresses are already normalized in the
// map (v4-mapped IPv6 collapsed); IPv6 is emitted BARE (no brackets) because
// that is what oidentd's user-config grammar expects for `to`/`from` — the same
// form The Lounge writes in production.
export function formatOidentdConfig(entries: Iterable<IdentEntry>): string {
  let file = OIDENTD_HEADER;
  for (const e of entries) {
    if (!e.localPort || !e.remotePort || !e.localAddress || !e.remoteAddress || !e.ident) continue;
    file +=
      `to ${e.remoteAddress} fport ${e.remotePort}` +
      ` from ${e.localAddress} lport ${e.localPort}` +
      ` { reply "${escapeReply(e.ident)}" }\n`;
  }
  return file;
}

// Serialized, coalesced, atomic writer. register/unregister mark the file dirty
// and (if no drain is already running) start a single drain loop: write, then
// re-check the dirty flag and write again. This coalesces a burst AND guarantees
// no two writeFile+rename pairs ever overlap on the shared `${file}.tmp` path —
// an earlier design fired a fresh async write per event, so during a reconnect
// storm (registrations arrive across many ticks) a second write could re-truncate
// tmp mid-rename of the first, or a rename could hit ENOENT and the catch's unlink
// remove a third write's tmp. The leading setImmediate keeps a lone connect
// same-tick while letting a synchronous burst pile into one pass — unlike the
// in-process identd, oidentd answers the :113 callback itself, so there's no
// grace window and write-speed is our only defense against the callback beating
// the file.
let oidentdDirty = false;
let oidentdWriting = false;
// Set once at shutdown so nothing renames stale mappings back over the truncated
// file afterward: scheduleOidentdRefresh stops starting drains (the disconnect-
// driven unregisters during shutdown won't schedule writes), the drain loop
// exits, and any in-flight write skips its rename. Cleared by initOidentdFile —
// a fresh boot re-enables the writer.
let oidentdStopped = false;
let lastOidentdWriteErrorAt = 0;
// Tracks the in-flight drain so tests can await a fully-settled flush. Production
// otherwise treats the refresh as fire-and-forget.
let oidentdWriteInFlight: Promise<void> = Promise.resolve();

function scheduleOidentdRefresh(): void {
  if (!isOidentdFileEnabled() || oidentdStopped) return;
  oidentdDirty = true;
  if (oidentdWriting) return; // a drain is already running; its loop will pick up the new dirty state
  oidentdWriting = true;
  oidentdWriteInFlight = drainOidentdWrites();
}

async function drainOidentdWrites(): Promise<void> {
  // Yield once so a synchronous burst of (un)registrations coalesces into the
  // first pass instead of writing per event.
  await new Promise<void>((r) => setImmediate(r));
  while (oidentdDirty && !oidentdStopped) {
    oidentdDirty = false;
    await writeOidentdFile();
  }
  // No await between the final dirty check above and here, so a registration
  // that arrives after this sees oidentdWriting=false and starts a fresh drain —
  // no lost update.
  oidentdWriting = false;
}

// Test-only: resolve once the current drain (if any) has fully settled.
export function whenOidentdSettled(): Promise<void> {
  return oidentdWriteInFlight;
}

// Test-only: clear module state between cases. Production drives this through
// initOidentdFile (boot) / stopOidentdFile (shutdown).
export function resetOidentdStateForTest(): void {
  oidentdDirty = false;
  oidentdWriting = false;
  oidentdStopped = false;
  lastOidentdWriteErrorAt = 0;
  oidentdWriteInFlight = Promise.resolve();
}

async function writeOidentdFile(): Promise<void> {
  const file = oidentdFilePath();
  if (!file) return;
  const content = formatOidentdConfig(idents.values());
  const tmp = `${file}.tmp`;
  try {
    // Write a sibling temp file then rename: rename is atomic within a
    // filesystem, so the host oidentd never reads a half-written config.
    await fs.promises.writeFile(tmp, content, 'utf8');
    // A shutdown may have truncated the file while this write was in flight;
    // don't rename our now-stale snapshot back over it.
    if (oidentdStopped) {
      await fs.promises.unlink(tmp).catch(() => {});
      return;
    }
    await fs.promises.rename(tmp, file);
  } catch (err) {
    // A write failure must never take down the server; throttle the warning so a
    // persistently unwritable path (bad mount, perms) can't flood the log.
    const now = Date.now();
    if (now - lastOidentdWriteErrorAt > 30_000) {
      lastOidentdWriteErrorAt = now;
      console.error(`[oidentd] failed to write ${file}: ${(err as Error).message}`);
    }
    // Best-effort: don't leave a temp file behind on a failed rename.
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// Write an initial (empty) file on boot, BEFORE initAll connects networks, so a
// stale file from a previous run can't serve dead 4-tuples in the window before
// live connections re-register. Synchronous by design: we want the fresh file on
// disk before any registration can race in.
export function initOidentdFile(): void {
  const file = oidentdFilePath();
  if (!file) return;
  // A fresh boot re-enables the writer after any prior stopOidentdFile.
  oidentdStopped = false;
  try {
    // Create the parent directory when the operator points at a not-yet-existing
    // path, so the mode doesn't silently no-op on every write (each writeOidentdFile
    // would otherwise throw ENOENT and only log, throttled).
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatOidentdConfig(idents.values()), 'utf8');
    console.log(
      `[oidentd] maintaining ${file} for a host oidentd (Lurker will NOT bind :113 for this) — ensure the host daemon reads this path and its :113 reaches your IRC servers`,
    );
  } catch (err) {
    console.error(
      `[oidentd] failed to initialize ${file}: ${(err as Error).message} — oidentd file mode will not work until this path is writable`,
    );
  }
}

// Truncate the file on shutdown so dead 4-tuple mappings don't linger for a
// local port the OS later reuses for an unrelated process.
export function stopOidentdFile(): void {
  // Block further writes FIRST: in-flight drains skip their rename, and the
  // disconnect-driven unregisters that ircManager.shutdown() fires next won't
  // schedule new writes — otherwise one of them would rename stale mappings
  // straight back over the header we're about to write.
  oidentdStopped = true;
  const file = oidentdFilePath();
  if (!file) return;
  try {
    fs.writeFileSync(file, OIDENTD_HEADER, 'utf8');
  } catch {
    // Shutting down; nothing useful to do if this fails.
  }
}
