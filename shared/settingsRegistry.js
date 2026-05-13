// Single source of truth for the settings registry, imported by both the
// server (which uses it to validate writes and seed defaults) and the client
// (which uses it to render the Settings UI and supply defaults during the
// initial paint before /api/settings/bootstrap returns). Each side adds its
// own helpers in a thin wrapper module — keep this file data-only.
//
// `category` + `group` drive the Settings UI sidebar and subheadings. The
// server ignores both fields; they exist purely so the client can build a
// table-of-contents layout without parsing key prefixes.

export const REGISTRY = Object.freeze([
  // ─── Fonts ─────────────────────────────────────────────────────────────
  {
    key: 'look.font.family',
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
    category: 'appearance',
    group: 'fonts',
    type: 'int',
    min: 9,
    max: 32,
    default: 14,
    description: 'Base font size in pixels for the whole UI.',
  },
  {
    key: 'look.font.weight',
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
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#212022',
    description: "Window background (every region uses this, like a CLI app).",
  },
  {
    key: 'look.color.bg_soft',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#2c2a2e',
    description: 'Slightly raised background used for hover and active-buffer highlight.',
  },
  {
    key: 'look.color.fg',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#fcfcfa',
    description: 'Default foreground / text color.',
  },
  {
    key: 'look.color.fg_muted',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#939293',
    description: 'Muted text (timestamps, system events, secondary labels).',
  },
  {
    key: 'look.color.accent',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#a99dec',
    description: 'Primary accent (logo, active-buffer indicator, focused borders).',
  },
  {
    key: 'look.color.link',
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
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#b3db82',
    description: 'Positive / connected state.',
  },
  {
    key: 'look.color.warn',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#f9d978',
    description: 'Warning / in-progress state (connecting, modified setting marker).',
  },
  {
    key: 'look.color.bad',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#ed6c89',
    description: 'Error / disconnected / destructive state.',
  },
  {
    key: 'look.color.border',
    category: 'appearance',
    group: 'palette',
    type: 'color',
    default: '#38353b',
    description: 'Subtle horizontal/vertical separators between regions.',
  },

  // ─── Alternating message rows ─────────────────────────────────────────
  {
    key: 'look.color.message.alt_bg',
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
    category: 'appearance',
    group: 'messages',
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
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#ed6c89',
    description: 'Color for the ~ prefix (channel owner mode +q).',
  },
  {
    key: 'look.color.member.admin',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#fc9867',
    description: 'Color for the & prefix (channel admin mode +a).',
  },
  {
    key: 'look.color.member.op',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#a99dec',
    description: 'Color for the @ prefix (channel operator mode +o).',
  },
  {
    key: 'look.color.member.halfop',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#78dce8',
    description: 'Color for the % prefix (half-op mode +h).',
  },
  {
    key: 'look.color.member.voice',
    category: 'appearance',
    group: 'members',
    type: 'color',
    default: '#b3db82',
    description: 'Color for the + prefix (voiced mode +v).',
  },

  // ─── Nick coloring ────────────────────────────────────────────────────
  {
    key: 'look.nick.colors',
    category: 'appearance',
    group: 'nicks',
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
    category: 'appearance',
    group: 'nicks',
    type: 'enum',
    choices: ['djb2-32'],
    default: 'djb2-32',
    description: 'Hash algorithm used to map nicknames to palette colors.',
  },

  // ─── Misc look ────────────────────────────────────────────────────────
  {
    key: 'look.action.italic',
    category: 'appearance',
    group: 'misc',
    type: 'bool',
    default: true,
    description: 'Render /me action messages in italics.',
  },
  {
    key: 'look.buffer.time_format',
    category: 'appearance',
    group: 'misc',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Time format for the per-message timestamp column in chat buffers. ' +
      'Tokens: YYYY MM DD HH mm ss. Empty string hides the column.',
  },
  {
    key: 'look.bar.time_format',
    category: 'appearance',
    group: 'misc',
    type: 'string',
    default: 'HH:mm:ss',
    description:
      'Time format for the clock displayed in the status bar (above the input). ' +
      'Tokens: YYYY MM DD HH mm ss. Empty string hides the clock.',
  },
  {
    key: 'look.bar.lag_min_show_ms',
    category: 'appearance',
    group: 'misc',
    type: 'int',
    min: 0,
    max: 60000,
    default: 500,
    description:
      'Minimum lag (in milliseconds) before the status-bar lag indicator appears. ' +
      'Below this threshold the indicator stays hidden. Modeled on weechat\'s ' +
      'irc.network.lag_min_show.',
  },
  {
    key: 'look.bar.lag_alarm_ms',
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
    category: 'appearance',
    group: 'layout',
    type: 'bool',
    default: true,
    description:
      'Show the channel members list on the right of the desktop layout. ' +
      'Turn off to reclaim horizontal space; a slim rail with a chevron ' +
      'remains so you can re-open it. Has no effect on mobile.',
  },

  // ─── Join/part consolidation (IRCCloud-style summary line) ────────────
  {
    key: 'chat.consolidate_joins',
    category: 'chat',
    group: 'consolidate',
    type: 'bool',
    default: true,
    description:
      'Merge consecutive join/part/quit/nick events into a single summary line ' +
      "per nick (e.g. \"Alice and Bob joined; Dave left; Eve → Eve_afk\"). " +
      'Off shows every event individually. Composes with smart filter — events ' +
      'the smart filter hides are excluded from the summary.',
  },
  {
    key: 'chat.consolidate_max_names',
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

  // ─── Smart filter (join/part/quit/nick noise) ─────────────────────────
  {
    key: 'chat.smart_filter',
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
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to JOIN events.',
  },
  {
    key: 'chat.smart_filter_quit',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to PART and QUIT events.',
  },
  {
    key: 'chat.smart_filter_nick',
    category: 'chat',
    group: 'smart-filter',
    type: 'bool',
    default: true,
    description: 'Apply smart filter to NICK change events.',
  },
  {
    key: 'chat.smart_filter_join_unmask',
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

  // ─── Auto-away (sets you AWAY when no client is connected) ────────────
  {
    key: 'away.auto.enabled',
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
    category: 'away',
    group: 'auto-away',
    type: 'int',
    min: 5,
    max: 3600,
    default: 300,
    description:
      'How long to wait after the last client disconnects before setting AWAY. ' +
      'Avoids flapping on browser refreshes or brief network blips.',
  },
  {
    key: 'away.auto.message',
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
    category: 'uploads',
    group: 'provider',
    type: 'enum',
    choices: ['x0', 'catbox', 'hoarder'],
    default: 'x0',
    description:
      'Where pasted/picked images are uploaded. x0.at and catbox.moe are ' +
      'anonymous public hosts. hoarder uploads to your own self-hosted ' +
      'Hoarder instance using the URL + API key configured below.',
  },
  {
    key: 'uploads.image.max_dimension',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 256,
    max: 8192,
    default: 2048,
    description:
      'Longest-edge limit for static images before they are re-encoded as JPEG. ' +
      'Animated GIF/WebP/APNG bypass this and are uploaded verbatim.',
  },
  {
    key: 'uploads.image.quality',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 30,
    max: 100,
    default: 85,
    description: 'JPEG quality for the re-encode pass on static images (30–100).',
  },
  {
    key: 'uploads.image.max_upload_mb',
    category: 'uploads',
    group: 'pipeline',
    type: 'int',
    min: 1,
    max: 200,
    default: 25,
    description:
      'Hard cap on the raw upload size in megabytes. Anything larger is ' +
      'rejected before the optimization pipeline runs.',
  },
  {
    key: 'uploads.paste.enabled',
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
    category: 'uploads',
    group: 'catbox',
    type: 'secret',
    default: '',
    description:
      'Optional catbox.moe account hash. Uploads made with a userhash can ' +
      'be managed from your catbox account; without one they are anonymous.',
  },
  {
    key: 'uploads.hoarder.url',
    category: 'uploads',
    group: 'hoarder',
    type: 'string',
    default: '',
    description:
      'Base URL of your Hoarder instance (e.g. https://upload.example.com). ' +
      'Only used when the upload provider is set to hoarder.',
  },
  {
    key: 'uploads.hoarder.api_key',
    category: 'uploads',
    group: 'hoarder',
    type: 'secret',
    default: '',
    description:
      'API key for your Hoarder instance. Generate one on the Hoarder server ' +
      'with `node scripts/gen-api-key.js` and add it to ' +
      'web.auth.api_keys in its config.json.',
  },

  // ─── In-client highlight notifications ────────────────────────────────
  // Push notifications cover the case where no client is visible. These
  // settings drive the in-client toast + sound that fire while you ARE
  // looking at Lurker, so an arriving highlight is impossible to miss.
  {
    key: 'notifications.highlight.toast.enabled',
    category: 'highlights',
    group: 'alerts',
    type: 'bool',
    default: true,
    description:
      'Show a corner toast when a new highlight arrives, even while a Lurker ' +
      'tab is visible (push notifications already cover the hidden-tab case).',
  },
  {
    key: 'notifications.highlight.sound.enabled',
    category: 'highlights',
    group: 'alerts',
    type: 'bool',
    default: false,
    description:
      'Play a short sound when a new highlight arrives in a buffer you are ' +
      'not currently looking at. Off by default — opt in if you want it.',
  },
  {
    key: 'notifications.highlight.sound.choice',
    category: 'highlights',
    group: 'alerts',
    type: 'enum',
    choices: ['ping', 'chime', 'pop', 'beep', 'knock'],
    default: 'ping',
    description:
      'Which bundled sound to play. Files live in /sounds/<choice>.mp3 on ' +
      'the client. Use the preview button in Settings to audition each one.',
  },
  {
    key: 'notifications.highlight.sound.volume',
    category: 'highlights',
    group: 'alerts',
    type: 'int',
    min: 0,
    max: 100,
    default: 60,
    description: 'Playback volume for the highlight sound, 0–100.',
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
