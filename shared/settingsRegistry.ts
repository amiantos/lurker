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

// ─── Constants ─────────────────────────────────────────────────────────────

/** The upload ceiling every install starts with, in MiB (#1131): the old hard
 *  cap, so nothing an admin never raised lets more through than before. (One
 *  deliberate move on upgrade: an account that never set its own cap used to
 *  get the 100 MB registry default and now gets the ceiling — see the
 *  uploads.image.max_upload_mb entry.) Lives here, import-free and on both
 *  sides, because the db layer and the hosted env reader both need it and
 *  can't share a server module. */
export const DEFAULT_UPLOAD_CEILING_MB = 200;

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
  requiresFeature?: FeatureFlag;

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

/** Integer settings, bounded below by `min` and, for all but a few, above by `max`.
 *  A setting whose ceiling the server decides at runtime (the upload cap, which
 *  an admin raises per instance) carries no `max`: the server advertises the
 *  bound and clamps a stored value above it at resolve time. */
export interface IntOption extends BaseOption {
  type: 'int';
  min: number;
  max?: number;
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
  // right answer for a choice whose ids are already the words.
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

/** An instance feature a settings surface depends on, as advertised by /api/config. */
export type FeatureFlag = 'linkPreviews' | 'bouncer' | 'dcc';

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
  // As on BaseOption: the category exists only where the instance runs the
  // feature behind it. A pane explaining a bouncer nobody runs is worse than none.
  requiresFeature?: FeatureFlag;
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
    default: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    description: 'Font stack for the whole UI. The first installed font wins.',
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
    description: 'Font size in pixels. Phone-width screens use the mobile size instead.',
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
    description: 'Font size in pixels on phone-width screens (768px and under).',
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
      'Font weight, 100–900 in steps of 100. Try 500 on macOS for a terminal-like ' + 'density.',
  },
  {
    key: 'look.font.smoothing_macos',
    label: 'Terminal-style font smoothing (macOS)',
    category: 'appearance',
    group: 'fonts',
    themed: true,
    type: 'bool',
    default: false,
    description: 'Subpixel antialiasing on macOS, for denser Terminal.app-style text.',
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
    description: 'Window background.',
  },
  {
    key: 'look.color.bg_soft',
    label: 'Soft background (hover / active)',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#2c2a2e',
    description: 'Background for hover and the active buffer.',
  },
  {
    key: 'look.color.fg',
    label: 'Foreground (text)',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#fcfcfa',
    description: 'Default text color.',
  },
  {
    key: 'look.color.fg_muted',
    label: 'Muted text',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#939293',
    description: 'Timestamps, events and secondary labels.',
  },
  {
    key: 'look.color.accent',
    label: 'Accent',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#a99dec',
    description: 'Logo, active-buffer indicator and focused borders.',
  },
  {
    key: 'look.color.link',
    label: 'Link color',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: 'var(--fg)',
    description: 'Links in chat messages.',
  },
  {
    key: 'look.color.good',
    label: 'Good / connected',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#b3db82',
    description: 'Connected and positive states.',
  },
  {
    key: 'look.color.warn',
    label: 'Warning',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#f9d978',
    description: 'In-progress states, and the marker on a modified setting.',
  },
  {
    key: 'look.color.bad',
    label: 'Error / disconnected',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#ed6c89',
    description: 'Errors, disconnected states and destructive actions.',
  },
  {
    key: 'look.color.border',
    label: 'Borders',
    category: 'appearance',
    group: 'palette',
    themed: true,
    type: 'color',
    default: '#38353b',
    description: 'Separators between regions.',
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
      'How mIRC color codes 0–15 render, one CSS color per line: white, black, ' +
      'navy, green, red, maroon, purple, orange, yellow, lime, teal, cyan, blue, ' +
      'magenta, gray, light gray. Use literal colors, not theme variables: text set ' +
      'to var(--bg) is invisible.',
  },

  {
    key: 'look.color.favorites',
    label: 'Favorite colors',
    category: 'appearance',
    group: 'palette',
    // Deliberately NOT themed: these are the user's own swatches, shown at the
    // bottom of the color picker so a colour chosen once can be picked again.
    // A theme is a snapshot of a look; a favourite is a bookmark, and it should
    // survive switching themes.
    type: 'string-list',
    default: [],
    description:
      'Colors starred in the color picker, one per line. Shown as swatches in every ' + 'picker.',
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
      'Background of every other message line. Set it to the window background for ' +
      'no striping.',
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
      'Text color of every other message line. Nick colors and highlights still ' + 'override it.',
  },
  // Empty, not var(--fg): an unset colour leaves your lines in the row's own
  // foreground, which on an alternating row is alt_fg (#1268).
  {
    key: 'look.color.message.self_fg',
    label: 'Your own message text',
    category: 'appearance',
    group: 'messages',
    themed: true,
    type: 'color',
    default: '',
    description: 'Text color of your own messages. Empty matches everyone else.',
  },

  // ─── Message layout, then the rest of Message rows ────────────────────
  {
    key: 'look.message.layout',
    label: 'Message layout',
    // `layout` is absent from CATEGORIES, as `avatars` is: the Appearance
    // pane's Message layout section draws this key and look.message.avatars
    // as one picker, so the registry pane leaves it alone. /set still reaches
    // both (COMMAND_CATEGORY_HOME).
    category: 'layout',
    group: 'message-layout',
    type: 'enum',
    choices: ['traditional', 'modern'],
    choiceLabels: {
      traditional: 'Traditional',
      modern: 'Modern',
    } as Readonly<Record<string, string>>,
    default: 'traditional',
    description:
      'Traditional is the three-column grid: time, nick, text. Modern puts nick and ' +
      'time on one line and the text below, with avatars if they are on. Modern ' +
      'always groups repeated authors and shows one time per group. Phone-width ' +
      'screens always use modern.',
  },
  {
    key: 'look.message.collapse_authors',
    label: 'Collapse repeated authors',
    category: 'appearance',
    group: 'messages',
    type: 'bool',
    default: false,
    description:
      'Hide the nick on consecutive messages from the same author. Traditional ' +
      'layout only, and only for plain messages; the modern layout always groups. A ' +
      'divider, or a gap longer than the collapse window, starts a new group.',
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
      'Longest gap, in minutes, between two messages that still group. 0 groups ' +
      'only messages with the same timestamp.',
  },
  {
    key: 'look.action.italic',
    label: 'Italicize /me actions',
    category: 'appearance',
    group: 'messages',
    type: 'bool',
    default: true,
    description: 'Show /me actions in italics.',
  },
  {
    key: 'look.message.hover_actions',
    label: 'Show hover action bar on messages',
    category: 'appearance',
    group: 'messages',
    type: 'bool',
    default: true,
    description:
      'Show the action bar (reply, quote, copy, bookmark, ignore) when hovering a ' +
      'message. Off, click a message for the same actions as a menu. Touch devices ' +
      'always use the menu.',
  },

  // ─── Modern layout density (#1186) ───────────────────────────────────
  // Themed like the fonts: how tight the rows sit is part of a look. The
  // phone apps, where compact is the default, are meant to read the same
  // three values (a Mobile: follow-up), so the units are ones a native
  // renderer applies without CSS: pixels, a percentage, and characters. The
  // ceilings are layout sanity for a phone's width, not policy. None of
  // these touch the standard layout.
  {
    key: 'look.message.modern.group_gap',
    label: 'Modern group gap (px)',
    category: 'appearance',
    group: 'modern-layout',
    themed: true,
    type: 'int',
    min: 0,
    max: 48,
    default: 10,
    description:
      'Space in pixels between message groups in the modern layout. 0 packs the ' +
      'buffer like a terminal.',
  },
  {
    key: 'look.message.modern.line_height',
    label: 'Modern line height (%)',
    category: 'appearance',
    group: 'modern-layout',
    themed: true,
    type: 'int',
    min: 100,
    max: 250,
    default: 155,
    description:
      'Line height of message text in the modern layout, as a percentage of the ' + 'font size.',
  },
  {
    key: 'look.message.modern.indent',
    label: 'Modern body indent (chars)',
    category: 'appearance',
    group: 'modern-layout',
    themed: true,
    type: 'int',
    min: 0,
    max: 8,
    default: 1,
    // Greyed out while avatars are on: the gutter is the indent then.
    dependsOn: [{ key: 'look.message.avatars', in: [false] }],
    description:
      'How far, in characters, message text sits in from the nick above it in the ' +
      'modern layout. Ignored while avatars are on.',
  },

  // ─── Timestamps ──────────────────────────────────────────────────────────
  {
    key: 'look.buffer.time_format',
    label: 'Message timestamp format',
    category: 'appearance',
    group: 'timestamps',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Format of the time column in chat buffers. Tokens: YYYY MM DD HH H hh h mm ' +
      'ss a A (hh and h are 12-hour, a and A are am/pm). Empty hides the column.',
  },
  {
    key: 'look.buffer.time_format_modern',
    label: 'Modern-layout timestamp format',
    category: 'appearance',
    group: 'timestamps',
    type: 'string',
    default: 'HH:mm',
    description:
      'Time format in the modern layout, which phones always use. Tokens: YYYY MM ' +
      'DD HH H hh h mm ss a A (hh and h are 12-hour, a and A are am/pm). Empty ' +
      'hides the time.',
  },
  {
    key: 'look.buffer.date_format_modern',
    label: 'Modern-layout date format',
    category: 'appearance',
    group: 'timestamps',
    type: 'string',
    default: 'YYYY-MM-DD',
    description:
      'In the modern layout, the date shown before the time on lines from another ' +
      'day. Same tokens as the time formats. Empty never shows a date.',
  },
  {
    key: 'look.message.collapse_timestamps',
    label: 'Collapse repeated timestamps',
    category: 'appearance',
    group: 'timestamps',
    type: 'bool',
    default: true,
    description:
      'Hide a timestamp that repeats the one on the row above. Traditional layout ' + 'only.',
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
    description: 'Mode +q, usually ~. Ranks a network adds above the usual five use it too.',
  },
  {
    key: 'look.color.member.admin',
    label: 'Admin prefix (&)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#fc9867',
    description: 'Mode +a, usually &.',
  },
  {
    key: 'look.color.member.op',
    label: 'Op prefix (@)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#a99dec',
    description: 'Mode +o, usually @.',
  },
  {
    key: 'look.color.member.halfop',
    label: 'Half-op prefix (%)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#78dce8',
    description: 'Mode +h, usually %.',
  },
  {
    key: 'look.color.member.voice',
    label: 'Voiced prefix (+)',
    category: 'appearance',
    group: 'members',
    themed: true,
    type: 'color',
    default: '#b3db82',
    description: 'Mode +v, usually +.',
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
    description: 'Rows with unread messages but no highlights.',
  },
  {
    key: 'look.color.buffer.highlight',
    label: 'Highlighted row color',
    category: 'appearance',
    group: 'buffer-list',
    themed: true,
    type: 'color',
    default: 'var(--warn)',
    description: 'Rows with highlights.',
  },
  {
    key: 'look.buffer_list.unread_bold',
    label: 'Bold unread rows',
    category: 'appearance',
    group: 'buffer-list',
    type: 'bool',
    default: false,
    description: 'Bold the names of rows with unread messages or highlights.',
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
      '"full" shows the highlight dot and an unread count. "highlights" shows the ' +
      'dot and a count of highlights only. "badge" shows only the dot. "off" shows ' +
      'neither.',
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
    description: "Colors given to other people's nicks, one CSS color per line.",
  },
  {
    key: 'look.nick.self_color',
    label: 'Your own nick color',
    category: 'appearance',
    group: 'nicks',
    themed: true,
    type: 'color',
    default: 'var(--fg)',
    description: 'Color of your own nick.',
  },
  {
    key: 'look.nick.color_stop_chars',
    label: 'Trailing characters to ignore',
    category: 'appearance',
    group: 'nicks',
    type: 'string',
    default: '_|',
    description:
      "Trailing characters ignored when picking a nick's color, so amiantos__ gets " +
      'the same color as amiantos.',
  },
  {
    key: 'look.nick.color_hash',
    label: 'Nick hash algorithm',
    category: 'appearance',
    group: 'nicks',
    type: 'enum',
    choices: ['djb2-32'],
    default: 'djb2-32',
    description: 'How a nick is mapped to a palette color.',
  },
  {
    key: 'look.nick.show_mode_prefix',
    label: 'Show mode prefix on nicks',
    category: 'appearance',
    group: 'nicks',
    type: 'bool',
    default: false,
    description:
      "Show a speaker's channel status (@ op, + voice, % halfop, ~ owner, & admin) " +
      'before their nick in the message list.',
  },
  {
    key: 'look.nick.mode_prefix_nick_color',
    label: 'Color mode prefix like the nick',
    category: 'appearance',
    group: 'nicks',
    type: 'bool',
    default: false,
    description:
      "Draw a mode prefix in its nick's color, in the member list and the " +
      'message list, instead of the Member prefixes colors.',
  },
  {
    key: 'look.nick.display_names',
    label: 'Show display names',
    category: 'appearance',
    group: 'nicks',
    type: 'bool',
    default: true,
    description:
      'On networks that support it, show the name a user set for themselves in ' +
      'place of their nick. The nick still shows on hover and in the profile, and ' +
      'mentions still match it.',
  },

  // ─── Status bar ──────────────────────────────────────────────────────────
  {
    key: 'look.bar.time_format',
    label: 'Status-bar clock format',
    category: 'appearance',
    group: 'status-bar',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Format of the status bar clock. Tokens: YYYY MM DD HH H hh h mm ss a A (hh ' +
      'and h are 12-hour, a and A are am/pm). Empty hides the clock.',
  },
  {
    key: 'look.bar.lag_min_show_ms',
    label: 'Lag indicator threshold (ms)',
    category: 'appearance',
    group: 'status-bar',
    type: 'int',
    min: 0,
    max: 60000,
    default: 500,
    description: 'Lag, in milliseconds, at which the lag indicator appears.',
  },
  {
    key: 'look.bar.lag_alarm_ms',
    label: 'Lag alarm threshold (ms)',
    category: 'appearance',
    group: 'status-bar',
    type: 'int',
    min: 0,
    max: 60000,
    default: 2000,
    description:
      'Lag, in milliseconds, at which the indicator turns red. Below that it shows ' +
      'in the warning color.',
  },
  {
    key: 'look.bar.lag_always_show',
    label: 'Always show lag value',
    category: 'appearance',
    group: 'status-bar',
    type: 'bool',
    default: false,
    description: 'Show the lag value even below the threshold.',
  },

  // ─── Panels (side panels and the modal backdrop, desktop) ────────────────
  {
    key: 'look.layout.show_channel_list',
    label: 'Show channel list (desktop)',
    category: 'appearance',
    group: 'panels',
    type: 'bool',
    default: true,
    description:
      'Show the channel list on the left. Off leaves a slim rail to reopen it. No ' +
      'effect on mobile.',
  },
  {
    key: 'look.layout.show_member_list',
    label: 'Show member list (desktop)',
    category: 'appearance',
    group: 'panels',
    type: 'bool',
    default: true,
    description:
      "Whether the member list shows by default. The toggle in each channel's topic " +
      'bar overrides this per channel. No effect on mobile.',
  },
  {
    key: 'look.modal.overlay',
    label: 'Modal backdrop (desktop)',
    category: 'appearance',
    group: 'panels',
    type: 'enum',
    choices: ['wordmark', 'dimmed', 'clear'],
    default: 'wordmark',
    description:
      '"wordmark" is the tiled-word wallpaper. "dimmed" darkens the chat behind the ' +
      'modal. "clear" leaves it untouched. No effect on mobile, where every modal ' +
      'is a full-screen sheet.',
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
      'How many join, part, quit, nick, host and mode events reach the message ' +
      'list. "Smart filter" shows them only for people who spoke recently. "Hide ' +
      'all" removes them. Kicks, topic changes and invites always show.',
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
      'The same choice for phone-width screens and the mobile apps. The settings ' +
      'below apply to both.',
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
      'Merge consecutive events into one summary line, such as "Alice and Bob ' +
      'joined; Dave left". Op and voice changes join the same line. Bans, keys, ' +
      'limits and channel flags keep their own line. With this off, a mode change is ' +
      'shown as its mode string, such as "set +v Alice".',
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
      'Most nicks named in each part of a summary line before the rest become "and ' +
      'N others". Recent speakers are named first.',
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
      'Show user@host beside the nick on join, part, quit and nick-change lines. ' +
      'Not shown in summary lines.',
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
      'Show the services (NickServ) account beside the nick on join lines, on ' +
      'networks with extended-join. Not shown in summary lines.',
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
      'How many minutes back counts as speaking recently. For an op or voice ' +
      'change, it is the person opped or voiced who must have spoken.',
  },
  {
    key: 'chat.smart_filter_join',
    label: 'Filter joins',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Hide joins from people who have not spoken recently.',
  },
  {
    key: 'chat.smart_filter_quit',
    label: 'Filter parts and quits',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Hide parts and quits from people who have not spoken recently.',
  },
  {
    key: 'chat.smart_filter_nick',
    label: 'Filter nick changes',
    category: 'events',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    dependsOn: EVENTS_SMART,
    description: 'Hide nick changes from people who have not spoken recently.',
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
      'Hide op and voice changes for people who have not spoken recently. Bans, ' +
      'keys, limits and channel flags always show.',
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
      'Reveal a hidden join if that person speaks within this many minutes. 0 never ' + 'reveals.',
  },

  // ─── Composing (outgoing message guardrails) ─────────────────────────
  // A message longer than one IRC line (~430 bytes on most networks, by our
  // prefix and the target: shared/wireBudget) goes out as several PRIVMSGs on
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
      'Send long messages as several lines without asking. Off, a message that ' +
      'would split needs a second press of Send, and one that would split into ' +
      'three or more offers to upload as a file. /me actions never split.',
  },
  {
    key: 'chat.send_typing_notifications',
    label: 'Send typing notifications',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: true,
    description: 'Let others see when you are typing. You still see theirs either way.',
  },
  {
    key: 'chat.threads',
    label: 'Reply threads (experimental)',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: false,
    description:
      'Experimental. Replies leave the channel and open in a thread panel beside ' +
      'it. A line with replies shows how many. A thread reply counts as unread only ' +
      'when it mentions you or answers you.',
  },
  {
    key: 'chat.keep_position_on_send',
    label: 'Stay where you are when you send',
    category: 'chat',
    group: 'composing',
    type: 'bool',
    default: false,
    description:
      'Keep your scroll position when you send, instead of jumping to the newest ' +
      'message. Sending from a jumped-to point in history returns to the live ' +
      'conversation either way.',
  },
  {
    key: 'chat.jitsi_url',
    label: 'Jitsi server',
    category: 'chat',
    group: 'composing',
    type: 'string',
    default: '',
    description:
      "The Jitsi Meet server /jitsi uses, as a URL. Empty uses this server's " +
      'default, or meet.jit.si.',
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
      'Open links to images, video, audio and .txt files in a viewer instead of a ' +
      'new tab. Cmd/Ctrl-click always opens a new tab.',
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
      'Show linked images under the message. Your Lurker server fetches them, so ' +
      'the host never sees your device. Video and audio links get a card that opens ' +
      "the host's site.",
  },
  {
    key: 'chat.inline_media.hide_urls',
    label: 'Hide inline media URLs',
    category: 'chat',
    group: 'viewing',
    type: 'bool',
    default: true,
    description:
      'Hide the URL of a link shown as inline media. It stays available as a button ' +
      'in the viewer.',
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
      "Show a card with a page's title, description and thumbnail. Your Lurker " +
      'server fetches the page, so the site never sees your device. Nothing reaches ' +
      'a video host until you press play.',
  },

  // ─── Notices (#1174) ─────────────────────────────────────────────────────
  // WeeChat's irc.look.notice_as_pv, with its values: a notice to your nick
  // either makes a buffer for its sender, joins one that is open, or stays in
  // the server buffer. Read by the server where the notice is stored, so every
  // device shows it in the same place.
  {
    key: 'chat.notice_buffer',
    label: 'Where notices to you appear',
    category: 'chat',
    group: 'notices',
    type: 'enum',
    choices: ['private', 'auto', 'server'],
    // WeeChat's default, and what most clients do. Until 2.7.2 Lurker did
    // only what `private` does (#439).
    default: 'auto',
    description:
      'Where a notice sent to your nick appears: "private" is a buffer for its ' +
      'sender, "auto" that buffer if you have it open and the server buffer if ' +
      'not, "server" always the server buffer. A notice you send follows the same rule.',
  },

  // ─── Connection (drawn under the list in Settings → Networks) ────────────
  {
    key: 'chat.quit_message',
    label: 'Quit message',
    category: 'networks',
    group: 'connection',
    type: 'string',
    default: '',
    description:
      'What others see when you disconnect without giving /quit a message. Empty ' +
      "uses Lurker's version and project URL.",
  },

  // ─── Away ────────────────────────────────────────────────────────────────
  {
    key: 'away.all_networks',
    label: 'Scope away to all networks by default',
    category: 'away',
    group: 'away',
    type: 'bool',
    default: false,
    description:
      'Make /away and /back apply to every network. On, -one limits them to the ' +
      'current network. Off, -all reaches every network.',
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
      'Set you away on every network when no Lurker client is in front of you and ' +
      'no IRC client is attached through the bouncer, and clear it when one ' +
      'returns. A bouncer client that sent AWAY * does not count as attached.',
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
    description: 'Seconds to wait after the last client leaves before setting away.',
  },
  {
    key: 'away.auto.message',
    label: 'Auto-away message',
    category: 'away',
    group: 'auto-away',
    type: 'string',
    default: 'afk',
    description:
      'Your auto-away message. The time is appended, as in "afk since 2026-05-09 ' +
      '15:30:00-0500".',
  },

  // ─── CTCP auto-replies (what we disclose to the network on a CTCP query) ──
  // Lurker answers a few standard CTCP queries cell-side (so they work even with
  // no tab open). The per-type values are WeeChat-style reply TEMPLATES: the
  // text sent back, with ${...} placeholders expanded. An EMPTY template
  // disables that reply. Placeholders: ${name} (Lurker), ${version}, ${source}
  // (project URL), ${time} (server time), ${clientinfo} (the types still
  // answered), ${nick} (your nick). Defaults reproduce the standard replies.
  // PING isn't templated — it only echoes the asker's token — but the master
  // switch silences it too. While an IRC client is attached through the bouncer,
  // it answers each type whose setting is unchanged (#932, ctcp.ts).
  {
    key: 'ctcp.replies',
    label: 'Answer CTCP queries',
    category: 'ctcp',
    group: 'ctcp',
    type: 'bool',
    default: true,
    description:
      'Answer CTCP queries: VERSION, TIME, SOURCE, CLIENTINFO and PING. Off, Lurker ' +
      'answers none, and IRC clients attached through the bouncer are not sent ' +
      'them. On, an attached client answers each type whose reply you have not ' +
      'changed.',
  },
  {
    key: 'ctcp.msgbuffer',
    label: 'Where CTCP notices appear',
    category: 'ctcp',
    group: 'ctcp',
    type: 'enum',
    choices: ['server', 'system', 'private'],
    default: 'server',
    description:
      'Where incoming CTCP requests and unsolicited replies appear: "server" is the ' +
      'network\'s server buffer, "system" the system buffer, "private" a DM with the ' +
      'sender (or the channel it was sent to). Replies to your own /ctcp return to ' +
      'the buffer you sent from.',
  },
  {
    key: 'ctcp.version',
    label: 'CTCP VERSION reply',
    category: 'ctcp',
    group: 'ctcp',
    type: 'string',
    default: '${name} ${version}',
    description:
      'Reply to VERSION. Placeholders: ${name}, ${version}, ${source}, ${time}, ' +
      '${clientinfo}, ${nick}. Empty sends no reply. Unchanged, an IRC client ' +
      'attached through the bouncer answers instead, with "via Lurker <version>" ' +
      'added.',
  },
  {
    key: 'ctcp.time',
    label: 'CTCP TIME reply',
    category: 'ctcp',
    group: 'ctcp',
    type: 'string',
    default: '${time}',
    description: 'Reply to TIME. Same placeholders as VERSION. Empty sends no reply.',
  },
  {
    key: 'ctcp.source',
    label: 'CTCP SOURCE reply',
    category: 'ctcp',
    group: 'ctcp',
    type: 'string',
    default: '${source}',
    description: 'Reply to SOURCE. Same placeholders as VERSION. Empty sends no reply.',
  },
  {
    key: 'ctcp.clientinfo',
    label: 'CTCP CLIENTINFO reply',
    category: 'ctcp',
    group: 'ctcp',
    type: 'string',
    default: '${clientinfo}',
    description:
      'Reply to CLIENTINFO. ${clientinfo} is the list of types you answer. Same ' +
      'placeholders as VERSION. Empty sends no reply.',
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
      'Format static images are re-encoded to. WebP is smaller and keeps ' +
      'transparency. Use JPEG if a client or host mangles WebP. Animated images are ' +
      'uploaded untouched.',
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
      'Static images are scaled down to this many pixels on their longest edge. ' +
      'Animated images are uploaded untouched.',
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
      'Re-encode quality for static images, 30–100. Higher looks better and is ' + 'larger.',
  },
  {
    key: 'uploads.image.max_upload_mb',
    label: 'Max upload size (MB)',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    // No `max`: the bound is the instance ceiling the admin sets (#1131), which
    // the server advertises as `uploadCeilingBytes` and clamps to at resolve
    // time. 0 (the default) means "the ceiling", so raising the ceiling raises
    // every account that never set its own cap, the way the retention
    // ceilings work. Only a LOWER personal cap is a statement. This replaced a
    // default of 100, so on upgrade an untouched account moves from 100 MB to
    // the 200 MB ceiling: the issue's intent, not an accident.
    min: 0,
    default: 0,
    selfHostedOnly: true,
    description:
      "Largest file you can upload, in MB. 0 uses this server's ceiling, and a " +
      'value above the ceiling counts as it.',
  },
  {
    key: 'uploads.paste.enabled',
    label: 'Upload pasted files',
    category: 'uploads',
    group: 'pipeline',
    type: 'bool',
    default: true,
    description: 'Upload a pasted image and insert its link. Off, paste is text only.',
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
      'When a message matches one of your highlight rules. A toast if a tab is ' +
      'visible, a push if none is.',
  },
  {
    key: 'notifications.highlight.sound.enabled',
    label: 'Highlight sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description: 'Play a sound for highlights.',
  },
  {
    key: 'notifications.highlight.sound.choice',
    label: 'Highlight sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'ping',
    description: 'Which sound plays for highlights.',
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
    description: 'Volume of the highlight sound, 0–100.',
  },

  {
    key: 'notifications.dm.enabled',
    label: 'DM notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'When someone sends you a direct message. A toast if a tab is visible, a push ' +
      'if none is.',
  },
  {
    key: 'notifications.dm.sound.enabled',
    label: 'DM sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description: 'Play a sound for direct messages.',
  },
  {
    key: 'notifications.dm.sound.choice',
    label: 'DM sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'chime',
    description: 'Which sound plays for direct messages.',
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
    description: 'Volume of the direct message sound, 0–100.',
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
    description: 'A toast when someone in your Friends section comes online.',
  },
  {
    key: 'notifications.friend_online.sound.enabled',
    label: 'Friend online sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description: 'Play a sound when a friend comes online.',
  },
  {
    key: 'notifications.friend_online.sound.choice',
    label: 'Friend online sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'knock',
    description: 'Which sound plays when a friend comes online.',
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
    description: 'Volume of the friend-online sound, 0–100.',
  },

  {
    key: 'notifications.always_notify.enabled',
    label: 'Always-notify channel notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Every message in channels you set to always notify. A toast if a tab is ' +
      'visible, a push if none is.',
  },
  {
    key: 'notifications.always_notify.sound.enabled',
    label: 'Always-notify sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description: 'Play a sound for messages in always-notify channels.',
  },
  {
    key: 'notifications.always_notify.sound.choice',
    label: 'Always-notify sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'plink',
    description: 'Which sound plays for always-notify channels.',
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
    description: 'Volume of the always-notify sound, 0–100.',
  },

  {
    // Not a channel signal, so it has no dependency on the notify-always bell:
    // being removed from a channel is a thing that happened to YOU, and it is
    // worth hearing about wherever it happens (#968).
    key: 'notifications.kicked.enabled',
    label: 'Kick notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description: 'When you are kicked from a channel. A muted channel stays silent.',
  },
  {
    key: 'notifications.kicked.sound.enabled',
    label: 'Kick sound',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description: 'Play a sound when you are kicked.',
  },
  {
    key: 'notifications.kicked.sound.choice',
    label: 'Kick sound choice',
    category: 'notifications',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock', 'plink'],
    default: 'beep',
    description: 'Which sound plays when you are kicked.',
  },
  {
    key: 'notifications.kicked.sound.volume',
    label: 'Kick sound volume',
    category: 'notifications',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Volume of the kick sound, 0–100.',
  },

  {
    // The toast stays off there either way: the line is already on screen.
    // Each kind's own toggles still decide whether it makes a sound at all (#1411).
    key: 'notifications.viewed_buffer.sound',
    label: 'Play sounds for the active buffer',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: false,
    description:
      'Play notification sounds for the buffer on screen too. Off, a buffer you ' +
      'are looking at stays silent.',
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
      'No push from a network while you are manually /away on it. Auto-away does ' + 'not count.',
  },
  {
    key: 'notifications.push.quiet_hours.enabled',
    label: 'Push quiet hours',
    category: 'notifications',
    group: 'push_filters',
    type: 'bool',
    default: false,
    description: 'No push during quiet hours. Toasts still show.',
  },
  {
    key: 'notifications.push.quiet_hours.start',
    label: 'Quiet hours start',
    category: 'notifications',
    group: 'push_filters',
    type: 'string',
    default: '22:00',
    description:
      'Start of quiet hours, HH:MM in 24-hour time, in your timezone. A start later ' +
      'than the end wraps past midnight.',
  },
  {
    key: 'notifications.push.quiet_hours.end',
    label: 'Quiet hours end',
    category: 'notifications',
    group: 'push_filters',
    type: 'string',
    default: '07:00',
    description: 'End of quiet hours, HH:MM in 24-hour time, in your timezone.',
  },

  // ─── Input bar ────────────────────────────────────────────────────────
  // One group: six rows do not need three headings, and a pane with a lone
  // group draws none.
  //
  // System text features:
  // Each setting maps directly to an HTML attribute on the chat input
  // element. Defaults are all true so the input behaves like a normal text
  // field out of the box; users can disable any one independently (the most
  // common ask is autocapitalize, which mangles nicks and commands).
  {
    key: 'input.spellcheck',
    label: 'Spellcheck input',
    category: 'input',
    group: 'input-bar',
    type: 'bool',
    default: true,
    description: "Use the browser's spellchecker in the message box.",
  },
  {
    key: 'input.autocorrect',
    label: 'Autocorrect input',
    category: 'input',
    group: 'input-bar',
    type: 'bool',
    default: true,
    description:
      'Let the browser correct what you type. Off also stops it capitalizing the ' +
      'start of sentences.',
  },
  {
    key: 'input.autocorrect_force_mobile',
    label: 'Force autocorrect on mobile',
    category: 'input',
    group: 'input-bar',
    type: 'bool',
    default: false,
    description:
      'Keep autocorrect and sentence capitals on for touch devices, even with ' +
      'autocorrect off.',
  },

  // Autocomplete UI.
  {
    key: 'input.suggestion_strip_on_desktop',
    label: 'Use suggestion strip on desktop',
    category: 'input',
    group: 'input-bar',
    type: 'bool',
    default: false,
    description:
      'Show matching nicks in a strip above the message box as you type, instead of ' +
      'the @ popup.',
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
    group: 'input-bar',
    type: 'string',
    default: ':',
    description:
      'What follows a nick completed at the start of a line, as in "nick: ". Empty ' +
      'leaves just a space. Mid-line completions are unaffected.',
  },

  // Formatting.
  // Surfaces the mIRC palette popover for users who want to insert colour /
  // bold / italic / underline codes via mouse. The Cmd/Ctrl+B/I/U keyboard
  // shortcuts always work regardless of this toggle — this only controls the
  // icon's visibility in the input row.
  {
    key: 'input.show_format_button',
    label: 'Show formatting button',
    category: 'input',
    group: 'input-bar',
    type: 'bool',
    default: false,
    description:
      'Show the button that opens the color and formatting picker. Cmd/Ctrl+B, I ' +
      'and U work either way.',
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
      '"single" uses the active theme everywhere. "system" follows each device\'s ' +
      'light or dark setting.',
  },
  // ─── Avatars (#607) ─────────────────────────────────────────────────────
  // `avatars` is absent from CATEGORIES so the registry pane never renders
  // these; the Appearance pane does: the switch as one of the Message layout
  // section's looks, the pointer in the Avatars section beside the sets. The
  // pointer works like the theme pointers: the bundled ids are in
  // avatarTiles.ts, anything else is the id of a set the user uploaded.
  {
    key: 'look.message.avatars',
    label: 'Show avatars',
    category: 'avatars',
    group: 'sets',
    type: 'bool',
    default: false,
    description:
      'Show an avatar beside each author in the modern layout. People without one ' +
      'get a placeholder from the avatar set.',
  },
  {
    key: 'look.avatars.set',
    label: 'Avatar set',
    category: 'avatars',
    group: 'sets',
    type: 'string',
    default: 'initial',
    description:
      'Where placeholder avatars come from: "initial" is the first letter of the ' +
      'name, "plain" a silhouette, "ealain" the bundled art, or the id of a set you ' +
      'uploaded.',
  },
  {
    key: 'look.theme.active',
    label: 'Active theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'dark',
    description:
      'The theme used when the mode is "single": "dark", "light" or the id of a ' + 'saved theme.',
  },
  {
    key: 'look.theme.light',
    label: 'Light-mode theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'light',
    description: 'The theme used in light mode when the mode is "system".',
  },
  {
    key: 'look.theme.dark',
    label: 'Dark-mode theme',
    category: 'theme',
    group: 'presets',
    type: 'string',
    default: 'dark',
    description: 'The theme used in dark mode when the mode is "system".',
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
      'IANA timezone, such as "America/Chicago", for times the server writes for ' +
      'you, like the auto-away message. Your browser sets it automatically. Empty ' +
      "uses the server's time.",
  },
  {
    key: 'onboarding.look_answered',
    label: 'Onboarding look answered',
    category: 'system',
    group: 'onboarding',
    type: 'bool',
    default: false,
    description: 'Set once the first-run flow has asked how chat should look.',
  },
  {
    key: 'onboarding.completed',
    label: 'Onboarding completed',
    category: 'system',
    group: 'onboarding',
    type: 'bool',
    default: false,
    // Lives here, not in localStorage, so it follows the user across devices.
    // Must default to false: settingsService drops any row whose value equals
    // the registry default, so a true default would be unstorable.
    description: 'Set once the first-run flow is finished or skipped.',
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
      'Each buffer keeps this many lines; older ones are deleted permanently. 0 ' +
      'keeps everything, up to any limit this server sets. The smallest limit is ' +
      '1,000. Bookmarked messages are never deleted.',
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
      'Joins, parts, quits, nick and mode changes and other server noise are ' +
      'deleted permanently after this many hours. 0 keeps them as long as messages. ' +
      'The smallest limit is 24.',
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
      'Closed buffers are deleted, history included, after this many days. 0 keeps ' +
      'them. The smallest limit is 7. A buffer holding a bookmark is never deleted.',
  },
  // ─── /sheep ───────────────────────────────────────────────────────────
  // The undocumented /sheep (the 1995 eSheep screen mate, run from the gSheep
  // pets under vue_client/public/sheep). Synced like any setting so the same
  // flock walks every desktop PWA. The category is deliberately absent from
  // CATEGORIES: these never show in the settings pane or /set — the command
  // and a sheep's right-click menu are their only surface.
  {
    key: 'sheep.flock',
    label: 'Sheep on screen',
    category: 'sheep',
    group: 'flock',
    type: 'string-list',
    // One entry per sheep, "<id>:<color>", in spawn order (a legacy third
    // ":<name>" field still parses and is ignored). Shooing a
    // sheep removes its entry; every client reconciles its own sheep to the list.
    default: [],
    description: 'The sheep walking around, one "<id>:<color>" entry each, in spawn order.',
  },
  {
    key: 'sheep.sounds',
    label: 'Sheep sounds',
    category: 'sheep',
    group: 'flock',
    type: 'bool',
    default: true,
    description: 'Whether the sheep make their noises.',
  },
  {
    key: 'sheep.scale',
    label: 'Sheep size',
    category: 'sheep',
    group: 'flock',
    type: 'int',
    min: 1,
    max: 3,
    default: 1,
    description: 'Pixel scale of the sheep: 1 is the original 40px, 2 and 3 are bigger.',
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
  // Command aliases (#276): table-backed, like the two above.
  { id: 'aliases', label: 'Aliases', kind: 'bespoke' },
  { id: 'away', label: 'Away', kind: 'registry' },
  // What Lurker answers when someone queries your client. Out of Chat, where
  // it was six rows about neither reading nor composing.
  { id: 'ctcp', label: 'CTCP', kind: 'registry' },
  // Bespoke for the network order; the quit message is a registry row embedded
  // beneath it (the Uploads pattern).
  { id: 'networks', label: 'Networks', kind: 'bespoke' },
  // How to attach an IRC client to this instance's bouncer. Self-hosted only
  // (a hosted cell runs no bouncer), and only where the operator enabled it.
  {
    id: 'bouncer',
    label: 'Bouncer',
    kind: 'bespoke',
    selfHostedOnly: true,
    requiresFeature: 'bouncer',
  },
  // What DCC does for this account: which parts it has, where received files
  // land and the limits the operator set. Only where the instance runs DCC; the
  // pane itself says when this account hasn't been granted any of it.
  {
    id: 'dcc',
    label: 'DCC',
    kind: 'bespoke',
    selfHostedOnly: true,
    requiresFeature: 'dcc',
  },
  { id: 'account', label: 'Account', kind: 'bespoke' },
  // Disabled in node edition: an API token can't be routed through the per-cell
  // proxy, so the server doesn't mount /api/api-tokens there (A7). Hide the whole
  // category in the hosted edition.
  { id: 'api-tokens', label: 'API tokens', kind: 'bespoke', selfHostedOnly: true },
  // Apps approved through OAuth sign-in (#891), in both editions.
  { id: 'authorized-apps', label: 'Authorized apps', kind: 'bespoke' },
  { id: 'data', label: 'Data', kind: 'bespoke' },
  { id: 'about', label: 'About', kind: 'bespoke' },
]);

// Categories a bespoke section draws by hand, so they are absent from
// CATEGORIES and the registry panes skip them, but whose keys are ordinary
// settings a user may still type: /set, /get and the /set listing treat each
// as part of the category named here. (`theme` and `system` are absent from
// both: pointers and flags the app writes, not settings.)
export const COMMAND_CATEGORY_HOME: Readonly<Record<string, string>> = Object.freeze({
  layout: 'appearance',
  avatars: 'appearance',
});

// Sub-group labels used inside a category pane (one heading per `group` field
// in REGISTRY). Groups without an entry here fall back to the raw group id.
export const GROUPS: Readonly<Record<string, string>> = Object.freeze({
  fonts: 'Fonts',
  palette: 'Colors',
  messages: 'Message rows',
  'modern-layout': 'Modern layout',
  timestamps: 'Timestamps',
  members: 'Member prefixes',
  'buffer-list': 'Buffer list',
  nicks: 'Nick coloring',
  'status-bar': 'Status bar',
  panels: 'Panels',
  'event-filter': 'Filter',
  consolidate: 'Consolidation',
  composing: 'Composing',
  'input-bar': 'Input bar',
  'smart-filter': 'Smart filter tuning',
  connection: 'Connection',
  away: 'Away',
  ctcp: 'CTCP replies',
  'auto-away': 'Auto-away',
  pipeline: 'Image pipeline',
  viewing: 'Viewing',
  notices: 'Notices',
  alerts: 'Alerts',
  push_filters: 'Push filters',
  locale: 'Locale',
  retention: 'Retention',
});
