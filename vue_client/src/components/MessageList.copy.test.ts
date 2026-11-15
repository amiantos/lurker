// @vitest-environment happy-dom
// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Copying a stretch of the message list copies a text log (#608): whole lines,
// each with its time and nick, whatever the selection's two ends cut through.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageList from './MessageList.vue';
import { useNetworksStore } from '../stores/networks.js';
import { useBuffersStore } from '../stores/buffers.js';
import { useSettingsStore } from '../stores/settings.js';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<() => boolean>(() => true),
  socketSendWithAck: vi.fn<() => null>(() => null),
  onSocketOpen: vi.fn<() => () => void>(() => () => {}),
}));

let wrapper: VueWrapper | null = null;

function message(id: number, nick: string, second: number, text: string, type = 'message') {
  const d = new Date(2026, 9, 5, 12, 4, second);
  return {
    id,
    networkId: 1,
    bufferId: 9,
    target: '#chan',
    type,
    nick,
    text,
    time: d.toISOString(),
  };
}

function mountList(settings: Record<string, unknown> = {}) {
  useSettingsStore().values = { 'look.buffer.time_format': 'HH:mm:ss', ...settings } as never;
  const networks = useNetworksStore();
  networks.networks = [{ id: 1, name: 'testnet' }] as never;
  networks.states = { 1: { nick: 'me', state: 'connected', peerPresence: {} } } as never;
  const b = useBuffersStore().ensure(1, '#chan', 9);
  b.members = [];
  b.messages = [
    message(1, 'alice', 1, 'so I was thinking'),
    message(2, 'alice', 2, 'it has the fix'),
    message(3, 'bob', 3, 'waves', 'action'),
    message(4, 'carol', 4, '', 'join'),
    message(5, 'bob', 5, 'sure, send it over'),
  ] as never;
  b.joined = true;
  b.hasMoreOlder = false;
  b.lastReadId = 999;
  networks.activeKey = '1::#chan';
  wrapper = mount(MessageList, { attachTo: document.body });
}

// The text node holding `text` inside row `id`.
function textNode(id: number, text: string): Text {
  const row = wrapper!.find(`[data-msg-id="${id}"]`).element;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(text)) return n as Text;
  }
  throw new Error(`no "${text}" in row ${id}`);
}

function select(from: [Text, number], to: [Text, number]): void {
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

// Fire a copy and say what, if anything, the list put on the clipboard.
function copy(target: EventTarget = document.body): string | null {
  let copied: string | null = null;
  const e = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'clipboardData', {
    value: { setData: (_type: string, text: string) => (copied = text) },
  });
  target.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(copied !== null);
  return copied;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  wrapper?.unmount();
  wrapper = null;
});

describe('MessageList copy', () => {
  it('copies every touched line whole, a continuation row with its nick', () => {
    mountList();
    // From the middle of alice's first line to the middle of bob's last.
    select([textNode(1, 'thinking'), 5], [textNode(5, 'sure'), 4]);
    expect(copy()).toBe(
      [
        '[12:04:01] <alice> so I was thinking',
        '[12:04:02] <alice> it has the fix',
        '[12:04:03] * bob waves',
        '[12:04:04] --> carol joined',
        '[12:04:05] <bob> sure, send it over',
      ].join('\n'),
    );
  });

  it('writes the same lines in the compact layout', () => {
    mountList({
      'look.message.layout': 'modern',
      'look.buffer.time_format_modern': 'HH:mm',
      // The fixture's day is not today; keep the date off the compact time.
      'look.buffer.date_format_modern': '',
    });
    select([textNode(2, 'fix'), 0], [textNode(5, 'sure'), 4]);
    expect(copy()).toBe(
      [
        '[12:04] <alice> it has the fix',
        '[12:04] * bob waves',
        '[12:04] --> carol joined',
        '[12:04] <bob> sure, send it over',
      ].join('\n'),
    );
  });

  it('leaves out a line the selection only reaches the edge of', () => {
    mountList();
    // A drag that ends at the very start of bob's row, before its time.
    select([textNode(1, 'thinking'), 0], [textNode(5, '12:04:05'), 0]);
    expect(copy()?.split('\n')).toHaveLength(4);
  });

  it('copies one line whole when the selection crosses its cells', () => {
    mountList();
    select([textNode(5, 'bob'), 0], [textNode(5, 'sure'), 4]);
    expect(copy()).toBe('[12:04:05] <bob> sure, send it over');
  });

  it('leaves a selection inside one cell to the browser', () => {
    mountList();
    const body = textNode(1, 'thinking');
    select([body, 5], [body, 9]);
    expect(copy()).toBeNull();
    const nick = textNode(5, 'bob');
    select([nick, 0], [nick, 3]);
    expect(copy()).toBeNull();
  });

  it('copies a triple-clicked line whole, with its time and nick', () => {
    mountList();
    // As a triple-click leaves it: from the start of the words to the start
    // of the next row.
    const next = wrapper!.find('[data-msg-id="3"]').element;
    const range = document.createRange();
    range.setStart(textNode(2, 'it has the fix'), 0);
    range.setEnd(next, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(copy()).toBe('[12:04:02] <alice> it has the fix');
  });

  it('drops the line breaks a selection inside a line ends on', () => {
    mountList();
    const body = textNode(1, 'thinking');
    select([body, 0], [body, body.length]);
    vi.spyOn(window.getSelection()!, 'toString').mockReturnValue('so I was thinking\n\n\n\n\n\n');
    expect(copy()).toBe('so I was thinking');
  });

  it('leaves a field’s own selection to the field', () => {
    mountList();
    select([textNode(1, 'thinking'), 5], [textNode(5, 'sure'), 4]);
    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.value = 'draft';
    field.setSelectionRange(0, 5);
    expect(copy(field)).toBeNull();
    // Nothing selected in it: the copy is the list's, as the browser has it.
    field.setSelectionRange(5, 5);
    select([textNode(1, 'thinking'), 5], [textNode(5, 'sure'), 4]);
    expect(copy(field)).not.toBeNull();
    field.remove();
  });

  it('leaves a selection that runs out of the list to the browser', () => {
    mountList();
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    select([textNode(1, 'thinking'), 5], [outside.firstChild as Text, 4]);
    expect(copy()).toBeNull();
    outside.remove();
  });

  it('stops listening once unmounted', () => {
    mountList();
    select([textNode(1, 'thinking'), 5], [textNode(5, 'sure'), 4]);
    wrapper!.unmount();
    wrapper = null;
    expect(copy()).toBeNull();
  });
});
