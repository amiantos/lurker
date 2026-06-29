// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { parseDccCommand } from './dcc.js';

describe('parseDccCommand', () => {
  it('treats no args as list', () => {
    expect(parseDccCommand('')).toEqual({ kind: 'list' });
    expect(parseDccCommand('   ')).toEqual({ kind: 'list' });
  });

  it('parses explicit list (and ls alias)', () => {
    expect(parseDccCommand('list')).toEqual({ kind: 'list' });
    expect(parseDccCommand('ls')).toEqual({ kind: 'list' });
  });

  it('parses accept/reject/cancel with an id', () => {
    expect(parseDccCommand('accept 7')).toEqual({ kind: 'accept', id: 7 });
    expect(parseDccCommand('reject 12')).toEqual({ kind: 'reject', id: 12 });
    expect(parseDccCommand('cancel 3')).toEqual({ kind: 'cancel', id: 3 });
  });

  it('accepts subcommand aliases', () => {
    expect(parseDccCommand('ok 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('yes 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('get 1')).toEqual({ kind: 'accept', id: 1 });
    expect(parseDccCommand('deny 1')).toEqual({ kind: 'reject', id: 1 });
    expect(parseDccCommand('no 1')).toEqual({ kind: 'reject', id: 1 });
    expect(parseDccCommand('abort 1')).toEqual({ kind: 'cancel', id: 1 });
    expect(parseDccCommand('stop 1')).toEqual({ kind: 'cancel', id: 1 });
  });

  it('is case-insensitive on the verb', () => {
    expect(parseDccCommand('ACCEPT 5')).toEqual({ kind: 'accept', id: 5 });
  });

  it('ignores trailing tokens after the id', () => {
    expect(parseDccCommand('accept 9 please')).toEqual({ kind: 'accept', id: 9 });
  });

  it('errors when an action is missing its id', () => {
    expect(parseDccCommand('accept')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('cancel')).toMatchObject({ kind: 'error' });
  });

  it('errors on a non-numeric or non-positive id', () => {
    expect(parseDccCommand('accept abc')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('reject 0')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('cancel -2')).toMatchObject({ kind: 'error' });
    expect(parseDccCommand('accept 1.5')).toMatchObject({ kind: 'error' });
  });

  it('errors on an unknown subcommand', () => {
    expect(parseDccCommand('frobnicate 1').kind).toBe('error');
  });
});
