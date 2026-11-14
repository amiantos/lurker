// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Which rows a selection covers (#608), on a page shaped like MessageList's.

import { describe, it, expect, afterEach } from 'vitest';
import { rowsInSelection } from './copyLog.js';

let root: HTMLElement | null = null;

function build(html: string): HTMLElement {
  root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function line(time: string, nick: string, body: string, timeStyle = ''): string {
  return `<div class="line"><span class="time" style="${timeStyle}">${time}</span><span class="prefix">${nick}</span><span class="body">${body}</span></div>`;
}

function text(el: Element, sel: string): Text {
  return el.querySelector(sel)!.firstChild as Text;
}

function range(from: [Node, number], to: [Node, number]): Range {
  const r = document.createRange();
  r.setStart(from[0], from[1]);
  r.setEnd(to[0], to[1]);
  return r;
}

afterEach(() => {
  root?.remove();
  root = null;
});

describe('rowsInSelection', () => {
  it('counts only the rows MessageList draws for a render row', () => {
    const el = build(
      `<div class="notice">— no older messages —</div>${line('1', 'a', 'one')}<div class="notice date-divider">Mon</div>${line('2', 'b', 'two')}`,
    );
    const rows = el.querySelectorAll('.line');
    const picked = rowsInSelection(
      el,
      range([text(rows[0]!, '.body'), 1], [text(rows[1]!, '.body'), 1]),
    );
    expect(picked).toEqual({ total: 3, indexes: [0, 1, 2], withinCell: false });
  });

  it('leaves out an end row whose only selected text is not drawn', () => {
    // Compact: an unheaded row keeps its leading time in the page, hidden.
    const el = build(line('1', 'a', 'one') + line('12:04', 'b', 'two', 'display: none'));
    const rows = el.querySelectorAll('.line');
    // A triple-click on the first body: on to the start of the next row's
    // first drawn text, past its hidden time.
    const picked = rowsInSelection(
      el,
      range([text(rows[0]!, '.body'), 0], [text(rows[1]!, '.prefix'), 0]),
    );
    expect(picked.indexes).toEqual([0]);
    expect(picked.withinCell).toBe(true);
  });

  it('leaves out an end row whose only selected text cannot be selected', () => {
    const el = build(line('1', 'a', 'one') + line('A', 'b', 'two', 'user-select: none'));
    const rows = el.querySelectorAll('.line');
    const picked = rowsInSelection(
      el,
      range([text(rows[0]!, '.body'), 0], [text(rows[1]!, '.prefix'), 0]),
    );
    expect(picked.indexes).toEqual([0]);
  });

  it('keeps a row between the ends that has no text of its own', () => {
    // A continuation row whose body is only an image.
    const el = build(line('1', 'a', 'one') + line('', '', '<img>') + line('3', 'a', 'three'));
    const rows = el.querySelectorAll('.line');
    const picked = rowsInSelection(
      el,
      range([text(rows[0]!, '.body'), 1], [text(rows[2]!, '.body'), 2]),
    );
    expect(picked.indexes).toEqual([0, 1, 2]);
  });

  it('says when the selection stays inside one cell', () => {
    const el = build(line('1', 'a', 'one two'));
    const body = text(el, '.body');
    expect(rowsInSelection(el, range([body, 0], [body, 3])).withinCell).toBe(true);
    expect(rowsInSelection(el, range([text(el, '.prefix'), 0], [body, 3])).withinCell).toBe(false);
  });
});
