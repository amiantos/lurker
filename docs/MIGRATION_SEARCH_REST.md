# Client migration: WS `search` → `GET /api/search`

Message search is now a REST endpoint. The WebSocket `search` command and its
`search-result` reply frame are **deprecated but still served** — nothing
breaks today, and removal (tracked in
[#799](https://github.com/amiantos/lurker/issues/799)) will be a protocol
version bump announced in its own migration guide. If you maintain a client,
migrate when convenient; new search capability will only land on the REST
route and the underlying verb, never on the WS shim.

Everything here is detailed in [Client Protocol & API](/CLIENT_PROTOCOL); this
page is the diff.

## TL;DR

- **Replace** `{type:'search', …}` over the socket **with**
  `GET /api/search?...` using the same credentials you already hold (session
  cookie or bearer token — both open every REST door).
- The rows are **identical** — same decorated event objects, produced by the
  same `search_messages` verb.
- The envelope changes from `{results, hasMore, token}` to
  `{items, nextBefore}` — the same feed contract as `/api/highlights` and
  `/api/bookmarks`, so a client that renders those already knows the shape.
- Your token/correlation machinery **deletes**: HTTP gives every request its
  own reply. Supersede a stale search by aborting the request
  (`AbortController` / `URLSession` cancellation) instead of tagging and
  dropping.

## Request mapping

| WS `search` field | REST query param                               |
| ----------------- | ---------------------------------------------- |
| `query`           | `q`                                            |
| `nick`            | `nick`                                         |
| `nicks: [a, b]`   | `nick=a&nick=b` (repeat the param; OR-matched) |
| `target`          | `target` (URL-encode: `#dev` → `%23dev`)       |
| `networkId`       | `networkId`                                    |
| `before`          | `before`                                       |
| `limit`           | `limit` (clamped to 1–100, same as the verb)   |
| `token`           | — gone; cancel the previous request instead    |

At least one of `q` / `nick` / `target` / `networkId` is required — with none,
the response is the empty page `{items: [], nextBefore: null}` rather than an
error, matching the WS command's behavior.

## Response mapping

| WS `search-result` field | REST equivalent                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| `results`                | `items` (same decorated event rows, `networkName` included)        |
| `hasMore`                | gone — `nextBefore` is non-null exactly when more matches exist    |
| synthesized cursor       | `nextBefore` — pass it back as `before` verbatim for the next page |
| `token`                  | gone                                                               |

One behavioral upgrade to know about: an unowned or unknown `networkId`
returns **404** on REST, where the WS path returned an empty result. Treat it
like the empty page unless you surfaced network scoping in UI.

## Reference implementation

The web client's search store
(`vue_client/src/stores/search.ts`) is the worked example: URL building from
the `from:`/`in:`/`on:` syntax, `AbortController` cancellation of superseded
searches, stale-response guarding for pagination, and a dedupe that skips
refetching when debounced typing produces an identical effective query. It
went from a socket send + frame correlation to a plain `fetch` in the same
number of lines.

## Why this moved (short version)

Not speed — the same query runs either way. As a WS verb, search was welded
to the socket hub: result pages competed with the live IRC event stream for
the socket's backpressure budget, and a superseded search could not be
cancelled because there is no WS cancel frame. As a URL it's a stateless
read: cancellable and cacheable by infrastructure. Full reasoning in
[#676](https://github.com/amiantos/lurker/issues/676).

Since 2.7.0 the query runs off the server's event loop, in a separate search
process, for both transports
([#1302](https://github.com/amiantos/lurker/issues/1302)). That is where the
difference between them now shows: aborting the REST request stops the search
at once, while a WS search you have superseded keeps its place until it
finishes, its socket closes, or the time limit ends it. Either can now fail
with "took too long" — see `GET /api/search` in
[CLIENT_PROTOCOL](/CLIENT_PROTOCOL).
