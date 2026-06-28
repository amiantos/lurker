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
- `/network` — view and manage your network connections.
- `/set`, `/get` — read and change settings from the keyboard.
- `/away` — set your away status (applies to every connection).

## Reference

A complete, always-current command reference is planned, generated directly from
Lurker's command definitions. Until then, `/help` in the app is the source of
truth.
