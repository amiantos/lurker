# Lurker Roadmap

This is a **living, high-level roadmap** — a sense of direction, not a promise of dates.
The authoritative, always-current source of truth is
[GitHub Milestones](https://github.com/amiantos/lurker/milestones); this document
just groups them into a narrative and explains *why* the order is what it is.

Lurker ships continuously (see [Releases](https://github.com/amiantos/lurker/releases)) —
milestones describe **themes**, and their issues land across many point releases.

---

## The through-line

There are two audiences on one codebase:

1. **Self-hosters** — the open-source IRC client/bouncer you run yourself.
2. **[lurker.chat](https://lurker.chat)** — the hosted, paid service.

The near-term priority is getting the hosted service to a state where paid
acquisition makes sense. The **critical path** to that is deliberately narrow:

> **Admin & Onboarding → Bouncer & Hosted Backbone → Mobile Apps**

The native mobile apps attach *through* the app.lurker.chat bouncer, so the
bouncer is a hard prerequisite, not a parallel track. Security hardening (#242)
and mobile push are treated as launch-blocking. Almost everything else —
protocol depth, react/reply, theming, engine decoupling — is intentionally
**post-launch**.

---

## Now — in flight

### [1.1.0](https://github.com/amiantos/lurker/milestone/3) · unread & notification correctness
The current release train, ~90% closed. Scoped down to the unread/notification
correctness cluster so it can ship clean.
- #463 PWA stuck unread badge
- #454 Unify per-user buffer enumeration (badge can't drift from in-app count)
- #470 Audit server-buffer unread state
- #441 Audit web-push failure cases
- #230 Clear buffer unread state when sending a message
- #411 "Add Channel" modal on the + button

### [Admin & Onboarding](https://github.com/amiantos/lurker/milestone/4) · **top priority**
The first thing a new hosted user touches. Highest-priority milestone.
- #300 First-run onboarding flow · #298 Suggested networks & channels · #308 `defaultChannel` in builtinNetworks
- #299 Instance-level default uploader · #271 Local upload hosting & direct S3 · #177 Hoarder uploader tooltip
- #304 Host standalone under a path · #57 User manual

---

## Next — the commercial launch path

These three, in order, are what stand between today and confidently spending on ads.

### [Bouncer & Hosted Backbone](https://github.com/amiantos/lurker/milestone/5) · **launch-critical**
Lurker-as-bouncer / BYOC for app.lurker.chat. **Hard prerequisite for the mobile apps.**
- #483 Relay client-only tags on PRIVMSG (reply/react), not just TAGMSG
- #242 Security audit: auth/session, deps, rate-limiting hardening *(launch-blocking)*
- _Needs a bouncer umbrella issue authored (tracked separately)._

### [Mobile Apps (iOS & Android)](https://github.com/amiantos/lurker/milestone/6) · **launch-critical**
Native clients for the paid service, **including mobile push**. The gate to advertising.
Depends on the Bouncer milestone.
- _Umbrella issues to be authored (iOS MVP, Android MVP, native push)._

---

## Later — post-launch depth & polish

Valuable, but none of it blocks the commercial launch. Roughly parallelizable.

### [IRC Protocol Completeness](https://github.com/amiantos/lurker/milestone/7)
Make Lurker a rock-solid IRC citizen.
- #206 Caller ID · #459 certfp · #486 Derive isPrefixMode from ISUPPORT PREFIX
- #315 Surface channel list-mode replies (ban/invite/ban-exception)
- #434 Route command-result error numerics to the originating buffer
- #430 Auto-replies honor /ignore · #291 Test against a variety of ircds
- #450 Capture IRCv3 msgid + echo-message — *foundation for a future react/reply epic*

### [Engine & Performance](https://github.com/amiantos/lurker/milestone/8)
Zero-downtime deploys and stability.
- #385 In-process IRC transport seam · #386 Decouple engine from app tier
- #469 Lazy-load online-buffer unread in connect snapshot · #265 Optimization session
- #442 Fix crash when controlling terminal goes away (dead-pty write)

### [Customization & Power-User](https://github.com/amiantos/lurker/milestone/9)
- #375 Custom CSS · #395 System light/dark preference · #474 Custom font upload
- #445 Log-length customization · #422 Buffer status icons
- #276 mIRC-style command aliases · #412 `/p` and `/j` aliases

### [Mobile UX Polish](https://github.com/amiantos/lurker/milestone/10)
PWA/mobile-web refinements (distinct from the native Mobile Apps milestone).
- #200 Swipe-right to go back to buffer list · #201 Mobile notification improvements
- #239 iOS nick-suggester touch target · #161 Show line-return character in input bar

### [DCC/XDCC](https://github.com/amiantos/lurker/milestone/11)
- #270 Finish the download manager (phase 4: authed browser download + per-bot concurrency)

---

## Icebox — speculative or blocked

Not scheduled. Ideas, big bets, cleanups, and work blocked on external dependencies.

- #22 Plugin system · #264 MCP / REST API · #67 AIO Electron build · #303 SOCKS/HTTP proxied connections
- #414 RPE2E DMs — *blocked on repartee's DM E2E*
- #55 Accessibility: screen-reader support for completion UIs
- #485 Schema-driven export/import at-rest encryption
- #146 Remove redundant asyncHandler wrapper · #184 Revisit node:22 Docker pin
- #2 Containerized IRCD + Lurker guide
