# The Interface

::: info This chapter is in progress
An outline is below. Help finish it via **Edit this page on GitHub**.
:::

A tour of the Lurker window and how messages are organized.

## Buffers

- What a buffer is: channels, direct messages, and the system buffer.
- The buffer list: pinning, rearranging, and unread indicators.

## Reading and writing

- Message composition, drafts, and tab completion.
- **Reply** and **Quote** on a message (the hover bar, or tap the message). Reply
  starts your line with their nick and, on a network that carries IRCv3 reply tags,
  shows a faded quote of the original above your message. Quote puts
  `> <alice> what she said` above your draft as plain text and your answer under
  it, for the people whose clients never see a reply tag. The two lines go out as
  two messages without the split confirmation. Any line that starts with `> `,
  yours or anyone's, is drawn as a block quote: faded, with a bar where the `> `
  was.
- **Delete message** on one of your own lines (and on others' where you're an op),
  on a network that supports message deletion. The line stays in place and reads
  _message deleted_ — for you, for everyone else on a client that understands, and
  in search, bookmarks and replies that quoted it. The words are gone from your
  server, not hidden. `/delete [reason]` does the same for the last thing you
  said.
- **Reply threads** (Settings › Chat, experimental, off by default). With it on,
  replies leave the channel: a line that was replied to shows `╰─ 3 replies 4m`
  under it, and that opens the thread beside the channel (over it, on a phone)
  with its own composer. A reply in a thread badges the channel only when it
  mentions you or answers one of your lines, and the Threads button in the
  header shows how many threads hold one; the chip turns accent when a thread
  you're in has replies you haven't seen. The Threads button, or `/threads`,
  lists the channel's threads.
- Saved messages and user notes.
- **Dimmed messages** at the foot of a buffer: yours, still to send. Lurker
  spaces out a long paste or a burst so the server doesn't drop the connection
  for flooding; each message turns solid as it goes, and one that never made
  it (the connection dropped first) is marked in its buffer. What
  you type goes ahead of Lurker's own housekeeping (refreshing names and modes
  after a join or a reconnect), and behind the join itself. If a server exempts
  you from its flood limits (you're an oper there, or you connect through a
  bouncer that paces on its own), turn **Flood protection** off in that
  network's advanced options, or `/network modify <name> -noflood`; lines then
  go out at once. On a server that says it never disconnects for flooding (it
  advertises `SAFERATE`, as Ergo and soju do), what you send is not paced at
  all, whatever the switch says; only Lurker's own housekeeping still is.

## Direct messages & presence

- Starting a DM and reading peer presence (online / away / offline).

## Link previews & inline media

Links in chat can do more than sit there as text. Two toggles in
**Settings → Chat** control it, and both start **off** — turn on what you want:

- **Link previews** — a link to an article or video unfurls into a card below
  the message: title, description, and a picture when the page offers one.
- **Inline media** — a link that points straight at an image renders the picture
  itself below the message instead of just the URL. A link to a video or audio
  file gets a card naming it; opening one goes to the site hosting it.

They're independent: preview cards without inline images is a perfectly good
combination, and so is the reverse. Turning both off returns every link to
plain text.

::: info Don't see these settings?
The toggles only appear when your instance has link previews enabled. If they're
missing from Settings → Chat, ask your operator — it's one environment variable
on the server ([self-hosting docs](/SELF_HOSTING#link-previews-inline-media)).
:::

## Customizing the look

- The 40+ settings and the retro terminal theme.
- **Avatars.** In the compact message layout, turn on **Show avatars** and every
  author gets one: the picture they set on networks that keep profile data, or a
  square in their nick colour with a tile from the active avatar set. Upload your
  own set as a zip of square images under Settings › Appearance › Avatars.

## See also

- [Slash Commands](/guide/slash-commands)
