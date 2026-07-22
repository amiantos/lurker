# Lurker Client Protocol & API — a guide for client authors

> **Audience:** third-party client authors (native apps, TUIs, alternative web
> clients). Last verified against server code 2026-07-21 (`main` @ `fefbeee`,
> protocol version **1**). The server source is authoritative; `file:line`
> references point into this repository.
>
> Reference implementations:
> [`vue_client/`](https://github.com/amiantos/lurker/tree/main/vue_client)
> (first-party web, cookie auth) and
> [`lurker-ios`](https://github.com/amiantos/lurker-ios) (native, Bearer auth).
> Where this doc says "the web client does X," that is reference-client policy,
> not protocol — noted as such.

---

## 1. Architecture in one page

Lurker's server is a **persistent IRC client** (a bouncer with a database). Your
client never speaks IRC. The server owns IRC parsing, TLS/SASL, reconnection,
history storage, highlight matching, ignore filtering, and push delivery. Your
client speaks two things:

1. **One WebSocket** at `/ws` — all realtime traffic, _including message history_.
   Every frame in both directions is a JSON object.
2. **A REST surface** under `/api/*` — auth, config, networks CRUD, settings,
   uploads, push registration, and other request/response management tasks.

The envelope discriminator differs by direction, and this asymmetry is load-bearing:

- **Server → client** frames carry a top-level **`kind`** field (`snapshot`,
  `backlog`, `irc`, `read-state`, …).
- **Client → server** messages carry a top-level **`type`** field (`send`, `join`,
  `mark-read`, …).

Concepts your client models: **networks** (IRC connections the user configured),
**buffers** (channel / DM / server-log / system conversations), **messages**
(one global id sequence), **members** (channel nicklists), and **read state**
(server-authoritative unread/highlight counts).

**Editions.** A server runs as `standalone` (self-hosted) or `node` (a hosted
lurker.chat cell behind the control plane at `app.lurker.chat`). Discover which —
and the protocol version — before doing anything else:

```
GET /api/config            (no auth)
→ { "edition": "standalone" | "node",
    "protocolVersion": 1,
    "minProtocolVersion": 1 }
```

Node edition disables `/api/api-tokens`, `/mcp`, and `/uploads/*` static serving;
standalone has no `/api/node/*`. The WS protocol itself is identical in both.
Health check: `GET /api/health` → `{"status":"ok","time":"<ISO 8601>"}` (no
auth, no version).

---

## 2. Compatibility contract

Defined in `server/protocol.ts`. The deal is:

- **Additive-only evolution.** New frame `kind`s, new event `type`s, and new fields
  may appear at any time. Existing fields are never repurposed. `protocolVersion`
  bumps only for a change the additive rule cannot express.
- **Unknown is never fatal — and your client must honor its half.** Ignore frame
  `kind`s you don't recognize, event `type`s you don't recognize, and fields you
  don't recognize. The server does the same: an unknown verb gets a non-fatal
  `{kind:'error', text:'unknown message type: …'}` and the socket stays open
  (`wsHub.ts:2900`).
- Announce your version on the upgrade: `/ws?v=1`. Omitting `?v` means "treat me
  as current" — **always send it** so a future `minProtocolVersion` bump rejects
  you cleanly (HTTP `426 Upgrade Required`) instead of feeding you frames you
  misparse. The `snapshot` frame also carries `protocolVersion`.

There is no capability negotiation beyond the version integer — no WS subprotocol,
no feature flags on the socket.

---

## 3. Authentication

Two credentials open every door (REST and WS); both resolve to the same
`sessions` row:

| Credential                      | Who uses it          | How                                                                                    |
| ------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Signed cookie `lurker_session`  | Browsers             | Set by the login endpoints; `httpOnly`, `SameSite=Lax`, 30-day                         |
| `Authorization: Bearer <token>` | Native / TUI clients | Token from the mint endpoints below; sent on every REST call **and on the WS upgrade** |

Browsers can't set headers on a WS upgrade, hence the cookie path. Native clients
should use Bearer exclusively.

### 3.1 Self-hosted: mint a token

```
POST /api/auth/login/token          (no auth; failure-throttled)
{ "username": "...", "password": "..." }
→ 200 { "token": "...", "expiresAt": "<ISO8601>", "user": { "id", "username", "role" } }
→ 401 invalid credentials · 429 throttled (see §3.4)
```

The token is an opaque 32-byte base64url session token (`routes/auth.ts:558`,
`db/sessions.ts:17`) — the same value the cookie would carry, returned in the body.

- **Lifetime:** 30 days, fixed. **No refresh token** — re-login to renew.
  Expired tokens are deleted on lookup, plus an hourly purge.
- **Revoke:** `POST /api/auth/logout` with the Bearer deletes the row
  (per-device revoke). Password reset does not revoke other devices' cell
  sessions on standalone; each session is its own row.
- Store it in the platform keychain/keystore. The iOS app uses a Keychain
  generic-password item with after-first-unlock accessibility so background
  reconnects work (`SessionStore.swift:29`).
- Mint is **password-only**. A passkey-only account can't mint a native token
  until it sets a password (`PUT /api/auth/password`). Surface that case: the
  mint endpoint just returns 401.

### 3.2 Hosted (`app.lurker.chat`): mint at the control plane

```
POST https://app.lurker.chat/_cp/auth/app/login     (no auth)
{ "email": "...", "password": "..." }
→ 200 { "token": "..." }
```

(`lurker-ios` `Backend.swift:26-39`.) The hosted token is a signed, **chat-scoped**
claim: it works for all proxied chat traffic (REST + WS against
`app.lurker.chat`) but is rejected on control-plane account/billing routes —
account administration stays on the web. Revocation is **global-only** (password
reset invalidates every session, via the session epoch); there is no per-device
revoke on hosted. After minting, use the token exactly as in §3.1 — same header,
same endpoints — the control plane proxies you to the right cell transparently.

### 3.3 Browser flows (for completeness)

WebAuthn/passkey and password login endpoints (`/api/auth/setup*`, `/invite/*`,
`/login/options|verify|password`, `/passkeys*`) set the `lurker_session` cookie
and are designed for the first-party web client; a native client doesn't need
them. `GET /api/auth/auth-methods` → `{passkey:boolean}` tells a login form what
to offer. `GET /api/auth/me` → `{user:{id,username,role,is_paused}}` validates a
session.

### 3.4 Cross-cutting auth behavior

- **401 semantics:** any `401` from `/api/*` or a refused WS upgrade means _dead
  session_ — clear the stored token and return to login. The server deliberately
  never uses 401 for downstream failures (upload provider errors are 502/400),
  so you can trust it.
- **Rate limiting:** credential endpoints allow 10 failures / 15 min / IP →
  `429` + `Retry-After`; the whole `/api/auth` router is capped at 60 req/min/IP.
  Honor `Retry-After`.
- **Paused accounts** (hosted billing): every authed non-GET REST call returns
  `403 {"error":"account paused"}` (except logout and exports), and write-verbs
  on the WS return `{kind:'error', text:'account paused'}`. The
  `{kind:'account-state', paused:bool}` frame notifies live. Treat paused as
  read-only mode, not an error loop.
- **No CSRF tokens** exist; browser security rests on `SameSite=Lax` + the CORS
  allowlist (`CORS_ORIGIN` env, credentials mode). Native clients are unaffected.
- Global JSON body limit: **1 MB** (`app.ts:67`).

---

## 4. The WebSocket

### 4.1 Upgrade

```
GET /ws?v=1&since=<highest-message-id-seen>
Authorization: Bearer <token>        (native; browsers ride the cookie)
```

- Rejections are raw HTTP status lines before the upgrade completes
  (`wsHub.ts:1694-1718`), in order: `403` (browser Origin not same-origin or
  allowlisted — native clients send no Origin and pass), `426` (`?v` below
  `minProtocolVersion`), `401` (bad/missing credentials).
- `?since` is your resume cursor — the highest **persisted message id** your
  client has ever seen (see §4.4). Omit or `0` for a fresh connect.

### 4.2 Frame plumbing

- JSON text frames only. Max **inbound** frame: 256 KiB (uploads go over REST).
- Flood control: per-socket token bucket, capacity 120, refill 40/sec. Exhaustion
  → `{kind:'error', text:'message rate exceeded'}` then close `1008`. Don't
  machine-gun verbs; batch where the protocol lets you.
- Malformed JSON → `{kind:'error', text:'invalid json'}`; socket stays open.
- **Heartbeat is WS-level ping/pong, not JSON.** The server pings every 30 s and
  terminates sockets that don't pong by the next sweep. Browser and most WS
  libraries auto-pong; if yours doesn't, implement it or you'll be dropped every
  ~60 s. There is no application-level ping message.
- Delivery is at-most-once per socket, no per-frame acks. Reliability comes from
  the id cursor + reconnect gap-fill (§4.4), not from the transport.

### 4.3 Connect: the snapshot burst

On every successful connect the server immediately sends a **burst of separate
frames**, synchronously, in this order (`wsHub.ts:1828`):

1. `{kind:'snapshot', protocolVersion, networks:[…], globalIgnores:[…], cursor?}`
   — full live state for every network (see §5.1). `cursor` (present only on a
   fresh connect) is the current global max message id: **seed your resume
   cursor from it**, because the shell backlogs that follow carry no rows and
   would otherwise leave your cursor at 0.
2. `{kind:'draft-snapshot', drafts}` — saved per-buffer input drafts.
3. `{kind:'bookmark-ids-snapshot', ids:[…]}` — bookmarked message ids.
4. A `backlog` frame for the app-scoped **system buffer** (`networkId:null`,
   `target:':system:'`).
5. `{kind:'contacts-snapshot', contacts:[…]}` — the friends/contacts list.
6. One `backlog` frame per open buffer on each connected network.
7. Per **offline** network: a real backlog for its `:server:` log, shells for
   its channels/DMs.

There is no "end of burst" marker; after frame 1 you can render progressively.

**Shells vs. hydrated backlogs.** On a fresh connect (`since=0`) channel/DM
buffers arrive as _shells_: `{kind:'backlog', …, events:[], hasMoreOlder:true}` —
"this buffer exists; fetch content when the user opens it." Hydrate a shell with
either `{type:'open-buffer'}` (server replies with a populated `backlog` — the
iOS approach) or `{type:'history', mode:'latest'}` (the web-client approach).
Both are valid; pick one.

### 4.4 Reconnect and resume (`?since`)

Every persisted message has an id from **one global monotonic sequence** across
all buffers (SQLite rowid — `db/messages.ts:115`). Track the highest id you have
ever seen and present it as `?since` on reconnect; the server then ships, per
buffer, only events with `id > since`.

Rules that keep resume correct:

- **The system buffer has a separate id sequence. Never feed its ids into your
  cursor.** Only events with `networkId != null` advance it. Getting this wrong
  corrupts resume for every other buffer (web: `useSocket.ts:461`; iOS:
  `LurkerStore.swift:339`).
- Ephemeral events (§7.2) have no `id`; they never advance the cursor.
- Per buffer, a resume gap is capped at **500** events. If the true gap is
  larger, the server instead sends the latest **200** with **`reset:true`** —
  meaning _replace this buffer's contents wholesale; do not splice_ (there would
  be a hole). `buildResumeSlice`, `wsHub.ts:771`.
- An in-band `{type:'snapshot'}` message re-runs the whole burst as a gap-fill
  from the server's tracked cursor for your socket — useful after long
  background/hidden periods without dropping the socket (the web client does
  this after >30 s hidden).
- Reconnect policy is yours; references: web = flat 2 s retry; iOS = exponential
  1→30 s, reset on first received frame, short-circuited by reachability
  changes. **Signal "connected" on the first received frame, not on socket
  open** — a refused upgrade looks like an open-then-close to some WS APIs
  (`LurkerClient.swift:172`).

---

## 5. Data model

### 5.1 Network snapshot blob

One per network inside `kind:'snapshot'` (`ircConnection.snapshot()`,
`ircConnection.ts:4315` + `ircManager.ts:765`):

```
{ networkId, state,                    // 'connecting'|'connected'|'reconnecting'|'disconnected'
  nick, userModes, lagMs,
  multilineLimits,
  away: { active, since, message, autoSet, backAt } | null,
  channels: [ { name, topic, modes,
                members: [ { nick, modes: [], away, user, host, account } ] } ],
  peerPresence: { "<lowercased nick>": { nick, state, stateAt, awayMessage } },
  pinned: [], collapsedNicklists: {}, channelNotify: {},
  ignoredMasks: [], nickNotes: [], relayBots: [] }
```

Offline networks appear with `state:'disconnected'`, `channels:[]`,
`peerPresence:{}`. The snapshot does **not** include network display
names/hosts — fetch `GET /api/networks` for the roster (the iOS app does this
before opening the socket; it doubles as a token validity check).

Member `modes` are **prefix-mode letters, highest first** (`q a o h v`), _not_
sigils (`~ & @ % +`). Map to sigils yourself for display.

### 5.2 Buffers

A buffer is one conversation: `kind ∈ channel | dm | server | system`. **The
server owns buffer existence and open/closed state** (a real `buffers` table
row per user/network/target). Clients never decide that a buffer exists — they
_materialize_ their local model in response to specific frames, and only those
(§9.1). Identity is `(networkId, case-folded target)`; two pseudo-buffers use
sentinel targets:

- `:server:` — per-network server log (`networkId` set, target literally
  `":server:"`). Uncloseable. Catch-all for server-voice text (§7.3).
- `:system:` — app-scoped Lurker log (`networkId: null`). Read-mostly; carries
  `type:'system'` events. Separate id space (§4.4).

Sentinel targets are exact-match, never case-folded. (The web client's
`:friends:` is a purely client-side virtual view — not a wire concept; ignore
it.)

**Case folding:** IRC targets are case-insensitive and servers echo
inconsistently-cased names. Fold with **ASCII `toLowerCase`** for identity;
keep the first/canonical casing for display. RFC 1459 casemapping (treating
`{}|^` as the lowercase of `[]\~`) is deliberately **not** implemented anywhere
in Lurker — match that, don't "fix" it unilaterally.

### 5.3 Messages (`MessageEvent`)

Common fields on every **persisted** event (`db/messages.ts:31` +
`decorateMessage`, `wsHub.ts:430`):

```
{ id, networkId, target, time,        // ISO 8601 — see the note below
  type,                               // see §7.2
  nick, text, kind,                   // kind = raw IRC command; see the ⚠ below
  self,                               // you sent it (any of your clients)
  userhost, alt, mirrored, dm,
  matched, matchedRuleId,             // highlight decoration
  fromIgnored, notifyAlways, notify,
  msgid? }                            // IRCv3 server message id, when supplied
```

plus type-specific extras (`newNick`, `kicked`, `modes`, `members`, …).
**Ephemeral** event types (§7.2) carry no `id`.

**`time` is IRCv3 server-time** where the network offers it (the `@time=` tag),
receive time otherwise. Far-future stamps (> ~2 min ahead) fall back to receive
time. Rows persisted before this existed carry receive time. Because a bouncer
upstream can replay old messages live, `time` is **not** guaranteed monotonic
with respect to `id` — order and dedupe by `id`, always (§9.3).

**`msgid`** is the server-assigned IRCv3 message id (`message-tags` networks;
own sends learn theirs via `echo-message`). Absent — not null — on rows from
untagged networks and on optimistic self echoes. It is the future anchor for
react/reply; today it is informational only.

**`notify` is the server's delivery decision — the one flag to gate a live
alert (toast, sound, native buzz) on.** It is the union of the content signals
(`matched`, `dm`, `notifyAlways`) with the user's ignore/mute verdict **already
applied**. A **NONOTIFY** rule — a muted channel, network, DM, or sender (§6
`add-ignore`) — forces `notify:false` while the message is still delivered and
still counts toward unread; only the alert is suppressed. A hide-level ignore
also forces `notify:false`, but that message is _additionally_ excluded from
unread/highlight counts server-side (the `from_ignored` stamp) and hidden by
your render filter — so don't count it. So a muted-channel highlight arrives as
`matched:true, notify:false` — style it as a highlight in history, but do
**not** raise a notification for it. **Do not re-implement ignore
matching client-side for this decision** — the server owns it (it must: push
fires when no client is attached, so the veto can't live only in a client).
The raw signals stay on the wire beside `notify` so you can still pick the
toast kind / sound per signal type. Note a **NOHIGHLIGHT** rule is display-only
(it clears `matched`, not `notify`), so a de-highlighted DM still notifies —
`notify` and the client-applied render/hide filter (from the snapshot's
`globalIgnores` / `ignoredMasks`) are two different jobs: the server pre-resolves
the _notify_ verdict into this flag; you apply the _hide_ verdict yourself.

> ⚠ **Live-frame `kind` clobber.** When an event arrives live it is wrapped as
> `{...event, kind:'irc'}` — the event's own `kind` field is overwritten by the
> envelope discriminator. The raw-IRC-command `kind` (`privmsg`, `action`,
> `notice`, …) survives only inside `backlog`/`history` `events[]`. Dispatch on
> `type`, never on an event's `kind`.

### 5.4 Read state

Server-authoritative, per buffer:
`{networkId, target, lastReadId, unread, highlights, highlightsCapped}` —
broadcast to **all** the user's sockets after every countable event and every
mark-read. Never count unread locally (§9.4).

---

## 6. Client → server verbs

All messages are `{type:'<verb>', …}`. Any message carrying a `networkId` for a
network you don't own gets `{kind:'error', text:'unknown network'}`. Unknown
verbs are non-fatal (§2). Verbs marked ⏸ are rejected when the account is
paused. Dispatch: `handleClientMessage`, `wsHub.ts:2031`.

### Sending ⏸

| `type`   | Fields                                             | Notes                                                                            |
| -------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `send`   | `networkId, target, text, clientId?`               | PRIVMSG. Ack via `send-result` iff `clientId` present                            |
| `action` | `networkId, target, text, clientId?`               | CTCP ACTION (`/me`)                                                              |
| `notice` | `networkId, target, text, clientId?`               | NOTICE                                                                           |
| `raw`    | `networkId, line`                                  | Raw IRC line — the escape hatch for `/mode`, `/kick`, `/whois`, unknown commands |
| `ctcp`   | `networkId, target, ctcpType, args, issuingTarget` | CTCP request (`/ping`, `/version` at a user)                                     |

**Ack contract:** include a client-generated `clientId` on `send`/`action`/
`notice` and the server replies `{kind:'send-result', clientId, ok, error?}`.
This confirms acceptance only — the message itself comes back as a normal `irc`
echo with `self:true` and its real id (§9.3). The web client times acks out
after 8 s (client policy). On networks that ACK `echo-message` upstream, that
`self:true` frame arrives only after the IRC server reflects the send back (one
upstream round trip, carrying the real `msgid` + server `time`); elsewhere it
is emitted immediately from the server's optimistic local copy.

### Channels & buffers ⏸

| `type`         | Fields                        | Notes                                                                                                                   |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `join`         | `networkId, channel, key?`    | Request only — the buffer appears on `channel-joined` (§9.1)                                                            |
| `part`         | `networkId, channel, reason?` | Buffer survives, parted                                                                                                 |
| `open-buffer`  | `networkId, target`           | Reopen/create: replies `backlog` + `buffer-opened`; JOINs if an unjoined channel; mints an empty DM row for a bare nick |
| `close-buffer` | `networkId, target, reason?`  | Closes (PARTs a joined channel, untracks a DM peer). `:server:` refuses                                                 |

### View state (persisted server-side, fanned out to your other devices)

| `type`                            | Fields                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mark-read`                       | `networkId, target, messageId` — MAX-clamped server-side, idempotent. System buffer: `networkId: null, target: ':system:'` (send an explicit null, don't omit)                                                                                                                                                                                    |
| `mark-all-read`                   | —                                                                                                                                                                                                                                                                                                                                                 |
| `clear-buffer` / `unclear-buffer` | `networkId, target`                                                                                                                                                                                                                                                                                                                               |
| `pin-buffer` / `unpin-buffer`     | `networkId, target`                                                                                                                                                                                                                                                                                                                               |
| `reorder-pins`                    | `networkId, targets:[…]`                                                                                                                                                                                                                                                                                                                          |
| `set-nicklist-collapsed`          | `networkId, target, collapsed`                                                                                                                                                                                                                                                                                                                    |
| `set-channel-notify-always`       | `networkId, target, notifyAlways`                                                                                                                                                                                                                                                                                                                 |
| `draft-set` / `draft-clear`       | `networkId, target, body?`                                                                                                                                                                                                                                                                                                                        |
| `input-history-add`               | `networkId, target, text`                                                                                                                                                                                                                                                                                                                         |
| `set-bookmark` / `unset-bookmark` | `messageId`                                                                                                                                                                                                                                                                                                                                       |
| `set-nick-note`                   | `networkId, nick, note`                                                                                                                                                                                                                                                                                                                           |
| `set-relay-bot`                   | `networkId, nick, marked, pattern`                                                                                                                                                                                                                                                                                                                |
| `set-contact` / `delete-contact`  | `contactId, displayName, notifyOnline, targets` / `contactId`                                                                                                                                                                                                                                                                                     |
| `add-ignore` / `remove-ignore`    | `networkId` (null = global), `rule`/`mask` / `id`/`mask`. `rule` = `{mask (null or '*' = anyone), channels?, pattern?, patternKind: substr\|full\|regex, levels? (default ALL), isExcept?, expiresAt?}` (`ignoreRuleInput.ts`). Channel/network **muting** is expressed here — a rule with no mask scoped to a channel — not via a dedicated verb |

### Presence & status

| `type`              | Fields                     | Notes                                                                               |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `presence`          | `visible: bool`            | **Per-socket, resets to `false` on every new socket** — re-assert on connect (§9.5) |
| `typing` ⏸          | `networkId, target, state` | Sends `+typing` TAGMSG                                                              |
| `away` ⏸ / `back` ⏸ | `message` / —              | User-scoped: hits every network                                                     |
| `probe-presence` ⏸  | `networkId, nick`          | Silent WHOIS; answer arrives as a `peer-presence` event                             |

### Sync & fetch

| `type`            | Fields                                                                                                      | Reply                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `snapshot`        | —                                                                                                           | Re-runs the snapshot burst as a gap-fill (§4.4)  |
| `history`         | `networkId, target, mode: before\|after\|around\|latest, limit (1–500), token?, before?/afterId?/anchorId?` | `{kind:'history'}` (§8)                          |
| `search`          | `query, networkId?, target?, nick?, nicks?, before?, limit?, token?`                                        | `{kind:'search-result'}`                         |
| `list-channels` ⏸ | `networkId`                                                                                                 | Kicks off `/LIST`; progress via `chanlist-state` |
| `chanlist-search` | `networkId, query, sortBy, sortDir, offset, limit`                                                          | `{kind:'chanlist-result'}`                       |

### E2E (RPE2E, per-channel opt-in)

`e2e` ⏸ (`networkId, target, args`), `e2e-export` (`networkId`) →
`{kind:'e2eExport'}`, `e2e-import` (`networkId, json`) → `{kind:'e2eImport'}`.
Status lines surface as ephemeral `type:'e2e'` events. Niche — safe to skip in
a v1 client.

---

## 7. Server → client frames

### 7.1 Frame kinds

| `kind`                                                                                                                                                                   | Payload                                                                                                                                                             | When                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `snapshot`                                                                                                                                                               | `protocolVersion, networks[], globalIgnores[], cursor?`                                                                                                             | Connect burst / gap-fill                           |
| `draft-snapshot` / `bookmark-ids-snapshot` / `contacts-snapshot`                                                                                                         | `drafts` / `ids[]` / `contacts[]`                                                                                                                                   | Connect burst                                      |
| `backlog`                                                                                                                                                                | `networkId, target, events[], reset?, hasMoreOlder, joined, lastReadId, unread, highlights, highlightsCapped, clearedBeforeId, clearedAt, speakers?, inputHistory?` | Burst, `open-buffer` reply, resume gap             |
| `irc`                                                                                                                                                                    | A decorated `MessageEvent` (§5.3) with `kind` clobbered to `'irc'`                                                                                                  | Every live IRC-side event                          |
| `history`                                                                                                                                                                | `networkId, target, mode, token, events[], speakers, hasMoreOlder, hasMoreNewer, hasMore, before/afterId/anchorId/anchorMissing` (per mode)                         | Reply to `history`                                 |
| `read-state`                                                                                                                                                             | see §5.4                                                                                                                                                            | After every countable event / mark-read            |
| `send-result`                                                                                                                                                            | `clientId, ok, error?`                                                                                                                                              | Ack for `send`/`action`/`notice`                   |
| `buffer-opened` / `buffer-closed` / `buffer-reopened`                                                                                                                    | `networkId, target`                                                                                                                                                 | Buffer lifecycle (§9.1)                            |
| `buffer-cleared`                                                                                                                                                         | `networkId, target, clearedBeforeId, clearedAt`                                                                                                                     | `/clear` marker                                    |
| `pins-changed`                                                                                                                                                           | `networkId, pinned[]`                                                                                                                                               | Authoritative pin order                            |
| `nicklist-collapsed-changed` / `channel-notify-changed`                                                                                                                  | `networkId, target, …`                                                                                                                                              | View-state sync                                    |
| `draft-updated` / `input-history-added` / `bookmark-updated` / `nick-note-updated` / `relay-bot-updated` / `contact-updated` / `contact-deleted` / `ignore-list-updated` | various                                                                                                                                                             | Multi-device view-state fan-out                    |
| `settings`                                                                                                                                                               | `changes`                                                                                                                                                           | Server-side settings changed                       |
| `highlight-rules-changed`                                                                                                                                                | —                                                                                                                                                                   | Re-fetch highlight rules                           |
| `account-state`                                                                                                                                                          | `paused: bool`                                                                                                                                                      | Hosted pause/resume                                |
| `chanlist-state` / `chanlist-result`                                                                                                                                     | `/LIST` cache meta / result page                                                                                                                                    | Channel browser                                    |
| `e2eExport` / `e2eImport`                                                                                                                                                | E2E key material / import result                                                                                                                                    | Replies, this socket only                          |
| `dcc-transfer`                                                                                                                                                           | full transfer row (snake_case)                                                                                                                                      | DCC state changes                                  |
| `upload-progress`                                                                                                                                                        | `token, phase, destination, percent`                                                                                                                                | During REST upload (correlate via `progressToken`) |
| `export`                                                                                                                                                                 | `job`                                                                                                                                                               | Export job progress                                |
| `error`                                                                                                                                                                  | `text`                                                                                                                                                              | Non-fatal; also the reply to unknown verbs         |

### 7.2 `irc` event types (the inner `type` field)

Also the `type` of rows inside `backlog`/`history` `events[]`. **P** = persisted
(has `id`, advances the cursor); **E** = ephemeral (no `id`).

| `type`                        | P/E | Extra fields / meaning                                                        |
| ----------------------------- | --- | ----------------------------------------------------------------------------- |
| `message`                     | P   | PRIVMSG (`kind:'privmsg'` in stored rows)                                     |
| `action`                      | P   | `/me`                                                                         |
| `notice`                      | P   | `mirrored:true` on the `:server:` copy of a notice to a closed/absent DM      |
| `join`                        | P   | `account?`                                                                    |
| `part` / `quit`               | P   | `text` = reason                                                               |
| `kick`                        | P   | `kicked`, `text`                                                              |
| `nick`                        | P   | `newNick`                                                                     |
| `own-nick`                    | E   | your nick changed — `nick` is the new one                                     |
| `mode`                        | P   | `text`, `modes[]`                                                             |
| `usermode`                    | E   | your user modes, whole string                                                 |
| `topic`                       | P   | a topic _change_ (renders as a line)                                          |
| `channel-topic`               | E   | RPL_TOPIC on join — set state, render nothing                                 |
| `channel-modes`               | E   | full channel mode string                                                      |
| `channel-joined`              | E   | **you** are in the channel — the materialization signal (§9.1)                |
| `channel-parted`              | E   | you left/were removed — mark parted, keep history                             |
| `join-error`                  | E   | join failed — `text`, `reason`; do **not** create a buffer                    |
| `names`                       | E   | `members[…]` — full nicklist replace                                          |
| `member-update`               | E   | `member{…}` — single-nick patch (away/account/host changes)                   |
| `invite`                      | E/P | you were invited (`channel`, `from`) / op-visibility variant                  |
| `state`                       | E   | network `state` + `nick` on connect — drive the connection indicator          |
| `motd`                        | P   | MOTD **and all otherwise-unclassified server text** (§7.3)                    |
| `error`                       | P   | server error text; `unknownCommand?` for 421s                                 |
| `system`                      | P\* | system-buffer line; severity in `level: info\|warn\|error`, not in `type`     |
| `away-state`                  | E   | your own away state per network                                               |
| `peer-presence`               | E   | `nick, state ∈ online\|offline\|away\|back, stateAt, awayMessage, cameOnline` |
| `typing`                      | E   | `nick, state ∈ active\|paused\|done`                                          |
| `lag`                         | E   | `lagMs`                                                                       |
| `ctcp`                        | E   | CTCP request/reply status text                                                |
| `chghost`                     | P   | `newIdent, newHost` — render only; the nicklist patch rides `member-update`   |
| `e2e`                         | E   | RPE2E status, `level` + `text`                                                |
| `chanlist-start/progress/end` | E   | `/LIST` refresh progress                                                      |

\*`system` rows persist in their own table with their own id sequence — see §4.4.

### 7.3 Where server text lands

Events of type `motd`, `error`, `e2e`, `ctcp` may arrive with **no `target`**.
Route them to that network's `:server:` buffer. `motd` is deliberately the
catch-all for all "server voice" text that has no better home — don't build a
taxonomy on top of it. `system` events (with `networkId:null`) belong to
`:system:`.

---

## 8. History & backlog merging

All history flows over the WS. Request `{type:'history', mode, …}`; one reply
`{kind:'history'}`. `limit` clamps to 1–500. History is DB-backed and
connection-independent — offline networks still serve it.

| `mode`             | Request keys            | Semantics                                                         | Merge                                                 |
| ------------------ | ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `before` (default) | `before` (exclusive id) | Older page (scroll up)                                            | **Prepend**, dedupe by id                             |
| `after`            | `afterId`               | Newer page (scroll down while detached)                           | **Append**, dedupe by id                              |
| `around`           | `anchorId`              | Jump-to-message window (max `2×limit+1`); `anchorMissing` if gone | **Replace** slice; buffer is now _detached_ from live |
| `latest`           | —                       | Newest slice; hydrates a shell; includes `inputHistory`           | **Replace**; buffer is live again                     |

`hasMoreOlder` / `hasMoreNewer` gate the pagers (`hasMore` is a legacy alias of
`hasMoreOlder`). Echo the request `token` discipline the web client uses if you
pipeline requests: keep a monotonically increasing token and drop any reply
whose token you've superseded.

**Jump-to-message detaches the buffer** (Discord/Slack convention): after
`around`, live events for that buffer should _not_ be spliced into the visible
slice (track them separately or refetch); `latest` reattaches.

**Merge rules that protect you from data loss:**

1. `backlog` with `reset:true` → replace the buffer's contents wholesale
   (resume gap overflowed; splicing leaves a hole).
2. `backlog` without a `reset` field, or the system buffer's backlog (which
   hardcodes `reset:false` but means "replace") → replace. Only
   `networkId != null` **and** `reset === false` means gap-append. (iOS
   `FrameParser.swift:104-111`; web detects the non-overlap case instead.)
3. **Never un-hydrate:** a later shell (`events:[]`) for a buffer you already
   populated must not wipe it.
4. On any replace, **keep held live events newer than the slice tail** — a
   message can land mid-hydrate.
5. Dedupe everything by id against what you hold; drop legacy `away`/`back`
   rows if you encounter them in old history.
6. The web client caps its in-memory ring at 500 events/buffer and pages the
   rest — policy, not protocol, but a sane default.

---

## 9. Rules your client must get right

The tribal-knowledge section. Every one of these was a real bug once.

### 9.1 Buffer materialization

The server decides existence; your client mirrors it in response to exactly
these signals:

- **A channel buffer materializes on `channel-joined` — never on the join
  request.** `{type:'join'}` is intent; record it as pending (the web client
  keeps a 10 s timeout that surfaces "no response joining"). `join-error`
  cancels the intent and creates nothing — a 470 forward means the channel you
  _asked for_ never existed; the channel you were _forwarded to_ announces
  itself with its own `channel-joined`.
- **A DM materializes on an incoming persisted `message`/`action`**, or locally
  when the user initiates one (send + activate, or `open-buffer` on a bare
  nick — the server persists an empty DM row, which survives reloads).
- **`buffer-closed` → drop the buffer from your model entirely** (messages,
  drafts, membership). Closed = absent.
- **`buffer-reopened` needs no handler** — the message that caused the reopen
  arrives as a normal `irc` event and materializes the buffer via the DM rule.
- **`channel-parted` → resolve, never materialize**: mark parted, clear members,
  keep the buffer and history. If you have no such buffer, ignore it.
- **Never materialize from ambient signals:** `typing`, `member-update`, and
  `read-state` for unknown buffers must resolve-or-drop. (`mark-all-read` fans
  out `read-state` for _closed_ buffers too — resurrecting them in the sidebar
  was bug #319; typing-tag DM creation was #292.)
- NOTICEs never create or reopen a DM — a notice to a closed/absent DM arrives
  on `:server:` with `mirrored:true`. Already handled server-side; just don't
  special-case it.

### 9.2 Identity & case

Fold targets with ASCII lowercase for identity; sentinels (`:server:`,
`:system:`) exact-match; first-seen casing is display-canonical (§5.2).

### 9.3 Sending: no optimistic rendering

Do **not** locally append sent messages. Send `{type:'send', clientId}`; the
authoritative row echoes back as an `irc` event with `self:true` and the real
id — that's when it renders. `send-result` only tells you accepted/failed (drive
a spinner or an error toast from it). This is what makes multi-device echo,
ids, and ordering trivially correct. Consequences:

- A dead socket at send time = keep the input text, tell the user; nothing was
  sent.
- Your own echoes count for dedupe and cursor like any other event; skip
  self-events when building tab-completion "recent speakers".

### 9.4 Read state is server-authoritative

Render `read-state` verbatim; never count locally. Send `mark-read` with the id
the user has seen — the server MAX-clamps, so re-sending stale ids is safe.
Mark on focus-**in** and on live messages while focused (focus-out marking
loses the tab-close race). The unread divider is client policy: snapshot
`lastReadId` when the buffer becomes active and pin it until switch-away.
App badge = Σ `highlights` across buffers; recompute on every `read-state`
(a push notification can only _revise_ the OS badge, your client must correct
it when the user actually reads).

### 9.5 Presence is per-socket and explicit

Every new socket starts `visible:false`. Assert `{type:'presence',
visible:true}` when your UI is actually in front of the user, `false` when it
leaves — **and re-assert after every reconnect**. Presence is what gates push
(no push while any client is visible) and auto-away (no visible client for
`away.auto.delay_seconds` → server sets away). An open socket is deliberately
_not_ presence: a backgrounded phone keeps its socket and must still get push.
On mobile, flush `presence:false` before suspension if the platform allows; the
server's heartbeat reaper (~60 s) is the fallback.

### 9.6 Ordering & dedupe

Per buffer, apply a persisted event only if its id is greater than the newest
you hold; **run side effects (nicklist mutations, topic set, notification,
unread sounds) only when the event was fresh**. Replays happen by design
(resume overlap, backlog/live races) — the topic-revert and double-join-line
bugs both came from mutating state below a missing dedupe check. Membership
side effects ride the same events you render: `join`→add member, `part`/`quit`→
remove, `kick`→remove `kicked`, `nick`→rename (`chghost` renders only; its
nicklist patch arrives separately as `member-update`).

---

## 10. HTTP API reference

Everything `requireAuth` unless noted. Errors are `{"error": "<message>"}` (some
add `key`/`code`/`status`). Exact multipart field names matter.

### Networks — `/api/networks`

| Method & path                                      | Body / notes                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                            | → `{networks:[…]}`. Passwords never returned — `has_password` / `has_sasl_password` booleans instead                                                                                                                                                         |
| `POST /`                                           | `{name*, host*, port, tls, nick*, username, realname, server_password, autoconnect, sasl_account, sasl_password, default_channel, connect_commands, trusted_certificates}` → `201 {network}`, connects immediately. `403` if host blocked by admin allowlist |
| `PATCH /:id` · `DELETE /:id`                       | Partial update / delete                                                                                                                                                                                                                                      |
| `POST /reorder`                                    | `{ids:[…]}` (409 on set mismatch, returns authoritative order)                                                                                                                                                                                               |
| `POST /:id/connect` · `/disconnect` · `/reconnect` | `disconnect` takes `{reason?}`                                                                                                                                                                                                                               |
| `POST /:id/join` · `/part`                         | `{channel*, key?}` / `{channel*, reason?}`; `409` if not connected                                                                                                                                                                                           |

`GET /api/network-presets` → `{presets, allowUserDefined}` for the add-network
form.

### Settings & personalization

| Endpoint                      | Notes                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/settings/bootstrap` | → `{registry, values}` — the registry is self-describing (types, defaults, enums); build your settings UI from it rather than hardcoding keys          |
| `PATCH /api/settings`         | `{changes:{key:value,…}}` → `{values}`; other devices get the `settings` frame                                                                         |
| `DELETE /api/settings/:key`   | Reset to default                                                                                                                                       |
| `/api/highlight-rules`        | CRUD: `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`                                                                                                   |
| `GET /api/highlights`         | Paginated highlight feed: `?limit (≤200), before, networkId, q, nick (repeatable), target` → `{items, nextBefore}`                                     |
| `GET /api/bookmarks`          | `?limit, before` → `{items, nextBefore}`                                                                                                               |
| `POST /api/drafts/flush`      | Beacon-style: raw text body containing JSON `{drafts:[{networkId,target,body}]}` → `204`. For page-unload flush; live clients use the `draft-set` verb |

### Uploads — `/api/uploads`

| Endpoint         | Notes                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /`         | `multipart/form-data`, file field **`image`**; optional `uploaderId`, `progressToken` (≤64 chars — progress arrives as `upload-progress` WS frames). → `{id, url, mime, can_delete, thumbnail_url?}`. `413` over cap, `415` rejected type, `502` provider error (never 401) |
| `GET /`          | `?before, limit, q, kind` → `{items, providers}`                                                                                                                                                                                                                            |
| `GET /:id/thumb` | Binary thumbnail                                                                                                                                                                                                                                                            |
| `DELETE /:id`    | `409` if not deletable                                                                                                                                                                                                                                                      |

`/api/uploaders` manages upload destinations (list/select/create/update/delete;
secrets write-only). Standalone serves local files publicly at
`GET /uploads/:key` (no auth, sandboxed CSP). Paste the returned `url` into a
message — the server does the rest.

### DCC — `/api/dcc` (403 unless enabled for the account)

`GET /?limit` list · `POST /:id/accept|reject|cancel`. Live updates via
`dcc-transfer` frames; file bytes move over IRC, not HTTP.

### Export / import

`GET /api/exports/preview` · `POST /api/exports` (`{include_messages}`, allowed
while paused, → `202 {job}`, progress via `export` frames) ·
`GET /api/exports/:id/download` (`.lurk` archive, Range-capable) ·
`POST /api/imports` (multipart, field **`archive`**, ≤500 MB; `409
account_not_empty`). A mobile/TUI client can skip all of this.

### Out of scope for third-party clients

- `/api/admin/*` — admin panel (users, invites, presence, instance uploaders/
  networks). Admin-gated; build against it only if you're making an admin tool.
- `/api/api-tokens` + `/mcp` (standalone only) — a _separate_ Bearer namespace
  for MCP/automation. **Those tokens cannot open the WS**; don't confuse them
  with session tokens.
- `/api/node/*` (node edition) — control-plane internal, fleet-secret gated.

---

## 11. Push notifications

`GET /api/push/config` → `{publicKey, transports}` where
`transports ⊆ ['webpush','apns','fcm']`, **filtered to what this server can
actually deliver**. This is the source of truth — check it before asking the OS
for notification permission.

| Endpoint                                  | Notes                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/push/devices`                  | `{token, transport: 'apns'\|'fcm'}` → `201`. Token validated by shape only. `503` if the transport isn't configured server-side |
| `DELETE /api/push/devices`                | `{token}` — **call before `POST /api/auth/logout`**, while the session still authenticates                                      |
| `POST/GET/DELETE /api/push/subscriptions` | Web Push (VAPID) subscription CRUD                                                                                              |
| `POST /api/push/heartbeat`                | `{endpoint}` — Web Push liveness                                                                                                |

> ### ⚠ Native push is effectively first-party-only today
>
> APNs/FCM delivery requires the **server** to hold push credentials for the
> _specific app_ a device token belongs to — the `.p8` signing key + bundle ID
> for iOS, the Firebase service account for Android. The hosted lurker.chat
> cells carry the official Lurker apps' credentials; therefore:
>
> - **Official clients + app.lurker.chat: push works.**
> - **Official clients + self-hosted: no native push** — the instance doesn't
>   (and can't) have the official signing keys. `GET /api/push/config` on a
>   self-hosted box reports `['webpush']` at most.
> - **Third-party clients: no native push anywhere.** This is structural, not a
>   policy gate: registration isn't checked against client identity, so on
>   hosted your `POST /api/push/devices` may return `201` — and delivery will
>   then _silently fail_, because the server signs with the official app's
>   credentials and APNs/FCM reject tokens belonging to a different app. Don't
>   burn hours debugging this; it cannot work.
>
> A **notification relay for self-hosters** (a Lurker-operated proxy the
> official apps could receive self-hosted pushes through — IRCCloud/Bitwarden
> style, or something UnifiedPush-shaped that could also serve third-party
> clients) is a design idea only. It is **not built and not a commitment**;
> do not architect against it.
>
> What third-party clients _can_ do today: **Web Push** works on any instance
> for browser-based clients; a TUI doesn't need push at all (it only matters
> when no client is attached — and presence gating already suppresses push
> while your client is visible). A native third-party app should treat
> "no push" as its baseline and lean on the `?since=` resume for fast catch-up.

Notification payload detail (for official-app parity): `networkId` and `target`
ride at the payload top level beside `aps`/`data` for tap-routing, and pushes
revise the OS badge — your client recomputes the true badge from `read-state`
(§9.4).

---

## 12. A minimal viable client

What the iOS app actually ships with (`FrameParser.parseWs`,
`LurkerStore.reduce`) — a useful floor for a v1:

- **Receive frames (7):** `snapshot`, `backlog`, `history`, `irc`,
  `read-state`, `send-result`, `error` — everything else safely ignored.
- **`irc` types rendered:** `message`, `action`, `notice`, `error`, `system`,
  `join`, `part`, `quit`, `nick`, `kick`, `mode`, `topic`, `motd`, `invite`
  (plus `channel-topic` for state). Unknown → drop.
- **Send verbs (8):** `presence`, `send`, `history` (`before`/`latest`),
  `mark-read`, `mark-all-read`, `join`, `open-buffer`, `close-buffer`.
- **REST (4):** `POST /api/auth/login/token` (or the CP login), `GET
/api/networks`, `POST /api/auth/logout`, and optionally `GET
/api/push/config`.

Known first-party gaps at this tier (fine to share): nicklist only as of last
snapshot (no live `names`/`member-update` patching), no typing/peer-presence,
no slash commands. **Slash commands are parsed client-side** — the server does
not interpret `/` in `send` text. Either implement a command table (translate
to typed verbs; fall back to `{type:'raw'}` for the rest — see
`MessageInput.vue:2670` for the reference table) or expose UI verbs directly
like iOS does. `/ns`/`/cs` style credential commands should go over `raw`
without local echo.

Suggested build order: config check → token mint → `GET /api/networks` → socket

- snapshot burst → render buffers/shells → hydrate on open → send with echo
  rendering → `mark-read` → resume cursor → reconnect policy → the §9 rules as
  you hit them.

---

## 13. Source-of-truth map

| Area                                                     | Files                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| WS upgrade, auth, snapshot burst, verb dispatch, fan-out | `server/services/wsHub.ts`                                                                                                  |
| IRC event production, network snapshot blob              | `server/services/ircConnection.ts`, `server/services/ircManager.ts`                                                         |
| Protocol version & compat rules                          | `server/protocol.ts`, `server/routes/config.ts`                                                                             |
| Message shape & id sequence                              | `server/db/messages.ts`                                                                                                     |
| Session auth (cookie + Bearer)                           | `server/middleware/auth.ts`, `server/routes/auth.ts`, `server/db/sessions.ts`                                               |
| REST routers                                             | `server/routes/*.ts` (mounted in `server/app.ts`)                                                                           |
| Shared portable data                                     | `shared/settingsRegistry.ts`, `shared/urlPattern.ts`                                                                        |
| Reference web client                                     | `vue_client/src/composables/useSocket.ts`, `vue_client/src/stores/buffers.ts`, `vue_client/src/components/MessageInput.vue` |
| Reference native client                                  | `lurker-ios/LurkerKit` (`LurkerClient.swift`, `LurkerStore.swift`, `FrameParser.swift`)                                     |
