// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Single source of truth for the settings registry, imported by both the
// server (which uses it to validate writes and seed defaults) and the client
// (which uses it to render the Settings UI and supply defaults during the
// initial paint before /api/settings/bootstrap returns). Each side adds its
// own helpers in a thin wrapper module — keep this file data-only.
//
// `category` + `group` drive the Settings UI sidebar and subheadings. The
// server ignores both fields; they exist purely so the client can build a
// table-of-contents layout without parsing key prefixes. `label` is the
// human-readable headline shown in the UI; the dotted key shows as a subtitle
// for power-user reference. `description` remains the longer help text.

// ─── Types ─────────────────────────────────────────────────────────────────

/** Discriminant for how a setting is edited, validated, and stored. */
export type SettingType = 'string' | 'color' | 'secret' | 'int' | 'bool' | 'enum' | 'string-list';

/** A stored setting value, in its decoded (non-string) form. */
export type SettingValue = string | number | boolean | string[];

/**
 * One "this setting is live when …" clause. `key` must name another registry
 * option; the clause holds when that option's effective value is one of `in`.
 */
export interface SettingDependency {
  key: string;
  in: readonly SettingValue[];
}

interface BaseOption {
  key: string;
  label: string;
  category: string;
  group: string;
  description: string;
  // Operator-only: hidden from the Settings UI in the hosted (node) edition,
  // where the cell — not the tenant — owns this knob. The server ignores the
  // flag; it is purely a client-side rendering gate (A3). Self-hosted
  // (standalone) instances show everything as before.
  //
  // CONVENTION: this is presentation only — it does NOT stop a tenant from
  // writing the setting via PUT /api/settings. That's fine for *cosmetic*
  // knobs, but any cost / abuse / security lever marked selfHostedOnly MUST
  // ALSO be enforced server-side in node edition (e.g. the cell sourcing the
  // value from operator config and ignoring the tenant's), or the gate is
  // trivially bypassable. The upload pipeline limits (uploads.image.*) are the
  // reference pattern: hidden here, enforced in the cell's upload route.
  selfHostedOnly?: boolean;

  // This option only exists when the named instance feature is enabled. Unlike `selfHostedOnly`
  // (a cosmetic gate on a knob that still works), a flagged-off feature has no server behind it
  // at all — the routes aren't even mounted — so the option is HIDDEN rather than shown and
  // ignored. Offering a switch that silently does nothing is worse than offering none.
  requiresFeature?: 'linkPreviews';

  // Conditions under which this setting actually does anything, ORed together:
  // the option is live if ANY clause holds. Resolution is TRANSITIVE — an
  // option whose dependency is itself inactive is inactive too, so a chain like
  // `consolidate_max_names → consolidate_joins → chat.events` only needs each
  // link stated once.
  //
  // Presentation only, and deliberately so: an inactive setting still stores and
  // returns its value, because the condition can flip back (switching a phone
  // off `none` must restore exactly the modifiers that were set before, not a
  // pile of defaults). Clients render these greyed out; nothing enforces them.
  //
  // The tier keys (chat.events / chat.events.mobile) are why this exists as
  // registry data rather than a hardcoded map per client — the iOS settings
  // screen was already carrying one of these by hand for consolidate_max_names,
  // and the tier adds eight more.
  dependsOn?: readonly SettingDependency[];

  // Part of a theme preset's snapshot (#TBD): the fonts group plus every
  // color-typed appearance setting. A theme stores a value for each themed key;
  // the client resolves a themed key as override → active theme → registry
  // default (stores/settings.ts). Two server behaviors hang off this flag:
  // settingsService KEEPS a themed row whose value equals the registry default
  // (on a non-default theme, "set it to the default color" is a statement, not
  // an absence), and /api/themes validates snapshot keys against it. The
  // look.theme.* pointer keys themselves must NEVER be themed — the resolver
  // reads them to pick the active theme, so a themed pointer would recurse.
  themed?: boolean;
}

/** Free-text settings: plain strings, CSS colors, and write-only secrets. */
export interface StringOption extends BaseOption {
  type: 'string' | 'color' | 'secret';
  default: string;
}

/** Integer settings, always bounded by min/max. */
export interface IntOption extends BaseOption {
  type: 'int';
  min: number;
  max: number;
  // Extra floor applied to NONZERO values only, for knobs where 0 means
  // "off/unlimited" but a small live value is almost certainly a mistake
  // (retention: deletion is irreversible, so 50 lines is a typo, not an
  // intent). Valid values are 0 or >= minNonzero; plain min/max can't
  // express that hole.
  minNonzero?: number;
  default: number;
}

/** Boolean toggle settings. */
export interface BoolOption extends BaseOption {
  type: 'bool';
  default: boolean;
}

/** Single-choice settings constrained to a fixed list of strings. */
export interface EnumOption extends BaseOption {
  type: 'enum';
  choices: readonly string[];
  default: string;
  // Display text per choice, for enums whose stored values read as identifiers
  // rather than as English. Omit and clients render the raw value, which is the
  // right answer for a choice like `auto` / `standard` / `compact`.
  //
  // The values stay the ids — see the note on `chat.image_modal.enabled` about
  // keys aging. Renaming a stored enum value is a MIGRATION, and doing one to
  // improve wording would be paying in orphaned rows for something a label
  // fixes for free. A choice with no entry here falls back to its raw value, so
  // a partial map is safe.
  choiceLabels?: Readonly<Record<string, string>>;
}

/** Multi-value settings: an ordered list of strings. */
export interface StringListOption extends BaseOption {
  type: 'string-list';
  default: string[];
}

/** Any entry in the settings REGISTRY. Narrow on `.type` for type-specific fields. */
export type SettingOption = StringOption | IntOption | BoolOption | EnumOption | StringListOption;

/**
 * A Settings-sidebar category. `registry` categories are auto-rendered from
 * REGISTRY entries; `bespoke` ones have a hand-written pane component.
 */
export interface SettingCategory {
  id: string;
  label: string;
  kind: 'registry' | 'bespoke';
  // As on BaseOption: hide the whole category in the hosted (node) edition.
  selfHostedOnly?: boolean;
}

// ─── Shared dependency clauses ─────────────────────────────────────────────
// Everything else in the Events category hangs off the event filter, which is
// two keys (desktop + mobile). A setting is live if EITHER device class can
// still see the thing it modifies — a phone set to "Hide all" must not grey out
// the consolidation knobs a desktop is actively using, and vice versa.

/** Live when at least one device class renders event rows at all. */
const EVENTS_VISIBLE: readonly SettingDependency[] = Object.freeze([
  { key: 'chat.events', in: ['all', 'smart'] },
  { key: 'chat.events.mobile', in: ['all', 'smart'] },
]);

/** Live when at least one device class is on the smart tier. */
const EVENTS_SMART: readonly SettingDependency[] = Object.freeze([
  { key: 'chat.events', in: ['smart'] },
  { key: 'chat.events.mobile', in: ['smart'] },
]);

export const REGISTRY: readonly SettingOption[] = Object.freeze([
  // ─── Fonts ─────────────────────────────────────────────────────────────
  {
    key: 'look.font.family',
    label: 'Font family',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'string',
    default: "'Input Mono', 'Input', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    description:
      'Font family stack used everywhere in the UI. The first installed font wins. ' +
      'Input Mono is the intended primary; the rest are system monospace fallbacks.',
  },
  {
    key: 'look.font.size',
    label: 'Font size',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'int',
    min: 9,
    max: 32,
    default: 14,
    description:
      'Base font size in pixels for the whole UI. ' +
      'Phone-sized viewports use `look.font.size.mobile` instead.',
  },
  {
    key: 'look.font.size.mobile',
    label: 'Font size (mobile)',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'int',
    min: 9,
    max: 32,
    default: 14,
    description:
      'Base font size in pixels used on phone-sized viewports (≤768px). ' +
      'Lets the desktop and mobile UIs scale independently — a large desktop ' +
      'setting need not be inherited on a phone, or vice versa.',
  },
  {
    key: 'look.font.weight',
    label: 'Font weight',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'int',
    min: 100,
    max: 900,
    default: 400,
    description:
      'Default font weight (100–900, in CSS steps of 100). ' +
      "Bump above 400 (e.g. 500) to roughly match terminals' visual density " +
      'on macOS, where browsers no longer apply subpixel antialiasing. ' +
      'Pairs with look.font.smoothing_macos to emulate Terminal.app rendering.',
  },
  {
    key: 'look.font.smoothing_macos',
    label: 'Terminal-style font smoothing (macOS)',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'bool',
    default: false,
    description:
      'Coax WebKit/Blink into denser, Terminal.app-style font rendering by setting ' +
      '-webkit-font-smoothing: subpixel-antialiased. Off by default; the browser ' +
      'default rendering is what most users expect.',
  },

  // ─── Core palette (Monokai Pro / Brad's iTerm theme) ───────────────────
  {
    key: 'look.color.bg',
    label: 'Background',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#212022',
    description: 'Window background (every region uses this, like a CLI app).',
  },
  {
    key: 'look.color.bg_soft',
    label: 'Soft background (hover / active)',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#2c2a2e',
    description: 'Slightly raised background used for hover and active-buffer highlight.',
  },
  {
    key: 'look.color.fg',
    label: 'Foreground (text)',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#fcfcfa',
    description: 'Default foreground / text color.',
  },
  {
    key: 'look.color.fg_muted',
    label: 'Muted text',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#939293',
    description: 'Muted text (timestamps, system events, secondary labels).',
  },
  {
    key: 'look.color.accent',
    label: 'Accent',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#a99dec',
    description: 'Primary accent (logo, active-buffer indicator, focused borders).',
  },
  {
    key: 'look.color.link',
    label: 'Link color',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: 'var(--fg)',
    description:
      'Color of clickable URL links inside chat messages. ' +
      'Any CSS color value; defaults to the foreground color.',
  },
  {
    key: 'look.color.good',
    label: 'Good / connected',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#b3db82',
    description: 'Positive / connected state.',
  },
  {
    key: 'look.color.warn',
    label: 'Warning',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#f9d978',
    description: 'Warning / in-progress state (connecting, modified setting marker).',
  },
  {
    key: 'look.color.bad',
    label: 'Error / disconnected',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#ed6c89',
    description: 'Error / disconnected / destructive state.',
  },
  {
    key: 'look.color.border',
    label: 'Borders',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#38353b',
    description: 'Subtle horizontal/vertical separators between regions.',
  },
  {
    key: 'look.color.mirc_colors',
    label: 'mIRC color palette',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'string-list',
    // 16 entries, one per mIRC color code 0..15. The chromatic slots default
    // to the closest hue from look.nick.colors so coloured chat text harmonises
    // with the rest of the theme.
    //
    // ⚠ EVERY slot is a literal colour, and must stay one. A mIRC code names a
    // colour — `\x0300` means white, not "whatever this theme calls text" — and
    // a sender who writes `\x0300,01` has specified both halves of a
    // self-sufficient pair that we have no business overriding.
    //
    // Slots 0/14/15 were theme references (var(--fg), var(--fg-muted), 70% of
    // var(--fg)) on the theory that they'd stay legible on any background. They
    // don't: a run carries its OWN background, which is a second surface the
    // theory never considered. In a light theme `\x0300,01` drew near-black on
    // black, and `\x0301,00` — where slot 0 is the *background* — drew a dark
    // box with black text in it. Both unreadable, both entirely the palette's
    // doing. A slot that can't be named without knowing what it's painted on
    // isn't a colour.
    //
    // The cost is accepted and is the sender's: white on a light canvas is
    // invisible, exactly as black on a dark one already was. Keep in sync with
    // MIRC_PALETTE_FALLBACK in vue_client/src/utils/nickColor.ts.
    default: [
      '#ffffff', // 0  white
      '#000000', // 1  black
      '#6799f3', // 2  navy
      '#a9dc76', // 3  green
      '#ff6188', // 4  red
      '#ed6c89', // 5  maroon
      '#ab9df2', // 6  purple
      '#fc9867', // 7  orange
      '#ffd866', // 8  yellow
      '#b3db82', // 9  lime
      '#78dce8', // 10 teal
      '#a0f1ff', // 11 cyan
      '#7ba4ff', // 12 blue
      '#ff7494', // 13 magenta
      '#7f7f7f', // 14 gray       — mIRC's own grey
      '#d2d2d2', // 15 light gray — mIRC's own light grey
    ],
    description:
      'How the 16 mIRC color codes (0-15) render in chat. One CSS color per line, ' +
      'in order: white, black, navy, green, red, maroon, purple, orange, yellow, ' +
      'lime, teal, cyan, blue, magenta, gray, light gray. Defaults pick the ' +
      'closest hue from your nick palette so coloured text matches the rest of ' +
      'the theme. Any CSS color value works (hex, rgb(), var(--name), color-mix()), ' +
      'but prefer a literal: a code names a colour, and a slot that follows the ' +
      'theme instead is wrong the moment a sender pairs it with a background of ' +
      'their own. var(--bg) is the worst case — it IS the chat background, so text ' +
      'set to it is invisible.',
  },

  // ─── Alternating message rows ─────────────────────────────────────────
  {
    key: 'look.color.message.alt_bg',
    label: 'Alternating row background',
    category: 'appearance',
    group: 'messages',
    themed: true,
    type: 'color',
    default: 'var(--bg)',
    description:
      'Background applied to every other message line in chat buffers, ' +
      'for visual separation. Set equal to look.color.bg to disable striping.',
  },
  {
    key: 'look.color.message.alt_fg',
    label: 'Alternating row text',
    category: 'appearance',
    group: 'messages',
    themed: true,
    type: 'color',
    default: '#c4c4c4',
    description:
      'Foreground applied to every other message line in chat buffers. ' +
      'Defaults to a slightly dimmed foreground. Nick colors and ' +
      'inline-highlighted segments still override this.',
  },

  // ─── Per-line display collapsing (nick / timestamp dedupe) ────────────
  {
    key: 'look.message.layout',
    label: 'Message layout',
    category: 'appearance',
    group: 'messages',
    type: 'enum',
    choices: ['auto', 'standard', 'compact'],
    default: 'auto',
    description:
      'How message rows are laid out. "auto" (default) uses the standard ' +
      'three-column grid on desktop and the compact two-line layout on ' +
      'mobile. "standard" forces the three-column grid everywhere. ' +
      '"compact" forces the two-line layout (nick + time on top, body ' +
      'below) everywhere — useful on low-resolution desktop displays ' +
      'where the columns squeeze the body too far. In compact mode the ' +
      'author and timestamp collapse settings below are effectively ' +
      'forced on regardless of their stored value.',
  },
  {
    key: 'look.message.collapse_authors',
    label: 'Collapse repeated authors',
    category: 'appearance',
    group: 'messages',
    type: 'bool',
    default: false,
    description:
      'Hide the nick on consecutive messages from the same author so a run ' +
      'reads as one grouped block. Only plain messages collapse; actions, ' +
      'notices, and system events always show their author. Reset by any ' +
      'divider (date/unread/away/back) or by a gap larger than the window ' +
      'below.',
  },
  {
    key: 'look.message.collapse_authors_window',
    label: 'Author collapse window (minutes)',
    category: 'appearance',
    group: 'messages',
    type: 'int',
    min: 0,
    max: 1440,
    default: 5,
    description:
      'Maximum gap in minutes between two messages from the same author for ' +
      'the second to be collapsed. 0 collapses only messages with the exact ' +
      'same timestamp; larger values keep the grouping going across longer ' +
      'pauses.',
  },
  {
    key: 'look.message.collapse_timestamps',
    label: 'Collapse repeated timestamps',
    category: 'appearance',
    group: 'messages',
    type: 'bool',
    default: true,
    description:
      'Hide the timestamp on consecutive rows that would display the exact ' +
      'same time string (driven by look.buffer.time_format). Reduces visual ' +
      'noise in fast bursts without losing any information.',
  },

  // ─── Member-list mode prefixes ────────────────────────────────────────
  {
    key: 'look.color.member.owner',
    label: 'Owner prefix (~)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#ed6c89',
    description: 'Color for the ~ prefix (channel owner mode +q).',
  },
  {
    key: 'look.color.member.admin',
    label: 'Admin prefix (&)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#fc9867',
    description: 'Color for the & prefix (channel admin mode +a).',
  },
  {
    key: 'look.color.member.op',
    label: 'Op prefix (@)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#a99dec',
    description: 'Color for the @ prefix (channel operator mode +o).',
  },
  {
    key: 'look.color.member.halfop',
    label: 'Half-op prefix (%)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#78dce8',
    description: 'Color for the % prefix (half-op mode +h).',
  },
  {
    key: 'look.color.member.voice',
    label: 'Voiced prefix (+)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#b3db82',
    description: 'Color for the + prefix (voiced mode +v).',
  },

  // ─── Buffer list (channel/DM rows in the sidebar) ─────────────────────
  // Defaults preserve current behavior: unread rows inherit --fg and render
  // bold; highlighted rows render in --warn; the full unread count plus the
  // highlight bullet both show. Customize the two colors for weechat-style
  // two-color buffer states; flip unread_display to dial down the numbers.
  {
    key: 'look.color.buffer.unread',
    label: 'Unread row color',
    category: 'appearance',
    group: 'buffer-list',
    themed: true,
    type: 'color',
    default: 'var(--accent)',
    description:
      'Color applied to channel/DM rows that have unread messages but no ' +
      'highlights. Defaults to the accent color so unread rows stand out from ' +
      'quiet rows at a glance; set it to var(--fg) for a more subdued look, ' +
      'or any other CSS color for weechat-style two-color buffer states.',
  },
  {
    key: 'look.color.buffer.highlight',
    label: 'Highlighted row color',
    category: 'appearance',
    group: 'buffer-list',
    themed: true,
    type: 'color',
    default: 'var(--warn)',
    description:
      'Color applied to channel/DM rows that contain highlights. Stands out ' +
      'from the plain-unread color above.',
  },
  {
    key: 'look.buffer_list.unread_bold',
    label: 'Bold unread rows',
    category: 'appearance',
    group: 'buffer-list',
    type: 'bool',
    default: false,
    description:
      'Render channel/DM row labels in bold when they have unread messages or ' +
      'highlights. Off by default — color already carries the signal; turn on ' +
      'for an extra weight cue on top of the color.',
  },
  {
    key: 'look.buffer_list.unread_display',
    label: 'Unread indicator display',
    category: 'appearance',
    group: 'buffer-list',
    type: 'enum',
    choices: ['full', 'highlights', 'badge', 'off'],
    default: 'full',
    description:
      'How much detail the unread indicators show on each channel/DM row. ' +
      '"full" shows the highlight ● plus a full unread count (default). ' +
      '"highlights" shows the ● plus a highlight-only count (hides the noisy ' +
      'total). "badge" shows only the ● for highlighted rows, no numbers. ' +
      '"off" hides both — rely purely on row color/weight.',
  },

  // ─── Nick coloring ────────────────────────────────────────────────────
  {
    key: 'look.nick.colors',
    label: 'Nick color palette',
    category: 'appearance',
    group: 'nicks',
    themed: true,
    type: 'string-list',
    default: [
      '#ff6188',
      '#fc9867',
      '#ffd866',
      '#a9dc76',
      '#78dce8',
      '#ab9df2',
      '#ed6c89',
      '#d4996e',
      '#f9d978',
      '#b3db82',
      '#91dae6',
      '#a99dec',
      '#ff7494',
      '#ffaf75',
      '#c4e29a',
      '#a0f1ff',
      '#b6aaff',
      '#7ba4ff',
      '#6799f3',
    ],
    description:
      "Palette of colors used to deterministically color other users' nicknames. " +
      'One entry per line; any CSS color value (hex, rgb(), var(--name)).',
  },
  {
    key: 'look.nick.self_color',
    label: 'Your own nick color',
    category: 'appearance',
    group: 'nicks',
    themed: true,
    type: 'color',
    default: 'var(--fg)',
    description:
      'Color used for your own nickname wherever it appears. ' +
      'Any CSS color value; defaults to your foreground color.',
  },
  {
    key: 'look.nick.color_stop_chars',
    label: 'Trailing characters to ignore',
    category: 'appearance',
    group: 'nicks',
    type: 'string',
    default: '_|',
    description:
      'Trailing characters trimmed from nicknames before hashing for color selection, ' +
      "so 'amiantos__' colors the same as 'amiantos'.",
  },
  {
    key: 'look.nick.color_hash',
    label: 'Nick hash algorithm',
    category: 'appearance',
    group: 'nicks',
    type: 'enum',
    choices: ['djb2-32'],
    default: 'djb2-32',
    description: 'Hash algorithm used to map nicknames to palette colors.',
  },
  {
    key: 'look.nick.show_mode_prefix',
    label: 'Show mode prefix on nicks',
    category: 'appearance',
    group: 'nicks',
    type: 'bool',
    default: false,
    description:
      'Show the channel user-mode prefix (@ op, + voice, % halfop, ~ owner, & admin) before a ' +
      "speaker's nick in the message list. Reflects the user's current status in that channel.",
  },

  // ─── Misc look ────────────────────────────────────────────────────────
  {
    key: 'look.modal.overlay',
    label: 'Modal backdrop (desktop)',
    category: 'appearance',
    group: 'misc',
    type: 'enum',
    choices: ['wordmark', 'dimmed', 'clear'],
    default: 'wordmark',
    description:
      'Backdrop shown behind centered modals on desktop. "wordmark" (default) ' +
      'is the opaque tiled-word wallpaper. "dimmed" replaces it with a ' +
      'translucent scrim so the chat stays visible (just darkened) behind the ' +
      'modal. "clear" shows the app behind with no tint at all — the card ' +
      'floats on its border and shadow. Has no effect on mobile, where every ' +
      'modal is a full-frame opaque sheet regardless of this setting.',
  },
  {
    key: 'look.action.italic',
    label: 'Italicize /me actions',
    category: 'appearance',
    group: 'misc',
    type: 'bool',
    default: true,
    description: 'Render /me action messages in italics.',
  },
  {
    key: 'look.message.hover_actions',
    label: 'Show hover action bar on messages',
    category: 'appearance',
    group: 'misc',
    type: 'bool',
    default: true,
    description:
      'Show the floating action toolbar (reply, copy, bookmark, ignore) when ' +
      'hovering a message on desktop. When off, click a message to open the same ' +
      'actions as a menu instead. No effect on touch devices, where the bar is ' +
      'never shown and tapping a message always opens the menu.',
  },
  {
    key: 'look.buffer.time_format',
    label: 'Message timestamp format',
    category: 'appearance',
    group: 'misc',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Time format for the per-message timestamp column in chat buffers. ' +
      'Tokens: YYYY MM DD HH H hh h mm ss a A — hh/h are 12-hour and a/A ' +
      'are am/pm, e.g. "hh:mm a". Empty string hides the column.',
  },
  {
    key: 'look.buffer.time_format_compact',
    label: 'Compact-layout timestamp format',
    category: 'appearance',
    group: 'misc',
    type: 'string',
    default: 'HH:mm',
    description:
      'Time format used in chat buffers when the compact message layout is ' +
      'active (look.message.layout = compact, or = auto on mobile). ' +
      "Defaults to HH:mm — compact's right-aligned per-line timestamp is " +
      'tight on small viewports and seconds are rarely useful at a glance. ' +
      'Tokens: YYYY MM DD HH H hh h mm ss a A — hh/h are 12-hour and a/A ' +
      'are am/pm, e.g. "hh:mm a". Empty string hides the column.',
  },
  {
    key: 'look.bar.time_format',
    label: 'Status-bar clock format',
    category: 'appearance',
    group: 'misc',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Time format for the clock displayed in the status bar (above the input). ' +
      'Tokens: YYYY MM DD HH H hh h mm ss a A — hh/h are 12-hour and a/A ' +
      'are am/pm, e.g. "hh:mm a". Empty string hides the clock.',
  },
  {
    key: 'look.bar.lag_min_show_ms',
    label: 'Lag indicator threshold (ms)',
    category: 'appearance',
    group: 'misc',
    type: 'int',
    min: 0,
    max: 60000,
    default: 500,
    description:
      'Minimum lag (in milliseconds) before the status-bar lag indicator appears. ' +
      "Below this threshold the indicator stays hidden. Modeled on weechat's " +
      'irc.network.lag_min_show.',
  },
  {
    key: 'look.bar.lag_alarm_ms',
    label: 'Lag alarm threshold (ms)',
    category: 'appearance',
    group: 'misc',
    type: 'int',
    min: 0,
    max: 60000,
    default: 2000,
    description:
      'Lag (in milliseconds) at which the status-bar indicator turns red to call ' +
      'attention to a connection problem. Between the show threshold and this value ' +
      'the indicator renders in the warning color.',
  },
  {
    key: 'look.bar.lag_always_show',
    label: 'Always show lag value',
    category: 'appearance',
    group: 'misc',
    type: 'bool',
    default: false,
    description:
      'Always display the lag value in the status bar, even when it is below the ' +
      'show threshold. Useful if you want to keep an eye on round-trip latency.',
  },

  // ─── Layout (collapsible side panels on desktop) ───────────────────────
  {
    key: 'look.layout.show_channel_list',
    label: 'Show channel list (desktop)',
    category: 'appearance',
    group: 'layout',
    type: 'bool',
    default: true,
    description:
      'Show the channel/buffer list on the left of the desktop layout. ' +
      'Turn off to reclaim horizontal space on cramped screens; a slim rail ' +
      'with a chevron remains so you can re-open it. Has no effect on mobile.',
  },
  {
    key: 'look.layout.show_member_list',
    label: 'Show member list (desktop)',
    category: 'appearance',
    group: 'layout',
    type: 'bool',
    default: true,
    description:
      'Default for whether the channel members list shows on the right of the ' +
      'desktop layout. The members toggle in each channel’s topic bar ' +
      'overrides this per channel and is remembered. Has no effect on mobile.',
  },

  // ─── Events: the filter (#666) ────────────────────────────────────────
  // The primary "how much presence churn do I want to see" choice, and the
  // reason this category exists. Everything in the two groups below is a
  // modifier on whatever this leaves standing — see shared/eventFilter.ts for
  // the tier semantics and the noise set. Registry ORDER decides the order the
  // pane renders its groups in, so keep these three adjacent and in this
  // sequence: filter, then consolidation, then smart-filter tuning.
  {
    key: 'chat.events',
    label: 'Event filter',
    category: 'events',
    group: 'event-filter',
    type: 'enum',
    choices: ['all', 'smart', 'none'],
    choiceLabels: { all: 'No filter', smart: 'Smart filter', none: 'Hide all' },
    default: 'all',
    description:
      'How much join/part/quit/nick/host-change/mode noise reaches the message list. ' +
      '"No filter" (the default) shows every event, folded into summary lines when ' +
      'consolidation is on. "Smart filter" shows events only for nicks who have recently ' +
      'spoken, so silent lurkers cycling on and off stay invisible. "Hide all" removes ' +
      'event rows entirely, leaving conversation only. Kicks, topic changes and ' +
      'invites are never hidden at any setting.',
  },
  {
    key: 'chat.events.mobile',
    label: 'Event filter (mobile)',
    category: 'events',
    group: 'event-filter',
    type: 'enum',
    choices: ['all', 'smart', 'none'],
    choiceLabels: { all: 'No filter', smart: 'Smart filter', none: 'Hide all' },
    default: 'all',
    description:
      'The same choice for phone-sized viewports (≤768px) and the native mobile ' +
      'apps, which read this key unconditionally. A phone screen holds a fraction ' +
      'of the lines a desktop one does, so "Hide all" is a common pick here even for ' +
      'people who want everything at their desk. Only the filter is split by device — ' +
      'the settings below are shared.',
  },

  // ─── Event consolidation (IRCCloud-style summary line) ────────────────
  {
    key: 'chat.consolidate_joins',
    label: 'Consolidate join/part/quit/nick/host-change and op/voice events',
    category: 'events',
    group: 'consolidate',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_VISIBLE,
    description:
      'Merge consecutive join/part/quit/nick/host-change events into a single summary line ' +
      'per nick (e.g. "Alice and Bob joined; Dave left; Eve → Eve_afk"). ' +
      'Mode changes that only grant or revoke member status join the same line ' +
      '("…; Alice and Bob were opped; Carol was briefly voiced"), naming who it ' +
      'was done to rather than who did it — bans, channel keys, limits and ' +
      'channel flags always keep their own line. ' +
      'Off shows every event individually. Composes with the "smart" tier — events ' +
      'it hides are excluded from the summary.',
  },
  {
    key: 'chat.consolidate_max_names',
    label: 'Max nicks per summary category',
    category: 'events',
    group: 'consolidate',
    type: 'int',
    min: 1,
    max: 50,
    default: 5,
    // Only names the switch directly above it: the tier condition arrives
    // transitively through chat.consolidate_joins.
    dependsOn: [{ key: 'chat.consolidate_joins', in: [true] }],
    description:
      'In each category (joined / left / reconnected / renamed / changed host / ' +
      'opped / voiced / briefly opped …) of a summary ' +
      'line, show at most this many nicks before collapsing the rest into ' +
      '"and N others". Recent speakers (those tracked for nick completion) ' +
      'are preferred when picking which names to show.',
  },
  {
    key: 'chat.show_event_host',
    label: 'Show user@host on join/part/quit/nick',
    category: 'events',
    group: 'consolidate',
    type: 'bool',
    default: false,
    // Hangs off the tier, not off consolidation: this decorates the individual
    // lines, which is exactly what survives when consolidation is OFF.
    dependsOn: EVENTS_VISIBLE,
    description:
      'Show the affected user’s user@host next to their nick on JOIN, PART, ' +
      'QUIT, and nick-change lines (e.g. "alice (~alice@host.example.net) ' +
      'joined") — useful for channel ops spotting ban masks. Applies to ' +
      'individual lines only; events that collapse into the consolidation ' +
      'summary above stay host-less. Regular chat messages are unaffected.',
  },
  {
    key: 'chat.show_join_account',
    label: 'Show services account on join lines',
    category: 'events',
    group: 'consolidate',
    type: 'bool',
    default: false,
    dependsOn: EVENTS_VISIBLE,
    description:
      'Show the joining user’s services (NickServ) account next to their nick ' +
      'on JOIN lines (e.g. "alice [aliceacct] joined") — useful for channel ops ' +
      'confirming who is identified. Requires the network to support the ' +
      'extended-join extension; nothing is shown for users who are not logged ' +
      'in, or on networks without it. Applies to individual lines only; events ' +
      'that collapse into the consolidation summary above stay account-less.',
  },

  // ─── Smart filter tuning (join/part/quit/nick/mode noise) ─────────────
  // Last of the three Events groups, and the narrowest — it only does anything
  // on one rung of the filter.
  //
  // The master switch used to live here as `chat.smart_filter`; it is now the
  // middle rung of `chat.events` (#666), and a boot migration carries anyone who
  // had it on across to the tier. What remains is the tuning it always had.
  {
    key: 'chat.smart_filter_delay',
    label: '"Recently spoke" window (minutes)',
    category: 'events',
    group: 'smart-filter',
    type: 'int',
    min: 0,
    max: 1440,
    default: 5,
    dependsOn: EVENTS_SMART,
    description:
      'Window in minutes for "recently spoke". An event is hidden if the nick it ' +
      'concerns has not posted a message within this many minutes before it. For ' +
      'joins, parts, quits and nick changes that is the nick the event is about; ' +
      'for op and voice changes it is the nick being opped or voiced, not whoever ' +
      'set the mode.',
  },
  {
    key: 'chat.smart_filter_join',
    label: 'Filter joins',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Apply smart filter to JOIN events.',
  },
  {
    key: 'chat.smart_filter_quit',
    label: 'Filter parts and quits',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Apply smart filter to PART and QUIT events.',
  },
  {
    key: 'chat.smart_filter_nick',
    label: 'Filter nick changes',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Apply smart filter to NICK change events.',
  },
  {
    key: 'chat.smart_filter_mode',
    label: 'Filter op and voice changes',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description:
      'Apply smart filter to MODE events that only grant or revoke member status ' +
      '(+o, +v, and the equivalents your network offers). The event is hidden when ' +
      'none of the nicks it acts on has spoken recently. Bans, channel keys, user ' +
      'limits and channel flags are never hidden, and a single MODE that mixes one ' +
      'of those in with an op change is shown in full.',
  },
  {
    key: 'chat.smart_filter_join_unmask',
    label: 'Reveal join when user speaks (minutes)',
    category: 'events',
    group: 'smart-filter',
    type: 'int',
    min: 0,
    max: 1440,
    default: 30,
    dependsOn: EVENTS_SMART,
    description:
      'If a smart-filtered nick speaks within this many minutes after their JOIN, ' +
      'the JOIN line is revealed. 0 disables unmasking.',
  },

  // ─── Composing (outgoing message guardrails) ─────────────────────────
  // irc-framework splits anything past ~350 bytes into multiple PRIVMSGs on
  // the wire. The default UX blocks the user from accidentally flooding —
  // they have to either shorten, hit Send a second time to confirm, or flip
  // this on to send splits silently like a traditional client.
  {
    key: 'chat.allow_split_messages',
    label: 'Allow long messages to split',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: false,
    description:
      'Allow long messages to send as multiple consecutive IRC lines without ' +
      'confirmation. When off (the default), trying to send a message that ' +
      "would split shows a SPLIT warning in the status bar and won't submit " +
      'until you press Send a second time; one that would split into three or ' +
      'more offers to upload the text as a file instead. /me actions never ' +
      'split — they are blocked outright regardless of this setting.',
  },
  {
    key: 'chat.send_typing_notifications',
    label: 'Send typing notifications',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: true,
    description:
      'Let other clients see when you are typing (IRCv3 +typing tag). Off stops ' +
      'this client from sending typing/paused/done notifications while you compose ' +
      "a message. Doesn't affect seeing other people's typing indicators.",
  },
  {
    key: 'chat.keep_position_on_send',
    label: 'Stay where you are when you send',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: false,
    description:
      'Keep your scroll position when you send a message, instead of jumping to ' +
      'the newest message. For reading back through a busy channel while still ' +
      'replying — your own line lands at the bottom and the "Return ↓" button ' +
      'counts it, so you can drop back down when you are ready. Off (the default) ' +
      'jumps to the bottom on every send. Sending while you are viewing a ' +
      'jumped-to point in history returns you to the live conversation either ' +
      'way, since that view holds live messages back and there is nowhere in it ' +
      'for your own message to appear.',
  },

  // ─── Inline media viewer ──────────────────────────────────────────────
  {
    // ⚠ The key still says `image_modal` even though the viewer now plays video and
    // audio and reads text (#563). Renaming it is a MIGRATION, not a rename: the stored
    // row lives under the old key, so a new key would orphan it — silently switching
    // the viewer back on for exactly the people who went out of their way to turn it
    // off. The label is what users read; the key is an id, and ids age.
    key: 'chat.image_modal.enabled',
    label: 'Media viewer',
    category: 'chat',
    group: 'viewing',
    type: 'bool',
    default: true,
    description:
      'When enabled, clicking a link to an image, video, audio file, or .txt opens it ' +
      'in an in-app viewer instead of a new browser tab. Cmd/Ctrl-click always opens ' +
      'in a new tab.',
  },

  // ─── Inline media & link previews ─────────────────────────────────────
  //
  // Two keys rather than one, because wanting one does not imply wanting the
  // other. Seeing the screenshots your friends paste is a different appetite
  // from having every news article sprout a card, and plenty of people want
  // exactly one of them.
  //
  // Both default OFF. Neither is device-split: if you want images inline you
  // want them inline everywhere. (Contrast `chat.events`, which IS device-split
  // because screen size genuinely changes the right answer.)
  {
    key: 'chat.inline_media.enabled',
    requiresFeature: 'linkPreviews',
    label: 'Inline media',
    category: 'chat',
    group: 'viewing',
    type: 'bool',
    default: false,
    // ⚠⚠ THE PRIVACY SENTENCE IS SCOPED TO IMAGES, and the scoping is the point rather than
    // pedantry. This string is the whole basis on which someone decides to turn the setting on,
    // and it used to promise that "the file is fetched and served by your Lurker server" for
    // video and audio too. That stopped being true when those kinds stopped being relayed: the
    // card links straight to the origin, so a reader who enabled this on the old promise would
    // hand their address to a stranger's host the moment they pressed the filename. A guarantee
    // a user acts on has to be narrower than the truth, never wider.
    description:
      'When enabled, a link that points straight at an image renders under the message ' +
      'instead of showing only as a link, and the image is fetched and served by your ' +
      'Lurker server, so the site hosting it never sees your device. Video and audio ' +
      'links get a card naming the file — opening one goes to the site hosting it, ' +
      'like any other link.',
  },
  {
    key: 'chat.link_previews.enabled',
    requiresFeature: 'linkPreviews',
    label: 'Link previews',
    category: 'chat',
    group: 'viewing',
    type: 'bool',
    default: false,
    description:
      'When enabled, a link to a web page renders a small card with its title, ' +
      'description, and thumbnail. Your Lurker server fetches the page — your device ' +
      'never contacts the site. Video links get a play button, and nothing is sent to ' +
      'the video host until you press it.',
  },

  // ─── Translation ──────────────────────────────────────────────────────
  // Live message translation (device-local). YOUR DEVICE calls the endpoint you
  // configure — the Lurker server is never involved and never sees which
  // messages you translate. That is the whole design: it works with a
  // local-network translator (Ollama, LM Studio, a self-hosted LibreTranslate)
  // using credentials only you hold. The trade is disclosed in each
  // description below, because the description is the entire basis on which
  // someone decides to turn a knob on: message text is sent to the configured
  // endpoint.
  //
  // These keys configure the translator; the per-conversation reading/posting
  // switches live in the buffer menu (device-local state, deliberately not
  // synced — which conversations you translate is as private as the messages).
  {
    key: 'chat.translate.backend',
    label: 'Translation backend',
    category: 'chat',
    group: 'translation',
    type: 'enum',
    choices: ['off', 'libretranslate', 'openai'],
    choiceLabels: { off: 'Off', libretranslate: 'LibreTranslate', openai: 'OpenAI-compatible' },
    default: 'off',
    description:
      'Translate messages using a service you configure. "LibreTranslate" is a free, ' +
      'self-hostable translator; "OpenAI-compatible" works with Ollama, LM Studio, or any ' +
      'API gateway speaking that protocol. Message text is sent from YOUR DEVICE to the ' +
      'endpoint below — your Lurker server never sees it. Off hides all translation UI.',
  },
  {
    key: 'chat.translate.endpoint',
    label: 'Translator endpoint',
    category: 'chat',
    group: 'translation',
    type: 'string',
    default: '',
    dependsOn: [{ key: 'chat.translate.backend', in: ['libretranslate', 'openai'] }],
    description:
      'Base URL of the translator (e.g. https://translate.example.com, or ' +
      'http://localhost:11434 for Ollama). For OpenAI-compatible backends, /v1 is ' +
      'appended automatically when missing. Because your browser calls this endpoint ' +
      'directly, it must allow cross-origin requests from your Lurker origin.',
  },
  {
    key: 'chat.translate.api_key',
    label: 'Translator API key',
    category: 'chat',
    group: 'translation',
    type: 'secret',
    default: '',
    dependsOn: [{ key: 'chat.translate.backend', in: ['libretranslate', 'openai'] }],
    description:
      'Optional. Sent as an api_key field to LibreTranslate, or as a Bearer token to an ' +
      'OpenAI-compatible backend. Leave empty for keyless services (a local Ollama, or a ' +
      'public LibreTranslate that requires none).',
  },
  {
    key: 'chat.translate.model',
    label: 'Translator model',
    category: 'chat',
    group: 'translation',
    type: 'string',
    default: '',
    // OpenAI-compatible only: LibreTranslate has no model concept, so showing
    // this knob there would be a switch that silently does nothing.
    dependsOn: [{ key: 'chat.translate.backend', in: ['openai'] }],
    description:
      'The model an OpenAI-compatible backend should use (e.g. llama3.2, gpt-4o-mini). ' +
      'Required for that backend — the API refuses a request without one.',
  },
  {
    key: 'chat.translate.target_lang',
    label: 'Translate into',
    category: 'chat',
    group: 'translation',
    type: 'enum',
    // A picker, never free-form entry: a typo'd language code fails silently at
    // the translator, which reads as "translation is broken" with no error to
    // chase. Codes are ISO-639-1 as LibreTranslate uses them ('zt' =
    // traditional Chinese in its scheme).
    choices: [
      'en',
      'ar',
      'cs',
      'da',
      'de',
      'el',
      'es',
      'fa',
      'fi',
      'fr',
      'he',
      'hi',
      'hu',
      'id',
      'it',
      'ja',
      'ko',
      'nl',
      'no',
      'pl',
      'pt',
      'ro',
      'ru',
      'sv',
      'th',
      'tr',
      'uk',
      'vi',
      'zh',
      'zt',
    ],
    choiceLabels: {
      en: 'English',
      ar: 'Arabic',
      cs: 'Czech',
      da: 'Danish',
      de: 'German',
      el: 'Greek',
      es: 'Spanish',
      fa: 'Persian',
      fi: 'Finnish',
      fr: 'French',
      he: 'Hebrew',
      hi: 'Hindi',
      hu: 'Hungarian',
      id: 'Indonesian',
      it: 'Italian',
      ja: 'Japanese',
      ko: 'Korean',
      nl: 'Dutch',
      no: 'Norwegian',
      pl: 'Polish',
      pt: 'Portuguese',
      ro: 'Romanian',
      ru: 'Russian',
      sv: 'Swedish',
      th: 'Thai',
      tr: 'Turkish',
      uk: 'Ukrainian',
      vi: 'Vietnamese',
      zh: 'Chinese (simplified)',
      zt: 'Chinese (traditional)',
    },
    default: 'en',
    dependsOn: [{ key: 'chat.translate.backend', in: ['libretranslate', 'openai'] }],
    description:
      'The language incoming messages are translated into, and the default language ' +
      'outgoing messages are translated to when posting translation is enabled for a ' +
      'conversation.',
  },

  // ─── Connection ───────────────────────────────────────────────────────
  {
    key: 'chat.quit_message',
    label: 'Quit message',
    category: 'chat',
    group: 'connection',
    type: 'string',
    default: '',
    description:
      'The QUIT reason others see when you disconnect from a network and no ' +
      'explicit /quit message is given. Leave blank to use the Lurker default ' +
      '(the version and project URL).',
  },

  // ─── CTCP auto-replies (what we disclose to the network on a CTCP query) ──
  // Lurker answers a few standard CTCP queries cell-side (so they work even with
  // no tab open). The per-type values are WeeChat-style reply TEMPLATES: the
  // text sent back, with ${...} placeholders expanded. An EMPTY template
  // disables that reply. Placeholders: ${name} (Lurker), ${version}, ${source}
  // (project URL), ${time} (server time), ${clientinfo} (the types still
  // answered), ${nick} (your nick). Defaults reproduce the standard replies.
  // PING isn't templated — it only echoes the asker's token — but the master
  // switch silences it too.
  {
    key: 'ctcp.replies',
    label: 'Answer CTCP queries',
    category: 'chat',
    group: 'ctcp',
    type: 'bool',
    default: true,
    description:
      'Master switch for replying to CTCP queries from other users (VERSION, ' +
      'TIME, SOURCE, CLIENTINFO, PING). Turn off to publish nothing — Lurker ' +
      'stays completely silent to CTCP, like a client with CTCP disabled. The ' +
      'per-type reply templates below apply only while this is on.',
  },
  {
    key: 'ctcp.msgbuffer',
    label: 'Where CTCP notices appear',
    category: 'chat',
    group: 'ctcp',
    type: 'enum',
    choices: ['server', 'system', 'private'],
    default: 'server',
    description:
      'Which buffer shows incoming CTCP notices — a "X requested CTCP …" probe, ' +
      'or an unsolicited CTCP reply. Modeled on WeeChat irc.msgbuffer.ctcp. ' +
      '"server" (default) = the network\'s server buffer; "system" = the ' +
      'app-wide system buffer (these lines persist there, like other log ' +
      'lines); "private" = a DM with the sender (or the channel, for a ' +
      'channel-targeted CTCP). A reply to a /ctcp YOU sent always returns to ' +
      'the buffer you ran it from, regardless of this.',
  },
  {
    key: 'ctcp.version',
    label: 'CTCP VERSION reply',
    category: 'chat',
    group: 'ctcp',
    type: 'string',
    default: '${name} ${version}',
    description:
      'Reply sent for a CTCP VERSION query. Placeholders: ${name}, ${version}, ' +
      '${source}, ${time}, ${clientinfo}, ${nick}. Leave EMPTY to not answer ' +
      'VERSION at all — disclosing your exact client/version aids fingerprinting.',
  },
  {
    key: 'ctcp.time',
    label: 'CTCP TIME reply',
    category: 'chat',
    group: 'ctcp',
    type: 'string',
    default: '${time}',
    description:
      'Reply sent for a CTCP TIME query (default is the current server time, ' +
      'sent as UTC). Same placeholders as the VERSION reply. Leave EMPTY to ' +
      'withhold it — answering tells the asker you are connected.',
  },
  {
    key: 'ctcp.source',
    label: 'CTCP SOURCE reply',
    category: 'chat',
    group: 'ctcp',
    type: 'string',
    default: '${source}',
    description:
      'Reply sent for a CTCP SOURCE query (default is the Lurker project URL). ' +
      'Same placeholders as the VERSION reply. Leave EMPTY to not answer.',
  },
  {
    key: 'ctcp.clientinfo',
    label: 'CTCP CLIENTINFO reply',
    category: 'chat',
    group: 'ctcp',
    type: 'string',
    default: '${clientinfo}',
    description:
      'Reply sent for a CTCP CLIENTINFO query. The default ${clientinfo} ' +
      'expands to the list of CTCP types you currently answer. Same ' +
      'placeholders as the VERSION reply. Leave EMPTY to not answer.',
  },

  // ─── Auto-away (sets you AWAY when no client is connected) ────────────
  {
    key: 'away.auto.enabled',
    label: 'Auto-set away when no client connected',
    category: 'away',
    group: 'auto-away',
    type: 'bool',
    default: true,
    description:
      'Automatically set you AWAY on every connected network when no Lurker client ' +
      'is attached, and clear AWAY when a client reconnects. Modeled on the WeeChat ' +
      'screen_away.py script.',
  },
  {
    key: 'away.auto.delay_seconds',
    label: 'Auto-away delay (seconds)',
    category: 'away',
    group: 'auto-away',
    type: 'int',
    min: 5,
    max: 3600,
    default: 900,
    description:
      'How long to wait after the last client disconnects before setting AWAY. ' +
      'Avoids flapping on browser refreshes or brief network blips.',
  },
  {
    key: 'away.auto.message',
    label: 'Auto-away message',
    category: 'away',
    group: 'auto-away',
    type: 'string',
    default: 'afk',
    description:
      'Auto-away message body. The current local timestamp is appended as ' +
      '" since YYYY-MM-DD HH:MM:SS±ZZZZ", so the default produces ' +
      '"afk since 2026-05-09 15:30:00-0500".',
  },

  // ─── Uploads ────────────────────────────────────────────────────
  //
  // WHERE a file goes is no longer a setting. The destination is a configured
  // uploader (a `uploader_config` row: driver + its own credentials), managed in
  // the bespoke half of the Uploads pane and selected via /api/uploaders. The old
  // `uploads.provider` enum + the flat `uploads.catbox.*`/`uploads.hoarder.*`
  // credential keys were removed in #514 and folded into rows by
  // db/uploaderConfigSeed.ts#reconcileLegacyUploadSettings. What remains here is
  // the part that genuinely is a per-user preference: the processing pipeline.
  {
    key: 'uploads.image.format',
    label: 'Static image format',
    category: 'uploads',
    group: 'pipeline',
    type: 'enum',
    choices: ['webp', 'jpeg'],
    default: 'webp',
    // Deliberately NOT selfHostedOnly, unlike every other key in this group.
    // Those are cost/abuse levers the operator owns in hosted edition; this is a
    // compatibility preference the user owns, and the hosted dropper accepts
    // both formats, so there is nothing for the operator to protect.
    description:
      'Format static images are re-encoded to. "webp" (default) is smaller and — ' +
      'unlike JPEG — has an alpha channel, so transparent PNGs survive the ' +
      're-encode instead of being flattened onto black. "jpeg" is the escape ' +
      'hatch for a client or upload host that mangles WebP. Animated GIF/WebP/' +
      'APNG bypass this entirely and are uploaded verbatim.',
  },
  {
    key: 'uploads.image.max_dimension',
    label: 'Max image dimension (longest edge)',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 256,
    max: 8192,
    default: 2048,
    // Cost/abuse lever — operator-controlled in node edition (enforced
    // server-side in A8), not a tenant knob.
    selfHostedOnly: true,
    description:
      'Longest-edge limit for static images before they are re-encoded. ' +
      'Animated GIF/WebP/APNG bypass this and are uploaded verbatim.',
  },
  {
    key: 'uploads.image.quality',
    label: 'Image re-encode quality',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 30,
    max: 100,
    default: 85,
    selfHostedOnly: true,
    description:
      'Quality (30–100) for the re-encode pass on static images, handed to ' +
      'whichever encoder uploads.image.format selects. Higher is better-looking ' +
      'and bigger in both, but the scales are not identical — WebP at 85 is not ' +
      'the same picture as JPEG at 85.',
  },
  {
    key: 'uploads.image.max_upload_mb',
    label: 'Max upload size (MB)',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 1,
    max: 200,
    // 100, not 25: a 30-second phone video clears 25 MB instantly, and media
    // uploads (#515) make that the common case rather than the exotic one.
    default: 100,
    selfHostedOnly: true,
    description:
      'Hard cap on the raw upload size in megabytes. Anything larger is ' +
      'rejected before the optimization pipeline runs.',
  },
  {
    key: 'uploads.paste.enabled',
    label: 'Upload pasted files',
    category: 'uploads',
    group: 'pipeline',
    type: 'bool',
    default: true,
    description:
      'When enabled, pasting an image into the input area uploads it and ' +
      'inserts the resulting URL. Disable to fall back to plain text paste.',
  },

  // ─── Notifications (unified intent, per signal type) ──────────────────
  // Toast (in-client when a tab is visible) and push (when no tab is visible)
  // are two delivery sides of the *same* intent. wsHub's userHasVisibleClient
  // gate routes the right one automatically. So each signal type has a single
  // master `enabled` toggle that governs both, plus a sound sub-toggle that
  // only matters when the master is on.
  {
    key: 'notifications.highlight.enabled',
    label: 'Highlight notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Notify me when a message matches one of my highlight rules. Toast appears ' +
      'in-client when a tab is visible; push fires when no tab is visible. Turning ' +
      'this off suppresses both.',
  },
  {
    key: 'notifications.highlight.sound.enabled',
    label: 'Highlight sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description:
      'Play a short sound when a new highlight arrives. Off by default — opt in ' +
      'if you want it. Dependent on notifications.highlight.enabled.',
  },
  {
    key: 'notifications.highlight.sound.choice',
    label: 'Highlight sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'ping',
    description:
      'Which bundled sound to play for highlights. Files live in /sounds/<choice>.mp3 ' +
      'on the client. Use the preview button in Settings to audition each one.',
  },
  {
    key: 'notifications.highlight.sound.volume',
    label: 'Highlight sound volume',
    category: 'notifications',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Playback volume for the highlight sound, 0–100.',
  },

  {
    key: 'notifications.dm.enabled',
    label: 'DM notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Notify me when someone sends me a direct message. Toast in-client when a ' +
      'tab is visible; push when none is. Master toggle for DM notifications.',
  },
  {
    key: 'notifications.dm.sound.enabled',
    label: 'DM sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description:
      'Play a short sound on incoming DMs. Off by default. Dependent on ' +
      'notifications.dm.enabled.',
  },
  {
    key: 'notifications.dm.sound.choice',
    label: 'DM sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'chime',
    description:
      'Which bundled sound to play for DMs. Audibly distinct default from the ' +
      'highlight sound so you can tell them apart by ear.',
  },
  {
    key: 'notifications.dm.sound.volume',
    label: 'DM sound volume',
    category: 'notifications',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Playback volume for the DM sound, 0–100.',
  },

  {
    // Same key names the contacts-era friend-online settings used: stored
    // user_settings rows were orphaned (never purged) when the friends system
    // left, so re-registering the names revives every preference untouched.
    key: 'notifications.friend_online.enabled',
    label: 'Friend online notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Toast me when a friend — the peer of a DM in your FRIENDS section — comes online.',
  },
  {
    key: 'notifications.friend_online.sound.enabled',
    label: 'Friend online sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description:
      'Play a short sound when a friend comes online. Off by default. Dependent on ' +
      'notifications.friend_online.enabled.',
  },
  {
    key: 'notifications.friend_online.sound.choice',
    label: 'Friend online sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'knock',
    description:
      'Which bundled sound to play when a friend comes online. Distinct default ' +
      'from the highlight/DM sounds so a friend signing on is recognizable by ear.',
  },
  {
    key: 'notifications.friend_online.sound.volume',
    label: 'Friend online sound volume',
    category: 'notifications',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Playback volume for the friend-online sound, 0–100.',
  },

  {
    key: 'notifications.always_notify.enabled',
    label: 'Always-notify channel notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Notify me for every message in channels I have flagged "always notify" ' +
      '(via the channel context menu). Toast in-client, push when no tab is ' +
      'visible. The per-channel bell is the opt-in; this is the global master.',
  },
  {
    key: 'notifications.always_notify.sound.enabled',
    label: 'Always-notify sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Play a short sound for messages in always-notify channels. Dependent on ' +
      'notifications.always_notify.enabled.',
  },
  {
    key: 'notifications.always_notify.sound.choice',
    label: 'Always-notify sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'plink',
    description:
      'Which bundled sound to play for always-notify channels. Defaults to a ' +
      'quieter/subtler choice since these channels can be higher-traffic.',
  },
  {
    key: 'notifications.always_notify.sound.volume',
    label: 'Always-notify sound volume',
    category: 'notifications',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Playback volume for the always-notify sound, 0–100.',
  },

  // ─── Push-side filters ────────────────────────────────────────────────
  // These only affect push delivery — toasts are unaffected (toasts require a
  // visible client, which short-circuits push anyway). All off by default.
  {
    key: 'notifications.push.mute_when_away',
    label: 'Mute push when manually away',
    category: 'notifications',
    group: 'push_filters',
    type: 'bool',
    default: false,
    description:
      'Suppress push notifications while you have a manual /away set. ' +
      "Auto-away (triggered when all your tabs close) is unaffected — that's " +
      'the case push exists to cover.',
  },
  {
    key: 'notifications.push.quiet_hours.enabled',
    label: 'Push quiet hours',
    category: 'notifications',
    group: 'push_filters',
    type: 'bool',
    default: false,
    description:
      'When on, push notifications are suppressed during the configured quiet ' +
      "hours window. Toasts are unaffected — they only fire when you're at " +
      'the desk anyway.',
  },
  {
    key: 'notifications.push.quiet_hours.start',
    label: 'Quiet hours start',
    category: 'notifications',
    group: 'push_filters',
    type: 'string',
    default: '22:00',
    description:
      'Start of the quiet-hours window in HH:MM (24h), interpreted in your ' +
      'system.timezone. When start > end the window wraps midnight (e.g. ' +
      '22:00–07:00 means 10pm through 7am).',
  },
  {
    key: 'notifications.push.quiet_hours.end',
    label: 'Quiet hours end',
    category: 'notifications',
    group: 'push_filters',
    type: 'string',
    default: '07:00',
    description:
      'End of the quiet-hours window in HH:MM (24h), interpreted in your system.timezone.',
  },

  // ─── Input bar (system text features) ─────────────────────────────────
  // Each setting maps directly to an HTML attribute on the chat input
  // element. Defaults are all true so the input behaves like a normal text
  // field out of the box; users can disable any one independently (the most
  // common ask is autocapitalize, which mangles nicks and commands).
  {
    key: 'input.spellcheck',
    label: 'Spellcheck input',
    category: 'input',
    group: 'system_features',
    type: 'bool',
    default: true,
    description:
      'Enable the browser/OS spellchecker on the chat input (red squigglies under ' +
      "misspellings). Disable if you frequently type words your dictionary doesn't " +
      'know and find the underlines distracting.',
  },
  {
    key: 'input.autocorrect',
    label: 'Autocorrect input',
    category: 'input',
    group: 'system_features',
    type: 'bool',
    default: true,
    description:
      'Allow the browser/OS to silently correct what you type as you go (most ' +
      'visible on Safari and mobile keyboards). Disable to keep chat slang, ' +
      'URLs, and command arguments exactly as typed. Also suppresses the ' +
      'sentence-start auto-capitalize behavior, which Safari otherwise re-applies ' +
      'regardless of any autocapitalize attribute.',
  },
  {
    key: 'input.autocorrect_force_mobile',
    label: 'Force autocorrect on mobile',
    category: 'input',
    group: 'system_features',
    type: 'bool',
    default: false,
    description:
      'On touch devices, force autocorrect on regardless of the desktop ' +
      'preference above. Useful if you keep autocorrect off on a hardware ' +
      'keyboard but want phone-typing assistance back on a soft keyboard. ' +
      'Re-enables the sentence-start auto-capitalize behavior too, since ' +
      'they ride together.',
  },

  // ─── Input bar (autocomplete UI) ──────────────────────────────────────
  {
    key: 'input.suggestion_strip_on_desktop',
    label: 'Use suggestion strip on desktop',
    category: 'input',
    group: 'autocomplete',
    type: 'bool',
    default: false,
    description:
      'Use the mobile-style horizontal suggestion strip on desktop instead of ' +
      'the @-triggered popup menu. The strip surfaces matching nicks above the ' +
      "input as you type any 2+ character prefix (no '@' required), tap or " +
      'click a nick to insert it.',
  },
  // What a nick picks up when completed at the START of a line — the
  // addressing form, `nick: `. Stored as the punctuation alone, with the
  // trailing space always appended by the client (irssi's completion_char):
  // every meaningful value is then visible in a text field, `/set
  // input.completion.nick_suffix ,` needs no quoting, and "space only" is the
  // empty string rather than an invisible ' '. The trade is that "no space"
  // and "two spaces" are inexpressible, which nobody has asked for. Not an
  // enum — the ask (#835) was for the common four AND free-form, and a string
  // gets both without a new registry type.
  {
    key: 'input.completion.nick_suffix',
    label: 'Nick completion suffix',
    category: 'input',
    group: 'autocomplete',
    type: 'string',
    default: ':',
    description:
      'Punctuation placed after a nick completed at the start of a line — the ' +
      '"nick: " addressing form: ":" (default), ",", ";", or empty for a bare ' +
      'space. A space always follows it. Applies to Tab, the @ picker, the ' +
      'suggestion strip, and Reply; mid-line completions are unaffected.',
  },

  // ─── Input bar (formatting) ──────────────────────────────────────────
  // Surfaces the mIRC palette popover for users who want to insert colour /
  // bold / italic / underline codes via mouse. The Cmd/Ctrl+B/I/U keyboard
  // shortcuts always work regardless of this toggle — this only controls the
  // icon's visibility in the input row.
  {
    key: 'input.show_format_button',
    label: 'Show formatting button',
    category: 'input',
    group: 'formatting',
    type: 'bool',
    default: false,
    description:
      'Show the palette icon in the input row that opens a mIRC colour picker ' +
      '(and a clear-formatting option). Off by default to keep the input chrome ' +
      'minimal — the Cmd/Ctrl+B/I/U keyboard shortcuts for bold/italic/underline ' +
      'work either way.',
  },

  // ─── Theme presets (pointer keys) ─────────────────────────────────────
  // Which theme preset drives the `themed` appearance keys. Category `theme`
  // is deliberately absent from CATEGORIES (like `system`): these render in
  // the bespoke Themes section of the Appearance pane, not as raw rows. The
  // stored value of the three pointer keys is a theme id — 'dark' / 'light'
  // for the built-ins, or the decimal row id of a saved /api/themes theme. A
  // pointer at a theme that no longer exists resolves as the built-in Dark
  // theme (the client resolver falls back; the themes DELETE route also
  // resets any pointer it dangles). None of these are `themed` — see the
  // BaseOption note; a themed pointer would make resolution recursive.
  {
    key: 'look.theme.mode',
    label: 'Theme selection mode',
    category: 'theme',
    group: 'presets',
    type: 'enum',
    choices: ['single', 'system'],
    // Ascribed because TS unions every literal in REGISTRY: a second distinct
    // choiceLabels key-set makes each other's keys optional-undefined, which the
    // Record<string, string> index signature rejects.
    choiceLabels: {
      single: 'One theme everywhere',
      system: 'Follow system light/dark',
    } as Readonly<Record<string, string>>,
    default: 'single',
    description:
      'How the active theme preset is chosen. "single" uses the one theme set ' +
      'in look.theme.active everywhere. "system" follows this device\'s ' +
      'light/dark preference: look.theme.light applies when the OS is in ' +
      'light mode, look.theme.dark when it is in dark mode. The preference is ' +
      'read per device, so a phone in light mode and a desktop in dark mode ' +
      'each get their assigned theme from the same synced settings.',
  },
  {
    key: 'look.theme.active',
    label: 'Active theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'dark',
    description:
      'The theme preset in effect when look.theme.mode is "single": "dark", ' +
      '"light", or the id of a saved theme. Applying a theme sets this and ' +
      'clears any per-setting overrides so the theme shows unmodified.',
  },
  {
    key: 'look.theme.light',
    label: 'Light-mode theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'light',
    description:
      'The theme preset used while this device reports a light color scheme, ' +
      'when look.theme.mode is "system". "dark", "light", or a saved theme id.',
  },
  {
    key: 'look.theme.dark',
    label: 'Dark-mode theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'dark',
    description:
      'The theme preset used while this device reports a dark color scheme, ' +
      'when look.theme.mode is "system". "dark", "light", or a saved theme id.',
  },

  // ─── System / locale ──────────────────────────────────────────────────
  {
    key: 'system.timezone',
    label: 'Timezone',
    category: 'system',
    group: 'locale',
    type: 'string',
    default: '',
    description:
      'IANA timezone name (e.g. "America/Chicago") used when the server formats ' +
      'human-readable timestamps for you — currently the timestamp baked into the ' +
      'auto-away message. The client auto-detects and syncs this on bootstrap, so ' +
      'travelling updates it on next connect. Leave blank to fall back to the ' +
      "server's local time.",
  },
  {
    key: 'onboarding.completed',
    label: 'Onboarding completed',
    category: 'system',
    group: 'onboarding',
    type: 'bool',
    default: false,
    description:
      'Set once the first-run flow has been finished or skipped, so it never shows ' +
      'again. Lives here rather than in localStorage so it follows the user across ' +
      'devices. Must default to false: settingsService drops any row whose value ' +
      'equals the registry default, so a true default would be unstorable.',
  },

  // ─── Data / retention ─────────────────────────────────────────────────
  // How much stored history to keep, per buffer (lurker-dev/RETENTION_PLAN.md).
  // Rendered by the bespoke DataPane via an embedded RegistryPane. The min/max
  // here are NOT the enforcement surface: the operator ceiling is the env var
  // LURKER_MAX_RETENTION_LINES, and every enforcement path resolves through
  // effectiveRetentionLines() (services/retentionLimits.ts), which clamps a
  // stored value regardless of what a client managed to write. minNonzero is
  // write-time-only guardrailing (validate()): pruning is irreversible, and a
  // cap like 50 is a mis-typed 5000, not a plan.
  {
    key: 'data.retention.lines',
    label: 'History limit (lines per buffer)',
    category: 'data',
    group: 'retention',
    type: 'int',
    min: 0,
    max: 10_000_000,
    minNonzero: 1000,
    default: 0,
    description:
      'Each buffer keeps at most this many lines; older lines are deleted ' +
      'permanently. 0 keeps everything (up to any limit this server sets); ' +
      'the smallest nonzero limit is 1,000. Bookmarked messages are never ' +
      'deleted. Export your data first if you want an archive.',
  },
  // The noise clock: presence/server churn ages out on its own (shorter)
  // schedule regardless of the line limit. Default ON at one week — the
  // operator weighed 72h against 168h and chose the week because these rows
  // feed search-driven fact-finding ("when did X last quit"). The deletable
  // set is shared/eventFilter.ts EARLY_PRUNE_TYPES, not something clients
  // enumerate. Enforced through effectiveEventRetentionHours(), ceiling env
  // var LURKER_MAX_EVENT_RETENTION_HOURS — same stack as the line cap.
  {
    key: 'data.retention.event_hours',
    label: 'Event history age limit (hours)',
    category: 'data',
    group: 'retention',
    type: 'int',
    min: 0,
    max: 87_600,
    // Same guardrail rationale as the lines floor, and this knob acts FASTER
    // (the settings listener flags the sweep due immediately): a typed 1 or
    // 17 would permanently delete nearly all event history within a tick.
    minNonzero: 24,
    default: 168,
    description:
      'Presence and server noise — joins, parts, quits, nick and mode ' +
      'changes, MOTDs, away toggles — is deleted permanently once older than ' +
      'this many hours, regardless of the line limit. 168 = one week; the ' +
      'smallest nonzero limit is 24. 0 keeps events as long as regular ' +
      'messages. Bookmarked messages are never deleted.',
  },
  // Closed-buffer garbage collection: a buffer closed for longer than this
  // is deleted ENTIRELY — row and history. Default OFF, deliberately and
  // unlike the noise clock: closing is sidebar tidiness, not a judgment on
  // the history (search/highlights reach into closed buffers), and this is
  // the one knob that deletes chat rather than churn. Hosted can force it
  // through the ceiling env var LURKER_MAX_CLOSED_BUFFER_DAYS. Buffers still
  // holding a bookmarked message are always skipped.
  {
    key: 'data.retention.closed_buffer_days',
    label: 'Delete closed buffers after (days)',
    category: 'data',
    group: 'retention',
    type: 'int',
    min: 0,
    max: 3650,
    minNonzero: 7,
    default: 0,
    description:
      'Buffers closed for longer than this many days are deleted entirely, ' +
      'history included. 0 keeps closed buffers forever; the smallest nonzero ' +
      'value is 7. Buffers containing a bookmarked message are never deleted.',
  },
]);

const BY_KEY = new Map(REGISTRY.map((opt) => [opt.key, opt] as const));

export function getOption(key: string): SettingOption | null {
  return BY_KEY.get(key) || null;
}

export function defaultsAsObject(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const opt of REGISTRY) out[opt.key] = opt.default;
  return out;
}

/** The keys a theme preset snapshots, in registry order. */
export const THEMED_KEYS: readonly string[] = Object.freeze(
  REGISTRY.filter((opt) => opt.themed).map((opt) => opt.key),
);

/**
 * Registry defaults for just the themed keys — the built-in Dark theme's
 * values. Arrays are copied: REGISTRY's freeze is shallow, so handing out the
 * live default arrays would let any consumer mutate the registry in place.
 */
export function themedDefaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const opt of REGISTRY) {
    if (opt.themed) out[opt.key] = Array.isArray(opt.default) ? [...opt.default] : opt.default;
  }
  return out;
}

// ─── Sidebar taxonomy ─────────────────────────────────────────────────────
//
// Ordered list of categories shown in the Settings sidebar. `kind: 'registry'`
// categories are auto-rendered by RegistryPane.vue from REGISTRY entries with
// the matching `category` field. `kind: 'bespoke'` categories have a custom
// pane component (NotificationsPane.vue, HighlightsPane.vue, etc.) that
// hand-renders its controls, optionally also reading registry settings.
//
// The `system` registry category is intentionally absent — system.timezone is
// auto-synced from the browser and not user-facing.
// Order reflects what the user is controlling, in flow order:
// visual → send-side cluster → receive-side cluster → presence → admin →
// personal → meta. Sidebar renders top-to-bottom; the first category is also
// the redirect target when navigating to bare /settings.
export const CATEGORIES: readonly SettingCategory[] = Object.freeze([
  // Bespoke only for the leading Themes section (AppearancePane.vue); the
  // registry rows still render beneath it via the embedded RegistryPane.
  { id: 'appearance', label: 'Appearance', kind: 'bespoke' },
  { id: 'chat', label: 'Chat', kind: 'registry' },
  // Everything about join/part/quit/nick/host-change/mode lines: whether you see
  // them at all, how they're folded, and how much detail each carries. Split out
  // of Chat (#666) because the tier turned three loosely-related groups into one
  // subject with a single primary control, and that subject is big enough to
  // stop being a tail on a category about composing and reading messages.
  { id: 'events', label: 'Events', kind: 'registry' },
  { id: 'input', label: 'Input bar', kind: 'registry' },
  // Bespoke: the pane leads with the configured-uploader list + picker (which is
  // table-backed, not registry-backed) and renders the surviving registry rows
  // for the image pipeline underneath it.
  { id: 'uploads', label: 'Uploads', kind: 'bespoke' },
  { id: 'notifications', label: 'Notifications', kind: 'bespoke' },
  { id: 'highlights', label: 'Highlights', kind: 'bespoke' },
  { id: 'ignores', label: 'Ignores', kind: 'bespoke' },
  { id: 'away', label: 'Away', kind: 'registry' },
  { id: 'networks', label: 'Networks', kind: 'bespoke' },
  { id: 'account', label: 'Account', kind: 'bespoke' },
  // Disabled in node edition: bearer clients can't be routed through the
  // per-cell proxy, so the server doesn't mount /api/api-tokens or /mcp there
  // (A7). Hide the whole category in the hosted edition.
  { id: 'api-tokens', label: 'API tokens', kind: 'bespoke', selfHostedOnly: true },
  { id: 'data', label: 'Data', kind: 'bespoke' },
  { id: 'about', label: 'About', kind: 'bespoke' },
]);

// Sub-group labels used inside a category pane (one heading per `group` field
// in REGISTRY). Groups without an entry here fall back to the raw group id.
export const GROUPS: Readonly<Record<string, string>> = Object.freeze({
  fonts: 'Fonts',
  palette: 'Colors',
  messages: 'Message rows',
  members: 'Member prefixes',
  'buffer-list': 'Buffer list',
  nicks: 'Nick coloring',
  layout: 'Layout',
  misc: 'Misc',
  'event-filter': 'Filter',
  consolidate: 'Consolidation',
  composing: 'Composing',
  'smart-filter': 'Smart filter tuning',
  connection: 'Connection',
  ctcp: 'CTCP replies',
  'auto-away': 'Auto-away',
  pipeline: 'Image pipeline',
  viewing: 'Viewing',
  alerts: 'Alerts',
  push_filters: 'Push filters',
  system_features: 'System text features',
  autocomplete: 'Autocomplete',
  formatting: 'Formatting',
  locale: 'Locale',
  retention: 'Retention',
});
