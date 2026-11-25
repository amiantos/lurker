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
//   [12:04:07] <@dave> with mode prefixes shown (#1404)
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
import { quoteMarks } from '../../../shared/replies.js';
import { hidesText, parseIrcFormatting } from '../utils/nickColor.js';

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
  // The text before the list took the reply address off it (`alice: yes` drawn
  // as `yes` under a quote of alice). A log has no quote, so it writes this.
  addressedText?: string;
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
  // The speaker's `@` or `+`, when the list shows one on their nick.
  nickPrefix(m: M): string;
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

// A line's text as a log keeps it: formatting codes dropped, a spoiler written
// back as the `||…||` it was typed as, and the whitespace left alone — pasted
// code keeps its indentation, where a quote (replyText) folds it away.
function plainText(text: string): string {
  return parseIrcFormatting(text)
    .map((run) => (hidesText(run.fg, run.bg) ? `||${run.text}||` : run.text))
    .join('');
}

// A chat line the way IRC writes it (quoteMarks): `<nick> text`, `* nick text`,
// `-nick- text`. The mode prefix goes on a message alone, where the list puts
// it in every layout: `<@nick> text`.
function chatLine<M extends LogMessage>(m: M, ctx: LogContext<M>): string {
  const [open, close] = quoteMarks(m.type);
  const text = m.redaction
    ? redactionLabel(m.redaction, m.nick)
    : plainText(m.addressedText ?? m.text ?? '');
  const source = m.relaySource ? `[${m.relaySource}] ` : '';
  const rank = m.type === 'message' ? ctx.nickPrefix(m) : '';
  return `${open}${rank}${m.nick ?? ''}${close} ${source}${text}`.trimEnd();
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
    return stamped(time, chatLine(m, ctx));
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

// Text the reader cannot have highlighted: not drawn (the compact layout keeps
// an unheaded row's leading time in the page and hides it) or not selectable
// (an avatar's initial).
function unselectable(node: Node, within: Element): boolean {
  const view = within.ownerDocument.defaultView;
  for (let el = node.parentElement; el && view; el = el.parentElement) {
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.userSelect === 'none') return true;
    if (el === within) break;
  }
  return false;
}

// Whether any text the reader could highlight inside `el` is in the selection.
// A range that only reaches the edge of `el` (a drag, or a triple-click, that
// ends at the start of the next row) intersects it and selects nothing in it.
function touches(range: Range, el: Element): boolean {
  if (!range.intersectsNode(el)) return false;
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const part = doc.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    if (part.toString().trim() !== '' && !unselectable(node, el)) return true;
  }
  return false;
}

// A selection's text without the line breaks at its edges. A triple-click runs
// the selection on to the start of the next row, and the browser copies a line
// break for every block it passed on the way: one in Chrome, and in Safari one
// more per hover button, so a line pasted with six empty lines under it. Spaces
// at the edges of a selection that has no line break there are the reader's
// and stay.
export function trimBlankEdges(text: string): string {
  return text.replace(/^\s*\n\s*|\s*\n\s*$/g, '');
}

export interface RowSelection {
  // How many row elements the scroller holds: the caller checks it against its
  // own row count before trusting an index.
  total: number;
  // The rows the selection covers, as indexes into the render rows: from the
  // first with selected text in it to the last. Only the two ends are asked
  // for text — a row between them is covered whether or not it has any (a
  // line that is only an image has none).
  indexes: number[];
  // The selection sits inside a single cell of a single row, and is a part of
  // it: a word, a nick, a link. A whole line taken at once (a triple-click) is
  // a line of the log like any other.
  withinCell: boolean;
}

// What a row's body holds besides the line's own words.
const BODY_EXTRAS = '.reply-quote, .attachments, .reaction-row, .thread-chip, .time';

// Whether the selection is the row's whole text, taken the way a triple-click
// takes it: from the start of the words on past their end, to wherever the
// next block begins. A drag across the same words ends inside them, and stays
// a part — it is how a reader copies a line that is only a link.
function wholeLine(range: Range, row: Element): boolean {
  const body = row.querySelector(':scope > .body');
  if (!body) return false;
  const doc = row.ownerDocument;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let first: Node | null = null;
  let last: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || node.parentElement?.closest(BODY_EXTRAS)) continue;
    if (unselectable(node, body)) continue;
    first ??= node;
    last = node;
  }
  if (!first || !last) return false;
  const words = doc.createRange();
  words.setStart(first, 0);
  words.setEnd(last, last.textContent?.length ?? 0);
  return (
    range.compareBoundaryPoints(Range.START_TO_START, words) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, words) > 0
  );
}

export function rowsInSelection(root: Element, range: Range): RowSelection {
  const rows = Array.from(root.children).filter((el) => el.matches(ROW_SELECTOR));
  let first = rows.findIndex((el) => range.intersectsNode(el));
  let last = rows.findLastIndex((el) => range.intersectsNode(el));
  while (first !== -1 && first <= last && !touches(range, rows[first]!)) first++;
  while (last > first && !touches(range, rows[last]!)) last--;
  const indexes: number[] = [];
  for (let i = first; i !== -1 && i <= last; i++) indexes.push(i);
  let withinCell = false;
  if (indexes.length === 1) {
    const row = rows[indexes[0]!]!;
    const cells = Array.from(row.querySelectorAll(CELL_SELECTOR));
    withinCell = cells.filter((cell) => touches(range, cell)).length <= 1 && !wholeLine(range, row);
  }
  return { total: rows.length, indexes, withinCell };
}
