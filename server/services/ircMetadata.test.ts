// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The pure half of IRCv3 metadata (#607): what the cap says, how the three
// line shapes parse, and what a value has to be to reach state.

import { describe, it, expect } from 'vitest';
import {
  METADATA_SUB_KEYS,
  channelMetadataView,
  metadataSubKeysFor,
  ownMetadataToSave,
  parseMetadataLimits,
  parseMetadataLine,
  parseOwnMetadataWrite,
  sizedAvatarUrl,
  userMetadataView,
  vetMetadataValue,
} from './ircMetadata.js';

describe('the cap value', () => {
  it('reads the limits ergo advertises', () => {
    expect(
      parseMetadataLimits('before-connect,max-subs=100,max-keys=50,max-value-bytes=1024'),
    ).toEqual({ maxSubs: 100, maxKeys: 50, maxValueBytes: 1024, beforeConnect: true });
  });
  it('reads nothing into a bare cap', () => {
    expect(parseMetadataLimits(undefined)).toEqual({
      maxSubs: null,
      maxKeys: null,
      maxValueBytes: null,
      beforeConnect: false,
    });
    expect(parseMetadataLimits('foo,bar=baz')).toMatchObject({ maxSubs: null });
  });
  it('trims the SUB list to max-subs, most wanted first', () => {
    expect(metadataSubKeysFor(parseMetadataLimits(undefined))).toEqual(METADATA_SUB_KEYS);
    expect(metadataSubKeysFor(parseMetadataLimits('max-subs=2'))).toEqual([
      'display-name',
      'avatar',
    ]);
    expect(metadataSubKeysFor(parseMetadataLimits('max-subs=0'))).toEqual([]);
  });
});

describe('the three line shapes', () => {
  it('reads the draft-2 METADATA message, three params being an unset', () => {
    expect(parseMetadataLine('METADATA', ['bob', 'avatar', '*', 'https://x/a.png'])).toEqual({
      target: 'bob',
      key: 'avatar',
      value: 'https://x/a.png',
    });
    expect(parseMetadataLine('METADATA', ['bob', 'avatar', '*'])).toEqual({
      target: 'bob',
      key: 'avatar',
      value: null,
    });
  });
  it("reads ergo's 761 and 766, whoever the asker param names", () => {
    expect(parseMetadataLine('761', ['*', 'bob', 'display-name', '*', 'Bob the Builder'])).toEqual({
      target: 'bob',
      key: 'display-name',
      value: 'Bob the Builder',
    });
    expect(parseMetadataLine('761', ['me', '#chan', 'display-name', '*', 'The Chan'])).toEqual({
      target: '#chan',
      key: 'display-name',
      value: 'The Chan',
    });
    expect(parseMetadataLine('766', ['*', 'bob', 'display-name', 'Key deleted'])).toEqual({
      target: 'bob',
      key: 'display-name',
      value: null,
    });
    // A WHOIS line is current too.
    expect(parseMetadataLine('760', ['me', 'bob', 'pronouns', '*', 'they/them'])).toEqual({
      target: 'bob',
      key: 'pronouns',
      value: 'they/them',
    });
  });
  it('is not fooled by anything else', () => {
    expect(parseMetadataLine('770', ['me', 'avatar'])).toBeNull();
    expect(parseMetadataLine('761', ['*'])).toBeNull();
    expect(parseMetadataLine('PRIVMSG', ['#chan', 'hi'])).toBeNull();
  });
});

describe('vetting a value', () => {
  it('keeps the keys we show and drops the rest', () => {
    expect(vetMetadataValue('display-name', 'Bob')).toBe('Bob');
    expect(vetMetadataValue('city', 'Berlin')).toBeNull();
    expect(vetMetadataValue('bot', 'yes')).toBeNull();
  });
  it('keeps a colour only as hex, in one spelling (#1452)', () => {
    expect(vetMetadataValue('color', '#FF0000')).toBe('#ff0000');
    expect(vetMetadataValue('color', '#f0a')).toBe('#ff00aa');
    expect(vetMetadataValue('color', 'red')).toBeNull();
    expect(vetMetadataValue('color', 'rgb(255, 0, 0)')).toBeNull();
    expect(vetMetadataValue('color', '#ff000')).toBeNull();
  });
  it('keeps a time zone only when it is a zone (#1450)', () => {
    expect(vetMetadataValue('lurker.chat/tz', 'europe/berlin')).toBe('Europe/Berlin');
    expect(vetMetadataValue('lurker.chat/tz', 'America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(vetMetadataValue('lurker.chat/tz', 'UTC')).toBe('UTC');
    // The name given, never the runtime's canonical one: ICU answers a renamed
    // zone with its OLD name, and an alias with another place.
    expect(vetMetadataValue('lurker.chat/tz', 'Europe/Kyiv')).toMatch(/^Europe\/Kyiv$/);
    expect(vetMetadataValue('lurker.chat/tz', 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(vetMetadataValue('lurker.chat/tz', 'EST')).toBe('EST');
    // An offset is not a zone: it has no DST, and reads as one to Intl.
    expect(vetMetadataValue('lurker.chat/tz', '+01:00')).toBeNull();
    expect(vetMetadataValue('lurker.chat/tz', 'Mars/Olympus_Mons')).toBeNull();
    expect(vetMetadataValue('lurker.chat/tz', 'Berlin time')).toBeNull();
  });
  it('treats an empty or oversized value as unset, never truncated', () => {
    expect(vetMetadataValue('display-name', '')).toBeNull();
    expect(vetMetadataValue('display-name', '   ')).toBeNull();
    expect(vetMetadataValue('display-name', 'x'.repeat(65))).toBeNull();
    expect(vetMetadataValue('status', 'x'.repeat(200))).toHaveLength(200);
  });
  it('strips line breaks, keeps mIRC formatting for the display layer', () => {
    expect(vetMetadataValue('display-name', 'Bob\r\nthe Builder')).toBe('Bobthe Builder');
    expect(vetMetadataValue('display-name', '\x0304Bob\x0f')).toBe('\x0304Bob\x0f');
  });
  it('takes only http(s) for the URL keys, with {size} filled in for avatars', () => {
    expect(vetMetadataValue('avatar', 'https://x/a/{size}.png')).toBe('https://x/a/256.png');
    expect(vetMetadataValue('avatar', 'javascript:alert(1)')).toBeNull();
    expect(vetMetadataValue('avatar', 'data:image/png;base64,AAAA')).toBeNull();
    expect(vetMetadataValue('avatar', 'not a url')).toBeNull();
    expect(vetMetadataValue('homepage', 'http://example.org')).toBe('http://example.org');
    expect(vetMetadataValue('homepage', 'ftp://example.org')).toBeNull();
    expect(sizedAvatarUrl('https://x/{size}/{size}.png', 64)).toBe('https://x/64/64.png');
  });
});

describe('what a client is sent', () => {
  it('mints the avatar and never hands over the origin', () => {
    const mint = (origin: string) => `/proxied/${encodeURIComponent(origin)}`;
    expect(
      userMetadataView(
        { 'display-name': 'Bob', avatar: 'https://x/a.png', pronouns: 'he/him' },
        mint,
      ),
    ).toEqual({
      displayName: 'Bob',
      avatarUrl: '/proxied/https%3A%2F%2Fx%2Fa.png',
      pronouns: 'he/him',
    });
    expect(channelMetadataView({ avatar: 'https://x/c.png', url: 'https://x' }, mint)).toEqual({
      avatarUrl: '/proxied/https%3A%2F%2Fx%2Fc.png',
    });
  });
  it('hands over a colour and a time zone as kept', () => {
    expect(
      userMetadataView({ color: '#ff00aa', 'lurker.chat/tz': 'Europe/Berlin' }, () => null),
    ).toEqual({ color: '#ff00aa', tz: 'Europe/Berlin' });
  });
  it('says null for an avatar it cannot serve, so the client shows its tile', () => {
    expect(userMetadataView({ avatar: 'https://x/a.png' }, () => null)).toEqual({
      avatarUrl: null,
    });
  });
});

describe('what the record may hold', () => {
  it('refuses a display name that would print as nothing', () => {
    expect(vetMetadataValue('display-name', '\x0304')).toBeNull();
    expect(vetMetadataValue('display-name', '\x02\x0f')).toBeNull();
    expect(vetMetadataValue('display-name', '​‍')).toBeNull();
    expect(vetMetadataValue('display-name', '\x02Bob\x02')).toBe('\x02Bob\x02');
  });
  it('keeps a key a bouncer client asked for, bounded, and no other', () => {
    const extra = new Set(['city']);
    expect(vetMetadataValue('city', 'Berlin', extra)).toBe('Berlin');
    expect(vetMetadataValue('city', 'x'.repeat(513), extra)).toBeNull();
    expect(vetMetadataValue('bot', 'yes', extra)).toBeNull();
  });
});

describe('our own metadata on its way out (#1189)', () => {
  const self = (target: string) => target.toLowerCase() === 'me';

  it('reads a SET on `*` or our nick, and a CLEAR', () => {
    expect(parseOwnMetadataWrite('METADATA * SET avatar :https://x.example/a.png', self)).toEqual({
      key: 'avatar',
      value: 'https://x.example/a.png',
    });
    expect(parseOwnMetadataWrite('METADATA Me SET Display-Name :Me Myself', self)).toEqual({
      key: 'display-name',
      value: 'Me Myself',
    });
    expect(parseOwnMetadataWrite('@label=1 METADATA * SET pronouns they', self)).toEqual({
      key: 'pronouns',
      value: 'they',
    });
    expect(parseOwnMetadataWrite('METADATA * CLEAR', self)).toBe('clear');
  });

  it('reads a SET with no value, or an empty one, as an unset', () => {
    expect(parseOwnMetadataWrite('METADATA * SET status', self)).toEqual({
      key: 'status',
      value: null,
    });
    expect(parseOwnMetadataWrite('METADATA * SET status :', self)).toEqual({
      key: 'status',
      value: null,
    });
  });

  it("ignores someone else's target, a channel, and the reads", () => {
    expect(parseOwnMetadataWrite('METADATA bob SET avatar :x', self)).toBeNull();
    expect(parseOwnMetadataWrite('METADATA #chan SET avatar :x', self)).toBeNull();
    expect(parseOwnMetadataWrite('METADATA * LIST', self)).toBeNull();
    expect(parseOwnMetadataWrite('METADATA * SUB avatar', self)).toBeNull();
    expect(parseOwnMetadataWrite('PRIVMSG * :METADATA * SET avatar :x', self)).toBeNull();
  });

  it('saves the value as typed, and refuses what Lurker would not show', () => {
    // The avatar keeps its {size}: it's re-set verbatim.
    expect(ownMetadataToSave('avatar', ' https://x.example/{size}.png ')).toBe(
      'https://x.example/{size}.png',
    );
    expect(ownMetadataToSave('avatar', 'javascript:alert(1)')).toBeUndefined();
    expect(ownMetadataToSave('display-name', '\u0002\u0002')).toBeUndefined();
    expect(ownMetadataToSave('display-name', 'x'.repeat(65))).toBeUndefined();
    expect(ownMetadataToSave('Bad Key', 'x')).toBeUndefined();
    // Named like an Object property: still bounded like any other key.
    expect(ownMetadataToSave('constructor', 'x'.repeat(513))).toBeUndefined();
    expect(ownMetadataToSave('constructor', 'x'.repeat(512))).toBe('x'.repeat(512));
    // A key Lurker doesn't show is kept, bounded like a status.
    expect(ownMetadataToSave('city', 'Berlin')).toBe('Berlin');
    // One Lurker shows is saved as typed, and not at all when it would be dropped.
    expect(ownMetadataToSave('color', '#FF0000')).toBe('#FF0000');
    expect(ownMetadataToSave('color', 'red')).toBeUndefined();
    expect(ownMetadataToSave('status', '')).toBeNull();
    expect(ownMetadataToSave('status', null)).toBeNull();
  });
});
