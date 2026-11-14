// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Copying out of the message list as a text log (#608).
//
// A row is a grid of cells (time, nick, body), so the browser's own copy puts
// each cell on a line of its own, leaves the nick off every line of an
// author's run after the first, and takes reactions, previews and thread chips
// along. So a copy that reaches across cells is written from the rows instead
// of from the page: every row the selection touches, whole, one per line, as
// IRC logs write them.
//
//   [12:04:05] <alice> what she said
//   [12:04:09] * bob waves
//   [12:05:00] --> carol joined
//
// Two halves: which rows a selection touches (the DOM half), and what a row
// reads as (the text half, which knows nothing of the page).

import { stripFormatting } from '../../../shared/textMatch.js';
import { redactionLabel, type Redaction } from '../../../shared/redaction.js';
import { describeMode } from '../../../shared/modeNarration.js';
import type { ModeChange } from '../../../shared/modes.js';
import type { ConsolidationGroup, NickEntry, RenameEntry } from '../../../shared/consolidate.js';
import { copyQuoteFor } from '../utils/replyText.js';

export interface LogMessage {
  type: string;
  nick?: string;
  text?: string;
  time?: string;
  newNick?: string;
  kicked?: string;
  invited?: string;
  modes?: ModeChange[];
  redaction?: Redaction;
  relaySource?: string | null;
}

export interface LogRow<M extends LogMessage> {
  m?: M;
  divider?: string;
  dateStr?: string;
  consolidation?: boolean;
  groups?: ConsolidationGroup[];
  time?: string;
}

// What the list already decides per row and a log line repeats rather than
// decides again: the reader's time format, the event marks (`-->`, `--`, the
// system line's network), and the settings-gated suffixes.
export interface LogContext<M extends LogMessage> {
  time(iso: string | undefined): string;
  prefix(m: M): string;
  hostSuffix(m: M): string;
  accountSuffix(m: M): string;
  newMask(m: M): string;
  modePhrase(g: ConsolidationGroup): string;
}

function stamped(time: string, rest: string): string {
  return time ? `[${time}] ${rest}` : rest;
}

function reason(text: string | undefined): string {
  return text ? ` (${stripFormatting(text)})` : '';
}

// A chat line, by the rule Copy quote reads by (copyQuoteFor): `<nick> text`,
// `* nick text`, `-nick- text`, formatting dropped and a spoiler kept `||…||`.
function chatLine(m: LogMessage): string {
  const text = m.redaction ? redactionLabel(m.redaction, m.nick) : (m.text ?? '');
  const source = m.relaySource ? `[${m.relaySource}] ` : '';
  return copyQuoteFor({ nick: m.nick ?? '', type: m.type, text: source + text });
}

// An event line's words, as the list prints them after the mark.
function eventBody<M extends LogMessage>(m: M, ctx: LogContext<M>): string {
  const nick = m.nick ?? '';
  switch (m.type) {
    case 'join':
      return `${nick}${ctx.accountSuffix(m)}${ctx.hostSuffix(m)} joined`;
    case 'part':
      return `${nick}${ctx.hostSuffix(m)} left${reason(m.text)}`;
    case 'quit':
      return `${nick}${ctx.hostSuffix(m)} quit${reason(m.text)}`;
    case 'chghost':
      return `${nick}${ctx.hostSuffix(m)} changed host to ${ctx.newMask(m)}`;
    case 'kick':
      return `${m.kicked ?? ''} kicked by ${nick}${reason(m.text)}`;
    case 'invite':
      return `${nick} invited ${m.invited ?? ''}`;
    case 'nick':
      return `${nick} is now ${m.newNick ?? ''}${ctx.hostSuffix(m)}`;
    case 'mode':
      return (
        nick +
        describeMode(m.modes, m.text)
          .map((seg) => (seg.t === 'nick' ? seg.nick : seg.text))
          .join('')
      );
    case 'topic':
      return `topic set by ${nick}${m.text ? `: ${stripFormatting(m.text)}` : ''}`;
    default:
      return stripFormatting(m.text ?? '');
  }
}

const GROUP_WORDS: Partial<Record<ConsolidationGroup['kind'], string>> = {
  joined: ' joined',
  left: ' left',
  reconnected: ' reconnected',
  joinedAndLeft: ' joined briefly',
  rehosted: ' changed host',
};

// A folded run of joins, parts and mode changes, in the list's own words.
function consolidationBody<M extends LogMessage>(
  groups: ConsolidationGroup[],
  ctx: LogContext<M>,
): string {
  return groups
    .map((g) => {
      let out = '';
      g.visible.forEach((item, i) => {
        if (i > 0) out += i === g.visible.length - 1 && g.hidden === 0 ? ' and ' : ', ';
        out +=
          g.kind === 'renamed'
            ? `${(item as RenameEntry).from} → ${(item as RenameEntry).to}`
            : (item as NickEntry).nick;
      });
      if (g.hidden > 0) out += `, and ${g.hidden} ${g.hidden === 1 ? 'other' : 'others'}`;
      return out + (GROUP_WORDS[g.kind] ?? (g.letter ? ctx.modePhrase(g) : ''));
    })
    .join('; ');
}

// One row as one log line, or null for a row a log has no line for (the
// unread, away and cleared markers).
export function logLine<M extends LogMessage>(row: LogRow<M>, ctx: LogContext<M>): string | null {
  if (row.divider) return row.divider === 'date' && row.dateStr ? `--- ${row.dateStr} ---` : null;
  if (row.consolidation) {
    return stamped(ctx.time(row.time), `-- ${consolidationBody(row.groups ?? [], ctx)}`);
  }
  const m = row.m;
  if (!m) return null;
  const time = ctx.time(m.time);
  if (m.type === 'message' || m.type === 'notice' || m.type === 'action') {
    return stamped(time, chatLine(m));
  }
  const mark = ctx.prefix(m);
  const body = eventBody(m, ctx);
  return stamped(time, mark ? `${mark} ${body}` : body);
}

// Every element MessageList draws for a render row, and nothing else it draws:
// the scroller's children that match are the render rows, one each, in order.
const ROW_SELECTOR = '.line, .unread-divider, .presence-divider, .date-divider, .cleared-divider';
// A row's cells. A selection that stays inside one is the reader copying a
// word, a nick or a link, and is the browser's to copy.
const CELL_SELECTOR =
  ':scope > .time, :scope > .prefix, :scope > .body, :scope > .head > .prefix, :scope > .head > .relay-source, :scope > .head > .time';

// The part of the selection that falls inside `el`, as text.
function selectedTextIn(range: Range, el: Element): string {
  const part = el.ownerDocument.createRange();
  part.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.toString();
}

function touches(range: Range, el: Element): boolean {
  return range.intersectsNode(el) && selectedTextIn(range, el).trim() !== '';
}

export interface RowSelection {
  // How many row elements the scroller holds: the caller checks it against its
  // own row count before trusting an index.
  total: number;
  // The rows with selected text in them, as indexes into the render rows. A
  // row the selection only reaches the edge of (a drag that ends at the start
  // of the next line) is not one.
  indexes: number[];
  // The selection sits inside a single cell of a single row.
  withinCell: boolean;
}

export function rowsInSelection(root: Element, range: Range): RowSelection {
  const rows = Array.from(root.children).filter((el) => el.matches(ROW_SELECTOR));
  const indexes: number[] = [];
  rows.forEach((el, i) => {
    if (touches(range, el)) indexes.push(i);
  });
  let withinCell = false;
  if (indexes.length === 1) {
    const cells = Array.from(rows[indexes[0]!]!.querySelectorAll(CELL_SELECTOR));
    withinCell = cells.filter((cell) => touches(range, cell)).length <= 1;
  }
  return { total: rows.length, indexes, withinCell };
}
