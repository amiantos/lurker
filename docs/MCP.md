# Lurker MCP & HTTP API

Lurker exposes its data and IRC actions through an authenticated
[Model Context Protocol](https://modelcontextprotocol.io/) endpoint so
external programs — LLM-driven agents, scripts, or anything else — can drive
your bouncer without a browser open.

This document covers the operator side: how to mint a token, point an
MCP-aware client at your Lurker, and what tools are available.

## Quick start

1. **Mint a token** in your settings (`/settings/api-tokens`). Choose
   read-only or read-write at creation time. The raw token is shown
   exactly once; copy it now.
2. **Configure your MCP client** with the token and the endpoint
   (`https://<your-lurker>/mcp`). See [Claude Desktop](#claude-desktop)
   below for a worked example.
3. **Verify** with `curl`:
   ```sh
   curl -X POST https://<your-lurker>/mcp \
     -H "Authorization: Bearer <your-token>" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

## Scopes

| scope        | what it grants                                                                                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`       | All read verbs. The token can list networks, browse buffers, fetch backlog, search history, and read your nick notes.                                                                                                                                                                                                     |
| `read-write` | Everything `read` does, plus every write verb: sending messages, notices and CTCP actions, writing nick notes, joining and parting channels, changing your nick, away state and channel topics, connecting and disconnecting networks, and `send_raw` — arbitrary IRC commands (`MODE`, `KICK`, `OPER`, …) issued as you. |

Scopes are coarse on purpose. Per-verb scopes are not implemented because
the threat model assumes the operator is the only person holding tokens for
their own account.

## API tokens and OAuth sign-in

`/mcp` accepts two bearer credentials:

- **An API token** from your settings, with the scope you chose. API tokens
  don't open the WebSocket the browser uses.
- **An OAuth access token.** An MCP client that looks for an OAuth server at
  your Lurker's root can skip the token and sign in through your browser: it
  finds the discovery document, registers itself, and you approve it. The token
  is read-write here and works everywhere a password sign-in does. Its redirect
  URI has to follow the rules in [OAuth for third-party clients](OAUTH.md).

There is no way to drive the browser-style stateful protocol (presence, drafts,
snapshot resume) from an MCP client — that surface is deliberately out of scope.

## Tools (MCP verbs)

All twenty-one tools come back through `tools/list` with full JSON Schemas
for their inputs. A read-only token only sees the seven read tools.

### `list_networks` _(read)_

Networks configured for your account, with live connection state and the
current nick.

### `list_buffers` _(read)_

Channels and DMs you have history for, with the most recent message
timestamp. Optionally filter by `networkId`. Server pseudo-buffers
(`:server:*`) are deliberately excluded — they're a UI plumbing concept,
not data agents should reason about.

### `recent_messages` _(read)_

Window of recent messages for one buffer, oldest-first. Paginate backwards
by passing the lowest id from a previous result as `before`. Limit defaults
to 100, capped at 500.

### `search_messages` _(read)_

Full-text search across your message history. Free-text `query` runs through
SQLite FTS5 (multiple terms are ANDed). Optional structured filters:
`networkId`, `target`, `nick`. Limit defaults to 50, capped at 100.

### `get_nick_note` _(read)_

Read your free-form note about a nick on a network. Empty string when no
note exists.

### `set_nick_note` _(read-write)_

Write a free-form note. Pass an empty string to delete. Notes are capped at
4096 chars. Writes fan out to any open browser tabs so the UI reflects the
change immediately.

### `set_relay_bot` _(read-write)_

Mark or unmark a nick as a relay/bridge bot (#277). When marked, messages from
that bot are re-attributed to the speaker embedded in its envelope, so
`[Discord] <alice> hi` is shown as from `alice`.
Pass `marked: false` to clear the mark.
An optional `pattern` overrides the built-in envelope formats with a template
using `{source}`, `{nick}` and `{message}`. A template missing `{nick}` or
`{message}` does not fail the call — it is stored and then silently ignored at
render time, so the verb returns `marked: true` for a pattern that does
nothing. Returns the stored `{ networkId, nick, marked, pattern }`, echoing the
canonical stored casing, and syncs the change to the user's open tabs.

### `send_message` _(read-write)_

Send a PRIVMSG to a channel or peer. Returns
`{ ok: false, error: "not-connected" }` when the network is offline; this
comes back as a normal tool result (not a JSON-RPC error) so agents can
branch on the value instead of catching.

### `send_action` _(read-write)_

Send a CTCP ACTION (`/me ...`). Same shape and error semantics as
`send_message`.

### `send_notice` _(read-write)_

Send a NOTICE to a channel or peer. Same shape and error semantics as
`send_message`, with NOTICE conventions — no auto-reply is expected, and bots
conventionally use it for output that should not trigger further bots.

### `send_raw` _(read-write)_

Send a raw IRC protocol line verbatim on a network — the escape hatch for any
command without a dedicated verb: `MODE #chan +o nick`, `KICK #chan bob :spam`,
`INVITE bob #chan`, `OPER user pass`, and so on. No parsing, no trailing CRLF.
**Powerful and unguarded — it runs as you.** Prefer a dedicated verb wherever
one exists. A `PRIVMSG` to a channel with end-to-end encryption enabled is
**rejected** (`e2e-channel-use-send-message`) rather than sent: this path has
none of `send_message`'s encryption, and no local echo either, so a leak here
would be silent at both ends.

Server replies (WHOIS, LIST, …) arrive asynchronously in the network's server
buffer, whose target is the literal `:server:<networkId>`. That buffer is
deliberately absent from `list_buffers`, so the result carries a `serverBuffer`
field with the exact string to hand to `recent_messages`.

`not-connected` here means the socket is actually up, not merely that a
connection object exists — a network in reconnect backoff would otherwise
accept the call and drop the line. Every write verb below uses the same gate.

### `join_channel` _(read-write)_

Join a channel; optional `key` for +k channels. The channel buffer and its
member list arrive asynchronously.

### `part_channel` _(read-write)_

Leave a channel, with an optional part `reason`.

### `set_nick` _(read-write)_

Change your nick on a network. Asynchronous and may be rejected (nick in use /
invalid) — watch the server buffer for the outcome.

### `set_away` _(read-write)_

Set or clear your away status across every network (user-wide). Pass `message`
to go away; omit it to come back. Returns `{ ok: true, away }`.

### `list_members` _(read)_

List the members currently in a joined channel, with their prefix modes
(`o`/`h`/`v`/…) and away state. Sorted by nick and capped at `limit` (default
200, max 1000) so a large channel can't flood the caller's context; `count` is
always the true total and `truncated` flags a short page. Returns
`not-in-channel` if you aren't in it.

### `whois` _(read-write)_

Send a WHOIS for a nick. The reply arrives asynchronously as numeric lines in
the network's server buffer (`:server:<networkId>`, which `list_buffers` does
not list) — read it afterward by passing the returned `serverBuffer` string to
`recent_messages`.

### `connect_network` / `disconnect_network` _(read-write)_

Connect (optionally `force` a fresh reconnect) or disconnect a configured
network. Connection is asynchronous — watch the server buffer for registration.
`connect_network` returns `locked-down` when the instance admin does not allow
that network's host, rather than tearing the connection down and failing.

### `get_topic` _(read)_ / `set_topic` _(read-write)_

Read or change a joined channel's topic. `set_topic` requires an explicit
`topic`, and an empty string **clears** the topic — it always writes, so use
`get_topic` to read. It needs the usual channel privileges (+o or a -t
channel); the server may reject it.

## Wire format

Transport is MCP's Streamable HTTP profile: a single `POST /mcp` with a
JSON-RPC 2.0 envelope. Each request reauthenticates via the `Authorization`
header — there is no Mcp-Session-Id state on the server side.

We implement four methods:

- `initialize` — capability handshake. Returns `protocolVersion`,
  `capabilities: { tools: {} }`, and `serverInfo`.
- `notifications/initialized` — client ack. No response.
- `tools/list` — enumerates verbs the token can invoke.
- `tools/call` — invokes a verb by name with arguments.

Verb-level failures (insufficient scope, unknown network, IRC offline) are
returned as a tool result with `isError: true` and a structured payload, not
as JSON-RPC errors. JSON-RPC errors are reserved for protocol problems:
malformed envelope, unknown method, missing tool name.

## Examples

### Claude Code

Claude Code's MCP client speaks streamable HTTP natively, so the setup is a
single command — no stdio bridge needed. To sign in through your browser,
add the server without a token:

```sh
claude mcp add --transport http lurker https://<your-lurker>/mcp
```

In a new session, run `/mcp`, pick `lurker` and choose **Authenticate**. Your
browser opens Lurker's approval page; approve it and the tools load. If sign-in
fails, check that `https://<your-lurker>/.well-known/oauth-authorization-server`
gives your public URL as its `issuer`. Behind a reverse proxy that doesn't pass
it through, set `PUBLIC_BASE_URL` (see [OAuth for third-party clients](OAUTH.md)).

To use an API token instead, pass it as a header. Claude Code doesn't offer
OAuth sign-in for a server that has an `Authorization` header set:

```sh
claude mcp add --transport http lurker https://<your-lurker>/mcp \
  --header "Authorization: Bearer <your-token>"
```

`claude mcp list` confirms the entry. MCP servers load at session start, so
restart Claude Code (start a new session) before the Lurker tools appear in
tool calls. To remove it later, `claude mcp remove lurker`.

### Claude Desktop

Add an entry under `mcpServers` in your Claude Desktop config (the exact
path depends on your OS; see Claude Desktop's docs). Since the transport is
HTTP, use the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
bridge to expose it as a local MCP stdio server:

```json
{
  "mcpServers": {
    "lurker": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://<your-lurker>/mcp",
        "--header",
        "Authorization: Bearer <your-token>"
      ]
    }
  }
}
```

After restarting Claude Desktop, the Lurker tools appear in the tool picker
and can be invoked directly.

### curl roundtrip

```sh
# Initialize.
curl -X POST https://<your-lurker>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List the eight tools.
curl -X POST https://<your-lurker>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Read the last 20 messages in #lurker on network 1.
curl -X POST https://<your-lurker>/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":3,"method":"tools/call",
    "params":{"name":"recent_messages",
              "arguments":{"networkId":1,"target":"#lurker","limit":20}}
  }'
```

### Auto-notes — reference integration

The repo includes a small standalone web app at
[`integrations/autonotes/`](../integrations/autonotes/) that uses the MCP API
to propose updates to your nick-notes from recent channel chatter. It's
useful on its own, but more importantly it serves as a worked example of
consuming Lurker's MCP API from outside the server. If you're building
your own integration, [`lib/mcpClient.js`](../integrations/autonotes/lib/mcpClient.js)
shows the wire protocol end-to-end and
[`lib/agent.js`](../integrations/autonotes/lib/agent.js) shows how to wrap
MCP verbs as Anthropic tool definitions for an agentic loop.

## Revocation

Revoke a token from the settings pane at any time. Soft revocation: the
row stays in the listing with a `revoked` marker (so you can see whether a
specific name was previously issued and torn down). The token immediately
stops authenticating against `/mcp`. There is no token rotation flow —
revoke the old one and mint a new one.

An MCP client that signed in with OAuth is revoked under **Settings →
Authorized apps**. Its token stops working at once, and the client has to be
approved again.

## What's not here

Intentionally outside the scope of this surface:

- **Streaming subscriptions** (`subscribe_events`, push notifications over
  MCP). Agents that want to react to live activity should poll
  `recent_messages` with a `before`/since cursor on a schedule.
- **Channel membership** (`join_channel`, `part_channel`). The operator
  manages this through the browser UI; agents that join channels without
  the operator noticing are a footgun.
- **Per-message read state** (`mark_read`, `get_unread`). Defer until a
  concrete agent needs it.
- **WHOIS / channel-member listings**. Derive from `recent_messages`; IRC
  member lists are unstable anyway.
- **REST endpoints for non-MCP HTTP clients.** MCP is the only HTTP
  surface here. If you need a non-MCP HTTP integration, file an issue
  describing the use case.
