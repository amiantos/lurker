// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let insertMessage: typeof import('./messages.js').insertMessage;
let listMessages: typeof import('./messages.js').listMessages;
let listMessagesAround: typeof import('./messages.js').listMessagesAround;
let searchMessages: typeof import('./messages.js').searchMessages;
let countNewer: typeof import('./messages.js').countNewer;
let countHighlightsNewer: typeof import('./messages.js').countHighlightsNewer;
let listUserHighlights: typeof import('./messages.js').listUserHighlights;
let maxIdForBuffer: typeof import('./messages.js').maxIdForBuffer;
let hasConversationForTarget: typeof import('./messages.js').hasConversationForTarget;
let listSpeakers: typeof import('./messages.js').listSpeakers;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({
    insertMessage,
    listMessages,
    listMessagesAround,
    searchMessages,
    countNewer,
    countHighlightsNewer,
    listUserHighlights,
    maxIdForBuffer,
    hasConversationForTarget,
    listSpeakers,
  } = await import('./messages.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function chat(networkId: number, target: string, nick: string, text: string, type = 'message') {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type,
    nick,
    text,
    self: false,
  });
  return { id: Number(result.id), alt: result.alt };
}

function event(networkId: number, target: string, type: string, nick: string | null = null) {
  const result = insertMessage({
    networkId,
    target,
    time: new Date().toISOString(),
    type,
    nick,
    self: false,
  });
  return { id: Number(result.id), alt: result.alt };
}

function altsFor(networkId: number, target: string) {
  return listMessages(networkId, target, { limit: 1000 }).map((m) => m.alt);
}

describe('hasConversationForTarget (#439)', () => {
  it('is true only when a non-notice message exists for the target', () => {
    const user = createUser('conv-target');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'conv-target',
    });
    // Notice-only buffer (a service) → not a conversation.
    chat(net!.id, 'NickServ', 'NickServ', 'you are now identified', 'notice');
    expect(hasConversationForTarget(net!.id, 'NickServ')).toBe(false);
    // A real PRIVMSG promotes it to a conversation; an ACTION counts too.
    chat(net!.id, 'bob', 'bob', 'hey there');
    expect(hasConversationForTarget(net!.id, 'bob')).toBe(true);
    chat(net!.id, 'carol', 'carol', 'waves', 'action');
    expect(hasConversationForTarget(net!.id, 'carol')).toBe(true);
    // Case-insensitive match; unknown target is false.
    expect(hasConversationForTarget(net!.id, 'BOB')).toBe(true);
    expect(hasConversationForTarget(net!.id, 'nobody')).toBe(false);
  });
});

describe('listSpeakers', () => {
  function net() {
    const user = createUser(`spk-${Math.random().toString(36).slice(2)}`);
    return createNetwork(user.id, { name: 'n', host: 'h', port: 6697, tls: true, nick: 'me' })!.id;
  }

  it('returns recent distinct speakers, case-folded, excluding self and non-chat', () => {
    const n = net();
    chat(n, '#c', 'Alice', 'hi');
    chat(n, '#c', 'alice', 'again'); // same speaker, divergent case → one entry
    chat(n, '#c', 'Bob', 'yo');
    event(n, '#c', 'join', 'Carol'); // non-chat → not a speaker
    insertMessage({
      networkId: n,
      target: '#c',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'me',
      text: 'self line',
      self: true, // our own line → excluded
    });
    const nicks = listSpeakers(n, '#c').map((s) => s.nick.toLowerCase());
    expect(new Set(nicks)).toEqual(new Set(['alice', 'bob']));
  });

  it('bounds the scan to the recent window — older speakers outside it drop off', () => {
    const n = net();
    chat(n, '#c', 'oldtimer', 'first'); // oldest chat line
    for (let i = 0; i < 5; i++) chat(n, '#c', `recent${i}`, 'x');
    // With a scan window of 3, only the 3 newest rows are considered, so
    // 'oldtimer' (6 rows back) is excluded even though it's real chat history.
    const nicks = listSpeakers(n, '#c', 20, 3).map((s) => s.nick);
    expect(nicks).not.toContain('oldtimer');
    // Unbounded (default window) still finds it.
    expect(listSpeakers(n, '#c').map((s) => s.nick)).toContain('oldtimer');
  });
});

describe('messages.alt parity', () => {
  it('alternates alt for chat-shaped types within a buffer', () => {
    const user = createUser('parity-basic');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-basic',
    });
    chat(net!.id, '#a', 'alice', 'one');
    chat(net!.id, '#a', 'bob', 'two');
    chat(net!.id, '#a', 'alice', 'three');
    chat(net!.id, '#a', 'bob', 'four');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false, true]);
  });

  it('does not flip parity on system events', () => {
    const user = createUser('parity-events');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-events',
    });
    chat(net!.id, '#a', 'alice', 'one');
    event(net!.id, '#a', 'join', 'carol');
    event(net!.id, '#a', 'part', 'carol');
    chat(net!.id, '#a', 'bob', 'two');
    event(net!.id, '#a', 'mode');
    chat(net!.id, '#a', 'alice', 'three');

    const events = listMessages(net!.id, '#a', { limit: 1000 });
    const chatAlts = events
      .filter((m) => ['message', 'action', 'notice'].includes(m.type))
      .map((m) => m.alt);
    expect(chatAlts).toEqual([false, true, false]);
    const sysAlts = events
      .filter((m) => !['message', 'action', 'notice'].includes(m.type))
      .map((m) => m.alt);
    expect(sysAlts.every((a) => a === false)).toBe(true);
  });

  it('tracks parity independently per buffer', () => {
    const user = createUser('parity-isolation');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-isolation',
    });
    chat(net!.id, '#a', 'alice', 'a1');
    chat(net!.id, '#b', 'alice', 'b1');
    chat(net!.id, '#a', 'alice', 'a2');
    chat(net!.id, '#b', 'alice', 'b2');
    chat(net!.id, '#a', 'alice', 'a3');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false]);
    expect(altsFor(net!.id, '#b')).toEqual([false, true]);
  });

  it('treats action and notice as striped types', () => {
    const user = createUser('parity-actions');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-actions',
    });
    chat(net!.id, '#a', 'alice', 'one', 'message');
    chat(net!.id, '#a', 'alice', 'two', 'action');
    chat(net!.id, '#a', 'alice', 'three', 'notice');
    chat(net!.id, '#a', 'alice', 'four', 'message');
    expect(altsFor(net!.id, '#a')).toEqual([false, true, false, true]);
  });
});

describe('searchMessages', () => {
  it('excludes mirrored server-buffer copies but keeps the real copy (#439)', () => {
    const user = createUser('search-mirror');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-mirror',
    });
    // The real copy in the sender's (closed) buffer, plus the mirrored duplicate
    // in the server buffer — same text. Search must return only the real one.
    insertMessage({
      networkId: net!.id,
      target: 'NickServ',
      time: new Date().toISOString(),
      type: 'notice',
      nick: 'NickServ',
      text: 'your unique-cloak-token is set',
      self: false,
    });
    insertMessage({
      networkId: net!.id,
      target: `:server:${net!.id}`,
      time: new Date().toISOString(),
      type: 'notice',
      nick: 'NickServ',
      text: 'your unique-cloak-token is set',
      self: false,
      mirrored: true,
    });
    const hits = searchMessages(user.id, { query: 'unique-cloak-token' });
    expect(hits).toHaveLength(1);
    expect(hits[0].target).toBe('NickServ');
  });

  it('matches free text against message bodies', () => {
    const user = createUser('search-text');
    const net = createNetwork(user.id, {
      name: 'libera',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-text',
    });
    chat(net!.id, '#a', 'alice', 'the release deadline is friday');
    chat(net!.id, '#a', 'bob', 'unrelated chatter');
    chat(net!.id, '#a', 'carol', 'another deadline slipped');

    const hits = searchMessages(user.id, { query: 'deadline' });
    expect(hits.map((m) => m.text).toSorted()).toEqual([
      'another deadline slipped',
      'the release deadline is friday',
    ]);
  });

  it('ANDs multiple free-text terms', () => {
    const user = createUser('search-and');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-and',
    });
    chat(net!.id, '#a', 'alice', 'release deadline friday');
    chat(net!.id, '#a', 'bob', 'deadline only');

    const hits = searchMessages(user.id, { query: 'release deadline' });
    expect(hits.map((m) => m.text)).toEqual(['release deadline friday']);
  });

  it('filters by nick (from:)', () => {
    const user = createUser('search-nick');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-nick',
    });
    chat(net!.id, '#a', 'alice', 'hello world');
    chat(net!.id, '#a', 'bob', 'hello world');

    const hits = searchMessages(user.id, { query: 'hello', nick: 'ALICE' });
    expect(hits.map((m) => m.nick)).toEqual(['alice']);
  });

  it('filters by target (in:)', () => {
    const user = createUser('search-target');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-target',
    });
    chat(net!.id, '#a', 'alice', 'ping');
    chat(net!.id, '#b', 'alice', 'ping');

    const hits = searchMessages(user.id, { query: 'ping', target: '#A' });
    expect(hits.map((m) => m.target)).toEqual(['#a']);
  });

  it('filters by networkId (on:)', () => {
    const user = createUser('search-network');
    const netA = createNetwork(user.id, {
      name: 'a',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-network',
    });
    const netB = createNetwork(user.id, {
      name: 'b',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-network',
    });
    chat(netA!.id, '#a', 'alice', 'shared word');
    chat(netB!.id, '#a', 'alice', 'shared word');

    const hits = searchMessages(user.id, { query: 'shared', networkId: netB!.id });
    expect(hits.map((m) => m.networkId)).toEqual([netB!.id]);
  });

  it('supports a structured-only query with no free text', () => {
    const user = createUser('search-structured');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-structured',
    });
    chat(net!.id, '#a', 'alice', 'first');
    chat(net!.id, '#a', 'alice', 'second');
    chat(net!.id, '#a', 'bob', 'third');

    const hits = searchMessages(user.id, { nick: 'alice' });
    expect(hits.map((m) => m.text).toSorted()).toEqual(['first', 'second']);
  });

  it('OR-matches several nicks via `nicks`, case-insensitively', () => {
    const user = createUser('search-nicks');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-nicks',
    });
    chat(net!.id, '#a', 'eren', 'one');
    chat(net!.id, '#a', 'nostimo', 'two');
    chat(net!.id, '#a', 'twomoon', 'three');
    chat(net!.id, '#a', 'stranger', 'four');

    const hits = searchMessages(user.id, { nicks: ['EREN', 'nostimo'] });
    expect(hits.map((m) => m.text).toSorted()).toEqual(['one', 'two']);
  });

  it('returns nothing when there is no free text and no filter', () => {
    const user = createUser('search-empty');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-empty',
    });
    chat(net!.id, '#a', 'alice', 'something');
    expect(searchMessages(user.id, { query: '   ' })).toEqual([]);
  });

  it('excludes non-chat event types', () => {
    const user = createUser('search-types');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-types',
    });
    chat(net!.id, '#a', 'alice', 'topic about widgets');
    insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'topic',
      nick: 'alice',
      text: 'widgets channel topic',
      self: false,
    });

    const hits = searchMessages(user.id, { query: 'widgets' });
    expect(hits.map((m) => m.type)).toEqual(['message']);
  });

  it("never returns another user's messages", () => {
    const userA = createUser('search-iso-a');
    const userB = createUser('search-iso-b');
    const netA = createNetwork(userA.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-iso-a',
    });
    const netB = createNetwork(userB.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-iso-b',
    });
    chat(netA!.id, '#a', 'alice', 'secret keyword apple');
    chat(netB!.id, '#a', 'bob', 'secret keyword apple');

    const hitsA = searchMessages(userA.id, { query: 'apple' });
    expect(hitsA.map((m) => m.networkId)).toEqual([netA!.id]);
    // Even an explicit networkId for a network they don't own returns nothing.
    expect(searchMessages(userA.id, { query: 'apple', networkId: netB!.id })).toEqual([]);
  });

  it('paginates newest-first via the before cursor', () => {
    const user = createUser('search-page');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-page',
    });
    for (let i = 1; i <= 5; i += 1) chat(net!.id, '#a', 'alice', `page item ${i}`);

    const firstPage = searchMessages(user.id, { query: 'item', limit: 2 });
    expect(firstPage.map((m) => m.text)).toEqual(['page item 5', 'page item 4']);

    const secondPage = searchMessages(user.id, {
      query: 'item',
      limit: 2,
      before: firstPage[firstPage.length - 1].id,
    });
    expect(secondPage.map((m) => m.text)).toEqual(['page item 3', 'page item 2']);
  });

  it('includes the network name on each result', () => {
    const user = createUser('search-netname');
    const net = createNetwork(user.id, {
      name: 'OFTC',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-netname',
    });
    chat(net!.id, '#a', 'alice', 'banana split');
    const hits = searchMessages(user.id, { query: 'banana' });
    expect(hits[0].networkName).toBe('OFTC');
  });

  it('excludes from_ignored senders', () => {
    const user = createUser('search-ignored');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'search-ignored',
    });
    chat(net!.id, '#a', 'alice', 'shared keyword here');
    insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'spammer',
      text: 'shared keyword here',
      self: false,
      fromIgnored: true,
    });

    // Free-text search skips the ignored row...
    expect(searchMessages(user.id, { query: 'keyword' }).map((m) => m.nick)).toEqual(['alice']);
    // ...and so does a structured-only filter (no FTS join).
    expect(searchMessages(user.id, { target: '#a' }).map((m) => m.nick)).toEqual(['alice']);
  });
});

describe('searchMessages matched (highlights)', () => {
  function hl(networkId: number, nick: string, text: string, matched: number | null) {
    return insertMessage({
      networkId,
      target: '#hl',
      time: new Date().toISOString(),
      type: 'message',
      nick,
      text,
      self: false,
      matchedRuleId: matched,
    });
  }

  it('returns only matched rows, and all of them with no other filter', () => {
    const user = createUser('hl-matched');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'hl-matched',
    })!;
    hl(net.id, 'alice', 'a highlight', 7);
    hl(net.id, 'bob', 'not a highlight', null);
    hl(net.id, 'carol', 'another highlight', 9);

    const hits = searchMessages(user.id, { matched: true });
    expect(hits.map((m) => m.nick).toSorted()).toEqual(['alice', 'carol']);
  });

  it('combines matched with free text and from:/in: filters', () => {
    const user = createUser('hl-matched-filter');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'hl-matched-filter',
    })!;
    hl(net.id, 'alice', 'deploy finished', 7);
    hl(net.id, 'bob', 'deploy finished', 7);
    hl(net.id, 'alice', 'lunch plans', 7);

    expect(searchMessages(user.id, { matched: true, nick: 'alice' }).map((m) => m.text)).toEqual([
      'lunch plans',
      'deploy finished',
    ]);
    expect(
      searchMessages(user.id, { matched: true, query: 'deploy', nick: 'alice' }).map((m) => m.text),
    ).toEqual(['deploy finished']);
  });
});

describe('listMessagesAround', () => {
  it('centers a slice on the anchor with hasMore=false when total fits in halfLimit', () => {
    const user = createUser('around-fits');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-fits',
    });
    const ids = [];
    for (let i = 1; i <= 101; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[50]; // 51st insert, 50 older + 50 newer

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events.length).toBe(101);
    expect(slice.events[50].id).toBe(anchorId);
    expect(slice.hasMoreOlder).toBe(false);
    expect(slice.hasMoreNewer).toBe(false);
  });

  it('truncates to halfLimit on each side with both hasMore flags true', () => {
    const user = createUser('around-trunc');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-trunc',
    });
    const ids = [];
    for (let i = 1; i <= 1001; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[500];

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events.length).toBe(201);
    expect(slice.events[100].id).toBe(anchorId);
    expect(slice.hasMoreOlder).toBe(true);
    expect(slice.hasMoreNewer).toBe(true);
  });

  it('returns hasMoreOlder=false when the anchor is the oldest message', () => {
    const user = createUser('around-top');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-top',
    });
    const ids = [];
    for (let i = 1; i <= 100; i += 1) ids.push(chat(net!.id, '#a', 'alice', `m${i}`).id);
    const anchorId = ids[0];

    const slice = listMessagesAround(net!.id, '#a', anchorId, 100);
    expect(slice.events[0].id).toBe(anchorId);
    expect(slice.events.length).toBe(100); // 0 older + anchor + 99 newer
    expect(slice.hasMoreOlder).toBe(false);
    expect(slice.hasMoreNewer).toBe(false);
  });

  it('returns anchorMissing when the id does not exist in the buffer', () => {
    const user = createUser('around-missing');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-missing',
    });
    chat(net!.id, '#a', 'alice', 'one');

    const slice = listMessagesAround(net!.id, '#a', 9999999, 100);
    expect((slice as { anchorMissing?: boolean }).anchorMissing).toBe(true);
    expect(slice.events).toEqual([]);
  });

  it('refuses to lift a row out of a buffer the caller did not name', () => {
    // Anchor exists in #a but the caller asks for it scoped to #b. The
    // (network_id, target) guard on the anchor lookup is the access boundary
    // here — without it, knowing any message id would expose its content via
    // jump-to-message regardless of which buffer was queried.
    const user = createUser('around-scope');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'around-scope',
    });
    const aId = chat(net!.id, '#a', 'alice', 'private').id;
    chat(net!.id, '#b', 'bob', 'unrelated');

    const slice = listMessagesAround(net!.id, '#b', aId, 100);
    expect((slice as { anchorMissing?: boolean }).anchorMissing).toBe(true);
  });
});

describe('messages.alt parity (insert result)', () => {
  it('returns alt on the insert result', () => {
    const user = createUser('parity-return');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'parity-return',
    });
    const first = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'alice',
      text: 'hi',
      self: false,
    });
    const second = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'message',
      nick: 'bob',
      text: 'hi',
      self: false,
    });
    const sysEvt = insertMessage({
      networkId: net!.id,
      target: '#a',
      time: new Date().toISOString(),
      type: 'join',
      nick: 'carol',
      self: false,
    });
    expect(first.alt).toBe(false);
    expect(second.alt).toBe(true);
    expect(sysEvt.alt).toBe(false);
  });
});

describe('from_ignored excludes ignored senders from unread/highlight counts', () => {
  function chatWith(
    networkId: number,
    opts: { nick: string; matched?: number; ignored?: boolean },
  ) {
    return insertMessage({
      networkId,
      target: '#ig',
      time: new Date().toISOString(),
      type: 'message',
      nick: opts.nick,
      text: 'hello',
      self: false,
      matchedRuleId: opts.matched ?? null,
      fromIgnored: opts.ignored === true,
    });
  }

  it('countNewer excludes from_ignored rows', () => {
    const user = createUser('ig-count');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice' });
    chatWith(net.id, { nick: 'spammer', ignored: true });
    chatWith(net.id, { nick: 'bob' });
    expect(countNewer(net.id, '#ig', 0)).toBe(2);
  });

  it('countHighlightsNewer excludes from_ignored rows even when they matched a rule', () => {
    const user = createUser('ig-hl-count');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice', matched: 7 });
    chatWith(net.id, { nick: 'spammer', matched: 7, ignored: true });
    chatWith(net.id, { nick: 'bob', matched: 7 });
    expect(countHighlightsNewer(net.id, '#ig', 0)).toBe(2);
  });

  it('listUserHighlights hides from_ignored rows', () => {
    const user = createUser('ig-hl-list');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice', matched: 7 });
    chatWith(net.id, { nick: 'spammer', matched: 7, ignored: true });
    const items = listUserHighlights(user.id);
    expect(items.map((r) => r.nick)).toEqual(['alice']);
  });

  it('fromIgnored round-trips through rowToEvent', () => {
    const user = createUser('ig-roundtrip');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chatWith(net.id, { nick: 'alice' });
    chatWith(net.id, { nick: 'spammer', ignored: true });
    const rows = listMessages(net.id, '#ig', { limit: 50 });
    expect(rows.map((r) => ({ nick: r.nick, fromIgnored: r.fromIgnored }))).toEqual([
      { nick: 'alice', fromIgnored: false },
      { nick: 'spammer', fromIgnored: true },
    ]);
  });
});

describe('maxIdForBuffer', () => {
  it('returns 0 for a buffer with no rows', () => {
    const user = createUser('mfb-empty');
    const net = createNetwork(user.id, {
      name: 'n',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    expect(maxIdForBuffer(net.id, '#nope')).toBe(0);
  });

  it('returns the largest id in the buffer, ignoring other targets and networks', () => {
    const user = createUser('mfb-multi');
    const net1 = createNetwork(user.id, {
      name: 'n1',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    const net2 = createNetwork(user.id, {
      name: 'n2',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'me',
    })!;
    chat(net1.id, '#a', 'alice', 'a1');
    const a2 = chat(net1.id, '#a', 'alice', 'a2');
    chat(net1.id, '#b', 'bob', 'b1');
    chat(net2.id, '#a', 'eve', 'e1');
    expect(maxIdForBuffer(net1.id, '#a')).toBe(a2.id);
  });
});
