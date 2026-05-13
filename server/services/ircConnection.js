import IRC from 'irc-framework';
import { insertMessage } from '../db/messages.js';
import { upsertChannel } from '../db/networks.js';
import * as chanlistDb from '../db/chanlist.js';
import highlightRulesService from './highlightRulesService.js';
import { matchEvent } from './highlightEngine.js';
import { IRC_VERSION } from '../utils/userAgent.js';

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
    // `version` is the string irc-framework returns in response to CTCP
    // VERSION queries — without this, peers see the library's default
    // "node.js irc-framework". Identifying as Lurker lets server operators
    // tell our traffic apart from generic library bots.
    this.client = new IRC.Client({ version: IRC_VERSION });
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
    // Pre-registration nick-fallback state. Counts ERR_NICKNAMEINUSE hits while
    // we're still trying to register; resets on every (re)connect so each socket
    // gets a fresh ladder. Once 'registered' fires we stop auto-falling back,
    // because a later 'nick in use' is the user's own /nick attempt.
    this.preRegistered = true;
    this.nickAttempt = 0;
    // Nick-regain state. When set, we're sitting on a fallback nick and have a
    // server-side MONITOR watch on the configured primary. Cleared once we
    // reclaim it, or the user manually picks a different nick, or the socket
    // dies. `pendingRegainSetup` defers the actual MONITOR + until ISUPPORT
    // tells us the server supports it (005 arrives after 001/'registered').
    this.regainNick = null;
    this.pendingRegainSetup = false;
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

    c.on('registered', (event) => {
      this.userModes.clear();
      this.lagMs = null;
      // From here on, 'nick in use' is the user's /nick attempt — not us racing
      // to register. Freeze the fallback ladder.
      this.preRegistered = false;
      // irc-framework's command-handler fires its 'all' proxy (which routes
      // events to us via the client) BEFORE its own specific-event listener
      // that updates `c.user.nick` to the registered nick. So at this moment
      // `c.user.nick` is still the configured primary — useless for detecting
      // fallback. Take the confirmed nick straight from the RPL_WELCOME payload.
      const registeredNick = event?.nick || c.user.nick;
      const fallbackUsed = this.nickAttempt > 0 && registeredNick !== this.network.nick;
      this.startLagPinger();
      this.setState('connected', { nick: registeredNick });
      if (fallbackUsed) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          text: `Connected as ${registeredNick} (configured nick ${this.network.nick} was unavailable).`,
        });
        // Defer the MONITOR + handshake until ISUPPORT tells us the server
        // supports it. 005 always follows 001, so the 'server options' handler
        // below will trip soon.
        this.regainNick = this.network.nick;
        this.pendingRegainSetup = true;
      }
      try {
        highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, registeredNick);
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
      // Next socket starts a fresh fallback ladder from the configured nick.
      this.preRegistered = true;
      this.nickAttempt = 0;
      // Drop the regain watch — the new socket will re-evaluate from scratch
      // after re-registering. (MONITOR state is server-side and dies with the
      // connection, so no explicit `MONITOR -` is needed here.)
      this.regainNick = null;
      this.pendingRegainSetup = false;
      this.setState('disconnected');
    });

    // ERR_NICKNAMEINUSE while we're still racing to register. Climb the
    // fallback ladder (nick1, nick2, …, nick9) until the server accepts a
    // NICK or we exhaust attempts. Post-registration hits are user-driven
    // /nick attempts — surface a notice and leave the user in control.
    c.on('nick in use', (event) => {
      const requested = event?.nick || '';
      if (!this.preRegistered) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          text: `Nick ${requested} is already in use.`,
        });
        return;
      }
      const next = computeFallbackNick(this.network.nick, this.nickAttempt);
      this.nickAttempt += 1;
      if (!next) {
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: `Nick ${this.network.nick} and all numeric fallbacks are taken; giving up. Edit the network to pick a different nick.`,
        });
        try { this.client.quit('No available nickname'); } catch (_) { /* ignore */ }
        return;
      }
      try { this.client.changeNick(next); } catch (_) { /* ignore */ }
    });

    // ISUPPORT (numeric 005) — irc-framework re-emits this once per line as
    // it accumulates options. We use it to defer the MONITOR + setup until
    // we know the server actually supports MONITOR (the token shows up as
    // e.g. options.MONITOR === '100', the per-connection watch limit).
    // Without this guard we'd send `MONITOR +` blind and trigger 421 on
    // older ircds, which our 'irc error' path surfaces to the user.
    c.on('server options', () => {
      if (!this.pendingRegainSetup || !this.regainNick) return;
      const opts = this.client.network?.options || {};
      if (!opts.MONITOR) return;
      this.pendingRegainSetup = false;
      try { this.client.addMonitor(this.regainNick); } catch (_) { /* ignore */ }
    });

    // RPL_MONOFFLINE: a nick we're MONITORing has gone offline. If it's the
    // primary we're trying to reclaim, race to grab it. If someone else snipes
    // us we'll get ERR_NICKNAMEINUSE post-registration (a passive notice — no
    // re-fallback) and the MONITOR watch stays live for another attempt.
    c.on('users offline', (event) => {
      if (!this.regainNick) return;
      const target = this.regainNick.toLowerCase();
      const nicks = Array.isArray(event?.nicks) ? event.nicks : [];
      const match = nicks.some((n) => typeof n === 'string' && n.toLowerCase() === target);
      if (!match) return;
      try { this.client.changeNick(this.regainNick); } catch (_) { /* ignore */ }
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
        nick: 'lurker',
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
      // Mirror the self-PART path when we ourselves are the one kicked, so
      // the buffer dims in the sidebar instead of staying styled as joined.
      // Persisting joined=false here also prevents auto-rejoin on reconnect.
      if (event.kicked && c.user.nick && event.kicked.toLowerCase() === c.user.nick.toLowerCase()) {
        this.channels.delete(event.channel.toLowerCase());
        try { upsertChannel(this.network.id, event.channel, false); } catch (_) { /* ignore */ }
        this.publish({ type: 'channel-parted', target: event.channel });
      }
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
      // irc-framework's command-handler runs the 'all' proxy (which routes
      // events to us) BEFORE its specific-event listeners. So when we receive
      // this event, `c.user.nick` is still the OLD nick — not the new one.
      // Detect self by matching the event's old nick against the current
      // tracked nick, mirroring what the framework's own listener does at
      // client.js:265 before it updates user.nick.
      const isSelfNick = !!c.user.nick && c.user.nick.toLowerCase() === oldLower;
      if (isSelfNick) {
        try {
          highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, event.new_nick);
        } catch (e) {
          console.warn('[highlight] failed to update auto nick rule:', e?.message || e);
        }
        // If a regain watch is active, tear it down on any self-nick change:
        // either we just reclaimed the primary (publish a notice), or the user
        // manually picked a different nick (their choice, drop the watch
        // silently). Either way the watch is now stale.
        if (this.regainNick) {
          const reclaimed = newLower === this.regainNick.toLowerCase();
          try { this.client.removeMonitor(this.regainNick); } catch (_) { /* ignore */ }
          if (reclaimed) {
            this.publish({
              type: 'notice',
              target: this.serverTarget(),
              nick: 'lurker',
              text: `Reclaimed nick ${this.regainNick}.`,
            });
          }
          this.regainNick = null;
          this.pendingRegainSetup = false;
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

    // irc-framework aggregates RPL_WHOIS* (311/312/317/319/330/...) into a
     // single 'whois' event when RPL_ENDOFWHOIS arrives. We fan it out as
     // motd-style lines on the server buffer so the user actually sees the
     // result of /whois (raw fall-through alone hides everything because the
     // numerics are consumed by irc-framework instead of becoming messages).
    c.on('whois', (event) => {
      if (!event || !event.nick) return;
      const lines = formatWhoisLines(event);
      for (const text of lines) {
        this.publish({ type: 'motd', target: this.serverTarget(), text });
      }
    });

    // Channel list (`/LIST`). irc-framework batches RPL_LIST every 50 rows and
    // again at RPL_LISTEND. Each batch lands in the per-network SQLite cache;
    // clients only see progress events (running count) — the actual rows are
    // fetched via the chanlist-search WS handler against the cache. Keeps a
    // 6k-row libera.chat list off the wire and out of client memory.
    c.on('channel list start', () => {
      const nid = this.network.id;
      try {
        chanlistDb.clearChannels(nid);
        chanlistDb.setMeta(nid, { inProgress: true, totalCount: 0, fetchedAt: null });
      } catch (e) {
        console.warn(`[chanlist:${nid}] start failed:`, e?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-start' });
    });
    c.on('channel list', (channels) => {
      const nid = this.network.id;
      try {
        chanlistDb.upsertChannels(nid, channels || []);
        const total = chanlistDb.countChannels(nid);
        chanlistDb.setMeta(nid, { totalCount: total, inProgress: true });
        this.publishEphemeral({ type: 'chanlist-progress', total });
      } catch (e) {
        console.warn(`[chanlist:${nid}] batch failed:`, e?.message || e);
      }
    });
    c.on('channel list end', () => {
      const nid = this.network.id;
      let total = 0;
      try {
        total = chanlistDb.countChannels(nid);
        chanlistDb.setMeta(nid, {
          inProgress: false,
          totalCount: total,
          fetchedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`[chanlist:${nid}] end failed:`, e?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-end', total });
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

  // Periodic PING with a `lurker-lag-<sent>` token. PONG echoes the token back
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
      const token = `lurker-lag-${Date.now()}`;
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
      nick: 'lurker',
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

  disconnect(reason = 'lurker shutting down') {
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

// Pure helper for the pre-registration nick-fallback ladder. The configured
// nick is attempt -1 (already tried by `connect()` itself); on each subsequent
// ERR_NICKNAMEINUSE we ask for index 0..N-1 here. Digits-only, no underscore
// dance — modern ircds allow long nicks so the legacy 9-char cap is moot, and
// `bob1` reads more clearly than `bob___`. Returns null once exhausted so the
// caller can give up and notify the user.
const NICK_FALLBACK_MAX = 9;
export function computeFallbackNick(base, attemptIndex) {
  if (!base) return null;
  if (attemptIndex < 0 || attemptIndex >= NICK_FALLBACK_MAX) return null;
  return `${base}${attemptIndex + 1}`;
}

// Render irc-framework's aggregated `whois` event into a small block of
// human-readable lines. Order roughly mirrors what other IRC clients show:
// identity → realname → host/ip → connection security → server → channels →
// modes → idle/signon → registered/account/oper/bot → secure/certfp.
function formatWhoisLines(w) {
  const lines = [];
  if (w.error === 'not_found') {
    lines.push(`whois: no such nick ${w.nick}`);
    return lines;
  }
  const userhost = [w.ident, w.hostname].filter(Boolean).join('@');
  lines.push(`whois ${w.nick}${userhost ? ` (${userhost})` : ''}`);
  if (w.real_name) lines.push(`  realname: ${w.real_name}`);
  if (w.actual_hostname || w.actual_ip) {
    const parts = [w.actual_hostname, w.actual_ip].filter(Boolean).join(' ');
    lines.push(`  host: ${parts}`);
  }
  if (w.server) {
    const info = w.server_info ? ` (${w.server_info})` : '';
    lines.push(`  server: ${w.server}${info}`);
  }
  if (w.channels) lines.push(`  channels: ${w.channels}`);
  if (w.modes) lines.push(`  modes: ${w.modes}`);
  if (w.account) lines.push(`  account: ${w.account}`);
  if (w.registered_nick) lines.push(`  registered: ${w.registered_nick}`);
  if (w.operator) lines.push(`  oper: ${w.operator}`);
  if (w.helpop) lines.push(`  helpop: ${w.helpop}`);
  if (w.bot) lines.push(`  bot: ${w.bot}`);
  if (w.secure) lines.push('  secure: yes');
  if (w.certfp) lines.push(`  certfp: ${w.certfp}`);
  if (w.away) lines.push(`  away: ${w.away}`);
  if (w.idle != null) {
    const idleSec = Number(w.idle);
    const signonStr = w.logon ? ` (signon ${new Date(Number(w.logon) * 1000).toISOString()})` : '';
    lines.push(`  idle: ${Number.isFinite(idleSec) ? `${idleSec}s` : w.idle}${signonStr}`);
  }
  return lines;
}
