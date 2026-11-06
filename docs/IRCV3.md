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
  one. Lurker shows the highest glyph, read from the network's own `PREFIX`, but
  tests the whole set when deciding which moderation actions to offer you, so
  someone who is both `+o` and `+v` is understood correctly.
  <br>`vue_client/src/utils/memberPrefix.ts:20`, `vue_client/src/composables/useMemberActions.ts:199`
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

### People have names and faces, where the network keeps them

On a network that stores profile data (Ergo does), a member's chosen display
name shows in place of their nick in the message list, the member list and DM
rows — the nick stays the identity: it's in the hover, the profile, the colour
and the mention matching — and their avatar shows in the compact layout and
the profile modal. Set yours with `/displayname` and `/avatar`, or in the
network menu's Edit Profile. Lurker remembers yours per network and sets it
again after every connect, since most servers forget it when you disconnect.

- **`draft/metadata-2`** — Lurker subscribes to `display-name`, `avatar`,
  `pronouns`, `homepage` and `status`, keeps a record per nick for the life of
  the connection, and re-syncs on every re-attach. A server syncs the room's
  metadata to whoever joins it, not the joiner's to the room, so Lurker asks
  for a joining peer's record itself (`METADATA <nick> SYNC`). Three line shapes are read
  as one: the spec's `METADATA`, and the `761`/`766` numerics Ergo sends them
  as. An avatar URL set by another user is an involuntary fetch, so it goes
  through the link-preview decoder — the client never sees the origin — which
  crops it to a square of at most 256 px and caches that (animated GIFs and
  WebPs stay animated unless they're too big, then they're their first frame),
  and only while link previews are configured; otherwise everyone gets a
  generated tile in their nick colour. `color` is deliberately not read:
  hex values fight every theme.
- **Your own metadata** — saved per network when the server accepts a `SET`
  (from the web app, a bouncer client, or `/quote`), so one it refuses isn't
  sent again at every connect. After a fresh registration Lurker
  sends `METADATA * LIST` and then `SET`s only what the server lacks: Ergo keeps
  metadata only for always-on clients, and it rate-limits your own `SET`s
  whether or not they change anything, so a blind re-send would spend that
  budget. Nothing is re-sent before registration (`before-connect`): Ergo never
  lets a pre-registration value replace one it kept. A change made from another
  session while Lurker is connected is saved too.
  <br>`server/services/ircConnection.ts` (`reconcileOwnMetadata`), `server/db/networkMetadata.ts`
  <br>`server/services/ircMetadata.ts`, `server/services/ircConnection.ts` (`applyMetadata`)

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
- **`msgid`** — on networks that send one, each message's server-assigned ID is
  stored and indexed. Messages on networks that don't send them, and messages from
  before Lurker kept them, have none. A message the network sends twice under the
  same ID, in the same channel or conversation, is stored once. Reactions and replies
  are anchored on it.
  <br>`server/services/ircConnection.ts:2434`
- **`draft/chathistory`** — what you missed while Lurker was off the network comes
  back. On a network that keeps history (ergo, soju, another Lurker), every rejoin
  asks for the lines between the newest one the channel holds and the join, and
  one `CHATHISTORY TARGETS` per registration finds the conversations that had a
  line in the meantime. The lines land at their own times and are shown there,
  under the lines they followed rather than under the rejoin they were stored
  after; they count as unread, and never notify: they are what was missed, not
  what just happened. Asked for in
  pages, one request on the wire at a time, behind your own typing; a buffer with
  nothing stored asks for nothing, since a first join is not an outage. The same
  path takes a ZNC's playback at attach, which used to be dropped whole, so a
  bouncer that replays its buffer on every attach no longer doubles anything.
  With the cap on, ergo and soju also stop replaying at JOIN on their own.
  `draft/event-playback` is asked for with it: a page then carries the joins,
  parts, quits, nick changes, kicks and topic and mode changes of its window as
  the lines they were, and Lurker leaves them out, since the rejoin's NAMES and
  topic already say where the channel stands. Without it ergo renders each as
  chat from HistServ ("x joined the channel"), and a reaction as "x sent a
  TAGMSG". One known hole: a multi-line message inside a page (a batch inside the batch) is
  dropped by irc-framework before Lurker sees it; the rest of the page lands.
  <br>`server/services/chathistoryBackfill.ts`, `server/services/ircConnection.ts`

### Multi-line messages stay one message

Paste several lines and they travel as a single logical message where the network
supports it, instead of being torn into separate messages that can interleave with
other people's chatter. One line too long for a single IRC message goes the same
way. Incoming multi-line messages are reassembled the same way.

- **`batch`**, **`draft/multiline`**, **`message-tags`**
  <br>`server/services/ircConnection.ts:518`

### Replies show what they answer

A reply opens with a faded quote of the message it answers, like `╭─ <alice> hi?`,
and clicking it jumps to the original. The quote is part of the reply, so a reply
doesn't break up someone's run of messages. A reply to one of your own messages counts
as a highlight, even when it doesn't mention your nick. Web client only for now.

- **`+reply`** (and the older **`+draft/reply`**, read and sent alongside it), which
  requires **`message-tags`**. Lurker finds the original by its `msgid` in the same
  channel or conversation. If the original is gone (taken by retention, older than your
  history, or from someone you ignore), the reply still shows, just without the quote.
  Replies you send start with `nick: ` too, so people on clients without reply support
  still see who you're answering. On a network whose `CLIENTTAGDENY` refuses the tag,
  or on an E2E channel, the reply goes out as a plain message.
  <br>`server/services/ircConnection.ts:2436` (receive), `:8305` (send),
  `server/db/messages.ts:317` (the quote)
- **Quote** is Reply's plain-text sibling, for when the people you're answering can't
  see a reply tag at all. It puts `> <alice> what she said` above your draft, on its
  own line, and your answer goes under it — two messages, no tag, that read the same
  on every client. The two lines send without the split confirmation; a long line torn
  in two by word wrap still asks. Quote replaces a pending Reply: one message carries
  one reply tag, and it would land on the quote line. On the way in, any line that
  starts with `> ` is drawn as a block quote — faded like the reply quote, with a bar
  where the `> ` was — whichever client wrote it.
  <br>`vue_client/src/utils/replyText.ts` (`quoteLineFor`, `quoteBlocks`),
  `vue_client/src/components/MessageInput.vue` (`quoteIntoDraft`),
  `vue_client/src/components/RenderSegments.vue` (the block)

### Reactions sit under the message

Emoji (or short text) reactions show as chips under the message they're on, with a
count; click one to add yours or take it back. Other people's reactions to your
messages show up in the activity view beside your highlights. They don't ping you.
Web client only for now.

- **`+draft/react`** and **`+draft/unreact`**, sent on `TAGMSG` and anchored to a
  message by **`+reply`** / **`+draft/reply`** (each name the network allows). Sending
  needs **`message-tags`** and **`echo-message`**: Lurker records your reaction only
  when the network echoes it back, so what you see is what the network accepted. A
  network whose `CLIENTTAGDENY` refuses the tags gets no React button. A reaction is at
  most 64 characters (graphemes) and is dropped, not cut short, when longer.
- You can't react to notices, or to messages on an E2E channel, where a reaction would
  be cleartext about an encrypted line. Other people's reactions there still show,
  read-only. New reactions from someone you ignore are dropped; ones they gave before
  you ignored them stay. Reactions aren't replayed to bouncer clients yet (#991).
  <br>`server/services/ircConnection.ts:3926` (receive), `:8321` (send)

### A deleted message is deleted here too

When someone deletes a message on a network that supports it, the line in Lurker
loses its words and reads _message deleted_ — naming who did it when it wasn't the
author, and the reason if one was given. Its reactions go with it, replies that
quoted it quote the deletion instead, and it leaves search, bookmarks, the activity
view and export. You can delete your own lines the same way (**Delete message** on
the line, or `/delete [reason]` for the last thing you said), and other people's
where you're an op, if the network allows that. Nothing is kept: the words are gone
from your server, not hidden.

- **`draft/message-redaction`**: Lurker asks for it and acts on every `REDACT` the
  network sends, its own echoed one included. A `REDACT` for a line it doesn't hold
  — one retention took, a reaction's `TAGMSG`, a msgid learned elsewhere — is ignored,
  as the spec says. A refusal (`FAIL REDACT …`) lands in the buffer the line is in.
  The network has the last word on who may delete what; on ergo that is the author
  (logged in), channel ops, and opers, and only with `allow-individual-delete` on.
  Attached IRC clients that negotiate the cap get the network's `REDACT`s and can send
  their own; a deleted line is left out of their playback and `CHATHISTORY`.
  <br>`server/services/ircConnection.ts` (`onRedactLine`, `sendRedact`),
  `server/db/messages.ts` (`redactMessage`), `server/services/bouncer.ts`
  (`handleClientRedact`)

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
  <br>`server/services/ircConnection.ts:880`

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

| You get                                                                                                      | Powered by                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Log in with SASL instead of a server password                                                                | `sasl` (PLAIN)                                                |
| Backlog replays at its original timestamps, not at attach time                                               | `server-time`                                                 |
| Scrollback on demand — page back through Lurker's full stored history from your terminal client              | `draft/chathistory`                                           |
| Joins, parts, quits, nick changes, kicks, and mode and topic changes in that scrollback                      | `draft/event-playback`                                        |
| What you've read in one client is read in the others, and in the web and iOS apps                            | `draft/read-marker`                                           |
| A client connecting in the background doesn't count as you being here                                        | `draft/pre-away`                                              |
| Your own sent messages echoed back, if your client wants them                                                | `echo-message`                                                |
| Your outgoing DMs attributed to you correctly in replay                                                      | `znc.in/self-message`                                         |
| Pick your network from a list instead of hardcoding `username/networkname`                                   | `soju.im/bouncer-networks`, `soju.im/bouncer-networks-notify` |
| Message metadata passed through from upstream                                                                | `message-tags`                                                |
| Network list delivered as one grouped burst                                                                  | `batch`                                                       |
| Attach a file in your client and get a link to send, when `PUBLIC_BASE_URL` is set                           | `soju.im/FILEHOST`                                            |
| People's away, account and host changes, when your network sends them                                        | `away-notify`, `account-notify`, `chghost`                    |
| The same for people you `MONITOR` but share no channel with                                                  | `extended-monitor`, `draft/extended-monitor`                  |
| Accounts on JOINs and on each message, when your network sends them                                          | `extended-join`, `account-tag`                                |
| Display names and avatars, when your network keeps them — SUB to the keys you show                           | `draft/metadata-2`                                            |
| Deleted messages deleted in your client too, and the right to delete your own, when your network supports it | `draft/message-redaction`                                     |
| Every prefix and full hostmasks in NAMES, when your network sends them                                       | `multi-prefix`, `userhost-in-names`                           |
| Invites other people get to your channels                                                                    | `invite-notify`                                               |
| Told when a capability comes or goes, such as while your network reconnects                                  | `cap-notify`                                                  |

Implementation notes worth knowing if you're writing against it:

- Scrollback is capped at 1000 messages per request, advertised via the
  `CHATHISTORY` ISUPPORT token. Over-limit requests are **rejected, not silently
  truncated** — matching soju, whose clients read the token and stay under it.
  History lines carry the network's own `msgid`, the one your client saw on the line
  live. A line has none if Lurker never stored one for it (the network didn't send
  one, or the message predates Lurker keeping them), or if it's a decrypted E2E
  message, whose ID belongs to the encrypted line. Message references are
  `timestamp` only, as with soju.
  <br>`server/services/bouncer.ts:177`, `:570`
- A client that negotiates `draft/chathistory` gets no playback on attach, as with
  soju. It fetches the history it wants itself, so it doesn't see the same lines twice.
  <br>`server/services/bouncer.ts:2016`
- With `draft/event-playback`, history also has joins, parts, quits, nick changes,
  kicks, and mode and topic changes, and they count toward the limit, as with soju.
  Events that name your current nick are left out: your own join, part, quit or nick
  change, or a kick of you. Some clients apply every replayed line to what they show
  now, so an old part of yours would mark the channel as left. Host changes and
  invites aren't replayed, a JOIN is sent without extended-join's account and
  realname, and by default join, part, quit, nick and mode lines are kept for 7 days.
  Playback on attach stays messages only.
  <br>`server/db/messages.ts:617`, `server/services/bouncer.ts:2089`
- Tags that only a server may set — `time`, `account`, `msgid`, `label`, `batch` —
  are stripped from anything an attached client sends, so a downstream client can't
  forge them.
  <br>`server/services/bouncer.ts:302`
- Caps whose lines come from the network (`away-notify`, `account-notify`,
  `account-tag`, `chghost`, `extended-join`, `multi-prefix`, `userhost-in-names`) are
  offered only while the network you bind has them, as soju does. `CAP LS 302` lists
  them before you pick a network, then `CAP DEL` takes back any that network lacks, and
  `CAP NEW` offers them again when it reconnects.
  <br>`server/services/bouncer.ts:157`
- What the network sends is trimmed to the caps your client negotiated, as soju and ZNC
  do: no `AWAY` without `away-notify`, a bare `JOIN` without `extended-join`, one prefix
  per nick in NAMES and WHO without `multi-prefix`, and so on. Without `chghost`, a host
  change arrives as the `QUIT`, `JOIN` and `MODE` a network sends in its place. Lurker
  never offers `draft/multiline`, so multiline messages arrive as separate lines.
  <br>`server/services/bouncerClientFilter.ts`
- Each attached client has its own `MONITOR` list, as in soju. Lurker merges the lists
  with its own watches (DM presence, nick regain) onto the network's one list, answers
  `L` and `S` from the client's list, and sends `730` and `731` only to the clients
  watching that nick. Everyone shares the network's limit, a client's list holds at most
  1000 nicks, and a nick that doesn't fit gets `734`.
  <br>`server/services/bouncer.ts:2416`, `server/services/monitorList.ts`
- Someone's away, account, host and realname changes reach a client that shares a
  channel with them. With `extended-monitor`, they also reach a client whose own
  `MONITOR` list has them, but not other clients: the network sends them for every nick
  on its one list, including Lurker's DM contacts and other clients' watches (soju
  sends them to every client). Both names are offered while the network has either.
  <br>`server/services/bouncerClientFilter.ts:401`
- `PART` leaves the channel and the channel stays in Lurker's list, dimmed, with its
  scrollback — the same thing `/part` does in the web app, and no longer rejoining on
  connect. Closing that window (in the web or iOS app; there's no way to ask for it
  from here) sends no second `PART`, because a network answers one for a channel it
  knows you left with `442`, and every attached client would be handed that error for
  a command nobody issued. A `PART` you send is forwarded either way — it's your
  command, and the server's answer to it is yours to see. ZNC and gamja both decline
  to send a `PART` for a channel they aren't on; soju and The Lounge never get there,
  because their own `PART` drops the channel outright.
  <br>`server/services/wsHub.ts` (`closeBuffer`), `server/services/bouncer.ts:2415`

- Read markers are the account's, the same unread position the web and iOS apps show.
  `MARKREAD` with a time moves it to the newest message at or before that time, and
  every client on the network that negotiated `draft/read-marker` hears the move, as do
  the apps. A channel's marker comes after its `JOIN`, before `NAMES`; ask for a DM's
  with `MARKREAD <nick>`.
  <br>`server/services/bouncer.ts:2208`, `server/services/ircManager.ts:948`
- Away is the account's, as it is in the web and iOS apps. `AWAY` from any client sets
  or clears it on every network. That client gets its `305` or `306`, and so does every
  other client, including one that attaches while you're away. `AWAY *` (from
  `draft/pre-away`) marks a connection that isn't you, such as goguma's background sync:
  it leaves your away alone. Any other attached client counts as you being here, so
  auto-away waits until the last one goes.
  <br>`server/services/bouncer.ts:2370`, `server/services/presence.ts:47`
- A reply goes only to whoever asked: your client, another attached client, the web
  app, or Lurker itself, which sends `MODE` and `WHO` when it joins a channel. A
  network's replies don't say who asked, so Lurker matches them to its queries in the
  order they went out.
  - Replies that name their channel or nick (`WHOIS`, `WHOWAS`, `NAMES`, `TOPIC`,
    channel modes) are matched by that name, so those queries go out at once.
  - Replies to `WHO`, `LIST`, `ISON`, `USERHOST` and a `MODE` for your own nick name
    nothing. Each of those waits until the last one of its kind is answered, as soju
    does for `WHO` and `LIST`.
  - `MODE #channel` is answered from Lurker's last reply until a mode it shows changes.
  - A query the network never answers ends after 30 seconds. `WHO`, `WHOIS`, `WHOWAS`,
    `LIST`, `NAMES` and list-mode queries then get their end numeric, marked
    `Command aborted`; the others get nothing.
    <br>`server/services/replyRouter.ts`
- A CTCP request such as `VERSION` gets one answer. While an IRC client is attached, it
  gets the request and Lurker stays quiet, as with ZNC, and its `VERSION` reply goes out
  with `via Lurker <version>` added. If that client doesn't answer (goguma and gamja
  never do), nobody does. With no client attached, Lurker answers. Once you change a CTCP
  reply in settings, that type stays Lurker's and no client sees the request: Lurker sends
  your reply, or nothing if it's empty or CTCP replies are off. A connection that sent
  `AWAY *` doesn't count as attached.
  <br>`server/services/ctcp.ts`, `server/services/ircConnection.ts`
- With `soju.im/bouncer-networks-notify`, your client hears when a network is added,
  edited or deleted in Lurker, and each notice carries only what changed. A network
  that failed to connect says why in its `error` attribute until it connects. A client
  attached to a network that's deleted is disconnected. Networks are managed in Lurker
  itself, so `ADDNETWORK`, `CHANGENETWORK` and `DELNETWORK` are refused.
  <br>`server/services/bouncer.ts:1631`
- `soju.im/FILEHOST` points your client at `<PUBLIC_BASE_URL>/api/filehost`. It's only
  advertised when `PUBLIC_BASE_URL` is set to an https URL and your account has an
  uploader. Your client uploads there with the credentials it logged in with: HTTP Basic
  with your password or a read-write API token (a `/network` or `@client` in the username
  is ignored), or an OAuth token as the password or as a Bearer token. The file goes
  through the same uploader and rules as an upload from the web app: images, text and
  audio/video only, images re-encoded, and it shows in your uploads list. The answer is
  `201 Created` with a `Location`; errors are plain text. Failed logins count toward the
  same limit as the web sign-in. A network's own `FILEHOST` token is never passed on, so
  your client can't send your Lurker password to the network's upload server.
  <br>`server/routes/filehost.ts`, `server/services/bouncer.ts:584`

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
| `draft/metadata-2`                      |   ✅   |   ✅    |
| `+typing`                               |   ✅   |    —    |
| `+draft/react`, `+draft/unreact`        |   ✅   |    —    |
| `+reply`, `+draft/reply`                |   ✅   |    —    |
| `draft/message-redaction`               |   ✅   |   ✅    |
| `draft/chathistory`                     |   ✅   |   ✅    |
| `draft/event-playback`                  |   ✅   |   ✅    |
| `draft/read-marker`                     |   —    |   ✅    |
| `draft/pre-away`                        |   —    |   ✅    |
| `multi-prefix`                          |   ✅   |   ✅    |
| `userhost-in-names`                     |   ✅   |   ✅    |
| `away-notify`                           |   ✅   |   ✅    |
| `extended-join`                         |   ✅   |   ✅    |
| `account-notify`                        |   ✅   |   ✅    |
| `chghost`                               |   ✅   |   ✅    |
| `invite-notify`                         |   ✅   |   ✅    |
| `monitor`                               |   ✅   |   ✅    |
| `extended-monitor`                      |   ✅   |   ✅    |
| `whox`                                  |   ✅   |    —    |
| `znc.in/self-message`                   |   —    |   ✅    |
| `soju.im/bouncer-networks` (+`-notify`) |   —    |   ✅    |
| `soju.im/FILEHOST`                      |   —    |   ✅    |

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

| Capability         | What it would give you                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `standard-replies` | Machine-readable `FAIL`/`WARN`/`NOTE` errors, so command failures render as real explanations instead of raw numerics. |

### Moderate value

| Capability                   | What it would give you                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labeled-response`           | Reliable correlation of a command with its reply, which makes command results attributable even when several are in flight.                                                      |
| `setname`                    | Change your realname without reconnecting. Lurker doesn't request this today.                                                                                                    |
| `bot-mode`                   | Visually distinguish bots from people in the nicklist and message list.                                                                                                          |
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
