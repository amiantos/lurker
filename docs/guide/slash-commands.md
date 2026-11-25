# Slash Commands

::: info This chapter is in progress
A full command reference will be **generated from the source** so it never drifts
from the app. For now, this is an outline.
:::

Lurker is built around a slash-command interface: every feature is operable by
typing a structured command, and the graphical UI is a view over that same core.
If you know the command, you never need to reach for the mouse.

## How commands work

- Type `/` in the message box to start a command.
- App-scoped commands (like settings and network management) run regardless of
  which buffer you're in; their output appears in the **system buffer**.
- A word Lurker has no command for is sent to the server as typed.

## Completion

Typing `/` opens a menu of commands, each with its usage and what it does. It
narrows as you type. Past the command, the menu follows the command's own
arguments:

- `/join `, `/part ` list your channels; `/msg `, `/kick ` list nicks. No `#` or
  `@` needed.
- `/dcc `, `/theme `, `/network ` list their subcommands.
- `/ignore -` lists its options.
- `/set ` lists setting keys with their current value, then the values a key
  takes. `/theme apply ` lists your themes.

Arrow keys move, **Tab** accepts, **Escape** closes the menu. **Enter** accepts
too, unless what you typed is already complete: `/aw` + Enter becomes `/away `,
and `/away` + Enter sends. On a nick or a channel, Enter sends what you typed
(`/join #new` joins `#new`) unless you picked a row with the arrows.

Once the command is typed, its usage stays under the menu with the argument you
are on picked out, and stays through the ones the menu has nothing to offer for:
a reason, a message. Escape puts it away until you start another command.

## Common commands

- `/commands` — list every command. (`/help` asks the IRC server for its own
  help.)
- `/delete [reason]` — delete the last line you said in this buffer, on a network
  that supports message deletion (ergo does, when its admin allows it). The line
  reads _message deleted_ everywhere afterwards, for everyone whose client
  understands; the reason, if you give one, travels with it.
- `/network` — view and manage your network connections.
- `/flushq` — drop your messages still waiting to be sent on the current
  network (a long paste that flood protection is spacing out). Each one is
  marked not sent in its buffer. Raw lines (`/quote`), CTCP requests and
  XDCC requests are not messages and still go.
- `/save` — keep the password you just gave NickServ (`identify` or
  `register`) as the network's login, so Lurker logs you in on every connect.
  Lurker offers it once the network confirms the login, on a network with no
  password saved or one whose saved password no longer works.
- `/set`, `/get` — read and change settings from the keyboard.
- `/away [message]` — set your away status on the current network; `/back` (or
  `/away` with no message) clears it. Add `-all` for every network. The **Scope
  away to all networks by default** setting flips this, and `-one` then limits it
  to the current network.
- `/displayname <name>` and `/avatar <https://…/image.png>` — the name and
  picture other people see for you on networks that keep profile data (IRCv3
  metadata; Ergo does). `off` clears either. `/metadata set|del|list|clear`
  reaches any key. Lurker remembers what you set per network and sets it again
  each time you connect; the network menu's Edit Profile shows it all, and
  uploads a picture for you, cropped square.
- `/avatars` — list the tile sets behind generated avatars; `/avatars use <set>`
  picks one, `/avatars delete <set>` removes an upload. The sets live in
  Settings › Appearance › Avatars.

## Aliases

An alias is a command of your own: a name for one or more commands, with what you
type after it filled in.

```
/alias greet /me waves at $1
/alias cycle /part; /join $channel
/alias brb /say be right back
```

`/greet bob` then runs `/me waves at bob`.

- `/alias` lists them, `/alias -greet` or `/unalias greet` removes one. They are also
  in **Settings › Aliases**, and they follow you to every browser you sign in
  from.
- `;` separates commands. Write `\;` for a semicolon that is part of the text.
- `$1` to `$9` are the words you typed, `$2-` is the second word to the end,
  `$2-3` a span, and `$*` everything.
- `$channel` is the buffer you ran it in, `$nick` your nick there, `$network` the
  network. `$$` is a plain `$`.
- If the alias names none of the typed words, they go on the end:
  `/alias j /join`, then `/j #lurker`.
- An alias can share a name with a built-in command, and then runs in its place.
  Inside its own definition the name still means the built-in:
  `/alias quit /quit gone fishing`.
- Aliases can run other aliases.
- `/say <text>` says the text in the current buffer, which is how an alias
  speaks. `/me` works too.

## Reference

A complete, always-current command reference is planned, generated directly from
Lurker's command definitions. Until then, `/commands` in the app is the source of
truth; it is printed from the same table the completion menu reads.
