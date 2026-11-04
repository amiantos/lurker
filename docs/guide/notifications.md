# Notifications

::: info This chapter is in progress
An outline is below. Help finish it via **Edit this page on GitHub**.
:::

How Lurker keeps you informed across all your devices.

## How notifications work

- One **enabled** toggle per signal — Lurker decides whether to show an in-app
  toast or send a web-push notification based on where your attention is.
- Highlights and direct messages as notification triggers.
- Each channel, DM and network has a notification level in its menu: **All
  messages**, **Highlights only**, **Nothing** (no alerts, the unread count
  stays) and **Muted** (no alerts and no unread count; a highlight still badges).
  Underneath they are ignore rules, so they appear in `/ignore`'s list and
  follow you to every device.

## Web push

- Enabling push so you're notified even when no tab is open.
- Per-device behavior and presence.

## Checking push

A notification that never arrived has a trail. Under **Settings → Notifications**:

- **send a test push** goes to every device you have registered, skipping quiet
  hours, the visible-client rule and every other gate. If the test arrives and a
  real one didn't, a rule held the real one.
- **current clients** lists what is connected to your account right now and
  whether it reports itself visible. Push fires only while nothing is visible,
  so a tab left in front, or the app open on your phone, is the usual reason.
- **recent pushes** is the last week of notifications the server tried to send
  you, each with what happened: _held_ and the rule, _sent_ and the push
  service's answer, or _failed_ and why. A "sent" line means the push service
  accepted it; whether the device showed it is then up to the device (Focus
  modes, notification permission, the app force-quit).

An admin sees everyone's log and connected clients under **Admin →
Notifications**, with a copy button for pasting it into a bug report.

## The iOS and Android apps

- The apps use native push. On lurker.chat it's built in. On a self-hosted server the
  admin turns it on under **Admin → Notifications** with
  [push.lurker.chat](https://push.lurker.chat); see
  [the self-hosting guide](/SELF_HOSTING#push-and-the-mobile-apps).
- Until it's on, the apps don't ask for notification permission and contact nothing.

## Auto-away

- Auto-away when no client is in front of you and no IRC client is attached through
  the bouncer, and automatic return. A client's background connection that sends
  `AWAY *` doesn't count. A network you set away yourself keeps that away: auto-away
  skips it, and returning doesn't clear it.

## See also

- [The Interface](/guide/interface)
