// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  buildCtcpReply,
  CTCP_DEFAULT_CONFIG,
  type CtcpReplyConfig,
  enabledCtcpTypes,
  expandCtcpTemplate,
  formatCtcpReplyLine,
  formatCtcpRequestLine,
  formatLatency,
  parseCtcp,
  pingReplyLatencyMs,
} from './ctcp.js';

// Representative ${...} values, as ircConnection.ctcpTemplateVars would supply.
const VARS: Record<string, string> = {
  name: 'Lurker',
  version: '1.2.3',
  source: 'https://example.test/src',
  clientinfo: 'ACTION CLIENTINFO PING SOURCE TIME VERSION',
  time: 'Sat, 27 Jun 2026 14:03:11 GMT',
  nick: 'me',
};
const cfg = (over: Partial<CtcpReplyConfig> = {}): CtcpReplyConfig => ({
  ...CTCP_DEFAULT_CONFIG,
  ...over,
});

describe('parseCtcp', () => {
  it('splits type and args, uppercasing the type', () => {
    expect(parseCtcp('VERSION')).toEqual({ type: 'VERSION', args: '' });
    expect(parseCtcp('version')).toEqual({ type: 'VERSION', args: '' });
    expect(parseCtcp('PING 1719500000000')).toEqual({ type: 'PING', args: '1719500000000' });
  });

  it('keeps spaces inside the args', () => {
    expect(parseCtcp('PING 123 456')).toEqual({ type: 'PING', args: '123 456' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseCtcp('  TIME  ')).toEqual({ type: 'TIME', args: '' });
  });
});

describe('expandCtcpTemplate', () => {
  it('expands known ${...} placeholders', () => {
    expect(expandCtcpTemplate('${name} ${version}', VARS)).toBe('Lurker 1.2.3');
  });

  it('leaves unknown placeholders literal (so a typo is visible)', () => {
    expect(expandCtcpTemplate('${bogus} ${name}', VARS)).toBe('${bogus} Lurker');
  });

  it('returns a plain template unchanged', () => {
    expect(expandCtcpTemplate('hello there', VARS)).toBe('hello there');
  });
});

describe('buildCtcpReply', () => {
  it('expands the default templates against the supplied vars', () => {
    expect(buildCtcpReply('VERSION', '', CTCP_DEFAULT_CONFIG, VARS)).toBe('Lurker 1.2.3');
    expect(buildCtcpReply('TIME', '', CTCP_DEFAULT_CONFIG, VARS)).toBe(VARS.time);
    expect(buildCtcpReply('SOURCE', '', CTCP_DEFAULT_CONFIG, VARS)).toBe(VARS.source);
    expect(buildCtcpReply('CLIENTINFO', '', CTCP_DEFAULT_CONFIG, VARS)).toBe(VARS.clientinfo);
  });

  it('echoes a PING payload verbatim', () => {
    expect(buildCtcpReply('PING', '1719500000000', CTCP_DEFAULT_CONFIG, VARS)).toBe(
      '1719500000000',
    );
  });

  it('refuses an oversized PING payload (flood-amp guard)', () => {
    expect(buildCtcpReply('PING', 'x'.repeat(101), CTCP_DEFAULT_CONFIG, VARS)).toBeNull();
  });

  it('is case-insensitive on the type', () => {
    expect(buildCtcpReply('version', '', CTCP_DEFAULT_CONFIG, VARS)).toBe('Lurker 1.2.3');
  });

  it('returns null for an unsupported type (e.g. USERINFO/FINGER)', () => {
    expect(buildCtcpReply('USERINFO', '', CTCP_DEFAULT_CONFIG, VARS)).toBeNull();
    expect(buildCtcpReply('FINGER', '', CTCP_DEFAULT_CONFIG, VARS)).toBeNull();
    expect(buildCtcpReply('DCC', 'SEND foo', CTCP_DEFAULT_CONFIG, VARS)).toBeNull();
  });

  it('honors a fully custom template', () => {
    expect(
      buildCtcpReply('VERSION', '', cfg({ version: 'hi from ${nick} on ${name}' }), VARS),
    ).toBe('hi from me on Lurker');
  });

  it('strips CR/LF/NUL and the 0x01 CTCP frame byte so a template cannot inject', () => {
    // CR/LF would split the IRC line; \x01 would split the reply into extra CTCP
    // segments for the peer.
    expect(buildCtcpReply('VERSION', '', cfg({ version: 'a\r\nQUIT b' }), VARS)).toBe('aQUIT b');
    const dirty = `a${String.fromCharCode(1)}b${String.fromCharCode(0)}c`;
    expect(buildCtcpReply('VERSION', '', cfg({ version: dirty }), VARS)).toBe('abc');
  });
});

describe('buildCtcpReply — disabling', () => {
  it('master enabled:false silences everything, including PING', () => {
    const off = cfg({ enabled: false });
    expect(buildCtcpReply('VERSION', '', off, VARS)).toBeNull();
    expect(buildCtcpReply('TIME', '', off, VARS)).toBeNull();
    expect(buildCtcpReply('PING', '123', off, VARS)).toBeNull();
  });

  it('an empty template disables that type while others still answer', () => {
    const noVersion = cfg({ version: '' });
    expect(buildCtcpReply('VERSION', '', noVersion, VARS)).toBeNull();
    expect(buildCtcpReply('TIME', '', noVersion, VARS)).toBe(VARS.time);
    expect(buildCtcpReply('PING', '123', noVersion, VARS)).toBe('123'); // PING isn't templated
  });

  it('a whitespace-only template counts as disabled', () => {
    expect(buildCtcpReply('SOURCE', '', cfg({ source: '   ' }), VARS)).toBeNull();
  });
});

describe('enabledCtcpTypes', () => {
  it('lists ACTION/PING plus each non-empty template, sorted', () => {
    expect(enabledCtcpTypes(CTCP_DEFAULT_CONFIG)).toEqual([
      'ACTION',
      'CLIENTINFO',
      'PING',
      'SOURCE',
      'TIME',
      'VERSION',
    ]);
  });

  it('omits a type whose template is empty', () => {
    expect(enabledCtcpTypes(cfg({ time: '', source: '' }))).toEqual([
      'ACTION',
      'CLIENTINFO',
      'PING',
      'VERSION',
    ]);
  });
});

describe('pingReplyLatencyMs', () => {
  it('computes the delta from an echoed epoch-ms timestamp', () => {
    expect(pingReplyLatencyMs('1000', 1123)).toBe(123);
  });

  it('uses only the first token (sec/usec style degrades to raw)', () => {
    // "1 0" → first token 1, now 1234 → 1233ms, still within plausible window
    expect(pingReplyLatencyMs('1000 500', 1500)).toBe(500);
  });

  it('rejects a non-numeric payload', () => {
    expect(pingReplyLatencyMs('hello', 1000)).toBeNull();
    expect(pingReplyLatencyMs('', 1000)).toBeNull();
  });

  it('rejects an implausible delta (future / >1h)', () => {
    expect(pingReplyLatencyMs('2000', 1000)).toBeNull(); // negative
    expect(pingReplyLatencyMs('0', 3_600_001)).toBeNull(); // > 1h
  });
});

describe('formatLatency', () => {
  it('renders seconds with 3 decimals', () => {
    expect(formatLatency(123)).toBe('0.123s');
    expect(formatLatency(1500)).toBe('1.500s');
  });
});

describe('formatCtcpReplyLine', () => {
  it('renders a generic reply with the data', () => {
    expect(formatCtcpReplyLine('bob', 'VERSION', 'WeeChat 4.0', 0)).toBe(
      'CTCP VERSION reply from bob: WeeChat 4.0',
    );
  });

  it('renders a PING reply as a latency', () => {
    expect(formatCtcpReplyLine('bob', 'PING', '1000', 1123)).toBe(
      'CTCP PING reply from bob: 0.123s',
    );
  });

  it('falls back to the raw PING payload when it is not our timestamp', () => {
    expect(formatCtcpReplyLine('bob', 'PING', 'garbage', 1123)).toBe(
      'CTCP PING reply from bob: garbage',
    );
  });

  it('omits the colon when there is no data', () => {
    expect(formatCtcpReplyLine('bob', 'CLIENTINFO', '', 0)).toBe('CTCP CLIENTINFO reply from bob');
  });
});

describe('formatCtcpRequestLine', () => {
  it('shows what we disclosed back on an answered probe', () => {
    expect(formatCtcpRequestLine('bob', 'version', 'Lurker 1.2.3')).toBe(
      'bob requested CTCP VERSION (replied: Lurker 1.2.3)',
    );
  });

  it('flags an unanswered probe (null reply)', () => {
    expect(formatCtcpRequestLine('bob', 'finger', null)).toBe(
      'bob requested CTCP FINGER (no reply)',
    );
  });
});
