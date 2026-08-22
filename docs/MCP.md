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

| scope        | what it grants                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `read`       | All read verbs. The token can list networks, browse buffers, fetch backlog, search history, and read your nick notes. |
| `read-write` | Everything `read` does, plus sending messages, sending CTCP actions, and writing nick notes.                          |

Scopes are coarse on purpose. Per-verb scopes are not implemented because
the threat model assumes the operator is the only person holding tokens for
their own account.

## Tokens are HTTP-only

API tokens authenticate the HTTP endpoint (`/mcp` and `/api/api-tokens`). The
WebSocket endpoint used by the browser is cookie-only and does not accept
bearer tokens. There is no way to drive the browser-style stateful protocol
(presence, drafts, snapshot resume) from an MCP client — that surface is
deliberately out of scope.

## Tools (MCP verbs)

All eight tools come back through `tools/list` with full JSON Schemas for
their inputs. A read-only token only sees the five read tools.

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

### `send_message` _(read-write)_

Send a PRIVMSG to a channel or peer. Returns
`{ ok: false, error: "not-connected" }` when the network is offline; this
comes back as a normal tool result (not a JSON-RPC error) so agents can
branch on the value instead of catching.

### `send_action` _(read-write)_

Send a CTCP ACTION (`/me ...`). Same shape and error semantics as
`send_message`.

### `send_raw` _(read-write)_

Send a raw IRC protocol line verbatim on a network — the escape hatch for any
command without a dedicated verb: `MODE #chan +o nick`, `KICK #chan bob :spam`,
`TOPIC #chan :new topic`, `WHOIS bob`, `INVITE bob #chan`, and so on. No
parsing, no trailing CRLF. **Powerful and unguarded — it runs as you.** Server
replies (WHOIS, LIST, …) arrive asynchronously; read them with `recent_messages`
on the relevant buffer. Same `not-connected` semantics as `send_message`.

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
(`o`/`h`/`v`/…) and away state. Returns `not-in-channel` if you aren't in it.

### `whois` _(read-write)_

Send a WHOIS for a nick. The reply arrives asynchronously as numeric lines in
the network **server buffer** — read it afterward with `recent_messages`.

### `connect_network` / `disconnect_network` _(read-write)_

Connect (optionally `force` a fresh reconnect) or disconnect a configured
network. Connection is asynchronous — watch the server buffer for registration.

### `get_topic` _(read)_ / `set_topic` _(read-write)_

Read or change a joined channel's topic. `set_topic` needs the usual channel
privileges (+o or a -t channel); the server may reject it.

### `send_dcc_file` _(read-write)_

Offer a file to a peer over DCC SEND. **Sandboxed to your fserve archive**
(`LURKER_FSERVE_DIR`): `path` is resolved relative to that root and rejected if
it escapes (symlinks included), so an agent can't exfiltrate arbitrary server
files. Requires DCC enabled and an fserve root configured. Returns
`{ ok: true, transferId }` on success.

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
single command — no stdio bridge needed:

```sh
claude mcp add --transport http lurker https://<your-lurker>/mcp \
  --header "Authorization: Bearer <your-token>"
```

`claude mcp list` confirms the entry. MCP servers load at session start, so
restart Claude Code (start a new session) before the eight Lurker tools
appear in tool calls. To remove it later, `claude mcp remove lurker`.

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

After restarting Claude Desktop, the eight Lurker tools appear in the
tool picker and can be invoked directly.

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
