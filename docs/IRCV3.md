# IRCv3 Support — what we use, and why it matters to you

> **Audience:** anyone evaluating Lurker's protocol support, plus contributors
> deciding what to build next. Last verified against `main` @ `9df7bb9`.
> The server source is authoritative; `file:line` references point into this
> repository unless otherwise noted (e.g. upstream deps like irc-framework).

Most clients publish a bare list of IRCv3 capability names. That tells you almost
nothing — "we support `multi-prefix`" is not a feature, it's an implementation
detail. A capability only matters if it changes what the software can actually do
for you.

So this page is organised the other way around: **by the thing you get**, with the
capabilities that make it possible listed underneath. There's a plain reference
table at the end if that's what you came for, an honest accounting of what we
negotiate but don't yet use, and a list of what we _don't_ support and what
adopting it would buy you.

One structural note that explains several entries: Lurker's upstream IRC
connection is built on [irc-framework](https://github.com/kiwiirc/irc-framework),
which negotiates a baseline capability set of its own. Some capabilities below are
consumed inside that library and reach Lurker only as better-shaped events. That's
still real support, but we mark which is which rather than taking credit for it.

---

## What you get

### Your nicklist is correct, and it stays correct

Open a channel and the member list is right immediately — ranks, away state, and
hostmasks — and it updates live instead of drifting until something forces a
refresh.

- **`multi-prefix`** — a member's _full_ set of ranks arrives, not just the highest
  one. Lurker shows the highest glyph (`~ & @ % +`) but tests the whole set when
  deciding which moderation actions to offer you, so someone who is both `+o` and
  `+v` is understood correctly.
  <br>`vue_client/src/utils/memberPrefix.ts:19`, `vue_client/src/composables/useMemberActions.ts:167`
- **`userhost-in-names`** — full `nick!ident@host` masks arrive with the member
  list, so hostmasks are known the moment you join rather than after a round-trip.
  <br>`irc-framework/src/commands/handlers/channel.js:71`
- **`away-notify`** — away state updates live, with no polling.
  <br>`server/services/ircConnection.ts:1845`
- **`whox`** — on joining, Lurker issues a single extended `WHO` to learn away state
  for the whole channel at once, instead of one query per member. `away-notify` keeps
  it current from then on.
  <br>`server/services/ircConnection.ts:2326`
- **`chghost`** — when someone's hostmask changes (typically a cloak applied after
  they identify), you see one clean line and the nicklist updates in place, rather
  than a fake disconnect-and-rejoin.
  <br>`server/services/ircConnection.ts:1405`
- **`extended-join`**, **`account-notify`** — a member's registered account is known
  on join and stays current if they identify or log out later, without Lurker having
  to run `WHOIS` at you. Account changes update the nicklist **silently**: on
  networks like Libera, identifying fires an account change and a cloak change
  back-to-back, and rendering both would print two lines per identify in every
  channel you share.
  <br>`server/services/ircConnection.ts:1467`

### Your history is in the right order, on every device

Lurker stores everything and replays it to any browser or client you attach. That
only works if timestamps are trustworthy.

- **`server-time`** — messages are stored with the time _the server_ stamped them,
  not the time Lurker happened to receive them. Lines that arrive late or out of
  order still land in the right place, and every device you attach sees the same
  ordering. Lurker normalises these to a canonical UTC form on the way in, and falls
  back to receive time for implausibly far-future stamps so one clock-skewed server
  can't reorder your buffer list.
  <br>`server/services/ircConnection.ts:294`
- **`echo-message`** — your own sent messages come back from the server, and _that_
  copy is the one Lurker stores. It's the only way your own messages learn their
  server-assigned ID and authoritative timestamp, which is what keeps them ordered
  identically across every device you're signed in on.
  <br>`server/services/ircConnection.ts:1533`
- **`msgid`** — every message gets the server's stable identifier, stored and
  indexed. Nothing user-facing depends on it today: it's deliberate groundwork, since
  reactions and threaded replies are both anchored on a message ID and can't be built
  without one.
  <br>`server/services/ircConnection.ts:1528`

### Multi-line messages stay one message

Paste several lines and they travel as a single logical message where the network
supports it, instead of being torn into separate messages that can interleave with
other people's chatter. Incoming multi-line messages are reassembled the same way.

- **`batch`**, **`draft/multiline`**, **`message-tags`**
  <br>`server/services/ircConnection.ts:518`

### You can see when someone is typing

Typing indicators in channels and DMs, both directions — Lurker sends yours and
displays other people's. Currently a web-client feature; the iOS app doesn't render
them yet.

- **`+typing`** (carried over `TAGMSG`), which requires **`message-tags`** — so it's
  automatically off on networks that don't speak IRCv3, because those answer every
  `TAGMSG` with an error and an ungated send would toast you on each keystroke.
  Lurker also suppresses typing notifications to a target the server has already
  refused your messages to (a `+R`/`+M` channel you can't speak in), and to peers it
  knows are offline — otherwise every keystroke earns another error reply in your DM
  buffer.
  <br>`server/services/ircConnection.ts:4873` (send), `:2746` (receive)

### You can see when your DM peers are around

Presence dots on DMs, without Lurker hammering the network with `WHOIS` polls.

- **`monitor`** — the presence transport. Lurker asks the server to tell it when
  specific people connect or disconnect. Networks without it get no presence
  tracking at all; we deliberately don't fall back to polling, because polling
  every open DM's peer is abusive to the network.
  <br>`server/services/ircConnection.ts:1298` (ISUPPORT gate), `:2891` (seed)
- **`extended-monitor`** — extends that to away/back state for people you share no
  channel with, which is what makes presence useful for DM peers rather than just
  channel regulars.
  <br>`server/services/ircConnection.ts:657`

### End-to-end encryption can identify who it's talking to

Lurker's optional E2E encryption keys off a stable `ident@host` identity rather than
a nickname, since nicknames are trivially reassigned.

- **`userhost-in-names`** — supplies that identity for everyone in a channel from
  the moment you join. Without it there's nothing stable to pin a key to.
  <br>`server/services/ircConnection.ts:3866`

### Connecting works, and failure is legible

- **`sasl`** (3.1 / 3.2, PLAIN) — proper account authentication rather than
  `/msg NickServ`. Under 3.2, Lurker reads the server's advertised mechanism list
  and fails fast with a clear reason if PLAIN isn't offered, instead of hanging. A
  genuine authentication failure is treated as _terminal_ — Lurker stops retrying
  and tells you, rather than looping against a password that will never work.
  <br>`server/services/ircConnection.ts:3115`, `:959`
- **`cap-3.1` / `cap-3.2`** — versioned capability negotiation, which is how the
  SASL mechanism list is readable at all.
- **`cap-notify`** — if a network enables a capability mid-session (common right
  after a services upgrade), it's picked up without you reconnecting.
- **`invite-notify`** — invites are recorded as a real "X invited Y" line that
  survives in your history.
  <br>`server/services/ircConnection.ts:1974`

---

## Attaching your own IRC client

Lurker can also act as a bouncer, so WeeChat, irssi, Textual or HexChat can attach
to the same always-on connection your browser uses (see
[Self-Hosting](/SELF_HOSTING#irc-bouncer-attach-from-other-irc-clients)). The
capabilities Lurker offers _downstream_ are a deliberately short, honest list —
we advertise only what we actually implement.

| You get                                                                                         | Powered by                                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Log in with SASL instead of a server password                                                   | `sasl` (PLAIN)                                                |
| Backlog replays at its original timestamps, not at attach time                                  | `server-time`                                                 |
| Scrollback on demand — page back through Lurker's full stored history from your terminal client | `draft/chathistory`                                           |
| Your own sent messages echoed back, if your client wants them                                   | `echo-message`                                                |
| Your outgoing DMs attributed to you correctly in replay                                         | `znc.in/self-message`                                         |
| Pick your network from a list instead of hardcoding `username/networkname`                      | `soju.im/bouncer-networks`, `soju.im/bouncer-networks-notify` |
| Message metadata passed through from upstream                                                   | `message-tags`                                                |
| Network list delivered as one grouped burst                                                     | `batch`                                                       |
| People's away, account and host changes, when your network sends them                           | `away-notify`, `account-notify`, `chghost`                    |
| Accounts on JOINs and on each message, when your network sends them                             | `extended-join`, `account-tag`                                |
| Every prefix and full hostmasks in NAMES, when your network sends them                          | `multi-prefix`, `userhost-in-names`                           |
| Invites other people get to your channels                                                       | `invite-notify`                                               |
| Told when a capability comes or goes, such as while your network reconnects                     | `cap-notify`                                                  |

Implementation notes worth knowing if you're writing against it:

- Scrollback is capped at 1000 messages per request, advertised via the
  `CHATHISTORY` ISUPPORT token. Over-limit requests are **rejected, not silently
  truncated** — matching soju, whose clients read the token and stay under it.
  Message references are `timestamp` only, deliberately not `msgid`, because
  Lurker's stored history IDs and an upstream network's message IDs are different
  namespaces and mixing them would break paging across the boundary.
  <br>`server/services/bouncer.ts:146`, `:520`
- Tags that only a server may set — `time`, `account`, `msgid`, `label`, `batch` —
  are stripped from anything an attached client sends, so a downstream client can't
  forge them.
  <br>`server/services/bouncer.ts:278`
- Caps whose lines come from the network (`away-notify`, `account-notify`,
  `account-tag`, `chghost`, `extended-join`, `multi-prefix`, `userhost-in-names`) are
  offered only while the network you bind has them, as soju does. `CAP LS 302` lists
  them before you pick a network, then `CAP DEL` takes back any that network lacks, and
  `CAP NEW` offers them again when it reconnects.
  <br>`server/services/bouncer.ts:905`
- What the network sends is trimmed to the caps your client negotiated, as soju and ZNC
  do: no `AWAY` without `away-notify`, a bare `JOIN` without `extended-join`, one prefix
  per nick in NAMES and WHO without `multi-prefix`, and so on. Without `chghost`, a host
  change arrives as the `QUIT`, `JOIN` and `MODE` a network sends in its place. Lurker
  never offers `draft/multiline`, so multiline messages arrive as separate lines.
  <br>`server/services/bouncerClientFilter.ts`

---

## Reference table

Capability names as they appear on [ircv3.net](https://ircv3.net/software/clients).
"Client" is Lurker connecting out to a network; "Bouncer" is your IRC client
attaching to Lurker.

| Capability                              | Client | Bouncer |
| --------------------------------------- | :----: | :-----: |
| `cap-3.1`, `cap-3.2`                    |   ✅   |   ✅    |
| `cap-notify`                            |   ✅   |   ✅    |
| `sasl-3.1`, `sasl-3.2` (PLAIN)          |   ✅   |   ✅    |
| `server-time`                           |   ✅   |   ✅    |
| `message-tags`                          |   ✅   |   ✅    |
| `msgid`                                 |   ✅   |   ✅    |
| `echo-message`                          |   ✅   |   ✅    |
| `batch`                                 |   ✅   |   ✅    |
| `draft/multiline`                       |   ✅   |    —    |
| `+typing`                               |   ✅   |    —    |
| `draft/chathistory`                     |   —    |   ✅    |
| `multi-prefix`                          |   ✅   |   ✅    |
| `userhost-in-names`                     |   ✅   |   ✅    |
| `away-notify`                           |   ✅   |   ✅    |
| `extended-join`                         |   ✅   |   ✅    |
| `account-notify`                        |   ✅   |   ✅    |
| `chghost`                               |   ✅   |   ✅    |
| `invite-notify`                         |   ✅   |   ✅    |
| `monitor`                               |   ✅   |    —    |
| `extended-monitor`                      |   ✅   |    —    |
| `whox`                                  |   ✅   |    —    |
| `znc.in/self-message`                   |   —    |   ✅    |
| `soju.im/bouncer-networks` (+`-notify`) |   —    |   ✅    |

### Negotiated but not yet used

In the interest of not padding the list: these are requested and acknowledged, but
nothing in Lurker reads them yet. We'd rather say so than count them.

| Capability                                                               | Status                                                                                                                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account-tag`                                                            | Acknowledged, but nothing reads the per-message account tag. Account information comes from `extended-join` and `account-notify` instead. The bouncer does pass the tag on to attached clients that ask for it. |
| `draft/message-tags-0.2`, `znc.in/server-time-iso`, `znc.in/server-time` | Pre-standardisation aliases requested by irc-framework for older servers. Superseded by `message-tags` and `server-time`.                                                                                       |

---

## Not supported yet

Kept deliberately, as a roadmap. Ordered by what we think it would actually buy
you, not by spec number.

### High value — natural fits for features Lurker already has

| Capability                      | What it would give you                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+draft/react`                  | Emoji reactions on messages. Lurker already stores the `msgid` that reactions anchor to, so the hard part is done.                                                                                                                                                                                                                                                                 |
| `+draft/reply`                  | Threaded replies, anchored on the same stored `msgid`.                                                                                                                                                                                                                                                                                                                             |
| `draft/read-marker`             | Read state shared with an attached IRC client. Lurker already tracks read position server-side per user and pushes it to every first-party client, so web and mobile agree — but that state is invisible over the bouncer, which replays a fixed-size burst per buffer rather than resuming from where you left off. This is the cap that would close that gap in both directions. |
| `draft/chathistory` (as client) | Backfill missed history from an upstream bouncer or a network that stores it. Note the asymmetry: Lurker _serves_ chathistory downstream but doesn't consume it upstream, so gaps from a Lurker outage can't currently be filled in.                                                                                                                                               |
| `standard-replies`              | Machine-readable `FAIL`/`WARN`/`NOTE` errors, so command failures render as real explanations instead of raw numerics.                                                                                                                                                                                                                                                             |
| `draft/message-redaction`       | When someone deletes a message, it disappears from your view too, rather than persisting forever in Lurker's history.                                                                                                                                                                                                                                                              |

### Moderate value

| Capability                   | What it would give you                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labeled-response`           | Reliable correlation of a command with its reply, which makes command results attributable even when several are in flight.                                                      |
| `setname`                    | Change your realname without reconnecting. Lurker doesn't request this today.                                                                                                    |
| `bot-mode`                   | Visually distinguish bots from people in the nicklist and message list.                                                                                                          |
| `draft/metadata`             | Server-side profile data — avatars being the obvious use.                                                                                                                        |
| `draft/account-registration` | Register a network account during onboarding, instead of sending someone off to `/msg NickServ`.                                                                                 |
| `draft/pre-away`             | Set away state before registration finishes, closing the brief window on reconnect where you appear present but aren't.                                                          |
| `utf8only`                   | Skip encoding guesswork on networks that guarantee UTF-8.                                                                                                                        |
| `draft/channel-rename`       | Follow a channel rename without a part/join cycle.                                                                                                                               |
| `sts`                        | Automatic upgrade to TLS and downgrade protection. Lower priority than it sounds — Lurker connects with TLS directly — but it would harden a misconfigured plaintext connection. |

### Low value or not applicable

| Capability                                                                                                                    | Why it's not a priority                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `starttls`                                                                                                                    | Superseded in practice by connecting with TLS directly, which Lurker does.                                             |
| `websockets`                                                                                                                  | Lurker connects to networks over TCP from the server; browser WebSocket transport isn't relevant to that path.         |
| `webirc`                                                                                                                      | Designed for gateways relaying many users, and requires per-network operator trust. Lurker's connections are per-user. |
| `no-implicit-names`                                                                                                           | A join-time optimisation for very large channels; little benefit at Lurker's scale.                                    |
| `account-extban`, `draft/oper-tag`, `draft/network-icon`, `draft/extended-isupport`, `client-batch`, `+draft/channel-context` | Narrow or largely server-side; no user-visible feature blocked on them today.                                          |

---

## Related

- [Self-Hosting → IRC bouncer](/SELF_HOSTING#irc-bouncer-attach-from-other-irc-clients)
  — how to attach a terminal client.
- [Client Protocol & API](/CLIENT_PROTOCOL) — Lurker's own WebSocket protocol, which
  is what first-party clients speak. It is not IRC.
- Lurker's entries in the IRCv3 support tables:
  [Web Clients](https://ircv3.net/software/clients) and Bouncers, as
  _Lurker_ and _Lurker (as Server)_.
