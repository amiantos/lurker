// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What an attached bouncer client may receive, given the caps it negotiated.
//
// Lurker's connection to a network negotiates caps of its own (irc-framework
// asks for away-notify, extended-join, multi-prefix, userhost-in-names, … by
// default), and the relay forwards what the network then sends. A client that
// never asked for those caps must not get the lines they bring (#892, #926). So
// every line the bouncer writes to a client (the live relay, the welcome and
// channel replay, playback, CHATHISTORY, self-echoes, our own notices) goes
// through that client's ClientLineFilter. One exit point is what stops a new
// write path from skipping the rules.
//
// The rules are soju's downstreamConn.SendMessage (downstream.go) and ZNC's
// CClient::PutClient (src/Client.cpp), plus two fallbacks for lines a client
// can't take as they are: ZNC's for CHGHOST (CIRCSock::OnChgHostMessage), and
// the draft/multiline spec's, since Lurker asks networks for multiline and never
// offers it to clients.
//
// Lines are parsed only as far as those rules need. A line no rule touches is
// written byte-for-byte; only a rewritten line is serialized again.

/** A server→client line, split into the parts the rules read. */
export interface ClientLine {
  // `key` or `key=value` items in wire order, still escaped. Rules keep or drop
  // whole tags, so a value is never decoded.
  tags: string[];
  source: string | null;
  command: string;
  params: string[];
  // Whether the last param arrived as a `:` trailing param, so a rewrite keeps
  // the line's shape: a NAMES reply trimmed to one name still ends `:name`.
  trailing: boolean;
}

/** Parse a server→client line. Null when it has no command. */
export function parseLine(line: string): ClientLine | null {
  let rest = line;
  let tags: string[] = [];
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    tags = rest.slice(1, sp).split(';').filter(Boolean);
    rest = rest.slice(sp + 1);
  }
  rest = rest.replace(/^ +/, '');
  let source: string | null = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    source = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let head = rest;
  let trailing: string | null = null;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    head = rest.slice(0, ti);
    trailing = rest.slice(ti + 2);
  }
  const params = head.split(' ').filter(Boolean);
  const command = params.shift()?.toUpperCase();
  if (!command) return null;
  if (trailing !== null) params.push(trailing);
  return { tags, source, command, params, trailing: trailing !== null };
}

/** Serialize a parsed line back to the wire form (no CRLF). */
export function formatLine(msg: ClientLine): string {
  const parts: string[] = [];
  if (msg.tags.length > 0) parts.push(`@${msg.tags.join(';')}`);
  if (msg.source !== null) parts.push(`:${msg.source}`);
  parts.push(msg.command);
  msg.params.forEach((param, i) => {
    const last = i === msg.params.length - 1;
    const colon =
      last && (msg.trailing || param === '' || param.includes(' ') || param.startsWith(':'));
    parts.push(colon ? `:${param}` : param);
  });
  return parts.join(' ');
}

function tagKey(tag: string): string {
  const eq = tag.indexOf('=');
  return eq === -1 ? tag : tag.slice(0, eq);
}

function tagValue(tags: readonly string[], key: string): string | undefined {
  for (const tag of tags) {
    if (tagKey(tag) === key) return tag.slice(key.length + 1);
  }
  return undefined;
}

/** `line` keeping only the tags whose key `keep` accepts. Null when it has no command. */
export function restrictTags(line: string, keep: (key: string) => boolean): string | null {
  const msg = parseLine(line);
  if (!msg) return null;
  const kept = msg.tags.filter((tag) => keep(tagKey(tag)));
  // An emptied (or already empty) tag block goes entirely, never as a bare `@`.
  if (kept.length === msg.tags.length && (kept.length > 0 || !line.startsWith('@'))) return line;
  msg.tags = kept;
  return formatLine(msg);
}

/**
 * A NAMES entry with only its highest prefix, for a client without multi-prefix:
 * `@+nick` → `@nick`. `symbols` is the network's PREFIX symbols, highest first.
 */
export function highestPrefixOnly(entry: string, symbols: string): string {
  let end = 0;
  while (end < entry.length && symbols.includes(entry[end])) end++;
  return end > 1 ? entry[0] + entry.slice(end) : entry;
}

/** The same for RPL_WHOREPLY's flags, where the prefixes follow H/G and `*`: `H*@+` → `H*@`. */
export function whoFlagsHighestPrefixOnly(flags: string, symbols: string): string {
  let start = 0;
  while (start < flags.length && !symbols.includes(flags[start])) start++;
  let end = start;
  while (end < flags.length && symbols.includes(flags[end])) end++;
  return end - start > 1 ? flags.slice(0, start + 1) + flags.slice(end) : flags;
}

/** What the filter needs to know about one attached client and its network. */
export interface ClientView {
  // The caps the client negotiated. Read on every line, so a later CAP REQ
  // takes effect at once.
  readonly caps: ReadonlySet<string>;
  // Source of the lines the bouncer makes up itself (the fallback MODE).
  readonly serverName: string;
  // Our nick on the network. An INVITE naming it arrives with or without
  // invite-notify.
  nick(): string | null;
  // The network's ISUPPORT PREFIX, highest rank first.
  prefixes(): ReadonlyArray<{ mode: string; symbol: string }>;
  // The channels `nick` shares with us, with its prefix modes in each and the
  // services account we know it by (a string; null when logged out; undefined
  // when never learned).
  sharedChannels(
    nick: string,
  ): Array<{ channel: string; modes: readonly string[]; account?: string | null }>;
}

const MULTILINE_BATCH = 'draft/multiline';
const MULTILINE_CONCAT = 'draft/multiline-concat';

// Commands a client gets only after negotiating the cap (soju's SendMessage).
// Lurker doesn't ask networks for some of these caps, so their commands can't
// arrive today. They're listed anyway: asking a network for a cap changes what
// it sends (#591), and doing that later must not reopen this leak.
const CAP_GATED_COMMANDS: Record<string, string> = {
  TAGMSG: 'message-tags',
  BATCH: 'batch',
  AWAY: 'away-notify',
  ACCOUNT: 'account-notify',
  CHGHOST: 'chghost',
  SETNAME: 'setname',
  REDACT: 'draft/message-redaction',
  MARKREAD: 'draft/read-marker',
  METADATA: 'draft/metadata-2',
};

// The tags a client without message-tags may still get, each behind its own cap.
const TAG_CAPS: Record<string, string> = {
  time: 'server-time',
  batch: 'batch',
  account: 'account-tag',
};

interface OpenBatch {
  type: string;
  // Whether this client was sent the `BATCH +` line. Lines inside keep their
  // batch tag only then.
  opened: boolean;
  // The `BATCH +` line's own tags. The multiline fallback puts them on the lines
  // instead: all of them on the first, all but msgid after that.
  tags: string[];
  first: boolean;
}

export class ClientLineFilter {
  private readonly view: ClientView;
  // Batches this client has seen start, by reference. Lurker's own batches
  // (network lists, CHATHISTORY) open and close within one write burst; the
  // network's live until its `BATCH -` or resetBatches().
  private readonly batches = new Map<string, OpenBatch>();

  constructor(view: ClientView) {
    this.view = view;
  }

  /**
   * The lines to write for `line`: none, the line itself (rewritten if a rule
   * applies), or the fallback lines that stand in for it.
   */
  apply(line: string): string[] {
    const msg = parseLine(line);
    if (!msg) return [];
    const { caps } = this.view;
    let dirty = false;

    // A batch tag survives only if this client was sent that batch's start.
    // That also covers a client that attached part-way through a batch.
    const ref = tagValue(msg.tags, 'batch');
    const batch = ref === undefined ? undefined : this.batches.get(ref);
    if (ref !== undefined && !batch?.opened) {
      msg.tags = msg.tags.filter((tag) => tagKey(tag) !== 'batch');
      dirty = true;
    }

    if (msg.command === 'BATCH') {
      const [refParam = '', type = ''] = msg.params;
      if (refParam.startsWith('+')) {
        const opened = caps.has('batch') && type !== MULTILINE_BATCH;
        this.batches.set(refParam.slice(1), {
          type,
          opened,
          tags: msg.tags.filter((tag) => tagKey(tag) !== 'batch'),
          first: true,
        });
        if (!opened) return [];
      } else if (refParam.startsWith('-')) {
        const open = this.batches.get(refParam.slice(1));
        this.batches.delete(refParam.slice(1));
        if (!open?.opened) return [];
      }
    }

    const gate = CAP_GATED_COMMANDS[msg.command];
    if (gate && !caps.has(gate)) {
      return msg.command === 'CHGHOST' ? this.chghostFallback(msg) : [];
    }

    if (msg.command === 'INVITE' && !caps.has('invite-notify')) {
      const nick = this.view.nick();
      if (!nick || (msg.params[0] ?? '').toLowerCase() !== nick.toLowerCase()) return [];
    }

    if (msg.command === 'JOIN' && msg.params.length > 1 && !caps.has('extended-join')) {
      msg.params = msg.params.slice(0, 1);
      msg.trailing = false;
      dirty = true;
    }

    // RPL_NAMREPLY: `<client> <symbol> <channel> :<entries>`.
    if (msg.command === '353' && msg.params.length >= 3) {
      const multiPrefix = caps.has('multi-prefix');
      const userhosts = caps.has('userhost-in-names');
      if (!multiPrefix || !userhosts) {
        const symbols = this.prefixSymbols();
        const last = msg.params.length - 1;
        const entries = msg.params[last]
          .split(' ')
          .map((entry) => {
            const name = multiPrefix ? entry : highestPrefixOnly(entry, symbols);
            const bang = userhosts ? -1 : name.indexOf('!');
            return bang === -1 ? name : name.slice(0, bang);
          })
          .join(' ');
        if (entries !== msg.params[last]) {
          msg.params[last] = entries;
          dirty = true;
        }
      }
    }

    // RPL_WHOREPLY: `<client> <channel> <user> <host> <server> <nick> <flags> :…`.
    if (msg.command === '352' && msg.params.length >= 7 && !caps.has('multi-prefix')) {
      const flags = whoFlagsHighestPrefixOnly(msg.params[6], this.prefixSymbols());
      if (flags !== msg.params[6]) {
        msg.params[6] = flags;
        dirty = true;
      }
    }

    // The multiline spec's fallback: a client without the cap gets the batch's
    // lines as plain messages, never a blank one, with the batch's tags moved
    // onto them.
    if (
      batch?.type === MULTILINE_BATCH &&
      (msg.command === 'PRIVMSG' || msg.command === 'NOTICE')
    ) {
      if ((msg.params[1] ?? '') === '') return [];
      const carried = batch.first
        ? batch.tags
        : batch.tags.filter((tag) => tagKey(tag) !== 'msgid');
      batch.first = false;
      const present = new Set(msg.tags.map(tagKey));
      const added = carried.filter((tag) => !present.has(tagKey(tag)));
      if (added.length > 0) {
        msg.tags = [...added, ...msg.tags];
        dirty = true;
      }
    }
    // Multiline is never offered, so its concat marker never goes out.
    if (msg.tags.some((tag) => tagKey(tag) === MULTILINE_CONCAT)) {
      msg.tags = msg.tags.filter((tag) => tagKey(tag) !== MULTILINE_CONCAT);
      dirty = true;
    }

    if (!caps.has('message-tags')) {
      const kept = msg.tags.filter((tag) => {
        const cap = TAG_CAPS[tagKey(tag)];
        return cap !== undefined && caps.has(cap);
      });
      if (kept.length !== msg.tags.length || (kept.length === 0 && line.startsWith('@'))) {
        msg.tags = kept;
        dirty = true;
      }
    }

    return [dirty ? formatLine(msg) : line];
  }

  /**
   * Forget the network's open batches. A new upstream connection starts with
   * none, and its references can repeat the old connection's (soju keeps them
   * per upstream connection too).
   */
  resetBatches(): void {
    this.batches.clear();
  }

  private prefixSymbols(): string {
    return this.view
      .prefixes()
      .map((p) => p.symbol)
      .join('');
  }

  // ZNC's fallback for a client without chghost, which is also the chghost
  // spec's SHOULD: what the network would have sent had Lurker not asked it for
  // chghost. A QUIT, then a JOIN in each shared channel and a MODE restoring the
  // prefix modes there. soju just drops the line, which leaves the client
  // holding a stale hostmask.
  private chghostFallback(msg: ClientLine): string[] {
    const source = msg.source ?? '';
    const bang = source.indexOf('!');
    const nick = bang === -1 ? source : source.slice(0, bang);
    const [user, host] = msg.params;
    const self = this.view.nick();
    // Our own change needs no fallback: the network reports it with a 396 of its
    // own, which the relay passes on.
    if (!nick || !user || !host || (self && nick.toLowerCase() === self.toLowerCase())) return [];
    const shared = this.view.sharedChannels(nick);
    if (shared.length === 0) return [];
    // The change's time applies to every fallback line. Its msgid names the
    // CHGHOST, not any of them, so it stays behind.
    const time = msg.tags.filter((tag) => tagKey(tag) === 'time');
    const tagBlock = time.length > 0 ? `@${time.join(';')} ` : '';
    const lines = [`${tagBlock}:${source} QUIT :Changing hostname`];
    const prefixes = this.view.prefixes();
    for (const { channel, modes, account } of shared) {
      // Built in extended-join form, which apply() trims for a client without
      // it. Members carry no realname, so that stays empty. (ZNC sends a plain
      // JOIN here, with a TODO for extended-join.)
      const accountParam = typeof account === 'string' ? account : '*';
      lines.push(`${tagBlock}:${nick}!${user}@${host} JOIN ${channel} ${accountParam} :`);
      const restored = prefixes.filter((p) => modes.includes(p.mode)).map((p) => p.mode);
      if (restored.length > 0) {
        const nicks = restored.map(() => nick).join(' ');
        lines.push(
          `${tagBlock}:${this.view.serverName} MODE ${channel} +${restored.join('')} ${nicks}`,
        );
      }
    }
    return lines.flatMap((l) => this.apply(l));
  }
}
