// Mirror of server/services/settingsRegistry.js — keep entries in sync.
// The server validates writes against its copy; this file drives the UI and
// supplies defaults during initial paint (before /api/settings/bootstrap returns).

export const REGISTRY = Object.freeze([
  // ─── Fonts ─────────────────────────────────────────────────────────────
  {
    key: 'look.font.family',
    type: 'string',
    default: "'Input Mono', 'Input', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    description:
      'Font family stack used everywhere in the UI. The first installed font wins. ' +
      'Input Mono is the intended primary; the rest are system monospace fallbacks.',
  },
  {
    key: 'look.font.size',
    type: 'int',
    min: 9,
    max: 32,
    default: 14,
    description: 'Base font size in pixels for the whole UI.',
  },
  {
    key: 'look.font.weight',
    type: 'int',
    min: 100,
    max: 900,
    default: 500,
    description:
      'Default font weight (100–900, in CSS steps of 100). ' +
      "Bumped above 400 to roughly match terminals' visual density on macOS, " +
      'where browsers no longer apply subpixel antialiasing. ' +
      'Set 400 if your font lacks a Medium face.',
  },

  // ─── Core palette (Monokai Pro / Brad's iTerm theme) ───────────────────
  {
    key: 'look.color.bg',
    type: 'color',
    default: '#212022',
    description: "Window background (every region uses this, like a CLI app).",
  },
  {
    key: 'look.color.bg_soft',
    type: 'color',
    default: '#2c2a2e',
    description: 'Slightly raised background used for hover and active-buffer highlight.',
  },
  {
    key: 'look.color.fg',
    type: 'color',
    default: '#fcfcfa',
    description: 'Default foreground / text color.',
  },
  {
    key: 'look.color.fg_muted',
    type: 'color',
    default: '#939293',
    description: 'Muted text (timestamps, system events, secondary labels).',
  },
  {
    key: 'look.color.accent',
    type: 'color',
    default: '#a99dec',
    description: 'Primary accent (links, logo, active-buffer indicator, focused borders).',
  },
  {
    key: 'look.color.good',
    type: 'color',
    default: '#b3db82',
    description: 'Positive / connected state.',
  },
  {
    key: 'look.color.warn',
    type: 'color',
    default: '#f9d978',
    description: 'Warning / in-progress state (connecting, modified setting marker).',
  },
  {
    key: 'look.color.bad',
    type: 'color',
    default: '#ed6c89',
    description: 'Error / disconnected / destructive state.',
  },
  {
    key: 'look.color.border',
    type: 'color',
    default: '#38353b',
    description: 'Subtle horizontal/vertical separators between regions.',
  },

  // ─── Alternating message rows ─────────────────────────────────────────
  {
    key: 'look.color.message.alt_bg',
    type: 'color',
    default: 'var(--bg)',
    description:
      'Background applied to every other message line in chat buffers, ' +
      'for visual separation. Set equal to look.color.bg to disable striping.',
  },
  {
    key: 'look.color.message.alt_fg',
    type: 'color',
    default: '#c4c4c4',
    description:
      'Foreground applied to every other message line in chat buffers. ' +
      'Defaults to a slightly dimmed foreground. Nick colors and ' +
      'inline-highlighted segments still override this.',
  },

  // ─── Member-list mode prefixes ────────────────────────────────────────
  {
    key: 'look.color.member.owner',
    type: 'color',
    default: '#ed6c89',
    description: 'Color for the ~ prefix (channel owner mode +q).',
  },
  {
    key: 'look.color.member.admin',
    type: 'color',
    default: '#fc9867',
    description: 'Color for the & prefix (channel admin mode +a).',
  },
  {
    key: 'look.color.member.op',
    type: 'color',
    default: '#a99dec',
    description: 'Color for the @ prefix (channel operator mode +o).',
  },
  {
    key: 'look.color.member.halfop',
    type: 'color',
    default: '#78dce8',
    description: 'Color for the % prefix (half-op mode +h).',
  },
  {
    key: 'look.color.member.voice',
    type: 'color',
    default: '#b3db82',
    description: 'Color for the + prefix (voiced mode +v).',
  },

  // ─── Nick coloring ────────────────────────────────────────────────────
  {
    key: 'look.nick.colors',
    type: 'string-list',
    default: [
      '#ff6188', '#fc9867', '#ffd866', '#a9dc76', '#78dce8', '#ab9df2',
      '#ed6c89', '#d4996e', '#f9d978', '#b3db82', '#91dae6', '#a99dec',
      '#ff7494', '#ffaf75', '#c4e29a', '#a0f1ff', '#b6aaff',
      '#7ba4ff', '#6799f3',
    ],
    description:
      "Palette of colors used to deterministically color other users' nicknames. " +
      'One entry per line; any CSS color value (hex, rgb(), var(--name)).',
  },
  {
    key: 'look.nick.self_color',
    type: 'color',
    default: 'var(--fg)',
    description:
      'Color used for your own nickname wherever it appears. ' +
      'Any CSS color value; defaults to your foreground color.',
  },
  {
    key: 'look.nick.color_stop_chars',
    type: 'string',
    default: '_|',
    description:
      'Trailing characters trimmed from nicknames before hashing for color selection, ' +
      "so 'amiantos__' colors the same as 'amiantos'.",
  },
  {
    key: 'look.nick.color_hash',
    type: 'enum',
    choices: ['djb2-32'],
    default: 'djb2-32',
    description: 'Hash algorithm used to map nicknames to palette colors.',
  },

  // ─── Misc look ────────────────────────────────────────────────────────
  {
    key: 'look.action.italic',
    type: 'bool',
    default: true,
    description: 'Render /me action messages in italics.',
  },
  {
    key: 'look.buffer.time_format',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Time format for the per-message timestamp column in chat buffers. ' +
      'Tokens: YYYY MM DD HH mm ss. Empty string hides the column.',
  },
  {
    key: 'look.bar.time_format',
    type: 'string',
    default: 'HH:mm',
    description:
      'Time format for the clock displayed in the status bar (above the input). ' +
      'Tokens: YYYY MM DD HH mm ss. Empty string hides the clock.',
  },

  // ─── Smart filter (join/part/quit/nick noise) ─────────────────────────
  {
    key: 'chat.smart_filter',
    type: 'bool',
    default: true,
    description:
      'Master switch for smart filtering of join/part/quit/nick noise. When enabled, ' +
      'these events are hidden for nicks that have not recently spoken in the channel.',
  },
  {
    key: 'chat.smart_filter_delay',
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
    type: 'bool',
    default: true,
    description: 'Apply smart filter to JOIN events.',
  },
  {
    key: 'chat.smart_filter_quit',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to PART and QUIT events.',
  },
  {
    key: 'chat.smart_filter_nick',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to NICK change events.',
  },
  {
    key: 'chat.smart_filter_join_unmask',
    type: 'int',
    min: 0,
    max: 1440,
    default: 30,
    description:
      'If a smart-filtered nick speaks within this many minutes after their JOIN, ' +
      'the JOIN line is revealed. 0 disables unmasking.',
  },

  // ─── Notifications ─────────────────────────────────────────────────────
  {
    key: 'notifications.enabled',
    type: 'bool',
    default: false,
    description:
      'Enable browser/system notifications for highlights and direct messages. ' +
      'When enabled, this device subscribes to Web Push so the server can wake it ' +
      'even when the tab is closed. Push only fires when no client of yours is visible.',
  },
]);

const BY_KEY = new Map(REGISTRY.map((opt) => [opt.key, opt]));

export function getOption(key) {
  return BY_KEY.get(key) || null;
}

export function defaultsAsObject() {
  const out = {};
  for (const opt of REGISTRY) out[opt.key] = opt.default;
  return out;
}

export function getDefault(key) {
  const opt = BY_KEY.get(key);
  return opt ? opt.default : undefined;
}
