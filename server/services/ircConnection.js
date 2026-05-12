import IRC from 'irc-framework';
import { insertMessage } from '../db/messages.js';
import highlightRulesService from './highlightRulesService.js';
import { matchEvent } from './highlightEngine.js';

const NON_PERSISTED_TYPES = new Set([
  'state', 'names', 'channel-joined', 'channel-parted', 'typing', 'away-state',
  'channel-modes', 'lag',
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
    this.awayState = { active: false, message: null, since: null, autoSet: false, backAt: null };
    this.disposed = false;
    this.lagMs = null;
    this.lagPingTimer = null;
    this.lagPendingToken = null;
    this.lagPendingSentAt = 0;
    this.bind();
  }

  publishUserModes() {
    this.publish({
      type: 'usermode',
      target: this.serverTarget(),
      modes: [...this.userModes].join(''),
    });
  }

  publishAwayState() {
    const a = this.awayState;
    // Emit the full pair whenever we have ANY away history (since set). The
    // client uses active+since to anchor the "you went away" divider and
    // backAt to anchor the "you came back" divider, so both timestamps must
    // ship even after the user returns.
    const away = a.since
      ? { active: a.active, since: a.since, message: a.message, autoSet: a.autoSet, backAt: a.backAt }
      : null;
    this.publish({ type: 'away-state', target: this.serverTarget(), away });
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
      // Run the highlight engine before persisting so the match decision is
      // stored on the row. The cheap path (engine gates on type & self) keeps
      // this off the hot path for non-highlightable events.
      let matchedRuleId = null;
      try {
        const compiled = highlightRulesService.getCompiled(this.network.user_id);
        const { matched, ruleId } = matchEvent(event, compiled);
        if (matched) matchedRuleId = ruleId;
      } catch (e) {
        console.warn('[highlight] match-on-insert failed:', e?.message || e);
      }
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
        matchedRuleId,
      });
      enriched.id = id;
      enriched.matched = matchedRuleId != null;
      enriched.matchedRuleId = matchedRuleId;
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
      this.lagMs = null;
      this.startLagPinger();
      this.setState('connected', { nick: c.user.nick });
      try {
        highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, c.user.nick);
      } catch (e) {
        console.warn('[highlight] failed to upsert auto nick rule:', e?.message || e);
      }
      // Re-assert /away on reconnect so the IRC server keeps showing us as
      // away — both manual and auto-away. For auto, if a client returns soon
      // after, the socket-reconnect path runs clearAwayAll({autoSet:true}) and
      // clears it cleanly; if not, staying away across an IRC blip is the
      // correct behavior.
      if (this.awayState.active && this.awayState.message) {
        try { this.client.raw('AWAY :' + this.awayState.message); } catch (_) { /* ignore */ }
      }
    });
    c.on('close', () => {
      this.userModes.clear();
      this.stopLagPinger();
      this.lagMs = null;
      this.setState('disconnected');
    });

    c.on('pong', (event) => {
      const token = event?.message;
      if (!token || token !== this.lagPendingToken) return;
      this.lagMs = Math.max(0, Date.now() - this.lagPendingSentAt);
      this.lagPendingToken = null;
      this.lagPendingSentAt = 0;
      this.publishLag();
    });
    // irc-framework's net transport stashes socket-level errors (DNS lookup
    // failures, ECONNREFUSED, TLS handshake errors, etc.) in last_socket_error
    // and hands them to the close handler instead of emitting 'error', so this
    // is the only place we get to see why the connection actually died. Without
    // surfacing it to the server buffer the user just sees a red dot and no
    // log line.
    c.on('socket close', (err) => {
      this.setState('disconnected');
      if (err && (err.message || err.code)) {
        const code = err.code ? `${err.code}: ` : '';
        const where = `${this.network.host}:${this.network.port}`;
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: `Connection failed (${where}): ${code}${err.message || 'unknown error'}`,
        });
      }
    });
    c.on('reconnecting', (event) => {
      this.setState('reconnecting');
      const wait = event && event.wait ? Math.max(1, Math.round(event.wait / 1000)) : null;
      const attempt = event && event.attempt;
      const text = wait != null && attempt
        ? `Reconnecting in ${wait}s (attempt ${attempt})…`
        : 'Reconnecting…';
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'caint',
        text,
      });
    });
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
      // Skip self-echoes. ircManager.send/.action already publishes a local
      // copy of every outgoing PRIVMSG/ACTION, so when the IRC server reflects
      // it back to us (echo-message cap, ergo's always-on relay, some
      // bouncers) the second copy would land in the database with a fresh id
      // and surface as a duplicate in the buffer. The local publish is the
      // source of truth for anything this backend sent.
      if (event.nick && me && event.nick.toLowerCase() === me.toLowerCase()) return;
      const isServer = !event.nick;
      const targetIsChannel = event.target && event.target.startsWith('#');

      let target;
      if (isServer) target = `:server:${this.network.id}`;
      else if (targetIsChannel) target = event.target;
      else target = event.nick;

      const type = event.type === 'action' ? 'action' : event.type === 'notice' ? 'notice' : 'message';
      const nick = event.nick || event.hostname || 'server';

      this.publish({
        type,
        target,
        nick,
        text: event.message,
        kind: event.type,
        self: false,
      });
    });

    c.on('join', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members.set(event.nick.toLowerCase(), { nick: event.nick, modes: [], away: false });
      this.publish({ type: 'join', target: event.channel, nick: event.nick });
      if (event.nick === c.user.nick) {
        this.publish({ type: 'channel-joined', target: event.channel });
        // Most servers volunteer 324 on join, but a few don't. Request it so
        // the channel's mode flags reach the status bar consistently.
        try { c.raw('MODE', event.channel); } catch (_) { /* ignore */ }
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
          ch.members.set(newLower, { nick: event.new_nick, modes: member.modes, away: !!member.away });
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
      let chanModesChanged = false;
      if (ch) {
        for (const m of (event.modes || [])) {
          if (!m || !m.mode) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          // Per-user prefix mode: lands on the member, not on the channel.
          if (m.param && isPrefixMode(letter)) {
            const member = ch.members.get(m.param.toLowerCase());
            if (!member) continue;
            const set = new Set(member.modes);
            if (sign === '+') set.add(letter);
            else set.delete(letter);
            member.modes = [...set];
            memberModesChanged = true;
            continue;
          }
          // Channel-level flag mode (no param, or list-type mode like +b that
          // we don't surface in the status bar). We only track flag modes
          // (no param) so +b/+e/+I bans don't pollute the (+...) display.
          if (!m.param) {
            if (sign === '+' && !ch.modes.has(letter)) { ch.modes.add(letter); chanModesChanged = true; }
            else if (sign === '-' && ch.modes.delete(letter)) { chanModesChanged = true; }
          }
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
          members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes, away: !!m.away })),
        });
      }
      if (chanModesChanged && ch) this.publishChannelModes(ch);
    });

    // RPL_CHANNELMODEIS (324) and friends. Sent on join by most servers and
    // on demand via `MODE #chan`. Captures the current flag set without
    // requiring us to have observed the +/− history.
    c.on('channel info', (event) => {
      if (!event?.channel || !event.modes) return;
      const ch = this.channels.get(event.channel.toLowerCase());
      if (!ch) return;
      const next = new Set();
      for (const m of event.modes) {
        if (!m || !m.mode || m.param) continue;
        const letter = m.mode.replace(/^[+-]/, '');
        if (!letter) continue;
        next.add(letter);
      }
      const before = [...ch.modes].sort().join('');
      const after = [...next].sort().join('');
      if (before !== after) {
        ch.modes = next;
        this.publishChannelModes(ch);
      }
    });

    c.on('userlist', (event) => {
      const ch = this.upsertChannel(event.channel);
      // Preserve known away flags across re-issued NAMES (e.g. on /NAMES or
      // a fresh join). away-notify keeps it live; WHO refreshes it below.
      const prev = new Map();
      for (const [k, v] of ch.members) prev.set(k, !!v.away);
      ch.members.clear();
      for (const u of event.users) {
        const lc = u.nick.toLowerCase();
        ch.members.set(lc, { nick: u.nick, modes: u.modes || [], away: prev.get(lc) || false });
      }
      this.publish({
        type: 'names',
        target: event.channel,
        members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes, away: !!m.away })),
      });
      // Issue a WHO so we learn the current away state for everyone in the
      // channel. away-notify keeps it live after this initial sync.
      try { c.who(event.channel); } catch (_) { /* ignore */ }
    });

    c.on('wholist', (event) => {
      const ch = this.channels.get(event.target?.toLowerCase());
      if (!ch) return;
      let changed = false;
      for (const u of (event.users || [])) {
        if (!u || !u.nick) continue;
        const m = ch.members.get(u.nick.toLowerCase());
        if (!m) continue;
        const next = !!u.away;
        if (m.away !== next) {
          m.away = next;
          changed = true;
        }
      }
      if (!changed) return;
      this.publish({
        type: 'names',
        target: ch.name,
        members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes, away: !!m.away })),
      });
    });

    // Per-user away/back. away-notify drives the non-self events; self events
    // come from RPL_NOWAWAY/RPL_UNAWAY in response to our own /AWAY. We honor
    // both so the self nick also dims in the nicklist.
    c.on('away', (event) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick, true);
    });
    c.on('back', (event) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick, false);
    });

    c.on('irc error', (event) => {
      // irc-framework maps the IRC ERROR command (sent right before the
      // server drops you) and ERR_* numerics to this event. `error` is a
      // short tag like 'irc' / 'no_such_nick' / 'password_mismatch';
      // `reason` is the human-readable trailing param from the server
      // ("Closing Link: foo[u@h] (G-Lined)", etc.). The earlier handler
      // returned the first truthy of (error, reason), so an ERROR command
      // with both fields collapsed to the literal string "irc" and the
      // actual disconnect reason was thrown away.
      const tag = event?.error || 'irc error';
      const reason = event?.reason;
      const ctx = [event?.nick, event?.channel, event?.server].filter(Boolean).join(' ');
      const parts = [tag];
      if (ctx) parts.push(ctx);
      if (reason) parts.push(`— ${reason}`);
      const text = parts.join(' ');
      console.warn(`[irc:${this.network.id}] ${text}`);
      this.publish({
        type: 'error',
        target: this.serverTarget(),
        text,
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

  // Update the away flag for `nick` across every channel they're in and
  // re-broadcast names for each affected channel so clients re-render the
  // nicklist. Silent if the nick isn't tracked anywhere.
  applyMemberAway(nick, away) {
    const lower = nick.toLowerCase();
    const next = !!away;
    for (const ch of this.channels.values()) {
      const m = ch.members.get(lower);
      if (!m) continue;
      if (m.away === next) continue;
      m.away = next;
      this.publish({
        type: 'names',
        target: ch.name,
        members: Array.from(ch.members.values()).map((mm) => ({ nick: mm.nick, modes: mm.modes, away: !!mm.away })),
      });
    }
  }

  upsertChannel(name) {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Map(), modes: new Set() };
      this.channels.set(key, ch);
    }
    if (!ch.modes) ch.modes = new Set();
    return ch;
  }

  publishChannelModes(ch) {
    this.publish({
      type: 'channel-modes',
      target: ch.name,
      modes: [...ch.modes].join(''),
    });
  }

  publishLag() {
    this.publish({
      type: 'lag',
      target: this.serverTarget(),
      lagMs: this.lagMs,
    });
  }

  // Periodic PING with a `caint-lag-<sent>` token. PONG echoes the token back
  // so the matching pong handler can compute roundtrip even when the server
  // is also ponging unrelated PINGs we didn't send. Cleared on disconnect.
  startLagPinger() {
    this.stopLagPinger();
    const sendOne = () => {
      if (this.disposed || this.state !== 'connected') return;
      // If a previous ping hasn't been answered after 30s, declare lag stale
      // so the client stops showing an old number.
      if (this.lagPendingToken && Date.now() - this.lagPendingSentAt > 30_000) {
        this.lagMs = null;
        this.publishLag();
        this.lagPendingToken = null;
      }
      const token = `caint-lag-${Date.now()}`;
      this.lagPendingToken = token;
      this.lagPendingSentAt = Date.now();
      try { this.client.ping(token); } catch (_) { /* ignore */ }
    };
    sendOne();
    this.lagPingTimer = setInterval(sendOne, 30_000);
  }

  stopLagPinger() {
    if (this.lagPingTimer) {
      clearInterval(this.lagPingTimer);
      this.lagPingTimer = null;
    }
    this.lagPendingToken = null;
    this.lagPendingSentAt = 0;
  }

  connect() {
    const { sasl_password, sasl_account, nick } = this.network;
    const account = sasl_password
      ? { account: sasl_account || nick, password: sasl_password }
      : undefined;
    const proto = this.network.tls ? ' (TLS)' : '';
    this.publish({
      type: 'notice',
      target: this.serverTarget(),
      nick: 'caint',
      text: `Connecting to ${this.network.host}:${this.network.port}${proto}…`,
    });
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

  // Mirror the user-level self-presence state onto this connection. Called by
  // ircManager after it persists and is responsible for any guard logic — this
  // method is a dumb applier. Emits AWAY to the IRC server when the new state
  // disagrees with what the network already thinks (active flip), and always
  // publishes the away-state event so clients refresh their dividers.
  applyAwayState(next) {
    const prev = this.awayState;
    this.awayState = {
      active: !!next.active,
      message: next.message ?? null,
      since: next.since ?? null,
      autoSet: !!next.autoSet,
      backAt: next.backAt ?? null,
    };
    if (this.state === 'connected') {
      if (next.active && next.message && !prev.active) {
        try { this.client.raw('AWAY :' + next.message); } catch (_) { /* ignore */ }
      } else if (!next.active && prev.active) {
        try { this.client.raw('AWAY'); } catch (_) { /* ignore */ }
      }
    }
    this.publishAwayState();
  }

  disconnect(reason = 'caint shutting down') {
    this.client.quit(reason);
  }

  dispose(reason = 'network removed') {
    this.disposed = true;
    this.stopLagPinger();
    try { this.client.quit(reason); } catch (_) { /* ignore */ }
  }

  snapshot() {
    const a = this.awayState;
    return {
      networkId: this.network.id,
      state: this.state,
      nick: this.client.user?.nick || this.network.nick,
      userModes: [...this.userModes].join(''),
      lagMs: this.lagMs,
      away: a.since
        ? { active: a.active, since: a.since, message: a.message, autoSet: a.autoSet, backAt: a.backAt }
        : null,
      channels: Array.from(this.channels.values()).map((ch) => ({
        name: ch.name,
        topic: ch.topic,
        modes: [...(ch.modes || [])].join(''),
        members: Array.from(ch.members.values()).map((m) => ({ nick: m.nick, modes: m.modes, away: !!m.away })),
      })),
    };
  }
}

const PREFIX_MODES = new Set(['q', 'a', 'o', 'h', 'v']);
function isPrefixMode(letter) { return PREFIX_MODES.has(letter); }
