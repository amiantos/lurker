// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The slash-command table (#533): what every command is called, where it files,
// what it does, and the grammar of its arguments. One source for the completion
// popover, the chip strip and the `/commands` cheatsheet.
//
// It describes commands; it does not run them. `handleCommand` in
// MessageInput.vue is still the dispatcher, and is typed against `CommandVerb`
// so a verb can't be in one and missing from the other. The same split the
// mobile apps keep between `CommandRegistry` and `CommandParser`, and the
// grammar here is theirs, widened: flags are a set rather than a position, and
// a slot can name a fixed list or a live one (setting keys, theme names).

import { CANONICAL_ORDER } from '../../../../shared/ignoreLevels.js';
import { SHEEP_COLORS } from '../sheep/colors.js';

/** How a command groups in `/commands` and under a bare `/`. */
export const COMMAND_CATEGORIES = [
  'Messaging',
  'Channels',
  'Moderation',
  'Server',
  'Status',
  'App',
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/**
 * What an argument slot expects, which is what completion reads.
 *
 * - `channel` `nick`: completed from the buffers and the member list.
 * - `keyword`: a literal word that picks one of a command's forms (`chat` in
 *   `/dcc chat <nick>`). Completed from the forms themselves.
 * - `choice`: one of a fixed list carried on the slot (`values`).
 * - `setting` `settingValue` `theme` `network` `avatarSet`: live lists the
 *   composer supplies.
 * - `text` `word` `newNick`: nothing to suggest. Free text to the end of the
 *   line, one opaque token, and a value only you can supply.
 */
export type ArgKind =
  | 'channel'
  | 'nick'
  | 'keyword'
  | 'choice'
  | 'setting'
  | 'settingValue'
  | 'theme'
  | 'network'
  | 'avatarSet'
  | 'text'
  | 'word'
  | 'newNick';

export interface ArgSpec {
  /** What usage prints: `<label>`, `[label]`, or bare for a keyword. */
  readonly label: string;
  readonly kind: ArgKind;
  readonly optional?: boolean;
  /** Swallows the rest of the line: a message body, a reason, a run of nicks. */
  readonly rest?: boolean;
  /**
   * `choice`: the values offered. `keyword`: other spellings the parser takes
   * (`del`, `rm`), accepted when reading a line and never offered.
   */
  readonly values?: readonly string[];
}

/** An option that may appear anywhere after the verb: `-passive`, `-time <dur>`. */
export interface FlagSpec {
  readonly name: string;
  /** The label of the value it takes, when it takes one: `dur` in `-time <dur>`. */
  readonly takes?: string;
  readonly summary?: string;
}

/** One shape a command's arguments can take. Most commands have exactly one. */
export interface FormSpec {
  readonly args: readonly ArgSpec[];
  readonly flags?: readonly FlagSpec[];
  /** Its options are read only ahead of everything else: `/away -all brb`. */
  readonly flagsLead?: boolean;
  /**
   * A form with a summary is a thing of its own: its own row when its keyword
   * is completed, its own line in `/commands`. A form without one only teaches
   * the grammar a second word order (`/invite #chan nick`).
   */
  readonly summary?: string;
  /** Extra `/commands` lines under this form: options, examples. */
  readonly notes?: readonly string[];
}

export interface CommandSpec {
  /** Canonical name first, then aliases. No leading slash. */
  readonly names: readonly string[];
  readonly category: CommandCategory;
  readonly summary: string;
  readonly forms: readonly FormSpec[];
  /** Runs without a network, so the system buffer can issue it. */
  readonly networkAgnostic?: boolean;
  /** Extra `/commands` lines under the command: options, examples. */
  readonly notes?: readonly string[];
  /** Overrides the computed usage line, for a family too wide to print. */
  readonly usage?: string;
  /** Works, completes its arguments, and is listed nowhere. */
  readonly hidden?: boolean;
  /** Its handler reads quotes, so `"Libera Chat"` is one argument. */
  readonly quoted?: boolean;
}

// ── Builders ────────────────────────────────────────────────────────────────

type ArgOpts = Pick<ArgSpec, 'optional' | 'rest' | 'values'>;

function arg(label: string, kind: ArgKind, opts: ArgOpts = {}): ArgSpec {
  return { label, kind, ...opts };
}
const opt = (label: string, kind: ArgKind, opts: ArgOpts = {}): ArgSpec =>
  arg(label, kind, { ...opts, optional: true });
/** A literal word; `aliases` are spellings the parser also takes. */
const kw = (label: string, ...aliases: string[]): ArgSpec =>
  arg(label, 'keyword', aliases.length ? { values: aliases } : {});
/** One of a fixed list. The label is the list itself unless one is given. */
const choice = (values: readonly string[], opts: ArgOpts & { label?: string } = {}): ArgSpec => {
  const { label, ...rest } = opts;
  return arg(label ?? values.join('|'), 'choice', { ...rest, values });
};
const flag = (name: string, takes?: string, summary?: string): FlagSpec => ({
  name,
  ...(takes ? { takes } : {}),
  ...(summary ? { summary } : {}),
});

interface FormOpts {
  flags?: readonly FlagSpec[];
  summary?: string;
  notes?: readonly string[];
}
function form(args: readonly ArgSpec[], opts: FormOpts | string = {}): FormSpec {
  return { args, ...(typeof opts === 'string' ? { summary: opts } : opts) };
}

interface CmdOpts {
  args?: readonly ArgSpec[];
  flags?: readonly FlagSpec[];
  flagsLead?: boolean;
  forms?: readonly FormSpec[];
  networkAgnostic?: boolean;
  notes?: readonly string[];
  usage?: string;
  hidden?: boolean;
  quoted?: boolean;
}

// `const N` keeps each name a literal type, which is what lets the dispatcher's
// switch be checked against this table.
function cmd<const N extends readonly string[]>(
  names: N,
  category: CommandCategory,
  summary: string,
  opts: CmdOpts = {},
): CommandSpec & { readonly names: N } {
  const { args, flags, flagsLead, forms, ...rest } = opts;
  return {
    names,
    category,
    summary,
    forms: forms ?? [form(args ?? [], flags ? { flags, ...(flagsLead ? { flagsLead } : {}) } : {})],
    ...rest,
  };
}

// ── Shared pieces ───────────────────────────────────────────────────────────

const text = (label: string): ArgSpec => arg(label, 'text', { rest: true });
const optText = (label: string): ArgSpec => opt(label, 'text', { rest: true });
const NICK = arg('nick', 'nick');
const CHAN = arg('#chan', 'channel');
const NICKS = arg('nick', 'nick', { rest: true });
const REASON = optText('reason');

/** `/op bob` in a channel, or `/op #chan bob` from anywhere. */
const inChannel = (...args: ArgSpec[]): FormSpec[] => [form(args), form([CHAN, ...args])];

const AWAY_FLAGS = [
  flag('-all', undefined, 'every network'),
  flag('-one', undefined, 'just this one'),
];
const DCC_FLAGS = [
  flag('-passive', undefined, 'ask them to listen'),
  flag('-secure', undefined, 'over TLS'),
];
const E2E_MODES = ['auto', 'normal', 'quiet'] as const;
const NETWORK_FLAGS = [
  flag('-host', 'addr'),
  flag('-port', 'n'),
  flag('-tls'),
  flag('-notls'),
  flag('-nick', 'n'),
  flag('-user', 'u'),
  flag('-realname', 'name'),
  flag('-sasl_username', 'u'),
  flag('-sasl_password', 'p'),
  flag('-password', 'serverpass'),
  flag('-autosendcmd', "'cmds'"),
  flag('-channel', '#chan'),
  flag('-auto'),
  flag('-noauto'),
  flag('-flood'),
  flag('-noflood'),
];
const NET = arg('name', 'network');
const BOT = arg('bot', 'nick');
const ID = arg('id', 'word');

// ── The table ───────────────────────────────────────────────────────────────
// Order within a category is the order `/commands` prints.

export const COMMANDS = [
  // Messaging
  cmd(['me'], 'Messaging', 'emote in the current buffer', { args: [text('text')] }),
  cmd(['msg', 'query'], 'Messaging', 'open a DM and send', { args: [NICK, optText('text')] }),
  cmd(['notice'], 'Messaging', 'send a NOTICE to a channel or nick', {
    args: [arg('tgt', 'nick'), text('text')],
  }),
  cmd(['react'], 'Messaging', 'react to the last line someone else said here', {
    args: [text('emoji|text')],
  }),
  cmd(['delete'], 'Messaging', 'delete the last line you said here, where the network allows it', {
    args: [REASON],
  }),
  cmd(['slap'], 'Messaging', 'slap someone around a bit with a large trout', { args: [NICK] }),
  cmd(['shrug'], 'Messaging', 'say your text followed by ¯\\_(ツ)_/¯', { args: [optText('text')] }),
  cmd(['ctcp'], 'Messaging', 'CTCP query', {
    args: [
      NICK,
      choice(['VERSION', 'PING', 'TIME', 'CLIENTINFO', 'SOURCE'], { label: 'type' }),
      optText('args'),
    ],
  }),
  cmd(['ping'], 'Messaging', 'CTCP ping a user for round-trip latency', {
    args: [opt('nick', 'nick')],
  }),
  cmd(['accept'], 'Messaging', 'caller ID (+g): let nicks message you', {
    args: [opt('nick', 'nick', { rest: true })],
    notes: ['-nick removes; no argument lists'],
  }),
  cmd(['jitsi', 'talk'], 'Messaging', 'start a video call'),
  cmd(['dcc'], 'Messaging', 'DCC transfers and direct chats', {
    usage: '/dcc [list]',
    forms: [
      form([kw('list', 'ls')], 'list transfers'),
      form([kw('files', 'file')], 'the files you keep from DCC, until you delete them'),
      form([kw('accept'), ID], 'take an offered file'),
      form([kw('reject'), ID], 'turn an offer down'),
      form([kw('cancel'), ID], 'stop a transfer'),
      form([kw('download'), ID], 'save a finished file to this device'),
      form([kw('delete'), ID], 'delete a file you keep'),
      form([kw('retry'), ID], 'ask again for a queued pack that failed, next in its queue'),
      form([kw('clear'), opt('id', 'word')], {
        summary: 'take finished transfers off the list; your files stay',
        notes: ['one holding a partial download needs /dcc delete <id> first'],
      }),
      form([kw('send'), NICK, opt('file', 'word')], {
        flags: DCC_FLAGS,
        summary: 'send one of your files; with no file, pick or upload one',
        notes: [
          'the file is its name or its id from /dcc files; -passive asks them to listen',
          "(it's passive anyway when this server can't listen); -secure sends over TLS (SSEND)",
          'e.g. /dcc send bob   ·   /dcc send bob holiday.mkv   ·   /dcc send -secure bob 12',
        ],
      }),
      form([kw('chat'), NICK], {
        flags: DCC_FLAGS,
        summary: 'open a direct peer-to-peer chat, in a =nick buffer',
        notes: [
          'also accepts an offer someone made you; /dcc close chat <nick> ends or declines',
          '-passive asks them to listen; -secure chats over TLS (SCHAT, as KVIrc does)',
          'e.g. /dcc chat bob   ·   /dcc chat -secure bob   ·   /dcc close chat bob',
        ],
      }),
      form([kw('close'), kw('chat'), NICK], 'end a direct chat, or decline one'),
    ],
    notes: ['e.g. /dcc   ·   /dcc accept 3   ·   /dcc download 3   ·   /dcc delete 3'],
    networkAgnostic: true,
  }),
  cmd(['xdcc'], 'Messaging', 'the XDCC queue; it asks each bot for one pack at a time', {
    usage: '/xdcc queue [bot]',
    forms: [
      form([kw('add'), BOT, arg('pack', 'word')], 'queue an XDCC pack'),
      form([kw('addl'), BOT, arg('first', 'word'), arg('last', 'word')], 'queue a range of packs'),
      form([kw('addm'), BOT, arg('pack', 'word', { rest: true })], 'queue several packs'),
      form([kw('queue', 'list'), opt('bot', 'nick')], 'show the queue'),
      form([kw('rmp'), BOT, arg('pack', 'word')], 'take a pack out'),
      form([kw('rmpl'), BOT, arg('first', 'word'), arg('last', 'word')], 'take a range out'),
      form([kw('rmpm'), BOT, arg('pack', 'word', { rest: true })], 'take several packs out'),
      form([kw('rmbot'), BOT], "drop that bot's queue"),
    ],
    notes: ['e.g. /xdcc addl Ginpachi-Sensei 29 32   ·   /xdcc rmp Ginpachi-Sensei 31'],
    networkAgnostic: true,
  }),

  // Channels
  cmd(['join', 'j'], 'Channels', 'join a channel', { args: [CHAN, opt('key', 'word')] }),
  cmd(['part', 'leave', 'p'], 'Channels', 'leave channel (keeps buffer)', {
    args: [opt('#chan', 'channel'), REASON],
  }),
  cmd(['cycle', 'hop'], 'Channels', 'part and rejoin this channel', { args: [REASON] }),
  cmd(['close'], 'Channels', 'close current buffer (parts if joined)'),
  cmd(['clear'], 'Channels', 'hide buffer up to now (off = undo, show again)', {
    args: [choice(['off'], { optional: true })],
  }),
  cmd(['topic'], 'Channels', 'show the topic, or set it', {
    args: [opt('#chan', 'channel'), optText('text')],
  }),
  cmd(['channel', 'chan'], 'Channels', 'open Channel Settings', {
    args: [opt('#chan', 'channel')],
  }),
  cmd(['threads', 'thread'], 'Channels', 'the reply threads in this buffer'),
  cmd(['retention'], 'Channels', 'per-buffer history cap (no arg = show current)', {
    args: [choice(['off', 'default'], { label: 'n|off|default', optional: true })],
  }),
  cmd(['list'], 'Channels', 'list channels on current network', {
    args: [optText('filter')],
  }),
  cmd(['nick'], 'Channels', 'change your nick', { args: [arg('newnick', 'newNick')] }),
  cmd(['whois'], 'Channels', "open a user's profile", { args: [NICK] }),
  cmd(['invite'], 'Channels', 'invite a user to a channel', {
    forms: [form([NICK, opt('#chan', 'channel')]), form([CHAN, NICK])],
  }),

  // Moderation
  cmd(['kick'], 'Moderation', 'kick from current channel', { forms: inChannel(NICK, REASON) }),
  cmd(['kickban'], 'Moderation', 'kick and ban in one step', { forms: inChannel(NICK, REASON) }),
  cmd(['op'], 'Moderation', 'give op', { forms: inChannel(NICKS) }),
  cmd(['deop'], 'Moderation', 'take op', { forms: inChannel(NICKS) }),
  cmd(['voice'], 'Moderation', 'give voice', { forms: inChannel(NICKS) }),
  cmd(['devoice'], 'Moderation', 'take voice', { forms: inChannel(NICKS) }),
  cmd(['halfop'], 'Moderation', 'give half-op', { forms: inChannel(NICKS) }),
  cmd(['dehalfop'], 'Moderation', 'take half-op', { forms: inChannel(NICKS) }),
  cmd(['ban'], 'Moderation', 'ban a nick or mask', {
    forms: inChannel(arg('nick|mask', 'nick', { rest: true })),
  }),
  cmd(['unban'], 'Moderation', 'lift a ban', {
    forms: inChannel(arg('mask', 'nick', { rest: true })),
  }),
  cmd(['quiet'], 'Moderation', 'quiet a nick or mask', {
    forms: inChannel(arg('nick|mask', 'nick', { rest: true })),
  }),
  cmd(['unquiet'], 'Moderation', 'lift a quiet', {
    forms: inChannel(arg('mask', 'nick', { rest: true })),
  }),
  cmd(['mode'], 'Moderation', 'set modes (target defaults to current channel)', {
    args: [text('[target] flags')],
    usage: '/mode [target] <flags>',
  }),
  cmd(['ignore'], 'Moderation', 'list, or add an ignore rule (global by default)', {
    args: [
      opt('mask|#chan', 'nick'),
      choice(CANONICAL_ORDER, { label: 'LEVELS', optional: true, rest: true }),
    ],
    flags: [
      flag('-network', undefined, 'only on this network'),
      flag('-regexp', undefined, 'the pattern is a regular expression'),
      flag('-full', undefined, 'the pattern matches whole words'),
      flag('-pattern', 'text', 'only lines containing this'),
      flag('-except', undefined, 'an exception to another rule'),
      flag('-time', 'dur', 'expires after this long'),
    ],
    notes: [
      `LEVELS: ${CANONICAL_ORDER.join(' ')}`,
      'e.g. /ignore bob NOHIGHLIGHT   ·   /ignore -network -regexp -pattern (foo|bar) #chan',
    ],
    networkAgnostic: true,
  }),
  cmd(['unignore'], 'Moderation', 'remove an ignore (index from /ignore list)', {
    args: [arg('index|mask', 'word')],
    networkAgnostic: true,
  }),
  cmd(['highlight', 'hilight'], 'Moderation', 'list, or add a highlight rule (global by default)', {
    args: [optText('text')],
    flags: [
      flag('-network', undefined, 'only on this network'),
      flag('-mask', undefined, 'match the sender, not the text'),
      flag('-full', undefined, 'whole words only'),
      flag('-regexp', undefined, 'the text is a regular expression'),
      flag('-matchcase', undefined, 'case sensitive'),
      flag('-channels', '#a,#b', 'only in these channels'),
    ],
    notes: [
      'e.g. /highlight QUACK!   ·   /highlight -mask bob!*@*   ·   /highlight -network -regexp qu+ack',
    ],
    networkAgnostic: true,
  }),
  cmd(
    ['unhighlight', 'dehilight'],
    'Moderation',
    'remove a highlight (index from /highlight list)',
    { args: [arg('index|text', 'word')], networkAgnostic: true },
  ),

  // Server
  cmd(['raw', 'quote'], 'Server', 'send a raw IRC line', { args: [text('line')] }),
  cmd(['ns'], 'Server', 'message NickServ (e.g. identify <pass>)', { args: [text('text')] }),
  cmd(['cs'], 'Server', 'message ChanServ', { args: [text('text')] }),
  cmd(['quit', 'disconnect'], 'Server', 'disconnect from current network', { args: [REASON] }),
  cmd(['reconnect'], 'Server', 'reconnect to current network'),
  cmd(['flushq'], 'Server', 'drop your messages still waiting to be sent on this network'),
  cmd(['names'], 'Server', 'list the users on a channel', { args: [opt('#chan', 'channel')] }),
  cmd(['who'], 'Server', 'find users', { args: [optText('mask')] }),
  cmd(['whowas'], 'Server', 'look up a departed nick', { args: [opt('nick', 'nick')] }),
  cmd(['userhost'], 'Server', "look up a user's host", { args: [opt('nick', 'nick')] }),
  cmd(['ison'], 'Server', 'check whether nicks are online', {
    args: [opt('nick', 'nick', { rest: true })],
  }),
  cmd(['motd'], 'Server', 'show the message of the day'),
  cmd(['version'], 'Server', 'query server version'),
  cmd(['time'], 'Server', 'query server time'),
  cmd(['admin'], 'Server', 'show server admin info'),
  cmd(['info'], 'Server', 'show server info'),
  cmd(['lusers'], 'Server', 'show network user counts'),
  cmd(['links'], 'Server', 'list server links'),
  cmd(['map'], 'Server', 'show the network map'),
  cmd(['stats'], 'Server', 'query server statistics', { args: [optText('query')] }),
  cmd(['help'], 'Server', "ask the server for help (this client's list is /commands)", {
    args: [optText('topic')],
  }),

  // Status
  cmd(['away'], 'Status', 'set away (no msg clears)', {
    args: [optText('msg')],
    flags: AWAY_FLAGS,
    flagsLead: true,
    notes: ['-all: every network; -one: just this one'],
    networkAgnostic: true,
  }),
  cmd(['back'], 'Status', 'clear away', {
    flags: AWAY_FLAGS,
    flagsLead: true,
    networkAgnostic: true,
  }),
  cmd(['displayname'], 'Status', 'the name shown for you on networks with IRCv3 metadata', {
    args: [text('name|off')],
  }),
  cmd(['avatar'], 'Status', 'your avatar image (an https URL) on networks with IRCv3 metadata', {
    args: [arg('url|off', 'word')],
  }),
  cmd(['metadata'], 'Status', 'any IRCv3 metadata key', {
    usage: '/metadata set|del|list|clear',
    forms: [
      form([kw('set'), arg('key', 'word'), text('value')], 'set one of your keys'),
      form([kw('del', 'unset', 'delete'), arg('key', 'word')], 'remove one of your keys'),
      form([kw('list'), opt('nick|#chan', 'nick')], 'show keys: yours, a nick’s or a channel’s'),
      form([kw('clear')], 'remove all of your keys'),
    ],
  }),

  // App
  cmd(['relay'], 'App', 'list, mark, or unmark relay/bridge bots on this network', {
    usage: '/relay [list]',
    forms: [
      form([kw('list', 'ls')], 'the bots marked on this network'),
      form([kw('add', 'mark', 'set'), NICK, optText('pattern')], 'mark a bot'),
      form([kw('remove', 'rm', 'del', 'delete', 'unmark'), NICK], 'unmark a bot'),
    ],
    notes: [
      'e.g. /relay add relaybot   ·   /relay add bridge <{nick}> {message}   ·   /relay remove relaybot',
      'custom template mirrors the bot order with {source}/{nick}/{message} placeholders',
      'e.g. reversed: /relay add eyebot <{nick}> [{source}] {message}',
    ],
  }),
  cmd(['network', 'net'], 'App', 'manage networks; runs from the system buffer', {
    usage: '/network [list]',
    quoted: true,
    forms: [
      form([kw('list', 'ls')], 'your networks'),
      form([kw('add'), arg('name', 'word')], { flags: NETWORK_FLAGS, summary: 'add a network' }),
      form([kw('modify', 'edit'), NET], { flags: NETWORK_FLAGS, summary: 'change a network' }),
      form([kw('remove', 'rm', 'del', 'delete'), NET], 'delete a network'),
      form([kw('move'), NET, arg('position', 'word')], 'reorder a network'),
      form([kw('connect'), NET], 'connect a network'),
      form([kw('disconnect'), NET], 'disconnect a network'),
      form(
        [kw('cert'), NET, choice(['new', 'remove'], { optional: true })],
        'show, replace or remove its client certificate',
      ),
    ],
    notes: ['Lurker folds irssi /server into connect and disconnect'],
    networkAgnostic: true,
  }),
  cmd(['set'], 'App', 'change a setting; /set (or /set ?) lists all keys', {
    args: [arg('key', 'setting'), arg('value', 'settingValue', { rest: true })],
    networkAgnostic: true,
  }),
  cmd(['get'], 'App', 'read a setting back (output in the system buffer)', {
    args: [arg('key', 'setting')],
    networkAgnostic: true,
  }),
  cmd(['theme'], 'App', 'theme presets', {
    usage: '/theme [list]',
    forms: [
      form([kw('list', 'ls')], 'your themes'),
      form([kw('apply', 'switch', 'load'), arg('name', 'theme', { rest: true })], 'switch to one'),
      form([kw('save'), text('name')], 'save the current look under a name'),
      form([kw('delete', 'del', 'remove', 'rm'), arg('name', 'theme', { rest: true })], 'delete'),
      form(
        [kw('mode'), choice(['single', 'system'], { optional: true })],
        'one theme, or follow the system',
      ),
      form(
        [kw('use'), choice(['light', 'dark']), arg('name', 'theme', { rest: true })],
        'the theme for system light or dark',
      ),
    ],
    notes: [
      'e.g. /theme apply light   ·   /theme save My Theme   ·   /theme use dark Ocean',
      'built-ins: Monokai Plus + Monokai Plus Light (dark/light work as shorthands)',
    ],
    networkAgnostic: true,
  }),
  cmd(['avatars'], 'App', 'the tile set behind generated avatars (Settings › Appearance)', {
    usage: '/avatars [list]',
    forms: [
      form([kw('list', 'ls')], 'the tile sets'),
      form([kw('use', 'apply', 'switch'), arg('set', 'avatarSet', { rest: true })], 'switch sets'),
      form(
        [kw('delete', 'del', 'remove', 'rm'), arg('set', 'avatarSet', { rest: true })],
        'delete a set',
      ),
    ],
    networkAgnostic: true,
  }),
  cmd(['e2e'], 'App', 'end-to-end encryption for a channel (experimental; /e2e help)', {
    usage: '/e2e <sub>',
    forms: [
      form(
        [kw('on'), opt('#chan', 'channel'), choice(E2E_MODES, { optional: true })],
        'turn it on',
      ),
      form([kw('off'), opt('#chan', 'channel')], 'turn it off'),
      form([kw('mode'), choice(E2E_MODES)], 'how keys are exchanged'),
      form([kw('handshake'), NICK], 'exchange keys with someone'),
      form([kw('accept'), NICK], 'accept a key request'),
      form([kw('decline'), NICK], 'decline a key request'),
      form([kw('revoke'), NICK], "stop trusting someone's key"),
      form([kw('unrevoke'), NICK], 'trust it again'),
      form([kw('reverify'), NICK], 'verify a changed key'),
      form([kw('verify'), NICK], 'verify a key'),
      form([kw('rotate'), opt('#chan', 'channel')], 'make a new channel key'),
      form([kw('forget'), arg('nick|handle', 'nick')], {
        flags: [flag('-all')],
        summary: 'forget a peer',
      }),
      form([kw('fingerprint')], 'your key fingerprint'),
      form([kw('status')], 'where this buffer stands'),
      form([kw('list')], { flags: [flag('-all')], summary: 'the peers you hold keys for' }),
      form([kw('autotrust'), kw('list')], 'the autotrust rules'),
      form(
        [kw('autotrust'), kw('add'), arg('scope', 'word'), arg('pattern', 'word')],
        'add an autotrust rule',
      ),
      form([kw('autotrust'), kw('remove'), arg('pattern', 'word')], 'remove an autotrust rule'),
      form([kw('export')], 'download your keys'),
      form([kw('import')], 'load keys from a file'),
      form([kw('help')], 'the full reference'),
    ],
  }),
  cmd(['sheep'], 'App', 'a sheep', {
    forms: [
      form([choice([...SHEEP_COLORS, 'random'], { label: 'color', optional: true })]),
      form([kw('off'), choice(['all'], { optional: true })]),
      form([kw('list')]),
      form([kw('sounds'), choice(['on', 'off'], { optional: true })]),
      form([kw('scale'), choice(['1', '2', '3'], { optional: true })]),
      form([kw('about')]),
      form([kw('debug')]),
      form([kw('help')]),
    ],
    networkAgnostic: true,
    hidden: true,
  }),
  cmd(['commands'], 'App', 'this list', { networkAgnostic: true }),
];

/** Every word the dispatcher answers to: each command's name and its aliases. */
export type CommandVerb = (typeof COMMANDS)[number]['names'][number];

const BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.flatMap((spec) => spec.names.map((name) => [name, spec] as const)),
);

/** The spec a typed word names, by name or alias; undefined for an unknown verb. */
export function specFor(verb: string): CommandSpec | undefined {
  return BY_NAME.get(verb.toLowerCase());
}

/** A typed word as a `CommandVerb`, or null when the table doesn't know it. */
export function resolveVerb(word: string): CommandVerb | null {
  const lower = word.toLowerCase();
  return BY_NAME.has(lower) ? (lower as CommandVerb) : null;
}

/**
 * What a bare `/` leads with: a starter set across categories, since nothing
 * typed means nothing to rank by. The mobile apps' six.
 */
export const FEATURED: readonly string[] = ['join', 'msg', 'me', 'nick', 'topic', 'away'];

export interface CommandMatch {
  readonly spec: CommandSpec;
  /** The name that matched: the canonical one, or the alias that was typed toward. */
  readonly name: string;
}

/**
 * The commands a typed prefix could become, best first. A command appears once:
 * under its own name when that matches, otherwise under the alias that does
 * (`/ho` is `/hop`). Canonical matches lead, the featured ones among them first,
 * then table order. An empty
 * query is everything, the featured set first.
 *
 * `agnosticOnly` is the system buffer, where nothing else can run.
 */
export function matchingCommands(
  query: string,
  opts: { agnosticOnly?: boolean } = {},
): CommandMatch[] {
  const needle = query.toLowerCase();
  const pool = COMMANDS.filter(
    (spec: CommandSpec) => !spec.hidden && (!opts.agnosticOnly || spec.networkAgnostic),
  );
  if (!needle) {
    const lead = FEATURED.flatMap((name) => pool.filter((spec) => spec.names[0] === name));
    const rest = pool.filter((spec) => !lead.includes(spec));
    return [...lead, ...rest].map((spec) => ({ spec, name: spec.names[0] }));
  }
  // A name or alias typed in full leads, so the highlighted row is the one
  // Enter runs: `/who` before `/whois`, `/q` before `/quit`.
  let exact: CommandMatch | null = null;
  const canonical: CommandMatch[] = [];
  const aliased: CommandMatch[] = [];
  for (const spec of pool) {
    if (needle && spec.names.includes(needle)) {
      exact = { spec, name: needle };
      continue;
    }
    if (spec.names[0].startsWith(needle)) {
      canonical.push({ spec, name: spec.names[0] });
      continue;
    }
    const alias = spec.names.find((name) => name.startsWith(needle));
    if (alias) aliased.push({ spec, name: alias });
  }
  // Stable, so table order holds within each group: `/j` is `/join` before `/jitsi`.
  const featuredFirst = (a: CommandMatch, b: CommandMatch) =>
    Number(FEATURED.includes(b.name)) - Number(FEATURED.includes(a.name));
  return [...(exact ? [exact] : []), ...canonical.toSorted(featuredFirst), ...aliased];
}

// ── Usage and the cheatsheet ────────────────────────────────────────────────

const REPEATING: ReadonlySet<ArgKind> = new Set<ArgKind>(['nick', 'channel', 'word', 'choice']);

function argUsage(a: ArgSpec): string {
  if (a.kind === 'keyword') return a.label;
  // The ellipsis is for a run of separate things (`/op a b c`), not for one value
  // that happens to hold spaces.
  const inner = a.rest && REPEATING.has(a.kind) ? `${a.label}…` : a.label;
  return a.optional ? `[${inner}]` : `<${inner}>`;
}

function flagUsage(f: FlagSpec): string {
  return f.takes ? `${f.name} <${f.takes}>` : f.name;
}

// Past this many, the options print as `[opts]` and are spelled out in a note.
const INLINE_FLAGS = 2;

/** `/dcc chat [-passive] [-secure] <nick>`: one form under a given name. */
export function formUsage(name: string, f: FormSpec): string {
  const flags = f.flags ?? [];
  const flagPart =
    flags.length === 0
      ? []
      : flags.length > INLINE_FLAGS
        ? ['[opts]']
        : flags.map((x) => `[${flagUsage(x)}]`);
  // Options read best after the words that pick the form and before its values.
  const lead = f.args.findIndex((a) => a.kind !== 'keyword');
  const split = lead === -1 ? f.args.length : lead;
  return [
    `/${name}`,
    ...f.args.slice(0, split).map(argUsage),
    ...flagPart,
    ...f.args.slice(split).map(argUsage),
  ].join(' ');
}

/** The one-line usage a command is listed under, by the name given or its own. */
export function commandUsage(spec: CommandSpec, name: string = spec.names[0]): string {
  if (spec.usage) return spec.usage.replace(`/${spec.names[0]}`, `/${name}`);
  const plain = spec.forms.filter((f) => !f.summary);
  return formUsage(name, plain[0] ?? spec.forms[0]);
}

function aliasNote(spec: CommandSpec): string {
  const aliases = spec.names.slice(1).map((n) => `/${n}`);
  if (!aliases.length) return '';
  return ` (${aliases.length === 1 ? 'alias' : 'aliases'}: ${aliases.join(', ')})`;
}

const USAGE_COLUMN = 24;
const NOTE_INDENT = '      ';

function helpLine(usage: string, summary: string): string {
  return `  ${usage.padEnd(USAGE_COLUMN)} — ${summary}`;
}

function flagNote(flags: readonly FlagSpec[]): string[] {
  return flags.length > INLINE_FLAGS ? [`opts: ${flags.map(flagUsage).join(' ')}`] : [];
}

/** The `/commands` cheatsheet, generated: grouped by category, one line per line. */
export function helpLines(): string[] {
  const lines = ['commands:'];
  for (const category of COMMAND_CATEGORIES) {
    const specs = COMMANDS.filter(
      (spec: CommandSpec) => spec.category === category && !spec.hidden,
    );
    if (!specs.length) continue;
    lines.push('', `${category}:`);
    for (const spec of specs as readonly CommandSpec[]) {
      const name = spec.names[0];
      lines.push(helpLine(commandUsage(spec), spec.summary + aliasNote(spec)));
      const note = (s: string) => lines.push(NOTE_INDENT + s);
      for (const f of spec.forms) if (!f.summary) flagNote(f.flags ?? []).forEach(note);
      spec.notes?.forEach(note);
      for (const f of spec.forms) {
        if (!f.summary) continue;
        const usage = formUsage(name, f);
        // The family's own line already stands for the form it is listed under:
        // `/dcc [list]` is `/dcc list`.
        const family = commandUsage(spec);
        if (usage !== family && usage !== family.replace(/[[\]]/g, '')) {
          lines.push(helpLine(usage, f.summary));
        }
        flagNote(f.flags ?? []).forEach(note);
        f.notes?.forEach(note);
      }
    }
  }
  lines.push('', '  //text                   — send literal "/text" as a message (escape)');
  return lines;
}
