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
  adminOnly?: boolean;
  // As on BaseOption: hide the whole category in the hosted (node) edition.
  selfHostedOnly?: boolean;
}

export const REGISTRY: readonly SettingOption[] = Object.freeze([
  // ─── Fonts ─────────────────────────────────────────────────────────────
  {
    key: 'look.font.family',
    label: 'Font family',
    category: 'appearance',
    group: 'fonts',
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
    type: 'color',
    default: '#212022',
    description: 'Window background (every region uses this, like a CLI app).',
  },
  {
    key: 'look.color.bg_soft',
    label: 'Soft background (hover / active)',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#2c2a2e',
    description: 'Slightly raised background used for hover and active-buffer highlight.',
  },
  {
    key: 'look.color.fg',
    label: 'Foreground (text)',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#fcfcfa',
    description: 'Default foreground / text color.',
  },
  {
    key: 'look.color.fg_muted',
    label: 'Muted text',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#939293',
    description: 'Muted text (timestamps, system events, secondary labels).',
  },
  {
    key: 'look.color.accent',
    label: 'Accent',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#a99dec',
    description: 'Primary accent (logo, active-buffer indicator, focused borders).',
  },
  {
    key: 'look.color.link',
    label: 'Link color',
    category: 'appearance',
    group: 'palette',
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
    type: 'color',
    default: '#b3db82',
    description: 'Positive / connected state.',
  },
  {
    key: 'look.color.warn',
    label: 'Warning',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#f9d978',
    description: 'Warning / in-progress state (connecting, modified setting marker).',
  },
  {
    key: 'look.color.bad',
    label: 'Error / disconnected',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#ed6c89',
    description: 'Error / disconnected / destructive state.',
  },
  {
    key: 'look.color.border',
    label: 'Borders',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#38353b',
    description: 'Subtle horizontal/vertical separators between regions.',
  },
  {
    key: 'look.color.mirc_colors',
    label: 'mIRC color palette',
    category: 'appearance',
    group: 'palette',
    type: 'string-list',
    // 16 entries, one per mIRC color code 0..15. The chromatic slots default
    // to the closest hue from look.nick.colors so coloured chat text harmonises
    // with the rest of the theme; the four mono-ish slots (white, black, gray,
    // light gray) use theme variables so they stay legible on any background.
    default: [
      'var(--fg)', //                                       0  white
      'var(--bg)', //                                       1  black
      '#6799f3', //                                         2  navy
      '#a9dc76', //                                         3  green
      '#ff6188', //                                         4  red
      '#ed6c89', //                                         5  maroon
      '#ab9df2', //                                         6  purple
      '#fc9867', //                                         7  orange
      '#ffd866', //                                         8  yellow
      '#b3db82', //                                         9  lime
      '#78dce8', //                                         10 teal
      '#a0f1ff', //                                         11 cyan
      '#7ba4ff', //                                         12 blue
      '#ff7494', //                                         13 magenta
      'var(--fg-muted)', //                                 14 gray
      'color-mix(in srgb, var(--fg) 70%, transparent)', //  15 light gray
    ],
    description:
      'How the 16 mIRC color codes (0-15) render in chat. One CSS color per line, ' +
      'in order: white, black, navy, green, red, maroon, purple, orange, yellow, ' +
      'lime, teal, cyan, blue, magenta, gray, light gray. Defaults pick the ' +
      'closest hue from your nick palette so coloured text matches the rest of ' +
      'the theme. Any CSS color value works (hex, rgb(), var(--name), color-mix()).',
  },

  // ─── Alternating message rows ─────────────────────────────────────────
  {
    key: 'look.color.message.alt_bg',
    label: 'Alternating row background',
    category: 'appearance',
    group: 'messages',
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
    type: 'color',
    default: '#ed6c89',
    description: 'Color for the ~ prefix (channel owner mode +q).',
  },
  {
    key: 'look.color.member.admin',
    label: 'Admin prefix (&)',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#fc9867',
    description: 'Color for the & prefix (channel admin mode +a).',
  },
  {
    key: 'look.color.member.op',
    label: 'Op prefix (@)',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#a99dec',
    description: 'Color for the @ prefix (channel operator mode +o).',
  },
  {
    key: 'look.color.member.halfop',
    label: 'Half-op prefix (%)',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#78dce8',
    description: 'Color for the % prefix (half-op mode +h).',
  },
  {
    key: 'look.color.member.voice',
    label: 'Voiced prefix (+)',
    category: 'appearance',
    group: 'members',
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

  // ─── Join/part consolidation (IRCCloud-style summary line) ────────────
  {
    key: 'chat.consolidate_joins',
    label: 'Consolidate join/part/quit/nick events',
    category: 'chat',
    group: 'consolidate',
    type: 'bool',
    default: true,
    description:
      'Merge consecutive join/part/quit/nick events into a single summary line ' +
      'per nick (e.g. "Alice and Bob joined; Dave left; Eve → Eve_afk"). ' +
      'Off shows every event individually. Composes with smart filter — events ' +
      'the smart filter hides are excluded from the summary.',
  },
  {
    key: 'chat.consolidate_max_names',
    label: 'Max nicks per summary category',
    category: 'chat',
    group: 'consolidate',
    type: 'int',
    min: 1,
    max: 50,
    default: 5,
    description:
      'In each category (joined / left / reconnected / renamed) of a summary ' +
      'line, show at most this many nicks before collapsing the rest into ' +
      '"and N others". Recent speakers (those tracked for nick completion) ' +
      'are preferred when picking which names to show.',
  },
  {
    key: 'chat.show_event_host',
    label: 'Show user@host on join/part/quit/nick',
    category: 'chat',
    group: 'consolidate',
    type: 'bool',
    default: false,
    description:
      'Show the affected user’s user@host next to their nick on JOIN, PART, ' +
      'QUIT, and nick-change lines (e.g. "alice (~alice@host.example.net) ' +
      'joined") — useful for channel ops spotting ban masks. Applies to ' +
      'individual lines only; events that collapse into the consolidation ' +
      'summary above stay host-less. Regular chat messages are unaffected.',
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
      'until you press Send a second time. Messages that would split into ' +
      'three or more lines always require confirmation regardless of this ' +
      'setting. /me actions never split — they are blocked outright.',
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

  // ─── Smart filter (join/part/quit/nick noise) ─────────────────────────
  {
    key: 'chat.smart_filter',
    label: 'Smart filter (hide noise from quiet users)',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: false,
    description:
      'Master switch for smart filtering of join/part/quit/nick noise. When enabled, ' +
      'these events are hidden for nicks that have not recently spoken in the channel. ' +
      'Off by default — the consolidation summary line above is usually a better fit, ' +
      'but turn this on to also hide events for nicks who never chat.',
  },
  {
    key: 'chat.smart_filter_delay',
    label: '"Recently spoke" window (minutes)',
    category: 'chat',
    group: 'smart-filter',
    type: 'int',
    min: 0,
    max: 1440,
    default: 5,
    description:
      'Window in minutes for "recently spoke". A join/part/quit/nick event is hidden ' +
      'if the affected nick has not posted a message within this many minutes before ' +
      'the event.',
  },
  {
    key: 'chat.smart_filter_join',
    label: 'Filter joins',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to JOIN events.',
  },
  {
    key: 'chat.smart_filter_quit',
    label: 'Filter parts and quits',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to PART and QUIT events.',
  },
  {
    key: 'chat.smart_filter_nick',
    label: 'Filter nick changes',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to NICK change events.',
  },
  {
    key: 'chat.smart_filter_join_unmask',
    label: 'Reveal join when user speaks (minutes)',
    category: 'chat',
    group: 'smart-filter',
    type: 'int',
    min: 0,
    max: 1440,
    default: 30,
    description:
      'If a smart-filtered nick speaks within this many minutes after their JOIN, ' +
      'the JOIN line is revealed. 0 disables unmasking.',
  },

  // ─── Inline image viewer ──────────────────────────────────────────────
  {
    key: 'chat.image_modal.enabled',
    label: 'Image viewer',
    category: 'chat',
    group: 'viewing',
    type: 'bool',
    default: true,
    description:
      'When enabled, clicking a URL to an image opens it in an in-app viewer instead ' +
      'of a new browser tab. Cmd/Ctrl-click always opens in a new tab.',
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

  // ─── Image uploads ────────────────────────────────────────────────────
  {
    key: 'uploads.provider',
    label: 'Upload provider',
    category: 'uploads',
    group: 'provider',
    type: 'enum',
    choices: ['x0', 'catbox', 'hoarder'],
    default: 'x0',
    // Node edition forces the operator's in-house uploader (A8); a tenant never
    // picks a host, so this and the provider-credential settings below are
    // hidden in the hosted edition.
    selfHostedOnly: true,
    description:
      'Where pasted/picked images are uploaded. x0.at and catbox.moe are ' +
      'anonymous public hosts. hoarder uploads to your own self-hosted ' +
      'Hoarder instance using the URL + API key configured below.',
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
      'Longest-edge limit for static images before they are re-encoded as JPEG. ' +
      'Animated GIF/WebP/APNG bypass this and are uploaded verbatim.',
  },
  {
    key: 'uploads.image.quality',
    label: 'JPEG re-encode quality',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 30,
    max: 100,
    default: 85,
    selfHostedOnly: true,
    description: 'JPEG quality for the re-encode pass on static images (30–100).',
  },
  {
    key: 'uploads.image.max_upload_mb',
    label: 'Max upload size (MB)',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 1,
    max: 200,
    default: 25,
    selfHostedOnly: true,
    description:
      'Hard cap on the raw upload size in megabytes. Anything larger is ' +
      'rejected before the optimization pipeline runs.',
  },
  {
    key: 'uploads.paste.enabled',
    label: 'Upload pasted images',
    category: 'uploads',
    group: 'pipeline',
    type: 'bool',
    default: true,
    description:
      'When enabled, pasting an image into the input area uploads it and ' +
      'inserts the resulting URL. Disable to fall back to plain text paste.',
  },
  {
    key: 'uploads.catbox.userhash',
    label: 'Catbox userhash',
    category: 'uploads',
    group: 'catbox',
    type: 'secret',
    default: '',
    selfHostedOnly: true,
    description:
      'Optional catbox.moe account hash. Uploads made with a userhash can ' +
      'be managed from your catbox account; without one they are anonymous.',
  },
  {
    key: 'uploads.hoarder.url',
    label: 'Hoarder URL',
    category: 'uploads',
    group: 'hoarder',
    type: 'string',
    default: '',
    selfHostedOnly: true,
    description:
      'Base URL of your Hoarder instance (e.g. https://upload.example.com). ' +
      'Only used when the upload provider is set to hoarder.',
  },
  {
    key: 'uploads.hoarder.api_key',
    label: 'Hoarder API key',
    category: 'uploads',
    group: 'hoarder',
    type: 'secret',
    default: '',
    selfHostedOnly: true,
    description:
      'API key for your Hoarder instance. Generate one on the Hoarder server ' +
      'with `node scripts/gen-api-key.js` and add it to ' +
      'web.auth.api_keys in its config.json.',
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
    key: 'notifications.friend_online.enabled',
    label: 'Friend online notifications',
    category: 'notifications',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Toast me when a friend I have flagged "notify when online" comes online. ' +
      'The per-friend toggle (in the Configure Friend dialog) is the opt-in; this ' +
      'is the global master.',
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

  // ─── Fserve (DCC-CHAT file server) ────────────────────────────────────────
  // Self-host only, and additionally gated server-side on LURKER_FSERVE_ENABLED
  // + LURKER_FSERVE_DIR + DCC being enabled. These are the per-user policy knobs.
  {
    key: 'fserve.enabled',
    label: 'Run an fserve',
    category: 'fserve',
    group: 'fserve',
    type: 'bool',
    default: false,
    selfHostedOnly: true,
    description:
      'Serve your archive over DCC CHAT: peers open a session and browse with ' +
      'dir/cd/get, downloading files over DCC. Requires the operator to set ' +
      'LURKER_FSERVE_ENABLED + LURKER_FSERVE_DIR and to have DCC enabled for you.',
  },
  {
    key: 'fserve.trigger',
    label: 'Trigger word',
    category: 'fserve',
    group: 'fserve',
    type: 'string',
    default: '',
    selfHostedOnly: true,
    description:
      'A word that opens your fserve when someone /msgs it to you (e.g. "!files"). ' +
      'A CTCP FSERVE always works too. Leave blank to allow only CTCP FSERVE.',
  },
  {
    key: 'fserve.access',
    label: 'Access',
    category: 'fserve',
    group: 'fserve',
    type: 'enum',
    choices: ['open', 'allowlist', 'password'],
    default: 'open',
    selfHostedOnly: true,
    description:
      'open = anyone who triggers it; allowlist = only nicks/hostmasks below; ' +
      'password = the session prompts for the password below.',
  },
  {
    key: 'fserve.password',
    label: 'Fserve password',
    category: 'fserve',
    group: 'fserve',
    type: 'secret',
    default: '',
    selfHostedOnly: true,
    description: 'Required on connect when Access is "password". Share it with allowed users.',
  },
  {
    key: 'fserve.allowlist',
    label: 'Allowlist (nicks / hostmasks)',
    category: 'fserve',
    group: 'fserve',
    type: 'string-list',
    default: [],
    selfHostedOnly: true,
    description:
      'Used when Access is "allowlist". Each entry is a nick or a nick!user@host ' +
      'glob (* and ? wildcards); a bare nick matches that nick from any host.',
  },
  {
    key: 'fserve.welcome',
    label: 'Welcome message',
    category: 'fserve',
    group: 'fserve',
    type: 'string',
    default: '',
    selfHostedOnly: true,
    description: 'Shown to a peer when their session opens (before the prompt). Optional.',
  },
  {
    key: 'fserve.max_sessions',
    label: 'Max concurrent sessions',
    category: 'fserve',
    group: 'fserve',
    type: 'int',
    min: 1,
    max: 20,
    default: 3,
    selfHostedOnly: true,
    description: 'How many peers can browse your fserve at once. Extras are turned away.',
  },
  {
    key: 'fserve.ad_channel',
    label: 'Ad channel',
    category: 'fserve',
    group: 'fserve-ads',
    type: 'string',
    default: '',
    selfHostedOnly: true,
    description:
      'A channel to periodically advertise your fserve in (e.g. #warez). Blank = no ads.',
  },
  {
    key: 'fserve.ad_message',
    label: 'Ad message',
    category: 'fserve',
    group: 'fserve-ads',
    type: 'string',
    default: '',
    selfHostedOnly: true,
    description: 'The line posted to the ad channel (e.g. "/msg me !files for my archive").',
  },
  {
    key: 'fserve.ad_interval',
    label: 'Ad interval (minutes)',
    category: 'fserve',
    group: 'fserve-ads',
    type: 'int',
    min: 0,
    max: 1440,
    default: 0,
    selfHostedOnly: true,
    description: 'How often to post the ad. 0 disables ads. Minimum 1 minute when enabled.',
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
  { id: 'appearance', label: 'Appearance', kind: 'registry' },
  { id: 'chat', label: 'Chat', kind: 'registry' },
  { id: 'input', label: 'Input bar', kind: 'registry' },
  { id: 'uploads', label: 'Uploads', kind: 'registry' },
  { id: 'notifications', label: 'Notifications', kind: 'bespoke' },
  { id: 'highlights', label: 'Highlights', kind: 'bespoke' },
  { id: 'ignores', label: 'Ignores', kind: 'bespoke' },
  { id: 'away', label: 'Away', kind: 'registry' },
  { id: 'users', label: 'Users', kind: 'bespoke', adminOnly: true },
  { id: 'networks', label: 'Networks', kind: 'bespoke' },
  { id: 'account', label: 'Account', kind: 'bespoke' },
  // Disabled in node edition: bearer clients can't be routed through the
  // per-cell proxy, so the server doesn't mount /api/api-tokens or /mcp there
  // (A7). Hide the whole category in the hosted edition.
  { id: 'api-tokens', label: 'API tokens', kind: 'bespoke', selfHostedOnly: true },
  { id: 'fserve', label: 'File server', kind: 'registry', selfHostedOnly: true },
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
  consolidate: 'Join/part consolidation',
  composing: 'Composing',
  'smart-filter': 'Smart filter',
  connection: 'Connection',
  ctcp: 'CTCP replies',
  'auto-away': 'Auto-away',
  provider: 'Provider',
  pipeline: 'Image pipeline',
  viewing: 'Viewing',
  catbox: 'catbox.moe',
  hoarder: 'Hoarder',
  alerts: 'Alerts',
  push_filters: 'Push filters',
  system_features: 'System text features',
  autocomplete: 'Autocomplete',
  formatting: 'Formatting',
  locale: 'Locale',
  fserve: 'File server',
  'fserve-ads': 'Advertising',
});
