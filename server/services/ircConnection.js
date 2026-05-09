import IRC from 'irc-framework';
import { insertMessage } from '../db/messages.js';
import highlightRulesService from './highlightRulesService.js';

const NON_PERSISTED_TYPES = new Set([
  'state', 'names', 'channel-joined', 'channel-parted', 'typing',
]);

function extractExtras(event) {
  switch (event.type) {
    case 'kick': return { kicked: event.kicked };
    case 'nick': return { newNick: event.newNick };
    case 'mode': return { modes: event.modes };
    default: return null;
  }
}

export class IrcConnection {
  constructor({ network, onEvent }) {
    this.network = network;
    this.onEvent = onEvent;
    this.client = new IRC.Client();
    this.client.requestCap('message-tags');
    this.state = 'disconnected';
    this.channels = new Map();
    this.userModes = new Set();
    this.disposed = false;
    this.bind();
  }

  publishUserModes() {
    this.publish({
      type: 'usermode',
      target: this.serverTarget(),
      modes: [...this.userModes].join(''),
    });
  }

  shouldPersist(event) {
    if (!event.target) return false;
    return !NON_PERSISTED_TYPES.has(event.type);
  }

  publish(event) {
    if (this.disposed) return;
    const time = event.time || new Date().toISOString();
    const enriched = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };

    if (this.shouldPersist(event)) {
      const id = insertMessage({
        networkId: this.network.id,
        target: event.target,
        time,
        type: event.type,
        nick: event.nick,
        text: event.text,
        kind: event.kind,
        self: event.self,
        extra: extractExtras(event),
      });
      enriched.id = id;
    }

    this.onEvent(enriched);
  }

  publishEphemeral(event) {
    if (this.disposed) return;
    this.onEvent({
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time: event.time || new Date().toISOString(),
    });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
  }

  bind() {
    const c = this.client;

    c.on('registered', () => {
      this.userModes.clear();
      this.setState('connected', { nick: c.user.nick });
      try {
        highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, c.user.nick);
      } catch (e) {
        console.warn('[highlight] failed to upsert auto nick rule:', e?.message || e);
      }
    });
    c.on('close', () => {
      this.userModes.clear();
      this.setState('disconnected');
    });
    c.on('socket close', () => this.setState('disconnected'));
    c.on('reconnecting', () => this.setState('reconnecting'));
    c.on('connecting', () => this.setState('connecting'));

    // RPL_UMODEIS arrives when the server sends our current umode (e.g. on
    // login or in response to /MODE <self>). irc-framework normalises it to
    // 'user info' with the raw mode string ('+iwx').
    c.on('user info', (event) => {
      if (!c.user.nick || event.nick.toLowerCase() !== c.user.nick.toLowerCase()) return;
      this.userModes = new Set((event.raw_modes || '').replace(/^[+-]/, '').split(''));
      this.publishUserModes();
    });

    c.on('motd', (event) => {
      this.publish({ type: 'motd', target: this.serverTarget(), text: event.motd });
    });

    c.on('message', (event) => {
      const me = c.user?.nick;
      const isSelf = !!event.nick && event.nick === me;
      const isServer = !event.nick;
      const targetIsChannel = event.target && event.target.startsWith('#');

      let target;
      if (isServer) target = `:server:${this.network.id}`;
      else if (targetIsChannel) target = event.target;
      else if (isSelf) target = event.target;
      else target = event.nick;

      const type = event.type === 'action' ? 'action' : event.type === 'notice' ? 'notice' : 'message';
      const nick = event.nick || event.hostname || 'server';

      this.publish({
        type,
        target,
        nick,
        text: event.message,
        kind: event.type,
        self: isSelf,
      });
    });

    c.on('join', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members.set(event.nick.toLowerCase(), { nick: event.nick, modes: [] });
      this.publish({ type: 'join', target: event.channel, nick: event.nick });
      if (event.nick === c.user.nick) {
        this.publish({ type: 'channel-joined', target: event.channel });
      }
    });

    c.on('part', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.nick.toLowerCase());
      this.publish({ type: 'part', target: event.channel, nick: event.nick, text: event.message });
      if (event.nick === c.user.nick) {
        this.channels.delete(event.channel.toLowerCase());
        this.publish({ type: 'channel-parted', target: event.channel });
      }
    });

    c.on('kick', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.kicked.toLowerCase());
      this.publish({
        type: 'kick',
        target: event.channel,
        nick: event.nick,
        kicked: event.kicked,
        text: event.message,
      });
    });

    c.on('quit', (event) => {
      const lower = event.nick.toLowerCase();
      for (const ch of this.channels.values()) {
        if (ch.members.delete(lower)) {
          this.publish({ type: 'quit', target: ch.name, nick: event.nick, text: event.message });
        }
      }
    });

    c.on('nick', (event) => {
      const oldLower = event.nick.toLowerCase();
      const newLower = event.new_nick.toLowerCase();
      const isSelfNick = !!c.user.nick && c.user.nick.toLowerCase() === newLower;
      if (isSelfNick) {
        try {
          highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, event.new_nick);
        } catch (e) {
          console.warn('[highlight] failed to update auto nick rule:', e?.message || e);
        }
      }
      for (const ch of this.channels.values()) {
        const member = ch.members.get(oldLower);
        if (member) {
          ch.members.delete(oldLower);
          ch.members.set(newLower, { nick: event.new_nick, modes: member.modes });
          this.publish({ type: 'nick', target: ch.name, nick: event.nick, newNick: event.new_nick });
        }
      }
    });

    c.on('topic', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.topic = event.topic;
      this.publish({ type: 'topic', target: event.channel, nick: event.nick, text: event.topic });
    });

    c.on('mode', (event) => {
      const target = event.target;

      // Self user-mode change (e.g. server sets +i on connect, /OPER yields +o, etc.)
      if (target && c.user.nick && target.toLowerCase() === c.user.nick.toLowerCase()) {
        let changed = false;
        for (const m of (event.modes || [])) {
          if (!m || !m.mode) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          if (sign === '+' && !this.userModes.has(letter)) { this.userModes.add(letter); changed = true; }
          else if (sign === '-' && this.userModes.delete(letter)) { changed = true; }
        }
        if (changed) this.publishUserModes();
        return;
      }

      if (!target || !target.startsWith('#')) return;
      const ch = this.channels.get(target.toLowerCase());
      // Apply per-user prefix modes (+o/-o, +v/-v, etc.) to the member map so
      // the snapshot keeps current modes after page reload.
      let memberModesChanged = false;
      if (ch) {
        for (const m of (event.modes || [])) {
          if (!m || !m.param) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          if (!isPrefixMode(letter)) continue;
          const member = ch.members.get(m.param.toLowerCase());
          if (!member) continue;
          const set = new Set(member.modes);
          if (sign === '+') set.add(letter);
          else set.delete(letter);
          member.modes = [...set];
          memberModesChanged = true;
        }
      }
      const text = [event.raw_modes, ...(event.raw_params || [])].filter(Boolean).join(' ');
      this.publish({
        type: 'mode',
        target,
        nick: event.nick,
        text,
        modes: event.modes,
      });
      if (memberModesChanged && ch) {
        this.publish({
          type: 'names',
          target: ch.name,
          members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes })),
        });
      }
    });

    c.on('userlist', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members.clear();
      for (const u of event.users) {
        ch.members.set(u.nick.toLowerCase(), { nick: u.nick, modes: u.modes || [] });
      }
      this.publish({
        type: 'names',
        target: event.channel,
        members: event.users.map((u) => ({ nick: u.nick, modes: u.modes || [] })),
      });
    });

    c.on('irc error', (event) => {
      this.publish({
        type: 'error',
        target: this.serverTarget(),
        text: event.error || event.reason || 'IRC error',
        raw: event,
      });
    });

    c.on('tagmsg', (event) => {
      const me = c.user?.nick;
      const isSelf = !!event.nick && event.nick === me;
      if (isSelf) return;
      const typing = event.tags && event.tags['+typing'];
      if (!typing) return;
      const targetIsChannel = event.target && event.target.startsWith('#');
      const target = targetIsChannel ? event.target : event.nick;
      this.publishEphemeral({
        type: 'typing',
        target,
        nick: event.nick,
        state: typing,
      });
    });
  }

  serverTarget() {
    return `:server:${this.network.id}`;
  }

  upsertChannel(name) {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Map() };
      this.channels.set(key, ch);
    }
    return ch;
  }

  connect() {
    const { sasl_password, sasl_account, nick } = this.network;
    const account = sasl_password
      ? { account: sasl_account || nick, password: sasl_password }
      : undefined;
    this.client.connect({
      host: this.network.host,
      port: this.network.port,
      tls: !!this.network.tls,
      nick,
      username: this.network.username || nick,
      gecos: this.network.realname || nick,
      password: this.network.server_password || undefined,
      account,
      auto_reconnect: true,
      auto_reconnect_max_retries: 0,
    });
  }

  join(channel) { this.client.join(channel); }
  part(channel, reason) { this.client.part(channel, reason); }
  say(target, text) { this.client.say(target, text); }
  action(target, text) { this.client.action(target, text); }
  raw(line) { this.client.raw(line); }
  sendTyping(target, state) {
    this.client.tagmsg(target, { '+typing': state });
  }

  disconnect(reason = 'caint shutting down') {
    this.client.quit(reason);
  }

  dispose(reason = 'network removed') {
    this.disposed = true;
    try { this.client.quit(reason); } catch (_) { /* ignore */ }
  }

  snapshot() {
    return {
      networkId: this.network.id,
      state: this.state,
      nick: this.client.user?.nick || this.network.nick,
      userModes: [...this.userModes].join(''),
      channels: Array.from(this.channels.values()).map((ch) => ({
        name: ch.name,
        topic: ch.topic,
        members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes })),
      })),
    };
  }
}

const PREFIX_MODES = new Set(['q', 'a', 'o', 'h', 'v']);
function isPrefixMode(letter) { return PREFIX_MODES.has(letter); }
