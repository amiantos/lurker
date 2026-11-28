// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { buildNickCandidates } from './nickCompletion.js';
// Display names (#607): `@bra` finds the user shown as "Brad Root", by the
// start of the name or of any word in it; the nick is what comes back.
describe('buildNickCandidates — display names', () => {
  const buf = {
    target: '#c',
    members: [{ nick: 'amiantos' }, { nick: 'carol' }, { nick: 'brad_' }],
    speakers: {},
  };
  const nameOf = (nick: string) => (nick === 'amiantos' ? 'Brad Root' : null);

  it('matches the name and its words, and says which name matched', () => {
    expect(buildNickCandidates(buf, 'me', 'bra', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
      { nick: 'brad_', recent: false },
    ]);
    expect(buildNickCandidates(buf, 'me', 'root', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
    ]);
    expect(buildNickCandidates(buf, 'me', 'ami', null, nameOf)).toEqual([
      { nick: 'amiantos', recent: false, displayName: 'Brad Root' },
    ]);
  });

  it('is the old matcher without a name source', () => {
    expect(buildNickCandidates(buf, 'me', 'bra')).toEqual([{ nick: 'brad_', recent: false }]);
  });
});

// Your own nick is offered, always last (#1496): after the recent speakers and
// after the alphabetical members, even when it spoke most recently.
describe('buildNickCandidates — own nick', () => {
  const buf = {
    target: '#c',
    members: [{ nick: 'Me' }, { nick: 'mallory' }, { nick: 'zed' }, { nick: 'mona' }],
    speakers: {
      me: { nick: 'me', lastTime: 30 },
      mona: { nick: 'mona', lastTime: 20 },
    },
  };

  it('comes after speakers and members, in the member list spelling', () => {
    expect(buildNickCandidates(buf, 'me', 'm')).toEqual([
      { nick: 'mona', recent: true },
      { nick: 'mallory', recent: false },
      { nick: 'Me', recent: false },
    ]);
    expect(buildNickCandidates(buf, 'me', '').map((c) => c.nick)).toEqual([
      'mona',
      'mallory',
      'zed',
      'Me',
    ]);
  });

  it('is left out when the prefix does not match it', () => {
    expect(buildNickCandidates(buf, 'me', 'z')).toEqual([{ nick: 'zed', recent: false }]);
  });

  it('matches on its display name too', () => {
    const nameOf = (nick: string) => (nick === 'Me' ? 'Brad Root' : null);
    expect(buildNickCandidates(buf, 'me', 'root', null, nameOf)).toEqual([
      { nick: 'Me', recent: false, displayName: 'Brad Root' },
    ]);
  });

  it('is offered in a DM, which has no member list', () => {
    const dm = { target: 'carol', speakers: { carol: { nick: 'carol', lastTime: 1 } } };
    expect(buildNickCandidates(dm, 'me', '').map((c) => c.nick)).toEqual(['carol', 'me']);
  });

  it('is not subject to the ignore list', () => {
    expect(buildNickCandidates(buf, 'me', 'me', () => true)).toEqual([
      { nick: 'Me', recent: false },
    ]);
  });
});
