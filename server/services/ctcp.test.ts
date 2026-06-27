// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from 'vitest';

import {
  buildCtcpReply,
  CTCP_DEFAULT_CONFIG,
  CTCP_SOURCE,
  CTCP_SUPPORTED,
  type CtcpReplyConfig,
  formatCtcpReplyLine,
  formatCtcpRequestLine,
  formatLatency,
  parseCtcp,
  pingReplyLatencyMs,
} from './ctcp.js';
import { IRC_VERSION } from '../utils/userAgent.js';

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

describe('buildCtcpReply', () => {
  const now = new Date('2026-06-27T14:03:11Z');

  it('answers VERSION with the Lurker user-agent', () => {
    expect(buildCtcpReply('VERSION', '', now)).toBe(IRC_VERSION);
  });

  it('answers SOURCE with the repo URL', () => {
    expect(buildCtcpReply('SOURCE', '', now)).toBe(CTCP_SOURCE);
  });

  it('answers CLIENTINFO with the supported set', () => {
    expect(buildCtcpReply('CLIENTINFO', '', now)).toBe(CTCP_SUPPORTED.join(' '));
  });

  it('answers TIME with a UTC string', () => {
    expect(buildCtcpReply('TIME', '', now)).toBe(now.toUTCString());
  });

  it('echoes a PING payload verbatim', () => {
    expect(buildCtcpReply('PING', '1719500000000', now)).toBe('1719500000000');
  });

  it('refuses an oversized PING payload (flood-amp guard)', () => {
    expect(buildCtcpReply('PING', 'x'.repeat(101), now)).toBeNull();
  });

  it('is case-insensitive on the type', () => {
    expect(buildCtcpReply('version', '', now)).toBe(IRC_VERSION);
  });

  it('returns null for an unsupported type (e.g. USERINFO/FINGER)', () => {
    expect(buildCtcpReply('USERINFO', '', now)).toBeNull();
    expect(buildCtcpReply('FINGER', '', now)).toBeNull();
    expect(buildCtcpReply('DCC', 'SEND foo', now)).toBeNull();
  });

  it('advertises exactly the types it can answer (CLIENTINFO ⊇ answerable)', () => {
    // ACTION is in the set for completeness (we send/receive it) but isn't a
    // query; every OTHER advertised type must produce a non-null reply.
    for (const t of CTCP_SUPPORTED) {
      if (t === 'ACTION') continue;
      expect(buildCtcpReply(t, '', now), `expected a reply for ${t}`).not.toBeNull();
    }
  });
});

describe('buildCtcpReply — config gating', () => {
  const now = new Date('2026-06-27T14:03:11Z');

  it('master replies:false silences everything, including PING', () => {
    const off = cfg({ replies: false });
    expect(buildCtcpReply('VERSION', '', now, off)).toBeNull();
    expect(buildCtcpReply('TIME', '', now, off)).toBeNull();
    expect(buildCtcpReply('SOURCE', '', now, off)).toBeNull();
    expect(buildCtcpReply('CLIENTINFO', '', now, off)).toBeNull();
    expect(buildCtcpReply('PING', '123', now, off)).toBeNull();
  });

  it('a disabled per-type reply returns null while others still answer', () => {
    const noVersion = cfg({ version: false });
    expect(buildCtcpReply('VERSION', '', now, noVersion)).toBeNull();
    expect(buildCtcpReply('TIME', '', now, noVersion)).toBe(now.toUTCString());
    expect(buildCtcpReply('PING', '123', now, noVersion)).toBe('123'); // PING has no toggle
  });

  it('CLIENTINFO advertises only the enabled types (+ ACTION/PING)', () => {
    expect(buildCtcpReply('CLIENTINFO', '', now, cfg({ time: false, source: false }))).toBe(
      'ACTION CLIENTINFO PING VERSION',
    );
    expect(
      buildCtcpReply('CLIENTINFO', '', now, cfg({ version: false, time: false, source: false })),
    ).toBe('ACTION CLIENTINFO PING');
  });

  it('defaults to all-on (current behavior) when no config is passed', () => {
    expect(buildCtcpReply('VERSION', '', now)).toBe(IRC_VERSION);
    expect(buildCtcpReply('CLIENTINFO', '', now)).toBe(CTCP_SUPPORTED.join(' '));
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
  it('notes an answered probe', () => {
    expect(formatCtcpRequestLine('bob', 'version', true)).toBe('bob requested CTCP VERSION');
  });

  it('flags an unanswered probe', () => {
    expect(formatCtcpRequestLine('bob', 'finger', false)).toBe(
      'bob requested CTCP FINGER (no reply)',
    );
  });
});
