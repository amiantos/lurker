// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Turning a MODE row into a sentence.
//
// The line used to render as `mode by ChanServ: +o alice` — the raw wire form
// with a label bolted on, which asks the reader to know IRC mode syntax to find
// out that somebody got opped. gamja narrates these instead
// (`components/buffer.js`), and it reads enormously better; this is that idea,
// built on the `kind` stamp from shared/modes.ts so it can tell `+o alice` (a
// nick) from `+b alice` (a mask that happens to look like one).
//
// Output is a SEGMENT LIST rather than a string so the caller can render the
// affected nick as a real nick — clickable, colored, with the nick menu on it,
// which the raw form never offered. It also keeps this file free of any view
// framework, so the phone can port it as-is.
//
// Only a SINGLE-change message is narrated, and only for a reader who has event
// consolidation on (`opts.raw` on describeMode). A message carrying several changes
// falls back to a compact mode string, matching gamja (which gates its
// narration on `modeStr.length === 2`): "gave op to alice and banned *!*@host
// and set the user limit to 50" is worse than `+o-b+l alice *!*@host 50`, and
// the multi-change case is overwhelmingly services bursts rather than something
// a human typed.

import { modeLetter, type ModeChange } from './modes.js';

/** A piece of a narrated mode line. */
export type ModeSegment =
  /** Narration prose. Rendered as-is. */
  | { t: 'text'; text: string }
  /** A nick the mode acted on. Render it as a nick — this is only ever emitted
   *  for a `prefix` change, so it is a real member and never a mask. */
  | { t: 'nick'; nick: string }
  /** A literal argument: a ban mask, a limit, a raw mode string. Never a nick,
   *  so it must never be rendered as one. */
  | { t: 'arg'; text: string };

/** What a member-prefix letter grants, for the "gave X to" phrasing. */
const PREFIX_NAMES: Record<string, string> = {
  q: 'owner',
  a: 'admin',
  o: 'op',
  h: 'half-op',
  v: 'voice',
};

/**
 * Narrate a change that grants or revokes member status.
 *
 * The letter set is only a phrasing table — whether a letter IS a prefix mode
 * was decided server-side by ISUPPORT and is already on `kind`. An unlisted
 * letter narrates with its token rather than being misread as something else.
 */
function prefixSegments(sign: string, letter: string, param: string): ModeSegment[] {
  const name = PREFIX_NAMES[letter] ?? `+${letter}`;
  return [
    { t: 'text', text: sign === '+' ? ` gave ${name} to ` : ` took ${name} from ` },
    { t: 'nick', nick: param },
  ];
}

/** Narrate a mask going onto or off a list mode (bans, exemptions, quiets). */
function listSegments(sign: string, letter: string, param: string): ModeSegment[] {
  const add = sign === '+';
  const phrase: Record<string, [string, string]> = {
    b: [' banned ', ' unbanned '],
    q: [' quieted ', ' unquieted '],
    e: [' added a ban exemption for ', ' removed the ban exemption for '],
    I: [' added an invite exception for ', ' removed the invite exception for '],
  };
  const known = phrase[letter];
  if (known) {
    return [
      { t: 'text', text: add ? known[0] : known[1] },
      { t: 'arg', text: param },
    ];
  }
  // An unknown list mode still reads correctly said plainly, and says which
  // list it was — better than inventing a verb for a letter we don't know.
  return [
    { t: 'text', text: add ? ' added ' : ' removed ' },
    { t: 'arg', text: param },
    { t: 'text', text: add ? ` to the +${letter} list` : ` from the +${letter} list` },
  ];
}

/** Narrate a channel flag or parameter mode. */
function chanSegments(sign: string, letter: string, param?: string): ModeSegment[] {
  const add = sign === '+';
  const text = (t: string): ModeSegment[] => [{ t: 'text', text: t }];

  // ⚠ The channel key is never printed. Every member of the channel saw the
  // MODE that set it, so it is not a secret from them — but it lands in
  // scrollback and in the database, and Lurker already keeps it out of the
  // channel-mode display for that reason (#476). This is the other half.
  if (letter === 'k') return text(add ? ' set a channel key' : ' removed the channel key');
  if (letter === 'l') {
    if (!add) return text(' removed the user limit');
    return param
      ? [
          { t: 'text', text: ' set the user limit to ' },
          { t: 'arg', text: param },
        ]
      : text(' set a user limit');
  }
  if (letter === 't') return text(add ? ' locked the topic' : ' unlocked the topic');
  // ⚠ +n BLOCKS messages from outside the channel; it does not allow them.
  // gamja has this pair inverted (`components/buffer.js`, the "n" case reads
  // "allowed" for `+n`) — narrate the mode, not the reference.
  if (letter === 'n') return text(add ? ' blocked outside messages' : ' allowed outside messages');
  if (letter === 'i') return text(add ? ' made the channel invite-only' : ' removed invite-only');
  if (letter === 'm') return text(add ? ' made the channel moderated' : ' removed moderation');
  if (letter === 's') return text(add ? ' made the channel secret' : ' removed secret');
  if (letter === 'p') return text(add ? ' made the channel private' : ' removed private');

  // Unknown letter. With a value it reads as an assignment; without one, as a
  // flag. Either way the token is shown rather than guessed at.
  if (param && add) {
    return [
      { t: 'text', text: ` set +${letter} to ` },
      { t: 'arg', text: param },
    ];
  }
  return text(add ? ` set +${letter}` : ` unset +${letter}`);
}

/**
 * A compact mode string for a message carrying more than one change, and for
 * anything else this can't narrate.
 *
 * Rebuilt from the parsed list rather than reusing the row's raw `text`,
 * because `text` is the wire form INCLUDING a `+k` key. Reconstructing is what
 * lets the key be dropped here the way it already is everywhere else (#476).
 */
function rawSegments(modes: readonly ModeChange[]): ModeSegment[] {
  // The form an operator would type (#1431): the letters run together under
  // their sign, then the parameters in order — `+ao alice alice`, `+o-b alice
  // *!*@host` — rather than each change spelled out with its own sign.
  let letters = '';
  let sign = '';
  const params: ModeSegment[] = [];
  for (const m of modes) {
    const s = m.mode.startsWith('-') ? '-' : '+';
    if (s !== sign) letters += s;
    sign = s;
    const letter = modeLetter(m.mode);
    letters += letter;
    // The one param that is withheld; the letter still shows, so the reader
    // knows a key was set.
    if (!m.param || letter === 'k') continue;
    // A member stays a nick here too: only the stamp says `+q alice` is one.
    params.push(
      { t: 'text', text: ' ' },
      m.kind === 'prefix' ? { t: 'nick', nick: m.param } : { t: 'arg', text: m.param },
    );
  }
  return [{ t: 'text', text: ' set ' }, { t: 'arg', text: letters }, ...params];
}

/**
 * The wire text of a mode message, with its parameters dropped when a `k` is
 * among the letters.
 *
 * `text` is `raw_modes` followed by every parameter, so it carries the channel
 * key — and this is the one path that would show it, since it is the parsed
 * list that lets rawSegments withhold it everywhere else. Which parameter is
 * the key can't be worked out here: mapping parameters to letters needs
 * CHANMODES, and a row with no parsed list has no classification either. So
 * when a key may be present, keep the letters and drop every parameter — the
 * same trade the channel-mode display already makes (#476).
 *
 * Reachable rather than theoretical: mode rows written before `modes` was
 * persisted take this path.
 */
function withoutKeyParam(text: string): string {
  const modeToken = text.split(/\s+/)[0] ?? '';
  return modeToken.includes('k') ? modeToken : text;
}

/**
 * Narrate a MODE row: the segments that follow the actor's nick.
 *
 * Every segment list starts with a leading space, so a caller renders the actor
 * and then these, with no separator of its own.
 *
 * @param modes the row's parsed change list, each stamped with its `kind`.
 * @param rawText the row's raw `text`, used only when there is no parsed list
 *   at all — backlog old enough to predate it.
 * @param opts.raw show the mode string for a single change too, not a
 *   sentence. Set for a reader who turned event consolidation off: they asked
 *   for every event as it happened, and `set +v alice` is that (#1431).
 */
export function describeMode(
  modes: readonly ModeChange[] | null | undefined,
  rawText?: string | null,
  opts: { raw?: boolean } = {},
): ModeSegment[] {
  const list = (modes ?? []).filter((m) => m && m.mode);

  if (list.length === 0) {
    // No parsed changes. Show whatever the row does have rather than nothing —
    // this is backlog old enough to predate `modes` being persisted at all, and
    // its raw text is the only description it has.
    const text = withoutKeyParam((rawText ?? '').trim());
    if (!text) return [{ t: 'text', text: ' changed the channel modes' }];
    return [
      { t: 'text', text: ' set ' },
      { t: 'arg', text },
    ];
  }

  if (list.length > 1 || opts.raw) return rawSegments(list);

  const only = list[0];
  const sign = only.mode.startsWith('-') ? '-' : '+';
  const letter = modeLetter(only.mode);

  // An unstamped row can't be narrated: without `kind` there is no way to know
  // whether `+q alice` grants ownership or quiets a mask, and guessing is
  // exactly the bug the stamp exists to prevent. Fall back to the mode string.
  if (only.kind === 'prefix' && only.param) return prefixSegments(sign, letter, only.param);
  if (only.kind === 'list' && only.param) return listSegments(sign, letter, only.param);
  if (only.kind === 'chan') return chanSegments(sign, letter, only.param);
  return rawSegments(list);
}
