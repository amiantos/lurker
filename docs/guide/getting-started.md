# Getting Started

::: info This chapter is in progress
An outline is below. Help finish it via **Edit this page on GitHub**.
:::

This chapter walks you from a fresh account to chatting in your first channel.

## Signing in

- Hosted: creating an account at [app.lurker.chat](https://app.lurker.chat).
- Self-hosted: the invite flow and first-run setup.
- Locked out: self-hosted accounts carry no email address, so your instance admin issues a one-time recovery link instead. See [Account recovery](/SELF_HOSTING#account-recovery).

## Connecting to a network

- Adding a network (server, port, TLS).
- Choosing a nick and authenticating (SASL / NickServ).

### Client certificates (CertFP)

Most networks let you identify with a TLS client certificate instead of a
password: the server hashes the certificate you present and matches it against
your services account. Lurker holds one per network, under **Advanced** in the
network's settings.

1. **Generate**, or **Import** and pick the `.pem` you already use in another
   client — Lurker sorts the halves out (select both files if your key is
   separate). Both are offered when you add a network as well as when you edit
   one; asked for while adding, the certificate is in place before the first
   connect.
2. Reconnect, so the certificate is actually presented — not needed if you asked
   for it while adding the network, since it was there from the start.
3. `/msg NickServ CERT ADD` — with **no fingerprint**. Services read it off the
   connection you are on, which is why this form works everywhere.

Some networks want the fingerprint spelled out instead — ergo requires it, and
you need it in hand if you are registering from another client.
`/network cert <network>` prints all three digests, because networks disagree
about which they accept: Libera takes **SHA-512** and rejects the others
outright, most other Atheme networks and ergo want **SHA-256**, and older
ratbox-family networks still use **SHA-1**.

From then on that network knows you by the certificate. If you have no password
set, Lurker authenticates with SASL EXTERNAL; with a password set it keeps using
SASL PLAIN and presents the certificate as well, which is what NickServ's own
CertFP recognises.

`/network cert <network>` prints those fingerprints, `… new` replaces the
certificate, and `… remove` detaches it. **Download for another client** gives you the pair as one
`client.pem`, the shape HexChat and WeeChat keep on disk.

A certificate is presented during the TLS handshake, so a change takes effect on
the next connect — and a network with one attached won't connect over plaintext,
since there is no handshake to present it in.

### Connecting through a proxy (SOCKS5 / HTTP)

A network can route its IRC connection through a SOCKS5 or HTTP CONNECT proxy,
so the server sees the proxy's address instead of yours. It lives under
**Advanced** in the network's settings: tick **Connect through a proxy**, pick
the type, and give the address.

For Tor, run a Tor daemon and point the network at **`127.0.0.1` port `9050`**
with type SOCKS5. That is also what makes `.onion` addresses work: the server
name is resolved _by the proxy_, never by Lurker, so an address that only exists
inside Tor resolves where it can be resolved. It also means your own DNS lookups
never name the servers you talk to.

Username and password are optional and only sent if the proxy asks for them.
The password is stored encrypted and never sent back to your browser, so when
you edit a proxy the field is blank — leave it blank to keep the saved one, or
use **clear** to remove it.

From the composer:

```
/network modify Libera -proxy socks5://127.0.0.1:9050
/network modify Libera -noproxy
```

`-noproxy` turns the proxy off and clears its details. A URL with a password in
it will sit in your input history, so prefer the settings form for that.

Two things worth knowing:

- **A change takes effect on the next connect**, like every other network
  setting. Reconnect to apply it.
- **File transfers (DCC) are refused while a proxy is set.** DCC connects
  directly, outside the tunnel, in both directions — so accepting one would give
  away the address the proxy exists to hide. Lurker says so rather than doing it
  quietly.

If the proxy can't be used — it's unreachable, it rejects your credentials, or
the details don't make sense — Lurker **refuses to connect** and says why. It
never falls back to connecting directly, because that would put your real
address on the wire while everything on screen said otherwise.

::: tip Self-hosting without a proxy setting
If you run Lurker behind the IRC engine, the engine is what dials — so it needs
to be new enough to understand proxies (protocol minor 5). An older engine is
refused rather than allowed to connect directly; update the engine image and
restart it.
:::

## Joining channels

- Joining by name and using the channel browser.
- Pinning and rearranging channels and DMs.

## Installing Lurker as an app

- Installing the PWA on phone, Mac, or PC.

## Next steps

- [The Interface](/guide/interface)
- [Notifications](/guide/notifications)
