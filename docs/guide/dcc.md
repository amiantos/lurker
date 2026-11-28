# Files and Chat (DCC)

DCC is how IRC users send each other files and hold direct chats, outside the
IRC server. In Lurker the receiving end is the Lurker server: a file someone
sends you lands on your server's disk and stays there, and you download it to
whatever device you're on.

::: info Self-hosted only, and off by default
DCC isn't available on hosted lurker.chat. On a self-hosted Lurker, the admin
turns it on for the instance and then for each person, in three parts: chat,
receive files and send files. See [DCC and XDCC](/SELF_HOSTING#dcc-and-xdcc)
in the self-hosting guide.
:::

Once you have any part of it, a **DCC** button appears next to **Shares** at
the foot of the buffer list on a computer. On a phone, **DCC** is in the ⋮
menu at the top of the buffer list, beside **Shares**. It opens the DCC window,
and the button (on a phone, the ⋮) turns the warning colour while an offer is
waiting for you. **Settings → DCC** shows which parts you have, the
space your files use, and the limits the admin set.

## The DCC window

The window has three parts:

- **waiting for you**: offers you haven't answered, with **Accept** and
  **Decline**.
- **in progress**: what is moving, grouped by who it's with, with speed and
  time left. A bot's block is its queue (below). A transfer that failed stays
  here with **Retry** when it can be retried, and **Delete partial** for the
  bytes it got.
- **kept**: every file you have on the server, received or uploaded, with
  **Download** and **Delete**. The line above the list says how
  much space your files take, partials included, and your limit if the admin
  set one. What a file coming in has still to send counts toward the limit
  too, shown as "on the way". **Delete partial** frees a partial's space.

Each row's actions are behind its **⋯** button, except an offer's Accept and
Decline and a queued pack's Remove, which sit on the row.

## Receiving a file

When someone offers you a file, a toast appears with **Accept**, **Decline** and
**Later**. **Later** hides the toast, and the offer waits in the DCC window. An
offer from someone you have no DM with opens one, as a private message would.

While a file comes in, the status bar shows it whenever you're in that
person's DM: the file, how far along it is, and how many more are queued.
Tapping it opens the DCC window.

Some clients (halloy and HexDroid by default) send _passive_ offers, where your
server has to accept a connection from them. Those only work if the admin set
your server up for it; otherwise Lurker says it can't take the offer.

A file that was cut off, by a dropped connection or a restart, isn't lost. The
next time the same file is offered, Lurker asks the sender to resume from where
it stopped.

## XDCC bots

An XDCC bot offers numbered packs, and you ask for one by messaging the bot:
`/msg Bot xdcc send #29`. Lurker takes the bot's offer for that pack without
asking you, since you just requested it.

To get several packs, queue them instead:

| Command                           | What it does                                                |
| --------------------------------- | ----------------------------------------------------------- |
| `/xdcc add <bot> <pack>`          | Queue one pack (`29`, `#29` or `29-32`)                     |
| `/xdcc addl <bot> <first> <last>` | Queue a range                                               |
| `/xdcc addm <bot> <pack> <pack>…` | Queue several                                               |
| `/xdcc queue [<bot>]`             | List the queue, one bot or all                              |
| `/xdcc rmp <bot> <pack>`          | Take a pack out (`rmpl` and `rmpm` take a range or several) |
| `/xdcc rmbot <bot>`               | Drop a bot's whole queue                                    |

The queue asks each bot for one pack at a time, and every bot's queue runs at
once. It lives on the server, so it keeps going while you're away and after a
restart. Up to 500 packs can be queued in one command.

- If the bot doesn't answer within two minutes, or the download fails, the pack
  goes to the back of that bot's queue for one more try. If it fails again it
  stays failed, with **Retry**. A pack the bot refuses (no such pack, queue
  full) or Lurker refuses (too big, over your limit) isn't tried again.
- If the bot puts you in its own queue, the status bar says so and Lurker waits
  up to 12 hours.
- Cancelling a pack the bot is sending tells the bot to stop.

## Checksums

Many release files carry a CRC32 checksum in their name, like
`Show - 01 [1080p][A1B2C3D4].mkv`. Lurker checks every received file against
it, and a kept file says how that went:

- **Verified**: the file matches.
- **Checksum mismatch**: it doesn't, so the file is damaged. Get it again.

A file whose name carries no checksum says nothing: the size matched, but there
was nothing more to check.

A resumed file is read back and checked as a whole once it's complete. The DCC
window says "checking the checksum" while that happens. One Lurker couldn't read
back says nothing either.

## Sending a file

To send someone a file, use **Send File (DCC)…** from their name in the member
list or their profile's **⋯** menu, or from a DM: the DM's menu in the buffer
list, or (on a computer) the send button at the top of the DM. The DCC window opens to pick the
file: one you keep, or a new one to upload.

From the keyboard: `/dcc send <nick> [<file>]`, where the file is a name or an
id from `/dcc files`. With no file, the DCC window opens to pick one.

A normal send needs your server to be reachable from outside. If the admin
hasn't set that up, Lurker asks the other side to connect instead (a _passive_
offer), and the line in the DM says "(passive)". Not every client takes one:
WeeChat and HexDroid don't.

## DCC chat

A DCC chat is a direct conversation with one person, not relayed by the IRC
server. It opens in a buffer named `=nick`.

- **Chat (DCC)** from someone's name in the member list, their profile's **⋯**
  menu, or a DM's menu in the buffer list offers one; so does
  `/dcc chat <nick>`. `/dcc chat -passive <nick>` asks the other
  side to listen instead. Only some clients handle that (irssi, HexChat and
  repartee do; WeeChat and HexDroid don't).
- An offer someone sends you gets an **Accept**, **Decline** and **Later**
  toast. Unlike a file, it doesn't wait in the DCC window: after **Later**,
  `/dcc chat <nick>` accepts it, for up to 10 minutes.
- `/dcc close chat <nick>` ends it.

## Secure DCC

A DCC connection is plain TCP, so anyone on the path can read it. KVIrc's
secure DCC puts the same chat or file transfer inside TLS, and Lurker speaks
it: **Secure Chat (DCC)** and **Secure Send File (DCC)…** sit under the plain
entries in the same menus, and `/dcc chat -secure <nick>` and
`/dcc send -secure <nick> [<file>]` do the same from the keyboard. When the
DCC window is picking a file for a secure send, its title says **secure dcc**.
An offer that arrives this way is taken this way. The toast, the status line and the
row in the DCC window say "secure"; a secure chat's connected line names the
TLS version and cipher, and its buffer shows a lock in the status bar for as
long as it is up. The send button at the top of that buffer sends securely
too. Everything else is the same, including `-passive`.

Two things to know:

- **Only KVIrc does both.** ZNC's `schat` module does secure chat. Other
  clients either show the offer as something they don't understand or ignore
  it. Two Lurker servers can talk to each other securely.
- **It stops eavesdropping, not impersonation.** Neither side checks who the
  other is; KVIrc has no certificate at all by default. Lurker's side uses the
  same self-signed certificate as its bouncer. Someone who can intercept the
  connection itself could still sit in the middle. For that, the IRC network's
  own TLS and services are no help either: DCC never goes through the server.

## /dcc commands

The `<id>` below is a transfer's, as `/dcc list` shows it.

| Command                                          | What it does                                        |
| ------------------------------------------------ | --------------------------------------------------- |
| `/dcc` or `/dcc list`                            | Open the DCC window and list transfers, with ids    |
| `/dcc files`                                     | List your kept files, with ids for `/dcc send`      |
| `/dcc accept <id>`, `/dcc reject <id>`           | Answer an offer                                     |
| `/dcc cancel <id>`                               | Stop a transfer                                     |
| `/dcc retry <id>`                                | Ask a bot for a failed pack again                   |
| `/dcc download <id>`                             | Download a received file                            |
| `/dcc delete <id>`                               | Delete a transfer's file from the server            |
| `/dcc clear [<id>]`                              | Clear finished transfers from the list (files stay) |
| `/dcc send [-passive] [-secure] <nick> [<file>]` | Send a file; `-secure` over TLS                     |
| `/dcc chat [-passive] [-secure] <nick>`          | Offer a chat; `-secure` over TLS                    |
| `/dcc close chat <nick>`                         | End a chat                                          |

## Things to know

- **DCC is refused on a network that uses a proxy.** DCC connects directly,
  outside the proxy, so it would give away the address the proxy hides. See
  [Getting Started](/guide/getting-started).
- **Turning a part off stops what starts next.** If the admin takes away your
  receive or send part, a transfer already running finishes, and files you
  already have stay yours to download.
