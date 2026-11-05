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

## Common commands

- `/help` — list available commands.
- `/delete [reason]` — delete the last line you said in this buffer, on a network
  that supports message deletion (ergo does, when its admin allows it). The line
  reads _message deleted_ everywhere afterwards, for everyone whose client
  understands; the reason, if you give one, travels with it.
- `/network` — view and manage your network connections.
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

## Reference

A complete, always-current command reference is planned, generated directly from
Lurker's command definitions. Until then, `/help` in the app is the source of
truth.
