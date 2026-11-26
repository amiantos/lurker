// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { describeMode, type ModeSegment } from './modeNarration.js';
import type { ModeChange } from './modes.js';

/** The narration as a plain string, for readable assertions. */
function say(modes: ModeChange[] | null | undefined, rawText?: string | null): string {
  return describeMode(modes, rawText)
    .map((s: ModeSegment) => (s.t === 'nick' ? s.nick : s.text))
    .join('');
}

const prefix = (mode: string, param: string): ModeChange => ({ mode, param, kind: 'prefix' });
const list = (mode: string, param: string): ModeChange => ({ mode, param, kind: 'list' });
const chan = (mode: string, param?: string): ModeChange => ({ mode, param, kind: 'chan' });

describe('describeMode — member status', () => {
  it('narrates the grants and revocations people actually see', () => {
    expect(say([prefix('+o', 'alice')])).toBe(' gave op to alice');
    expect(say([prefix('-o', 'alice')])).toBe(' took op from alice');
    expect(say([prefix('+v', 'carol')])).toBe(' gave voice to carol');
    expect(say([prefix('-v', 'carol')])).toBe(' took voice from carol');
    expect(say([prefix('+h', 'dave')])).toBe(' gave half-op to dave');
    expect(say([prefix('+q', 'erin')])).toBe(' gave owner to erin');
    expect(say([prefix('+a', 'frank')])).toBe(' gave admin to frank');
  });

  it('emits the target as a nick segment, so it can be rendered as one', () => {
    expect(describeMode([prefix('+o', 'alice')])).toEqual([
      { t: 'text', text: ' gave op to ' },
      { t: 'nick', nick: 'alice' },
    ]);
  });

  it('falls back to the token for a prefix letter it has no name for', () => {
    // The letter set here is only phrasing — whether it IS a prefix mode was
    // settled server-side by ISUPPORT, so an exotic network still narrates.
    expect(say([prefix('+y', 'gwen')])).toBe(' gave +y to gwen');
    expect(say([prefix('-y', 'gwen')])).toBe(' took +y from gwen');
  });
});

describe('describeMode — list modes', () => {
  it('narrates bans, quiets and exceptions', () => {
    expect(say([list('+b', '*!*@host')])).toBe(' banned *!*@host');
    expect(say([list('-b', '*!*@host')])).toBe(' unbanned *!*@host');
    expect(say([list('+q', '*!*@host')])).toBe(' quieted *!*@host');
    expect(say([list('+e', '*!*@host')])).toBe(' added a ban exemption for *!*@host');
    expect(say([list('-I', '*!*@host')])).toBe(' removed the invite exception for *!*@host');
  });

  it('names the list for a letter it does not know', () => {
    expect(say([list('+d', 'mask')])).toBe(' added mask to the +d list');
    expect(say([list('-d', 'mask')])).toBe(' removed mask from the +d list');
  });

  it('never emits a mask as a nick segment', () => {
    // `+b alice` is a mask that happens to look like a nick. Rendering it as a
    // nick would give it a colour, a nick menu, and a whois — for a ban.
    expect(describeMode([list('+b', 'alice')]).some((s) => s.t === 'nick')).toBe(false);
  });
});

describe('describeMode — channel modes', () => {
  it('narrates the common flags', () => {
    expect(say([chan('+t')])).toBe(' locked the topic');
    expect(say([chan('-t')])).toBe(' unlocked the topic');
    expect(say([chan('+m')])).toBe(' made the channel moderated');
    expect(say([chan('-m')])).toBe(' removed moderation');
    expect(say([chan('+i')])).toBe(' made the channel invite-only');
    expect(say([chan('+s')])).toBe(' made the channel secret');
    expect(say([chan('+p')])).toBe(' made the channel private');
  });

  it('gets +n the right way round', () => {
    // +n BLOCKS messages from outside the channel. gamja narrates `+n` as
    // "allowed external messages", which is inverted; this pins ours.
    expect(say([chan('+n')])).toBe(' blocked outside messages');
    expect(say([chan('-n')])).toBe(' allowed outside messages');
  });

  it('narrates the user limit with its value', () => {
    expect(say([chan('+l', '50')])).toBe(' set the user limit to 50');
    expect(say([chan('-l')])).toBe(' removed the user limit');
  });

  it('never prints the channel key (#476)', () => {
    expect(say([chan('+k', 'hunter2')])).toBe(' set a channel key');
    expect(say([chan('+k', 'hunter2')])).not.toContain('hunter2');
    expect(say([chan('-k', 'hunter2')])).toBe(' removed the channel key');
  });

  it('falls back to the token for an unknown letter', () => {
    expect(say([chan('+C')])).toBe(' set +C');
    expect(say([chan('-C')])).toBe(' unset +C');
    expect(say([chan('+j', '5:1')])).toBe(' set +j to 5:1');
  });
});

describe('describeMode — the fallbacks', () => {
  it('shows a compact mode string when a message carries several changes', () => {
    expect(say([prefix('+o', 'alice'), list('-b', '*!*@host')])).toBe(' set +o-b alice *!*@host');
  });

  it('runs letters together under their sign, as an operator types them (#1431)', () => {
    expect(say([prefix('+a', 'alice'), prefix('+o', 'alice')])).toBe(' set +ao alice alice');
    expect(say([prefix('+o', 'alice'), prefix('-v', 'bob'), prefix('-h', 'bob'), chan('+m')])).toBe(
      ' set +o-vh+m alice bob bob',
    );
    // A parameterless mode among them takes no slot in the parameter list.
    expect(say([chan('+m'), chan('+l', '50'), prefix('+v', 'carol')])).toBe(' set +mlv 50 carol');
  });

  it('withholds the key in the multi-change form too', () => {
    // The row's raw `text` is the wire form and carries the key, which is why
    // this rebuilds from the parsed list instead of reusing it.
    const said = say([chan('+k', 'hunter2'), chan('+m')]);
    expect(said).toBe(' set +km');
    expect(said).not.toContain('hunter2');
  });

  it('does not narrate an unstamped change, because it cannot know what it is', () => {
    // Without `kind`, `+q alice` might grant ownership or quiet a mask. Guessing
    // is the bug the stamp exists to prevent, so this shows the mode string.
    expect(say([{ mode: '+q', param: 'alice' }])).toBe(' set +q alice');
    expect(say([{ mode: '+o', param: 'alice' }])).toBe(' set +o alice');
  });

  it('uses the row text when there is no parsed list at all', () => {
    expect(say([], '+o alice')).toBe(' set +o alice');
    expect(say(null, '+nt')).toBe(' set +nt');
  });

  it('withholds the key from the raw-text path too, by dropping every param', () => {
    // Reachable, not theoretical: rows written before `modes` was persisted take
    // this path, and their `text` is the wire form. Which param is the key can't
    // be worked out without CHANMODES — and a row with no parsed list has no
    // classification either — so the letters stay and the params go.
    expect(say([], '+k hunter2')).toBe(' set +k');
    expect(say([], '+ok alice hunter2')).toBe(' set +ok');
    expect(say([], '-k hunter2')).toBe(' set -k');
    expect(say([], '+k hunter2')).not.toContain('hunter2');
  });

  it('leaves a key-less raw text with its params intact', () => {
    expect(say([], '+b *!*@host')).toBe(' set +b *!*@host');
    expect(say([], '+l 50')).toBe(' set +l 50');
  });

  it('still says something when the row has nothing usable', () => {
    expect(say([], '')).toBe(' changed the channel modes');
    expect(say(null, null)).toBe(' changed the channel modes');
  });

  it('ignores malformed entries rather than narrating them', () => {
    expect(say([{ mode: '', param: 'x' }, prefix('+o', 'alice')])).toBe(' gave op to alice');
  });
});
