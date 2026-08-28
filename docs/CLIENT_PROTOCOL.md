# Lurker Client Protocol & API — a guide for client authors

> **Audience:** third-party client authors (native apps, TUIs, alternative web
> clients). Last verified against server code 2026-08-06 (`theme-presets-foundation`,
> protocol version **1**; settings/themes sections updated for that branch — the
> rest last swept 2026-07-21, `main` @ `fefbeee`). The server source is
> authoritative; `file:line` references point into this repository.
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
    "minProtocolVersion": 1,
    "features": { "linkPreviews": false } }
```

`features` carries instance-level flags an operator turned on. Treat a missing
flag as **off** — an older server that doesn't advertise one doesn't have it.
Settings whose registry entry names a feature (`requiresFeature`) must be
**hidden**, not merely disabled, when that flag is false: there is no server
behind them, and the endpoints aren't mounted, so a toggle would do nothing.
`linkPreviews` gates `chat.inline_media.enabled`, `chat.link_previews.enabled`,
and the `/api/link-preview/*` endpoints.

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
frames**, synchronously, in this order (`wsHub.ts` `sendSnapshotInner`, 2293):

1. `{kind:'snapshot', protocolVersion, maxUploadBytes, networks, globalIgnores, cursor?}`
   — full live state for every network (see §5.1). `cursor` (present only on a
   fresh connect) is the current global max message id: **seed your resume
   cursor from it**, because the shell backlogs that follow carry no rows and
   would otherwise leave your cursor at 0. `maxUploadBytes` is the largest
   upload this account may send right now — see §Uploads.
2. `{kind:'draft-snapshot', drafts}` — saved per-buffer input drafts.
3. A `backlog` frame for the app-scoped **system buffer** (`networkId:null`,
   `target:':system:'`).
4. `{kind:'favorites-changed', favorites:[{networkId, target, bufferId}]}` —
   the user's favorite buffers in global order. Deliberately the SAME frame
   every later favorite/unfavorite/reorder correction uses (replace
   wholesale), so one handler covers seed and updates. Additive like frame 7:
   an older server never sends it — no frame ⇒ treat favorites as empty,
   don't wait on it.
5. One `backlog` frame per open buffer on each connected network.
6. Per **offline** network: a real backlog for its `:server:` log, shells for
   its channels/DMs.
7. `{kind:'backlog-complete'}` — terminal marker, nothing else in it.

Render progressively from frame 1; don't wait for the end.

**What frame 7 is for.** Until it arrives, "I have no row for this buffer _yet_"
and "there is no such buffer" are the same observation, and no amount of waiting
separates them. After it arrives, **absence is proof**: a buffer key with no
`backlog` frame is **not open** — for channels, DMs and `:server:` logs alike,
on connected and disconnected networks alike. That matters if you
navigate by **key** rather than by tapping a row that already exists (restoring
the last-read buffer at launch, opening one from a notification tap): without it
those screens sit on a spinner forever, because nothing ever says the row isn't
coming (#635).

**"Not open" is not "never existed", and the burst can't tell you which.** A
buffer the user closed from another client ships no frame either (it's dropped
from the enumeration — `wsHub.ts:609`), yet it keeps its full persisted history
and one `open-buffer` reopens it with that history intact. Both cases mean the
same thing for what you _render_ — it isn't in the buffer list — which is why
§9.1 models closed as absent. They differ for what you **destroy**: don't purge
local history, drafts, or a saved read position on the strength of a missing
frame, because the server hasn't forgotten any of it.

Two things that look like they'd answer the same question and don't:

- **`snapshot`'s per-network `channels` is not authoritative for buffer
  existence.** It's empty outright for any network with no live connection
  (paused account, manually disconnected, never autoconnected) even though
  those networks still own persisted buffers, and even on a live connection
  it's read at the `'connected'` instant — before auto-rejoin JOINs land. Judge
  membership from it and you'll decide a user left channels they're still in.
- **Don't probe with `open-buffer`.** For a `#channel` with no row the server
  reads that as "join it" (§9.1), so a probe silently re-JOINs a channel the
  user deliberately left from another client. `{type:'history', mode:'latest'}`
  (§4.3) is the read — it answers for any target without creating, reopening, or
  joining anything.

An older server never sends frame 7 (it's additive, and `protocolVersion` does
not move for it) — if you don't see one, keep whatever you do today rather than
concluding anything. A truncated burst withholds it too: the server only sends
it once the whole burst went out, so a snapshot that failed part-way through
never claims a buffer is missing.

**Shells vs. hydrated backlogs.** On a fresh connect (`since=0`) channel/DM
buffers arrive as _shells_: `{kind:'backlog', …, events:[], mode:'shell',
hasMoreOlder:true}` — "this buffer exists; fetch content when the user opens it."

Hydrate a shell with **`{type:'history', mode:'latest'}`**, and only with that.
It **changes nothing**: no reopen, no row minted, no JOIN, and nothing announced
to the user's other devices. Send it for any buffer you hold, as often as you
like. If you consolidate presence noise, send `countBy:'renderable'` with it —
or `countBy:'chat'` if you hide events entirely (§8). This is the fetch that
fills the first screenful, so it's where sizing a page in stored rows shows up
as a blank-looking channel.

It **always answers**, including for a target with no row and no history (an
empty `events` array). A client that spends one request per buffer can't tell
"no reply yet" from "never coming", so a silent branch would be a permanent
loading spinner.

It is also **not gated for paused accounts** — reading your own history is not a
write. That matters more than it sounds: see the warning below.

> ⚠ **`{type:'open-buffer'}` is a WRITE — don't hydrate with it.** It returns a
> populated `backlog` too, which is exactly why it was easy to reach for. But for
> a closed buffer with history it _reopens_ it (a persisted state flip), for a
> bare nick it mints a DM row, and for an unjoined `#channel` it JOINs. Hydrating
> with it means a user merely _opening a screen_ mutates state on every device
> they own — and since an open is now announced (below), visibly. Reserve it for
> explicit user intent ("open this DM", "join this channel"). Same hazard as the
> "don't probe with `open-buffer`" warning above, reached from a different
> direction.
>
> It is also gated for paused accounts, correctly, being a write. So a client
> that hydrates through it **cannot show a paused user anything at all**:
> `{kind:'error', text:'account paused'}`, then a loading spinner forever. That
> pairing is what makes this seam load-bearing rather than tidy — the paused gate
> has encoded it all along, and a client hydrating through the write verb was
> simply on the wrong side of it.

**A successful `open-buffer` is announced to the user's other devices**, which
receive a `backlog` **shell** for the buffer followed by `buffer-opened`. The
requesting socket gets its full backlog and the `buffer-opened` ack, and is
excluded from the announcement.

> ⚠ **`buffer-opened` is not a "focus this" instruction.** To the socket that
> asked, it's the reply resolving canonical casing, and focusing is reasonable.
> To every other device it means only _this buffer is now open_ — activating on
> it would drag the user to a buffer they opened on a different device. The two
> are the same frame, so the only thing that distinguishes them is whether you
> asked: track your own outstanding `open-buffer` targets and focus only on a
> match (`vue_client/src/stores/buffers.ts`, `pendingOpens`). Clear that record
> when the socket drops, or a reply that never arrived will claim someone else's
> open later.
>
> You don't need a `buffer-opened` handler to _materialize_ the buffer — the
> shell that travels with it already does, the same way every other
> buffer-creating frame works (§9.1). `buffer-reopened` (`wsHub.ts:1815`) is
> still emitted separately, when an incoming _event_ outranks a closed flag
> rather than a verb doing it.

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
                members: [ { nick, modes: [], away, user, host, account } ],
                membersPending?: true } ],   // NAMES not heard yet — see §9.1
  peerPresence: { "<lowercased nick>": { nick, state, stateAt, awayMessage } },
  pinned: [], collapsedNicklists: {}, channelNotify: {},
  ignoredMasks: [], nickNotes: [], relayBots: [] }
```

Offline networks appear with `state:'disconnected'`, `channels:[]`,
`peerPresence:{}`. The snapshot does **not** include network display
names/hosts — fetch `GET /api/networks` for the roster (the iOS app does this
before opening the socket; it doubles as a token validity check).

Member `modes` are **prefix-mode letters, highest first** (`q a o h v`), _not_
sigils (`~ & @ % +`). Map to sigils yourself for display. That letter list is a
display ordering, not a classification set — don't reuse it to decide what a
mode letter _means_ on a given network (§7.4).

### 5.2 Buffers

A buffer is one conversation: `kind ∈ channel | dm | server | system`. **The
server owns buffer existence and open/closed state** (a real `buffers` table
row per user/network/target). Clients never decide that a buffer exists — they
_materialize_ their local model in response to specific frames, and only those
(§9.1).

**Identity is `bufferId`** — the server-assigned integer that is stable for
the buffer's whole life (it will not change even when the buffer's NAME does;
renames are a coming feature). `(networkId, case-folded target)` remains a
valid, always-present _address_ for the same buffer, and is how the two ends
talked before `bufferId` existed. The connect burst doubles as the directory:
every `backlog` frame carries `bufferId` alongside `networkId`/`target`, so by
`backlog-complete` a client holds the full id⇄name mapping. New clients should
key their per-buffer state by `bufferId` and treat the name as a resolvable
attribute; old clients that ignore the field keep working unchanged.
`bufferId` is `null` in exactly one degenerate case (a live-joined channel
whose registry row was lost mid-session — the same defensive carve-out §9.1
describes) and absent on the one `buffer-opened` ack for a channel still being
JOINed (no row exists until the echo).

Two sentinel buffers use `:`-prefixed targets. They are REAL rows with real
`bufferId`s (minted at account/network creation), just uncloseable and never
user-managed:

- `:server:<networkId>` — per-network server log (`networkId` set). Catch-all
  for server-voice text (§7.3).
- `:system:` — app-scoped Lurker log (`networkId: null`). Read-mostly; carries
  `type:'system'` events. Separate message-id space (§4.4).

Sentinel targets are exact-match, never case-folded.

**Case folding:** IRC targets are case-insensitive and servers echo
inconsistently-cased names. Clients fold with plain `toLowerCase` for identity
(the first-party clients use their platform's Unicode lowercase; ASCII-only is
also fine) and keep the first/canonical casing for display. The _server_ folds
per the network's declared ISUPPORT `CASEMAPPING` (#707) — including the
RFC 1459 rule treating `{|}~` as the lowercase of `[\]^` — so two names a
client held apart may be one buffer server-side, and (rarely: non-ASCII
case-twins on an ascii-family network) two server buffers may collide under a
client's fold; prefer `bufferId` wherever a frame carries it. Don't implement
the server's fold client-side: when the server learns a mapping that collapses
names, it merges the rows and announces each merge with the ordinary
`buffer-renamed` frame (§9.7), which is all a client needs to converge.

### 5.3 Messages (`MessageEvent`)

Common fields on every **persisted** event (`db/messages.ts` `rowToEvent` +
`decorateMessage`, `wsHub.ts`):

```
{ id, networkId, target, time,        // ISO 8601 — see the note below
  bufferId,                           // buffers(id) — absent only on synthetic
                                      // never-persisted events (§5.2)
  type,                               // see §7.2
  nick, text, kind,                   // kind = raw IRC command; see the ⚠ below
  self,                               // you sent it (any of your clients)
  userhost, alt, mirrored, dm,
  matched, matchedRuleId,             // highlight decoration
  fromIgnored, notifyAlways, notify,
  msgid?,                             // IRCv3 server message id, when supplied
  bookmarked? }                       // true when you've saved this line
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

**`bookmarked`** is `true` when the account reading the row has saved it, and
**absent — not `false`** otherwise, so unsaved rows (nearly all of them) cost
nothing on the wire. There is no bookmark snapshot in the connect burst: keep a
`Set` of the ids you've seen carrying this flag, add/remove on `bookmark-updated`,
and treat "not in the Set" as unsaved. That bounds the state you hold by what
you've loaded rather than by everything the account has ever saved. Full rows for
the saved-messages list come from `GET /api/bookmarks`, which is paginated.

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
`{networkId, target, bufferId, lastReadId, unread, highlights, highlightsCapped}` —
broadcast to **all** the user's sockets after every countable event and every
mark-read. Never count unread locally (§9.4).

---

## 6. Client → server verbs

**Addressing a buffer by id:** every verb below that operates on an existing
buffer also accepts an optional `bufferId` (number). When present and valid it
WINS over `networkId`/`target`, which may then be omitted; an id that doesn't
resolve to one of your buffers drops the verb — the same outcome as an unknown
name. `reorder-pins` takes `bufferIds:[…]` as the id-form alternative to
`targets`; `reorder-favorites` is id-form ONLY (favorites span networks, so
bare names can't address them — and every client holds the ids from
`favorites-changed`). Verbs that address IRC _entities_ rather than buffers (`send`,
`action`, `notice`, `join`, `part`, `typing`, `e2e`, `ctcp`) stay name-only —
the name is what goes on the IRC wire. `open-buffer`'s id form addresses an
existing row only; minting a new DM or JOINing a channel is inherently
name-first.

All messages are `{type:'<verb>', …}`. Any message carrying a `networkId` for a
network you don't own gets `{kind:'error', text:'unknown network'}`. Unknown
verbs are non-fatal (§2). Verbs marked ⏸ are rejected when the account is
paused. Dispatch: `handleClientMessage`, `wsHub.ts:2031`.

**Request/reply correlation.** There is no envelope-level request id. The verbs
that answer you carry a per-verb correlation field instead, which you generate
and the server echoes back (verbatim, with one length caveat noted below):

| Verb(s)                      | Field           | Echoed on                   | Discipline                                                           |
| ---------------------------- | --------------- | --------------------------- | -------------------------------------------------------------------- |
| `send` / `action` / `notice` | `clientId`      | `send-result`               | Optional. Omit it and you get no ack (the `irc` echo still arrives)  |
| `history` / `search`         | `token`         | `history` / `search-result` | Keep it monotonic and **drop replies whose token you've superseded** |
| `POST /api/uploads` (REST)   | `progressToken` | `upload-progress`           | **Must be ≤64 chars** — see below; the only cross-transport one      |

> ⚠ `progressToken` is **truncated, not rejected**, at 64 characters
> (`routes/uploads.ts:250`). Send a longer one and the upload succeeds while
> every `upload-progress` frame carries the truncated token, matching nothing
> you're waiting on — so progress silently never appears and no error is raised
> anywhere. Keep yours short (a UUID is 36).

Three names for one concept is a historical accident, not a pattern to extend.
Nothing else is correlated: every other verb either replies with a frame whose
`(networkId, target)` identifies it unambiguously, or doesn't reply at all.
Match on those keys rather than inventing your own correlation. Frames
that describe one buffer also carry `bufferId`; matching on it is equivalent
and rename-proof.

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

| `type`         | Fields                        | Notes                                                                                                                                                                                               |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join`         | `networkId, channel, key?`    | Request only — the buffer appears on `channel-joined` (§9.1)                                                                                                                                        |
| `part`         | `networkId, channel, reason?` | Buffer survives, parted                                                                                                                                                                             |
| `open-buffer`  | `networkId, target, countBy?` | **Write.** Reopen/create: replies `backlog` + `buffer-opened`, announces a shell + `buffer-opened` to the user's other devices; JOINs if an unjoined channel; mints an empty DM row for a bare nick |
| `close-buffer` | `networkId, target, reason?`  | Closes (PARTs a joined channel, untracks a DM peer). `:server:` refuses                                                                                                                             |

Every verb in this section is rejected while an account is paused — they are all
writes. **Hydration is not in this section for that reason:** it's
`{type:'history', mode:'latest'}` (§4.3, §8), which is a read and stays
available. A client that hydrates through `open-buffer` can't show a paused user
anything at all.

### View state (persisted server-side, fanned out to your other devices)

| `type`                                  | Fields                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mark-read`                             | `networkId, target, messageId` (or `bufferId, messageId`) — MAX-clamped server-side, idempotent. System buffer: `networkId: null, target: ':system:'` (send an explicit null, don't omit)                                                                                                                                                                                                                                  |
| `mark-all-read`                         | —                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `clear-buffer` / `unclear-buffer`       | `networkId, target` (or `bufferId`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `pin-buffer` / `unpin-buffer`           | `networkId, target` (or `bufferId`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `reorder-pins`                          | `networkId, targets:[…]` (or `networkId, bufferIds:[…]`). Same subset semantics as `reorder-favorites`: unmentioned pins keep their relative order after the supplied ones                                                                                                                                                                                                                                                 |
| `favorite-buffer` / `unfavorite-buffer` | `networkId, target` (or `bufferId`). One flag for both UX labels: channels surface as "Favorites", DMs as "Friends". Server/system pseudo-buffers and CLOSED buffers are refused. Closing a buffer implies unfavorite; favoriting implies unpin (one placement per buffer — a `pins-changed` follows when a pin was dropped)                                                                                               |
| `reorder-favorites`                     | `bufferIds:[…]` (id-form only, global order). May be a subset — unmentioned favorites keep their relative order after the supplied ones, so a kind-filtered section reorders independently. A stale/foreign id ⇒ no write; either way the server echoes the authoritative `favorites-changed`                                                                                                                              |
| `set-nicklist-collapsed`                | `networkId, target, collapsed` (or `bufferId, collapsed`)                                                                                                                                                                                                                                                                                                                                                                  |
| `set-channel-notify-always`             | `networkId, target, notifyAlways` (or `bufferId, notifyAlways`)                                                                                                                                                                                                                                                                                                                                                            |
| `set-buffer-retention`                  | `networkId, target, maxLines` (or `bufferId, maxLines`). Per-buffer override of `data.retention.lines`: a number sets it (`0` = explicitly unlimited, otherwise ≥ the registry floor), `null` clears back to inherit. Channels and DMs only; an invalid value or a server pseudo-buffer is silently refused. A `buffer-retention-changed` fans out on success. Read the effective picture from `GET /api/retention/buffer` |
| `draft-set` / `draft-clear`             | `networkId, target, body?` (or `bufferId, body?`)                                                                                                                                                                                                                                                                                                                                                                          |
| `input-history-add`                     | `networkId, target, text` (or `bufferId, text`)                                                                                                                                                                                                                                                                                                                                                                            |
| `set-bookmark` / `unset-bookmark`       | `messageId`. Saving is a silent no-op for a message you don't own, and for system-buffer lines (`networkId:null`) which have no owning network — no `bookmark-updated` follows, so don't render a toggle optimistically                                                                                                                                                                                                    |
| `set-nick-note`                         | `networkId, nick, note`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `set-relay-bot`                         | `networkId, nick, marked, pattern`                                                                                                                                                                                                                                                                                                                                                                                         |
| `add-ignore` / `remove-ignore`          | `networkId` (null = global), `rule`/`mask` / `id`/`mask`. `rule` = `{mask (null or '*' = anyone), channels?, pattern?, patternKind: substr\|full\|regex, levels? (default ALL), isExcept?, expiresAt?}` (`ignoreRuleInput.ts`). Channel/network **muting** is expressed here — a rule with no mask scoped to a channel — not via a dedicated verb                                                                          |

### Presence & status

| `type`              | Fields                     | Notes                                                                               |
| ------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `presence`          | `visible: bool`            | **Per-socket, resets to `false` on every new socket** — re-assert on connect (§9.5) |
| `typing` ⏸          | `networkId, target, state` | Sends `+typing` TAGMSG                                                              |
| `away` ⏸ / `back` ⏸ | `message` / —              | User-scoped: hits every network                                                     |
| `probe-presence` ⏸  | `networkId, nick`          | Silent WHOIS; answer arrives as a `peer-presence` event                             |

### Sync & fetch

| `type`                 | Fields                                                                                                                                                                                                                                                | Reply                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `snapshot`             | —                                                                                                                                                                                                                                                     | Re-runs the snapshot burst as a gap-fill (§4.4)  |
| `history`              | `networkId, target, mode: before\|after\|around\|latest, limit (1–500), token?, countBy?, before?/afterId?/anchorId?`                                                                                                                                 | `{kind:'history'}` (§8)                          |
| `search` ⚠️ deprecated | `query, networkId?, target?, nick?, nicks?, before?, limit?, token?` — **use `GET /api/search` instead** ([migration](/MIGRATION_SEARCH_REST)); the command keeps working but gets no new capability, and its removal will be a protocol version bump | `{kind:'search-result'}`                         |
| `list-channels` ⏸      | `networkId`                                                                                                                                                                                                                                           | Kicks off `/LIST`; progress via `chanlist-state` |
| `chanlist-search`      | `networkId, query, sortBy, sortDir, offset, limit`                                                                                                                                                                                                    | `{kind:'chanlist-result'}`                       |

### E2E (RPE2E, per-channel opt-in)

`e2e` ⏸ (`networkId, target, args`), `e2e-export` (`networkId`) →
`{kind:'e2eExport'}`, `e2e-import` (`networkId, json`) → `{kind:'e2eImport'}`.
Status lines surface as ephemeral `type:'e2e'` events. Niche — safe to skip in
a v1 client.

---

## 7. Server → client frames

### 7.1 Frame kinds

| `kind`                                                                                                                           | Payload                                                                                                                                                                                                                                                                                                                                                                                                     | When                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                                                                                                                       | `protocolVersion, maxUploadBytes, networks[], globalIgnores[], cursor?`                                                                                                                                                                                                                                                                                                                                     | Connect burst / gap-fill                                                                                                                                  |
| `draft-snapshot`                                                                                                                 | `drafts`                                                                                                                                                                                                                                                                                                                                                                                                    | Connect burst                                                                                                                                             |
| `backlog-complete`                                                                                                               | —                                                                                                                                                                                                                                                                                                                                                                                                           | Last frame of the burst; absence is proof (§4.3)                                                                                                          |
| `backlog`                                                                                                                        | `networkId, target, bufferId, events[], mode, reset?, hasMoreOlder, joined, lastReadId, unread, highlights, highlightsCapped, clearedBeforeId, clearedAt, speakers?, inputHistory?` — **`mode ∈ replace\|append\|shell` is how you merge it (§8); `reset` is legacy**                                                                                                                                       | Burst, `open-buffer` reply, resume gap                                                                                                                    |
| `irc`                                                                                                                            | A decorated `MessageEvent` (§5.3) with `kind` clobbered to `'irc'`; persisted events carry `bufferId`                                                                                                                                                                                                                                                                                                       | Every live IRC-side event                                                                                                                                 |
| `history`                                                                                                                        | `networkId, target, bufferId, mode, token, events[], speakers, hasMoreOlder, hasMoreNewer, hasMore, before/afterId/anchorId/anchorMissing` (per mode)                                                                                                                                                                                                                                                       | Reply to `history`                                                                                                                                        |
| `read-state`                                                                                                                     | see §5.4                                                                                                                                                                                                                                                                                                                                                                                                    | After every countable event / mark-read                                                                                                                   |
| `send-result`                                                                                                                    | `clientId, ok, error?`                                                                                                                                                                                                                                                                                                                                                                                      | Ack for `send`/`action`/`notice`                                                                                                                          |
| `buffer-opened` / `buffer-closed` / `buffer-reopened`                                                                            | `networkId, target, bufferId?` (absent only on the ack for a channel still being JOINed — no row yet)                                                                                                                                                                                                                                                                                                       | Buffer lifecycle (§9.1). `buffer-opened` is an ack to the socket that asked **and** a fan-out to the user's other devices — only focus on your own (§4.3) |
| `buffer-cleared`                                                                                                                 | `networkId, target, bufferId, clearedBeforeId, clearedAt`                                                                                                                                                                                                                                                                                                                                                   | `/clear` marker                                                                                                                                           |
| `buffer-renamed`                                                                                                                 | `networkId, from, to, bufferId, merged, mergedFromBufferId?` — see §9.7                                                                                                                                                                                                                                                                                                                                     | A buffer kept its id across a name event: DM follows a peer's NICK, or a CASEMAPPING refold merged case-twins (any kind)                                  |
| `pins-changed`                                                                                                                   | `networkId, pinned[], pinnedIds[]` (parallel-indexed: `pinnedIds[i]` is `pinned[i]`'s buffer)                                                                                                                                                                                                                                                                                                               | Authoritative pin order                                                                                                                                   |
| `favorites-changed`                                                                                                              | `favorites:[{networkId, target, bufferId}]` — the FULL global order; replace wholesale                                                                                                                                                                                                                                                                                                                      | Connect burst + authoritative favorites order                                                                                                             |
| `nicklist-collapsed-changed` / `channel-notify-changed`                                                                          | `networkId, target, bufferId, …`                                                                                                                                                                                                                                                                                                                                                                            | View-state sync                                                                                                                                           |
| `buffer-retention-changed`                                                                                                       | `networkId, target, bufferId, maxLines` (`null` = inherit)                                                                                                                                                                                                                                                                                                                                                  | Reply/fan-out to `set-buffer-retention`; safe to ignore if you don't render retention state                                                               |
| `draft-updated` / `input-history-added` / `bookmark-updated` / `nick-note-updated` / `relay-bot-updated` / `ignore-list-updated` | various                                                                                                                                                                                                                                                                                                                                                                                                     | Multi-device view-state fan-out                                                                                                                           |
| `settings`                                                                                                                       | `changes`, `resets?`, `maxUploadBytes?` (only when the upload cap was touched). `resets` names keys whose stored override was DELETED; each also appears in `changes` as `{key: registryDefault}` for older clients. Apply `changes` first, then delete `resets` keys — for a `themed` registry key the two differ: a default-valued entry in `changes` alone is a real override of the active theme preset | Server-side settings changed                                                                                                                              |
| `themes-changed`                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                           | Saved theme presets changed (any device) — re-fetch `GET /api/themes`                                                                                     |
| `highlight-rules-changed`                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                           | Re-fetch highlight rules                                                                                                                                  |
| `account-state`                                                                                                                  | `paused: bool`                                                                                                                                                                                                                                                                                                                                                                                              | Hosted pause/resume                                                                                                                                       |
| `chanlist-state` / `chanlist-result`                                                                                             | `/LIST` cache meta / result page                                                                                                                                                                                                                                                                                                                                                                            | Channel browser                                                                                                                                           |
| `e2eExport` / `e2eImport`                                                                                                        | E2E key material / import result                                                                                                                                                                                                                                                                                                                                                                            | Replies, this socket only                                                                                                                                 |
| `dcc-transfer`                                                                                                                   | full transfer row (snake_case)                                                                                                                                                                                                                                                                                                                                                                              | DCC state changes                                                                                                                                         |
| `upload-progress`                                                                                                                | `token, phase, destination, percent`                                                                                                                                                                                                                                                                                                                                                                        | During REST upload (correlate via `progressToken`)                                                                                                        |
| `export`                                                                                                                         | `job`                                                                                                                                                                                                                                                                                                                                                                                                       | Export job progress                                                                                                                                       |
| `error`                                                                                                                          | `text`                                                                                                                                                                                                                                                                                                                                                                                                      | Non-fatal; also the reply to unknown verbs                                                                                                                |

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
| `mode`                        | P   | `text`, `modes[]` — see §7.4 for the entry shape and `kind`                   |
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

### 7.4 `mode` events: the `modes[]` entry shape

A single MODE message carries a list of changes. `text` is the raw form
(`"+o-b alice *!*@host"`) for display; `modes[]` is the parsed list, and each
entry is:

```
{ mode: "+o",            // the signed token
  param?: "alice",       // the argument, when the mode takes one
  kind?: "prefix" | "list" | "chan" }
```

`kind` is the server's classification of the letter, and it is **the only
correct way to tell one kind of change from another**:

| `kind`   | meaning                                        | examples                 |
| -------- | ---------------------------------------------- | ------------------------ |
| `prefix` | a member's status changed; `param` is a nick   | `+o alice`, `-v bob`     |
| `list`   | a mask was added to / removed from a list mode | `+b *!*@host`, `-e mask` |
| `chan`   | a channel flag or parameter mode               | `+m`, `+k key`, `+l 50`  |

⚠ **Do not classify mode letters yourself.** It requires the network's ISUPPORT
`PREFIX` and `CHANMODES`, which is not in any client-facing frame, and the
obvious shortcut is wrong: a hardcoded `q a o h v` prefix set disagrees with
solanum, where `+q` is a _quiet_ (a list mode) whose mask is often a bare nick —
so `+q troll` looks exactly like an owner grant and is nothing of the sort. That
is a real bug we shipped once (lurker#486). The member-`modes` letters in §5.1
are a **display** ordering for sigils and are not a classification set; don't
reuse them here.

An entry with **no `kind`** was stored before the server stamped it. Treat
missing as "not `prefix`": show the row, and don't fold or filter it. There is
no backfill.

Clients use this to decide what counts as presence churn. Lurker's own rule, in
`shared/modes.ts`: a mode row is churn only if **every** entry in it is `prefix`
with a `param` — one ban or channel flag anywhere in the message and the whole
row is shown, since a row renders as a single line and can't be half-hidden.

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

**Stored history is NOT append-only.** Instances can enforce a retention
policy (an operator ceiling and/or a per-user setting) that permanently
deletes a buffer's oldest rows in the background. Do not treat a message id
you once fetched as permanently fetchable: an `around` jump to it can come
back `anchorMissing`, a `before` page can return fewer rows with
`hasMoreOlder:false` earlier than history "should" end, and on the IRC
bouncer surface an empty CHATHISTORY batch can mean pruned as well as
never-existed. None of these are distinguishable from history that never
existed — cache accordingly.

### `countBy` — what `limit` counts

`limit` counts **stored rows**. If you consolidate presence noise — the web
client folds runs of `join`/`part`/`quit`/`nick`/`chghost`, **plus `mode` rows
that only grant or revoke member status**, into one summary line, per
`shared/consolidate.ts` — that is not the unit you render in, and on a busy
channel the gap is enormous: a 100-row page out of a netsplit can render as
three visible lines. You fetch, fold it to nothing, notice the page was short,
fetch again — and the user watches the buffer assemble itself.

⚠ **`CONSOLIDATABLE_TYPES` is not the fold set.** It is the five presence types,
and it is deliberately narrower than what folds: `mode` stays out of it because
that set also defines the `renderable` unit for every client, including shipped
ones. `foldsIntoRun` answers what folds; `countsTowardPage` answers what counts.
The two agree on churn modes and are free to diverge elsewhere.

Send **`countBy:'renderable'`** (every `history` mode, and `open-buffer`) and the
server sizes the page in rows that render as their own line — the five presence
types, and a `mode` row whose every change is a member-status grant or
revocation (§7.4). The folded rows still come back — consolidation needs the
whole run to summarize it — they just don't spend the budget.

If you fold presence but **not** mode, `renderable` is still safe: you receive
mode rows that cost nothing, so your page renders longer than you asked rather
than shorter. The rule to keep on the right side of is that the unit must never
be **finer** than what you draw. Default is `'event'`, i.e. today's behavior; an
older server ignores the field and answers exactly as before.

Send **`countBy:'chat'`** instead if you hide event noise **entirely** — the
`none` rung of the web client's event tier (`chat.events`). That unit also makes
`mode` free, because a client drawing nothing for a mode change would otherwise
spend budget on invisible rows. The canonical set is `NOISE_TYPES` in
`shared/eventFilter.ts`: the fold set plus `mode`.

There is deliberately **no unit for partial (smart) filtering**. Which events it
hides depends on who spoke recently in your client, which the server can't know;
ask for the unit your tier would otherwise use and accept the occasional short
page.

- **What counts is the complement of the set you hide**, not "messages". Under
  `'renderable'` a `kick`, `topic`, `error`, or `invite` each renders standalone,
  so each is worth one slot — as does a `mode` row that isn't pure member-status
  churn. Under `'chat'` no `mode` row counts at all. Kicks, topics and invites
  are never free under either; that they aren't in the noise set is an
  undocumented default rather than a decision, so don't reason from it.
- **The slice is still a contiguous id range**, exactly like an event-counted
  one. `hasMoreOlder`, prepend-and-dedupe, and the `before: <oldest returned
id>` cursor are unchanged. This cannot open a hole.
- **The scan is capped** (2000 rows). Past the cap you get fewer renderable rows
  than you asked for and `hasMoreOlder` stays true — a buffer holding tens of
  thousands of joins between two sentences degrades to today's behavior instead
  of shipping a huge frame.
- **Ask for the unit you actually render in** — and only once you _know_ what
  that is. If your client renders every event as its own line (the web client
  makes this a user setting), `'event'` is already the right unit, and
  `'renderable'` would hand you up to a full scan window of rows you then
  display in full. If the preference hasn't loaded yet, send `'event'`: of the
  wrong guesses, that one just costs a short first page.
- **On `around` it sizes each side**, so the window is up to `2×limit+1`
  _renderable_ rows. Worth sending: for a client that enters a buffer with a
  pending jump (a push tap, a highlight, jump-to-first-unread), the `around`
  slice **is** the hydrate — no `latest` or `open-buffer` precedes it.
- **A page can now be much bigger than your in-memory cap, if you keep one.**
  Two consequences, both silent when missed:
  - `hasMoreOlder` describes the slice the server _sent_. If your ring drops
    rows off the old edge, there is more older history than you hold regardless
    of what the flag said — re-arm the pager yourself.
  - Don't merge a page larger than your ring into an existing slice. It evicts
    the very rows the reader is looking at, and their scroll position ends up
    pointing at content that no longer exists. Take the end **adjacent** to what
    you hold (newest rows of an older page, oldest rows of a newer one), keep
    the merge contiguous, and treat the remainder as still fetchable. The web
    client caps an incremental merge at 250 rows for exactly this
    (`vue_client/src/stores/buffers.ts:28`).

**Jump-to-message detaches the buffer** (Discord/Slack convention): after
`around`, live events for that buffer should _not_ be spliced into the visible
slice (track them separately or refetch); `latest` reattaches.

**Merge rules that protect you from data loss:**

1. **Read `mode` on every `backlog` frame and do what it says.** It is the
   server stating how it built the slice — the only field you need to decide
   _how to merge_ (but not the only one you must record; see rule 4):

   | `mode`    | Meaning                                                | Action                                                      |
   | --------- | ------------------------------------------------------ | ----------------------------------------------------------- |
   | `replace` | Authoritative slice, **not** contiguous with your tail | Take `events`; **may** keep overlapping older rows — rule 5 |
   | `append`  | A contiguous gap-fill                                  | Splice onto your existing tail                              |
   | `shell`   | Buffer exists, nothing shipped (`events:[]`)           | Leave existing contents alone; fetch on open                |

   > Taking `events` wholesale is always **safe** on `replace`, and is the right
   > first implementation. Rule 5 is the refinement that stops it costing the
   > user their scrollback — read it before you ship.

2. **Ignore `reset`.** It predates `mode` and is not decodable on its own:
   `reset:false` means _append_ on a resume gap but _replace_ on a fresh
   connect and on the system buffer — three meanings, two values. Old clients
   derived it by also reading `networkId` and by knowing out-of-band whether
   they'd sent `?since` (iOS `FrameParser.swift:104-111`; web inferred from id
   non-overlap). It is still sent wherever it was sent before, unchanged — note
   that's only two of the four backlog shapes: shells and `open-buffer` replies
   have never carried it at all. Don't build on it.

   > A server predating `mode` omits the field entirely. If you must support
   > one: treat `events:[] && hasMoreOlder` as a shell **first** (absent `reset`
   > would otherwise fall into replace and un-hydrate it — rule 3), then append
   > only when `networkId != null && reset === false`, else replace.

3. **Never un-hydrate:** a `shell` for a buffer you already populated must not
   wipe it. This is why shells are their own `mode` rather than
   `replace`-with-empty.
4. **`mode` tells you how to merge; `hasMoreOlder` tells you whether the pager
   is still armed — record it on every frame, including `append` and `shell`.**
   It's the flag your open-time lazy fetch and scroll-up pager gate on, so
   dropping it on a gap-fill strands the buffer at whatever it happens to hold
   (`wsHub.ts:870-876`).
5. **`replace` permits preserving contiguous older history you already hold.**
   The rule it must never break is _don't create a hole_. So: if the incoming
   slice **overlaps** what you hold (its oldest id ≤ your newest id), you may
   dedupe-merge and keep older rows the user paged in — this is what the web
   client does (`vue_client/src/stores/buffers.ts:504-525`), and it matters
   because `:system:` and offline `:server:` buffers get a full `replace` frame
   on **every** snapshot, including the in-band `{type:'snapshot'}` resync a
   client may fire on visibility return. Dropping everything there would throw
   away the user's scrollback each time they tab back. If the slice is
   **disjoint** (its oldest id > your newest id), rows went missing in between —
   you must replace wholesale and let `hasMoreOlder` page the rest.
6. On any replace, **keep held live events newer than the slice tail** — a
   message can land mid-hydrate.
7. Dedupe everything by id against what you hold; drop legacy `away`/`back`
   rows if you encounter them in old history.
8. The web client caps its in-memory ring at 500 events/buffer and pages the
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
- **`membersPending` (on a snapshot channel, or on a `names` event) → keep the
  members you already hold.** The server has not heard the channel's NAMES
  since it last connected or attached — after an engine re-attach that is every
  channel until the restore asks, one at a time — so the list it sends is only
  the members learned so far, at least yourselves; rendering it looks like
  everyone left. Take that list only if you hold none. Normally a definitive
  `names` follows within seconds; a restore step whose NAMES the server never
  answers sends nothing further, and the flag stays until a later `/names` or
  rejoin.
- **Never materialize from ambient signals:** `typing`, `member-update`, and
  `read-state` for unknown buffers must resolve-or-drop. (`mark-all-read` fans
  out `read-state` for _closed_ buffers too — resurrecting them in the sidebar
  was bug #319; typing-tag DM creation was #292.)
- **NOTICEs may create a DM buffer, but never reopen a closed one.** Both
  outcomes are decided server-side and arrive as ordinary frames — don't
  special-case either. What the server actually does with an incoming
  DM-targeted event (`server/db/buffers.ts:21-29`):

  | Trigger              | Buffer has no row | Buffer row is closed                      |
  | -------------------- | ----------------- | ----------------------------------------- |
  | `message` / `action` | creates it, open  | **reopens** it                            |
  | `notice`             | creates it, open  | **stays closed** → mirrored to `:server:` |

  So a NOTICE from a nick you've never talked to does open a buffer for that
  nick — that's how services (NickServ, ChanServ, oper notices) get their own
  buffer instead of dumping into `:server:`. Only the **closed-row** case
  routes elsewhere: the real copy is persisted in the closed DM buffer (waiting
  for a reopen) and a second, durable copy lands in `:server:` carrying
  `mirrored:true`. Render the mirror like any other `:server:` line; it's
  excluded from search so it can't double up results.

  A notice-only buffer is deliberately **not** a "conversation": the server
  won't start presence-tracking its nick (no MONITOR slot, no presence dot)
  until a real PRIVMSG/ACTION arrives (`db/messages.ts:440`).

- **Navigating to a buffer by key** (launch restore, notification tap) is the
  one case where you need to ask "does this exist?" rather than mirror a
  signal. Wait for `backlog-complete`; if the key still has no `backlog` frame
  after it, that buffer isn't open — say so instead of spinning. It may be
  closed rather than gone, so render it as absent but don't destroy anything
  local over it. Don't guess from `snapshot` and don't probe with `open-buffer`
  — see §4.3 for why both are traps.

### 9.2 Identity & case

Prefer `bufferId` wherever a frame carries it — it is fold-proof and (soon)
rename-proof (§5.2). When matching by name: fold targets with ASCII lowercase;
sentinels (`:server:<networkId>`, `:system:`) exact-match; first-seen casing
is display-canonical (§5.2).

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

### 9.7 Renames keep a buffer's identity

**Two producers emit this frame today**, for buffers of any kind: a DM
following its peer's `/nick` (weechat/irssi parity), and the CASEMAPPING
refold (#707) merging rows — channels included — that fold together under a
newly-declared mapping. Channel renames (`draft/channel-rename`) will reuse it
too. ⚠ The producers orient `from`/`to` differently on a merge: the DM path
absorbs the row that already held `to`, the refold path absorbs the `from` row
(the survivor keeps its own name, so `from ≠ to` with no actual rename).
Never derive which buffer died from orientation — `mergedFromBufferId` is the
absorbed row, `bufferId` the survivor, and `to` is always the survivor's final
name.

```jsonc
{
  "kind": "buffer-renamed",
  "networkId": 4,
  "from": "alice", // canonical pre-rename name (registry casing)
  "to": "alice_away", // authoritative new name — key off THIS
  "bufferId": 42, // the SURVIVING buffer; its id did not change
  "merged": false,
  "mergedFromBufferId": 17, // present iff merged: the absorbed, now-deleted id
}
```

The contract, in the order a client should apply it:

- **The id never changes.** `bufferId` is the same id this buffer has always
  had; only the name moved. A client keying state by id has almost nothing to
  do; a client keying by name rekeys `from → to` in every store holding
  per-buffer state (the web client does this with one registry sweep —
  `lib/bufferLifecycle.ts`).
- **`merged: true` means another buffer was absorbed**, and
  `mergedFromBufferId` names it — drop THAT buffer everywhere first (by id,
  per the orientation warning above), then apply the rename; done in that
  order there is no key collision. The surviving conversation keeps its id.
  The merged history interleaves server-side, so wipe the local slice and
  re-hydrate rather than guessing at the interleave.
- **Corrections ride behind a merge.** `read-state`, `pins-changed`,
  `favorites-changed`, and (when the surviving draft changed) `draft-updated`
  frames follow immediately — the merge changed those server-side and an idle
  buffer would never otherwise learn. Favorites entries' `target` strings are
  display hints subject to `buffer-renamed`; `bufferId` is the identity.
- **Key off `to`, never a name you predicted**, and follow the active buffer:
  a rename of the buffer the user is reading is the same buffer, not a
  navigation.
- The frame reaches **every** socket including whichever device's action
  caused it — it describes a fact, not an instruction.
- The DM also receives an ordinary persisted `type:'nick'` row ("x is now
  known as y"), AFTER the rename, so it renders under the new name with the
  same code path channel nick rows use.
- What deliberately does NOT follow a rename: highlight/ignore rules scoped
  to the old name (glob patterns, possibly cross-network), and e2e crypto
  contexts (wire-keyed; a DM context keys on the peer's host and is already
  rename-proof).

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

| Endpoint                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/settings/bootstrap` | → `{registry, values, themes}` — the registry is self-describing (types, defaults, enums); build your settings UI from it rather than hardcoding keys. `themes` is the saved-theme list (same rows as `GET /api/themes`), bundled so theme-pointer resolution never races the list                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PATCH /api/settings`         | `{changes?:{key:value,…}, resets?:[key,…]}` → `{values}`; at least one required. `resets` deletes stored overrides outright — applying a theme is one call: its pointer in `changes` + every `themed` key in `resets`. Other devices get the `settings` frame                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/retention/limits`   | → `{maxLines, maxEventHours}` — the operator ceilings (null = none declared). Hide any retention preset above a ceiling; a stored value above it is enforced clamped, so don't render it as if it were in effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/retention/buffer`   | `?networkId=&target=` → `{bufferId, overrideLines (null = inherit), effectiveLines (0 = unlimited), effectiveEventHours, recentLinesPerDay (null = too little data)}` — one buffer's whole retention picture, resolved by the same code the sweeper enforces with. Writes go over the `set-buffer-retention` verb                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DELETE /api/settings/:key`   | Reset one key to its baseline (registry default, or the active theme's value for `themed` keys)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/api/themes`                 | Saved theme presets — CRUD: `GET /` → `{items}`, `POST /` `{name, values}`, `PUT /:id` `{name?, values?}`, `DELETE /:id`. `values` = a subset of the `themed` registry keys, type-validated; names ≤40 chars, per-user unique (ASCII case-insensitive), reserved: `default`, `dark`, `light`, `Monokai Plus`, `Monokai Plus Light`; 50 per user. The built-ins (ids `dark`/`light`, named "Monokai Plus" / "Monokai Plus Light") never appear here (`shared/themePresets.ts`). The `look.theme.*` settings store which theme is active: `'dark'`/`'light'` or a saved id as a decimal string; unknown ids resolve as the dark built-in. Deleting a theme resets any pointer aimed at it (broadcast as a `settings` frame) |
| `/api/highlight-rules`        | CRUD: `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/highlights`         | Paginated highlight feed: `?limit (≤200), before, networkId, q, nick (repeatable), target` → `{items, nextBefore}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/bookmarks`          | `?limit, before` → `{items, nextBefore}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/search`             | Full-text + filtered message search: `?q, nick (repeatable, OR-matched), target, networkId, before, limit (≤100)` → `{items, nextBefore}`. Same rows as the deprecated WS `search` command (it wraps the same verb); at least one of `q`/`nick`/`target`/`networkId` required or the page is empty. Unowned `networkId` → 404. See [MIGRATION_SEARCH_REST](/MIGRATION_SEARCH_REST)                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/drafts/flush`      | Beacon-style: raw text body containing JSON `{drafts:[{networkId,target,body}]}` → `204`. For page-unload flush; live clients use the `draft-set` verb                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Uploads — `/api/uploads`

| Endpoint               | Notes                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /`               | `multipart/form-data`, file field **`image`**; optional `uploaderId`, `progressToken` (≤64 chars — progress arrives as `upload-progress` WS frames). → `{id, url, mime, can_delete, thumbnail_url?}`. `413` over cap, `415` rejected type, `502` provider error (never 401) |
| `GET /`                | `?before, limit, q, kind, favorites` → `{items, providers, maxUploadBytes}`. Each item carries `favorite: boolean`                                                                                                                                                          |
| `GET /:id/thumb`       | Binary thumbnail                                                                                                                                                                                                                                                            |
| `PUT /:id/favorite`    | Star it → `{ok, favorite:true}`. `404` if no such upload                                                                                                                                                                                                                    |
| `DELETE /:id/favorite` | Unstar it → `{ok, favorite:false}`. Succeeds on an already-unstarred row; `404` only means no such upload                                                                                                                                                                   |
| `DELETE /:id`          | `409` if not deletable                                                                                                                                                                                                                                                      |

`/api/uploaders` manages upload destinations (list/select/create/update/delete;
secrets write-only). Standalone serves local files publicly at
`GET /uploads/:key` (no auth, sandboxed CSP). Paste the returned `url` into a
message — the server does the rest.

**Favourites** (`?favorites=1`) is the user's starred set — a curated quick-access
list, not another page of history, and it behaves differently in two ways worth
coding to. It is ordered by **when the upload was starred**, newest star first,
not by upload id; and because that ordering is incompatible with the `before` id
cursor, the server **ignores `before`** here. There is no way to page this view:
ask for as much of it as you want with `limit` (default 50, ceiling 200) in a
single request, and treat a full response as "there may be more" — a client that
sends `before` gets the same rows back forever. Moderated
(`removed`) uploads are excluded even when starred, since their bytes are gone —
they still appear in an unfiltered `GET /` as tombstones, and can still be
unstarred. `favorites` composes normally with `q` and `kind`.

**Size cap.** `maxUploadBytes` — on the `snapshot` frame and on `GET /api/uploads`
— is the largest **file** this account may send, and the number to compress media
against. **Do not hardcode a cap.** It is the smallest of three ceilings: the
200 MB hard limit, the instance's declared transport limit (`LURKER_MAX_UPLOAD_MB`
— what a CDN or reverse proxy in front of Lurker will pass), and the per-user or
operator-baked uploader cap. Only the first is universal, so a self-hosted
instance and a CDN-fronted one legitimately differ by a lot.

It already has the multipart envelope subtracted, so a file at exactly
`maxUploadBytes` still fits inside the request body once the boundaries, part
headers, and `uploaderId` / `progressToken` fields are added. Size the **file**
to it; don't budget for the envelope yourself.

Treat it as advisory, not a contract: it is resolved for the account's **default**
uploader, so a per-upload `uploaderId` override with a tighter policy cap, or an
operator changing the limit mid-session, is still settled by a `413` carrying the
real number. It is refreshed on reconnect, and re-sent on the `settings` frame
whenever the user changes their own cap — so a client that reads it from both
frames never compresses against a stale number.

**Imports are capped separately.** `POST /api/imports` has its own, much larger
limit (500 MB) and is **not** bound by the 200 MB upload ceiling — so
`maxUploadBytes` is the wrong number to check an archive against. Read
`maxImportBytes` from `GET /api/exports/preview` instead. Only the instance's
transport limit is shared between the two, which does mean lowering
`LURKER_MAX_UPLOAD_MB` lowers both. Over-limit archives get a `413` with
`code: "archive_too_large"`; there is no way to compress an archive to fit, so
check before uploading.

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
- **Send verbs (8):** `presence`, `send`, `history` (`before`/`latest`; add
  `countBy:'renderable'` if you consolidate, `'chat'` if you hide events — §8),
  `mark-read`, `mark-all-read`,
  `join`, `open-buffer`, `close-buffer`. Hydrate with `{mode:'latest'}`, never
  with `open-buffer` — §4.3 for why that's the difference between reading a
  buffer and reopening it on every device the user owns.
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
