// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';
import {
  ownMetadataRefusal,
  parseAvatarCommand,
  parseColorCommand,
  parseDisplayNameCommand,
  parseMetadataCommand,
  parseTzCommand,
} from './metadata.js';

describe('/metadata', () => {
  it('sets a key on ourselves, the value as a trailing param', () => {
    expect(parseMetadataCommand('set display-name Bob the Builder')).toEqual({
      line: 'METADATA * SET display-name :Bob the Builder',
      write: { key: 'display-name', value: 'Bob the Builder' },
    });
    expect(parseMetadataCommand('SET Status  away for lunch ')).toEqual({
      line: 'METADATA * SET status :away for lunch',
      write: { key: 'status', value: 'away for lunch' },
    });
  });
  it('unsets with no value, as the spec has it', () => {
    expect(parseMetadataCommand('del avatar')).toEqual({
      line: 'METADATA * SET avatar',
      write: { key: 'avatar', value: null },
    });
    expect(parseMetadataCommand('unset avatar')).toEqual({
      line: 'METADATA * SET avatar',
      write: { key: 'avatar', value: null },
    });
    // An empty value is an unset too — the server would store "".
    expect(parseMetadataCommand('set avatar    ')).toEqual({
      error: 'usage: /metadata set <key> <value>',
    });
  });
  it('lists ourselves, a nick or a channel', () => {
    expect(parseMetadataCommand('list')).toEqual({ line: 'METADATA * LIST' });
    expect(parseMetadataCommand('list bob')).toEqual({ line: 'METADATA bob LIST' });
    expect(parseMetadataCommand('list #chan extra')).toEqual({ line: 'METADATA #chan LIST' });
    expect(parseMetadataCommand('clear')).toEqual({ line: 'METADATA * CLEAR', write: 'clear' });
  });
  it('refuses a key the spec would, and says how', () => {
    expect(parseMetadataCommand('set Bad%Key x')).toEqual({
      error: 'invalid metadata key: bad%key (a-z, 0-9, _ . / -)',
    });
    expect(parseMetadataCommand('')).toMatchObject({ error: expect.stringMatching(/^usage/) });
    expect(parseMetadataCommand('frob')).toMatchObject({ error: expect.stringMatching(/^usage/) });
  });
  it('never lets a line break onto the wire', () => {
    expect(parseMetadataCommand('set status hi\r\nQUIT')).toEqual({
      line: 'METADATA * SET status :hiQUIT',
      write: { key: 'status', value: 'hiQUIT' },
    });
  });
});

describe('/avatar and /displayname', () => {
  it('set their key, and `off` unsets it', () => {
    expect(parseAvatarCommand('https://example.org/me/{size}.png')).toEqual({
      line: 'METADATA * SET avatar :https://example.org/me/{size}.png',
      write: { key: 'avatar', value: 'https://example.org/me/{size}.png' },
    });
    expect(parseAvatarCommand('off')).toEqual({
      line: 'METADATA * SET avatar',
      write: { key: 'avatar', value: null },
    });
    expect(parseDisplayNameCommand('Bob the Builder')).toEqual({
      line: 'METADATA * SET display-name :Bob the Builder',
      write: { key: 'display-name', value: 'Bob the Builder' },
    });
    expect(parseDisplayNameCommand('OFF')).toEqual({
      line: 'METADATA * SET display-name',
      write: { key: 'display-name', value: null },
    });
  });
  it('wants an http(s) URL for the avatar', () => {
    expect(parseAvatarCommand('ftp://x/y.png')).toEqual({
      error: 'the avatar must be an http(s) URL',
    });
    expect(parseAvatarCommand('me.png')).toEqual({ error: 'the avatar must be an http(s) URL' });
    expect(parseAvatarCommand('')).toMatchObject({ error: expect.stringMatching(/^usage/) });
    expect(parseDisplayNameCommand(' ')).toMatchObject({ error: expect.stringMatching(/^usage/) });
  });
});

describe('where our own metadata can go (#1189)', () => {
  const limits = { maxSubs: 10, maxKeys: 10, maxValueBytes: null, beforeConnect: false };
  it('refuses a connected network without the cap, or with no room for a key', () => {
    expect(ownMetadataRefusal({ networkId: 1, channels: [], state: 'connected' })).toMatch(
      /doesn't support/,
    );
    expect(
      ownMetadataRefusal({
        networkId: 1,
        channels: [],
        state: 'connected',
        metadataLimits: { ...limits, maxKeys: 0 },
      }),
    ).toMatch(/doesn't keep/);
  });
  it('refuses a network that is not connected', () => {
    expect(ownMetadataRefusal({ networkId: 1, channels: [], state: 'disconnected' })).toBe(
      'not connected',
    );
    expect(ownMetadataRefusal(undefined)).toBe('not connected');
  });
  it('lets a connected network with room for a key through', () => {
    expect(
      ownMetadataRefusal({
        networkId: 1,
        channels: [],
        state: 'connected',
        metadataLimits: limits,
      }),
    ).toBeNull();
  });
});

describe('/color and /tz', () => {
  it('sets the colour as lower-case #rrggbb, or clears it', () => {
    expect(parseColorCommand('#F0A')).toEqual({
      line: 'METADATA * SET color :#ff00aa',
      write: { key: 'color', value: '#ff00aa' },
    });
    expect(parseColorCommand('off')).toEqual({
      line: 'METADATA * SET color',
      write: { key: 'color', value: null },
    });
    expect(parseColorCommand('red')).toHaveProperty('error');
    expect(parseColorCommand('')).toHaveProperty('error');
  });

  it('sets the time zone in its usual spelling, or clears it', () => {
    expect(parseTzCommand('europe/berlin')).toEqual({
      line: 'METADATA * SET timezone :Europe/Berlin',
      write: { key: 'timezone', value: 'Europe/Berlin' },
    });
    expect(parseTzCommand('Europe/Kyiv')).toMatchObject({
      line: 'METADATA * SET timezone :Europe/Kyiv',
    });
    expect(parseTzCommand('OFF')).toMatchObject({ write: { value: null } });
    expect(parseTzCommand('Berlin')).toHaveProperty('error');
    expect(parseTzCommand('+02:00')).toHaveProperty('error');
  });
});
