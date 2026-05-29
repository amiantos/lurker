# Lurker Design Tokens

Lurker's visual system is built on a small set of **design tokens** — named CSS
custom properties — instead of hardcoded values scattered through components.
This is the shared vocabulary for talking about layout and style: instead of
"make that gap 10 instead of 8 pixels," you can say "bump that gap from
`--space-4` to `--space-5`."

All tokens live in one file: [`vue_client/src/assets/main.css`](../vue_client/src/assets/main.css).

## Two tiers of token

**1. Themeable tokens** — colors and fonts. These are user-configurable: the
Settings UI writes them onto the page live (via `useTheme()`), so changing a
color in Settings re-themes the whole app instantly. The values in `main.css`
are just the defaults for the first paint.

**2. Internal tokens** — spacing, z-index, scrim, radius. These are _not_ user
settings; they exist purely so the same value isn't retyped in 80 places. They
are intentionally fixed. (Changing one of these is a code change, not a
setting.)

---

## Color (themeable)

| Token                                  | Role                                       |
| -------------------------------------- | ------------------------------------------ |
| `--bg`, `--bg-soft`                    | page background, raised surfaces           |
| `--fg`, `--fg-muted`                   | primary text, secondary/de-emphasized text |
| `--accent`                             | links, focus, primary highlight            |
| `--good`, `--warn`, `--bad`            | success / warning / error                  |
| `--border`                             | hairline borders                           |
| `--member-owner/admin/op/halfop/voice` | IRC member-list mode colors                |

**Hierarchy is expressed with color and weight, never font size.** There is one
font size across the whole UI. To make text recede, use `color: var(--fg-muted)`;
to emphasize, use `font-weight: 600`. (The only exception is big hero/brand
display titles — the login screen, modal titles — which use a deliberately
large responsive size.)

## Spacing (internal) — a 4px rhythm

Used for gaps, padding, and margins. Everything should land on one of these
steps so the layout breathes on a consistent grid.

| Token       | px  | Token        | px  |
| ----------- | --- | ------------ | --- |
| `--space-1` | 2   | `--space-6`  | 12  |
| `--space-2` | 4   | `--space-7`  | 16  |
| `--space-3` | 6   | `--space-8`  | 20  |
| `--space-4` | 8   | `--space-9`  | 24  |
| `--space-5` | 10  | `--space-10` | 32  |

(Borders stay a literal `1px`, and a few hairline `1px` paddings in very dense
rows are deliberate — those aren't on the scale by design.)

## z-index (internal) — a layering ladder

Named by role, so it's clear what sits above what. Higher in the list = closer
to the viewer.

| Token         | Role                                                     |
| ------------- | -------------------------------------------------------- |
| `--z-base`    | in-flow lift (sticky headers, background layers)         |
| `--z-raised`  | lifts above sibling content within a component           |
| `--z-modal`   | modal / overlay shells (dialogs, quick switcher)         |
| `--z-toast`   | toast notifications (above modals, so they stay visible) |
| `--z-menu`    | context menus                                            |
| `--z-popover` | input autocomplete (nick picker) — top of the stack      |

## Radius (internal)

The app is intentionally flat — most things are square corners.

| Token           | px  | Use                                     |
| --------------- | --- | --------------------------------------- |
| `--radius-sm`   | 2   | subtle softening (chips, small buttons) |
| `--radius-md`   | 6   | floating popups                         |
| `--radius-pill` | 999 | fully-rounded pills                     |

(`50%` is used directly for circles.)

## Scrim

`--scrim` is the dimmed backdrop behind overlays (e.g. the quick switcher).

---

## Giving feedback in token terms

When something looks off, the most actionable feedback names the token:

- _"The buffer-list rows feel cramped — try `--space-5` instead of `--space-4`
  for the row padding."_
- _"That label should recede — give it `--fg-muted` rather than a smaller font."_
- _"The modal corners should be a touch softer — `--radius-md`?"_

If a value you want isn't on a scale (e.g. a spacing step between two existing
ones), that's worth a conversation — we add scale steps deliberately rather
than sprinkling one-off pixel values, which is the drift this system exists to
prevent.
