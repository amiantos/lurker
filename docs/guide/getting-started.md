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

1. **Generate** (or **Import**, if you already use one in another client). When
   adding a network you can tick _Generate one for this network_ instead, and it
   is created before the first connect.
2. Reconnect, so the certificate is actually presented — not needed if you asked
   for it while adding the network, since it was there from the start.
3. `/msg NickServ CERT ADD` — with **no fingerprint**. Services read it off the
   connection you are on, which is why this form works everywhere.

If you do have to paste one, Lurker shows all three digests, because networks
disagree about which they accept: Libera takes **SHA-512** and rejects the
others outright, most other Atheme networks and ergo want **SHA-256**, and older
ratbox-family networks still use **SHA-1**.

From then on that network knows you by the certificate. If you have no password
set, Lurker authenticates with SASL EXTERNAL; with a password set it keeps using
SASL PLAIN and presents the certificate as well, which is what NickServ's own
CertFP recognises.

`/network cert <network>` prints the fingerprint, `… new` replaces it, and
`… remove` detaches it. **Download for another client** gives you the pair as one
`client.pem`, the shape HexChat and WeeChat keep on disk.

A certificate is presented during the TLS handshake, so a change takes effect on
the next connect — and a network with one attached won't connect over plaintext,
since there is no handshake to present it in.

## Joining channels

- Joining by name and using the channel browser.
- Pinning and rearranging channels and DMs.

## Installing Lurker as an app

- Installing the PWA on phone, Mac, or PC.

## Next steps

- [The Interface](/guide/interface)
- [Notifications](/guide/notifications)
