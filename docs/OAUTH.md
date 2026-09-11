# OAuth for third-party clients

A self-hosted Lurker is an OAuth 2 authorization server for third-party apps. It
follows Mastodon's model: an app registers itself, the member signs in and
approves it in the browser, and the app exchanges a one-time code for an access
token. Hosted lurker.chat doesn't offer it.

## The flow at a glance

1. **Register** once per server: `POST /api/oauth/register` returns a
   `client_id`.
2. **Authorize:** make a PKCE verifier and challenge, then open the member's
   browser at `/oauth/authorize`. The member approves.
3. **Get the code** from the redirect to your `redirect_uri`, or have the member
   paste it (out-of-band).
4. **Exchange** the code: `POST /api/oauth/token` returns an `access_token`.
5. **Use** the token: `Authorization: Bearer <access_token>` on REST calls and
   the WebSocket.
6. **Revoke** it with `POST /api/oauth/revoke`, or the member does it in
   Settings.

The access token:

- **Access:** the same as a password sign-in — every REST route, the WebSocket
  and the MCP endpoint (`/mcp`, read-write). There are no scopes; a `scope`
  parameter is ignored.
- **Lifetime:** never expires. There are no refresh tokens; a token lasts until
  it's revoked.
- **Clients:** public only. There are no client secrets, and PKCE with `S256` is
  required on every authorization.
- **Platforms:** native, desktop and CLI apps. An app running in a web page on
  another origin can't call the API: the CORS allowlist and the WebSocket origin
  check refuse it.

The password endpoint `POST /api/auth/login/token`
([Client Protocol](CLIENT_PROTOCOL.md) §3.1) still works. Third-party clients
should use OAuth instead, so the app never handles the password.

## Discovery

`GET /.well-known/oauth-authorization-server` (RFC 8414), no auth:

```json
{
  "issuer": "https://irc.example.com",
  "authorization_endpoint": "https://irc.example.com/oauth/authorize",
  "token_endpoint": "https://irc.example.com/api/oauth/token",
  "revocation_endpoint": "https://irc.example.com/api/oauth/revoke",
  "registration_endpoint": "https://irc.example.com/api/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "token_endpoint_auth_methods_supported": ["none"],
  "revocation_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "service_documentation": "https://docs.lurker.chat/OAUTH"
}
```

`issuer` comes from `PUBLIC_BASE_URL` if the operator set it, otherwise from the
request's `Host` or `X-Forwarded-Host` header.

## Register

RFC 7591. JSON, no auth.

```
POST /api/oauth/register
Content-Type: application/json

{
  "client_name": "My Client",
  "client_uri": "https://myclient.example",
  "redirect_uris": ["com.example.myclient:/oauth"]
}
```

| Field           | Required | Rules                                                                                               |
| --------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `client_name`   | yes      | At most 60 characters. No control or text-direction characters.                                     |
| `redirect_uris` | yes      | Non-empty array, at most 2000 characters in total. See [Redirect URIs](#redirect-uris).             |
| `client_uri`    | no       | An http or https URL, at most 2000 characters. The approval page shows its host. It isn't verified. |

`scope`, `grant_types`, `response_types` and `token_endpoint_auth_method` are
ignored. The response states what you got.

`201`:

```json
{
  "client_id": "…",
  "client_id_issued_at": 1757462400,
  "client_name": "My Client",
  "client_uri": "https://myclient.example",
  "redirect_uris": ["com.example.myclient:/oauth"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

A rejected registration is `400` with `invalid_redirect_uri` or
`invalid_client_metadata`.

**Limits.** 5 registrations per IP per 10 minutes, then `429` with a
`Retry-After` header. While 1,000 registrations are waiting for approval, every
registration gets `429 temporarily_unavailable`.

**Keep the `client_id`.** A registration nobody approves within one hour is
deleted; an approved app's registration is kept. Store `client_id` per server and
reuse it. If a request later fails with `invalid_client`, register again.

## Authorize

### PKCE

Make a new `code_verifier` for each authorization and derive the
`code_challenge` from it (RFC 7636):

| Value                   | Rule                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `code_verifier`         | 43–128 characters of `[A-Za-z0-9._~-]`. Keep it for the exchange. |
| `code_challenge`        | `BASE64URL(SHA-256(code_verifier))`, no padding: 43 characters.   |
| `code_challenge_method` | `S256`. `plain` is refused.                                       |

RFC 7636's test vector, to check your implementation:

```
code_verifier   dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
code_challenge  E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
```

### Open the approval page

Open the member's browser at:

```
GET /oauth/authorize?client_id=…&redirect_uri=…&response_type=code
    &code_challenge=…&code_challenge_method=S256&state=…
```

| Parameter               | Value                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `client_id`             | From registration.                                                                     |
| `redirect_uri`          | One of the registered redirect URIs, exactly. A loopback URI may use a different port. |
| `response_type`         | `code`                                                                                 |
| `code_challenge`        | From your verifier.                                                                    |
| `code_challenge_method` | `S256`                                                                                 |
| `state`                 | Optional, at most 1024 characters. Returned unchanged.                                 |

The member signs in if needed (password or passkey) and sees the approval page:
the app's name, its website host, that it gets full access, and where the
approval goes. The page appears every time, even for an app the member approved
before. An invalid request is shown as an error on the page and is never
redirected.

| Member   | Redirect URI                               | Out-of-band                      |
| -------- | ------------------------------------------ | -------------------------------- |
| Approves | `redirect_uri?code=…&state=…`              | The page shows the code.         |
| Denies   | `redirect_uri?error=access_denied&state=…` | The page says access was denied. |

Codes are single-use and expire after 10 minutes.

## Exchange the code

```
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=…&code=…&redirect_uri=…&code_verifier=…
```

JSON with the same parameters is also accepted.

| Parameter       | Value                                       |
| --------------- | ------------------------------------------- |
| `grant_type`    | `authorization_code`                        |
| `client_id`     | From registration.                          |
| `code`          | From the redirect, or pasted by the member. |
| `redirect_uri`  | Identical to the one used at authorization. |
| `code_verifier` | The verifier the challenge was made from.   |

`200`, with `Cache-Control: no-store`:

```json
{ "access_token": "…", "token_type": "Bearer", "created_at": 1757462400 }
```

There is no `expires_in` and no `refresh_token`. A code that fails a check is
spent and can't be retried; start a new authorization. A request refused before
the code is looked at (`invalid_request`, `unsupported_grant_type`,
`invalid_client`) leaves it usable. See [Errors](#errors).

## Use the token

```
Authorization: Bearer <access_token>
```

Send it on every REST call and on the WebSocket upgrade, exactly like the session
token in [Client Protocol](CLIENT_PROTOCOL.md) §3.1 and §4.1. A `401` means the
token was revoked: discard it and authorize again.

## Revoke

RFC 7009. Form-encoded or JSON, no auth.

```
POST /api/oauth/revoke
Content-Type: application/x-www-form-urlencoded

client_id=…&token=…
```

The response is `200` whenever `client_id` is known, whether or not the token
existed. Only a token issued to that `client_id` is revoked. An unknown
`client_id` gets `401 invalid_client`, and a missing parameter gets
`400 invalid_request`. Revoking closes any WebSocket the token opened (close
code `4001`) and deletes the push subscriptions registered with it.

`POST /api/auth/logout` with `Authorization: Bearer <access_token>` does the same.

The member can revoke any app under **Settings → Authorized apps**. Account
recovery revokes every app; a normal password change doesn't.

## Redirect URIs

Each registered redirect URI must take one of these forms:

| Form                      | Example                                                                             | Notes                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| https                     | `https://myclient.example/oauth/callback`                                           |                                                                                                       |
| Loopback http             | `http://127.0.0.1/callback`, `http://[::1]/callback` or `http://localhost/callback` | At authorization the port may differ (RFC 8252 §7.3); host, path and query must match.                |
| Reverse-DNS custom scheme | `com.example.myclient:/oauth`                                                       | The scheme must contain a dot.                                                                        |
| Out-of-band               | `urn:ietf:wg:oauth:2.0:oob`                                                         | The approval page shows the code for the member to paste into the app. For TUIs over SSH and similar. |

Refused: fragments, userinfo, anything but printable ASCII, and plain `http`
anywhere but loopback.

At authorization, `redirect_uri` must match a registered URI exactly, except for
the loopback port.

## Errors

OAuth errors are JSON: `{ "error": "…", "error_description": "…" }`.

| Status | `error`                   | Endpoint      | When                                                                                                                              |
| ------ | ------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_client_metadata` | register      | `client_name` is missing or invalid, or `client_uri` is invalid.                                                                  |
| 400    | `invalid_redirect_uri`    | register      | `redirect_uris` is missing, empty or too long, or holds a URI that isn't an allowed form.                                         |
| 429    | `temporarily_unavailable` | register      | 1,000 registrations are waiting for approval.                                                                                     |
| 400    | `invalid_request`         | token, revoke | A parameter is missing.                                                                                                           |
| 400    | `unsupported_grant_type`  | token         | `grant_type` isn't `authorization_code`.                                                                                          |
| 400    | `invalid_grant`           | token         | The code is unknown, expired or already used, or `client_id`, `redirect_uri` or `code_verifier` doesn't match. The code is spent. |
| 401    | `invalid_client`          | token, revoke | Unknown `client_id`. Register again.                                                                                              |
| 400    | `invalid_request`         | all           | The request body is malformed (`413` if it's too large). No `error_description`.                                                  |

Registration also answers `429` with `Retry-After` past 5 registrations per IP
per 10 minutes.

A `401 invalid_client` rejects the `client_id`, not the member's sign-in. Don't
treat it as a revoked token.

Errors during authorization never reach the app. They're shown on the approval
page; the only error sent to `redirect_uri` is `access_denied`.

## Example: a CLI with out-of-band sign-in

The out-of-band redirect needs no local listener, so this works over SSH. It
uses `curl`, `openssl` and `jq`.

```sh
SERVER=https://irc.example.com
OOB=urn:ietf:wg:oauth:2.0:oob

# 1. Register once. Store CLIENT_ID for this server and reuse it.
CLIENT_ID=$(curl -s "$SERVER/api/oauth/register" \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"lurk-cli","redirect_uris":["urn:ietf:wg:oauth:2.0:oob"]}' \
  | jq -r .client_id)

# 2. A new PKCE verifier and challenge for this authorization.
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/\n' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary \
  | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 3. The member opens this URL, approves, and pastes the code the page shows.
AUTHORIZE="$SERVER/oauth/authorize?response_type=code&client_id=$CLIENT_ID"
AUTHORIZE="$AUTHORIZE&redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob"
AUTHORIZE="$AUTHORIZE&code_challenge=$CHALLENGE&code_challenge_method=S256"
echo "Open $AUTHORIZE"
printf 'Code: '
read -r CODE

# 4. Exchange the code for an access token.
TOKEN=$(curl -s "$SERVER/api/oauth/token" \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode client_id="$CLIENT_ID" \
  --data-urlencode code="$CODE" \
  --data-urlencode redirect_uri="$OOB" \
  --data-urlencode code_verifier="$VERIFIER" \
  | jq -r .access_token)

# 5. Use it.
curl -s "$SERVER/api/auth/me" -H "Authorization: Bearer $TOKEN"

# 6. Revoke it.
curl -s "$SERVER/api/oauth/revoke" \
  --data-urlencode client_id="$CLIENT_ID" \
  --data-urlencode token="$TOKEN"
```

## For operators

- OAuth is for self-hosted (standalone) Lurker only. Hosted lurker.chat doesn't
  offer it.
- **Set `PUBLIC_BASE_URL` behind a reverse proxy.** The discovery document's
  `issuer` and endpoint URLs come from it, and otherwise from the request's
  `Host` or `X-Forwarded-Host` header.
- **Set `LURKER_TRUST_PROXY=true` behind a reverse proxy you control.**
  Registration is rate-limited per client IP. Without it, Lurker sees only the
  proxy's IP and every client shares one limit. See
  [Auth rate limiting behind a proxy](SELF_HOSTING.md#auth-rate-limiting-behind-a-proxy).
- **Never add a third-party app's origin to `CORS_ORIGIN`.** That grants the app
  cookie access to the whole API without the member approving it. Apps that run
  in a web page on another origin aren't supported.
