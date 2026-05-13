#!/usr/bin/env node
// Visual demo of the join/part consolidation algorithm. Run with:
//
//   node scripts/consolidate-demo.js
//
// Each scenario prints two columns: the raw event stream (what the user sees
// with consolidation OFF) and the consolidated rendering (consolidation ON).
// Adjust scenarios, max-names, recent-speakers etc. to eyeball behavior in
// busy vs. sparse channels without spinning up the client.

import { consolidateMessages } from '../shared/consolidate.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

// Step a clock forward by a small random amount so timestamps look realistic
// without being important to the algorithm.
function clock(startIso = '2026-05-13T10:00:00Z') {
  let t = Date.parse(startIso);
  return () => {
    t += 1000 + Math.floor(Math.random() * 8000);
    return new Date(t).toISOString();
  };
}

// Compact, reproducible scenario builder. Each scenario gets a fresh clock
// so timestamps don't drift across runs.
function makeScenario() {
  const next = clock();
  const events = [];
  const helpers = {
    chat(nick, text) {
      events.push({ type: 'message', nick, text, time: next() });
      return helpers;
    },
    join(nick) {
      events.push({ type: 'join', nick, time: next() });
      return helpers;
    },
    part(nick, reason) {
      events.push({ type: 'part', nick, text: reason, time: next() });
      return helpers;
    },
    quit(nick, reason) {
      events.push({ type: 'quit', nick, text: reason, time: next() });
      return helpers;
    },
    nick(oldNick, newNick) {
      events.push({ type: 'nick', nick: oldNick, newNick, time: next() });
      return helpers;
    },
    kick(by, who, reason) {
      events.push({ type: 'kick', nick: by, kicked: who, text: reason, time: next() });
      return helpers;
    },
    out() {
      return events;
    },
  };
  return helpers;
}

function timeLabel(iso) {
  if (!iso) return '       ';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function rawLine(m) {
  const t = `${ANSI.dim}${timeLabel(m.time)}${ANSI.reset}`;
  switch (m.type) {
    case 'message':
      return `${t}  ${ANSI.cyan}<${m.nick}>${ANSI.reset} ${m.text || ''}`;
    case 'join':
      return `${t}  ${ANSI.green}-->${ANSI.reset} ${ANSI.dim}${m.nick} joined${ANSI.reset}`;
    case 'part':
      return `${t}  ${ANSI.dim}<-- ${m.nick} left${m.text ? ` (${m.text})` : ''}${ANSI.reset}`;
    case 'quit':
      return `${t}  ${ANSI.dim}<-- ${m.nick} quit${m.text ? ` (${m.text})` : ''}${ANSI.reset}`;
    case 'nick':
      return `${t}  ${ANSI.dim}-- ${m.nick} is now ${m.newNick}${ANSI.reset}`;
    case 'kick':
      return `${t}  ${ANSI.red}<--${ANSI.reset} ${m.kicked} kicked by ${m.nick}${m.text ? ` (${m.text})` : ''}`;
    default:
      return `${t}  ${ANSI.dim}[${m.type}]${ANSI.reset}`;
  }
}

function nameList(visible, hidden, kind) {
  const items = visible.map((v) =>
    kind === 'renamed' ? `${v.from} → ${v.to}` : v.nick,
  );
  let list;
  if (items.length === 0) list = '';
  else if (items.length === 1) list = items[0];
  else if (items.length === 2 && hidden === 0) list = `${items[0]} and ${items[1]}`;
  else list = items.join(', ');

  if (hidden > 0) {
    list += `, and ${hidden} ${hidden === 1 ? 'other' : 'others'}`;
  } else if (items.length > 2) {
    // Replace last comma-separator with ", and " for natural English.
    const idx = list.lastIndexOf(', ');
    if (idx > -1) list = list.slice(0, idx) + ', and ' + list.slice(idx + 2);
  }
  return list;
}

function groupClause(g) {
  const list = nameList(g.visible, g.hidden, g.kind);
  switch (g.kind) {
    case 'joined':         return `${list} joined`;
    case 'left':           return `${list} left`;
    case 'reconnected':    return `${list} reconnected`;
    case 'joinedAndLeft':  return `${list} joined briefly`;
    case 'renamed':        return list;
    default:               return list;
  }
}

function consolidatedLine(row) {
  if (!row.consolidation) return rawLine(row.m);
  const t = `${ANSI.dim}${timeLabel(row.time)}${ANSI.reset}`;
  const body = row.groups.map(groupClause).join('; ');
  return `${t}  ${ANSI.dim}--${ANSI.reset} ${ANSI.magenta}${body}${ANSI.reset} ${ANSI.dim}(${row.eventCount} events)${ANSI.reset}`;
}

const SEPARATOR = '─'.repeat(78);

function run(title, events, options = {}) {
  console.log(`\n${ANSI.bold}${title}${ANSI.reset}`);
  console.log(`${ANSI.dim}${SEPARATOR}${ANSI.reset}`);
  console.log(`${ANSI.yellow}raw (consolidation OFF):${ANSI.reset}`);
  for (const m of events) console.log('  ' + rawLine(m));

  const rows = consolidateMessages(events, options);
  const consolidatedCount = rows.filter((r) => r.consolidation).length;
  const optsBits = [];
  if (options.maxNames) optsBits.push(`maxNames=${options.maxNames}`);
  if (options.recentSpeakers) optsBits.push(`recentSpeakers=[${[...options.recentSpeakers].join(', ')}]`);
  const optsLabel = optsBits.length ? ` ${ANSI.dim}(${optsBits.join(', ')})${ANSI.reset}` : '';
  console.log(`\n${ANSI.green}consolidated (ON)${optsLabel}:${ANSI.reset}`);
  for (const r of rows) console.log('  ' + consolidatedLine(r));
  console.log(`${ANSI.dim}→ ${events.length} raw event(s) collapsed into ${consolidatedCount} summary line(s)${ANSI.reset}`);
}

// ───────────────────────── scenarios ────────────────────────────────────

run(
  '1. Single join (length-1 run → passthrough, no summary)',
  makeScenario().join('Alice').out(),
);

run(
  '2. Three nicks join in a row',
  makeScenario().join('Alice').join('Bob').join('Carol').out(),
);

run(
  '3. Mass join after a netsplit recovery (12 nicks)',
  (() => {
    const s = makeScenario();
    for (const n of ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Kim', 'Liam']) s.join(n);
    return s.out();
  })(),
);

run(
  '4. Flapping user (joins/quits repeatedly, ends in channel)',
  makeScenario()
    .join('Bouncy')
    .quit('Bouncy', 'ping timeout')
    .join('Bouncy')
    .quit('Bouncy', 'ping timeout')
    .join('Bouncy')
    .out(),
);

run(
  '5. Joined and immediately left (joinedAndLeft category)',
  makeScenario().join('Drifter').quit('Drifter', 'oops wrong window').out(),
);

run(
  '6. Left and rejoined (reconnected category)',
  makeScenario().quit('Regular', 'connection reset').join('Regular').out(),
);

run(
  '7. Conversation interleaved with comings/goings (runs split at chat lines)',
  makeScenario()
    .chat('Host', 'morning all')
    .join('EarlyBird')
    .chat('EarlyBird', 'hey')
    .join('Carl')
    .join('Dora')
    .quit('EarlyBird', 'lunch')
    .chat('Host', 'anyone up for a game?')
    .join('Pat')
    .quit('Carl', 'gtg')
    .nick('Dora', 'Dora_afk')
    .out(),
);

run(
  '8. Rename chain (Alice → Alice_brb → Alice_back as one identity)',
  makeScenario().nick('Alice', 'Alice_brb').nick('Alice_brb', 'Alice_back').out(),
);

run(
  '9. Mixed categories: joins + leaves + renames in one run',
  makeScenario()
    .join('Alice')
    .join('Bob')
    .quit('Dave')
    .quit('Erin')
    .nick('Frank', 'Frank_afk')
    .out(),
);

run(
  '10. Kick interrupts a run (kick is NOT consolidated)',
  makeScenario()
    .join('Alice')
    .join('Bob')
    .kick('OpUser', 'Spammer', 'no spam')
    .join('Carol')
    .join('Dave')
    .out(),
);

run(
  '11. Large channel, cap to 5 names (default)',
  (() => {
    const s = makeScenario();
    for (let i = 1; i <= 20; i++) s.join(`User${i}`);
    return s.out();
  })(),
  { maxNames: 5 },
);

run(
  '12. Same crowd, but Alice and Bob are recent speakers (prioritized)',
  (() => {
    const s = makeScenario();
    for (let i = 1; i <= 18; i++) s.join(`User${i}`);
    s.join('Alice');
    s.join('Bob');
    return s.out();
  })(),
  { maxNames: 5, recentSpeakers: ['Alice', 'Bob'] },
);

run(
  '13. Identity rename then leave (rename chain followed by part)',
  makeScenario().nick('Alice', 'Alice_afk').quit('Alice_afk', 'sleep').out(),
);

run(
  '14. Two separate runs broken by a single chat message',
  makeScenario()
    .join('Alice')
    .join('Bob')
    .chat('Existing', 'sup')
    .join('Carol')
    .quit('Alice')
    .out(),
);

console.log('');
