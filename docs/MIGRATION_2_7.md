# Client migration: 2.6 → 2.7

Lurker 2.7 removes one request from the WebSocket protocol and moves the
protocol version to **2**. If you maintain a client, this page is the whole
list.

Everything here is detailed in [Client Protocol & API](/CLIENT_PROTOCOL); this
page is the diff.

## TL;DR

- The WS **`search` command and its `search-result` frame are gone**. Search is
  `GET /api/search`, which has been there since 2.1.3.
- **`protocolVersion` is 2.** `minProtocolVersion` stays 1: a version 1 client
  that doesn't send `search` needs no change at all.
- Nothing else was removed. Everything added in 2.7 is additive.

---

## Breaking: the WS `search` command is gone

| Removed                            | Replacement       |
| ---------------------------------- | ----------------- |
| `{type:'search', …}` (client verb) | `GET /api/search` |
| `{kind:'search-result'}` (frame)   | the HTTP response |

**The failure mode to check for first:** a client that still sends `search`
gets the generic `{kind:'error', text:'unknown message type: search'}` frame,
with no `token`. If you wait on a `search-result` matched by token, that wait
never ends. The socket stays open and everything else keeps working.

To tell which server you are talking to, read `protocolVersion` from
`GET /api/config` or the `snapshot` frame: 2 or higher has no WS search. The
REST route works on both.

### Request mapping

Use the same credentials you already hold (session cookie or bearer token).

| WS `search` field | REST query param                               |
| ----------------- | ---------------------------------------------- |
| `query`           | `q`                                            |
| `nick`            | `nick`                                         |
| `nicks: [a, b]`   | `nick=a&nick=b` (repeat the param; OR-matched) |
| `target`          | `target` (URL-encode: `#dev` → `%23dev`)       |
| `networkId`       | `networkId`                                    |
| `before`          | `before`                                       |
| `limit`           | `limit` (clamped to 1–100)                     |
| `token`           | — gone; cancel the previous request instead    |

At least one of `q` / `nick` / `target` / `networkId` is required. With none,
the response is the empty page `{items: [], nextBefore: null}`, not an error.

### Response mapping

| WS `search-result` field | REST equivalent                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| `results`                | `items` (same decorated event rows, `networkName` included)        |
| `hasMore`                | gone — `nextBefore` is non-null exactly when more matches exist    |
| synthesized cursor       | `nextBefore` — pass it back as `before` verbatim for the next page |
| `token`                  | gone                                                               |

The envelope is the same feed contract as `/api/highlights` and
`/api/bookmarks`, so a client that renders those already knows the shape.

Three differences from the WS command:

- An unowned or unknown `networkId` returns **404**, where the WS path returned
  an empty result.
- Your token/correlation machinery deletes: HTTP gives every request its own
  reply. Supersede a stale search by aborting the request (`AbortController` /
  `URLSession` cancellation). An aborted search stops on the server at once.
- A search can answer **`503 {error}`**: it took too long, too many are
  waiting, or a newer search of yours displaced it. Show the error and let the
  user retry. See `GET /api/search` in [CLIENT_PROTOCOL](/CLIENT_PROTOCOL).

### Reference implementation

The web client's search store (`vue_client/src/stores/search.ts`) is the worked
example: URL building from the `from:`/`in:`/`on:` syntax, `AbortController`
cancellation of superseded searches, stale-response guarding for pagination,
and a dedupe that skips refetching when debounced typing produces an identical
effective query.

### Why it moved

As a WS verb, search was welded to the socket hub: result pages competed with
the live IRC event stream for the socket's backpressure budget, and a
superseded search could not be cancelled because there is no WS cancel frame.
As a URL it is a stateless read. Full reasoning in
[#676](https://github.com/amiantos/lurker/issues/676); the removal is
[#799](https://github.com/amiantos/lurker/issues/799).

---

## The version bump

`protocolVersion` moved from 1 to 2 because removing a request is the one kind
of change the additive rule cannot express. What to do with it:

- Announce the version you speak on the upgrade, `/ws?v=2` once you no longer
  send `search`. `?v=1` is still accepted.
- Don't refuse a server whose `protocolVersion` is higher than yours. Only
  `minProtocolVersion` above the version you speak means you are too old.
