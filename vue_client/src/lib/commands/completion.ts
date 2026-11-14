// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The pure logic behind command completion (#533). It answers the one question
// the composer asks on every keystroke and caret move: is a command completion
// live under the caret, and if so, of what?
//
//  - Typing the verb (`/jo|`): commands, filtered by what's typed.
//  - Typing an argument of a known command (`/join #li|`, `/dcc ac|`,
//    `/set inp|`): whatever that command's grammar says the slot takes.
//  - A free-text slot (`/me hello`), an opaque one (a channel key) or an unknown
//    command: nothing, and the composer carries on as if no command were there,
//    so `/me @al|` still completes a nick.
//
// A port of the mobile apps' `CommandCompletion`, with one widening: where they
// answer with a single kind, this answers with every slot the token could fill,
// because the web completes keywords and flags too and a command's forms each
// offer their own (`/dcc ` is list, files, accept, …).

import { isChannelTarget } from '../../../../shared/channels.js';
import {
  matchingCommands,
  specFor,
  commandUsage,
  formUsage,
  type ArgKind,
  type ArgSpec,
  type CommandSpec,
  type FlagSpec,
  type FormSpec,
} from './registry.js';

/** The kinds whose candidates are live lists the composer has to supply. */
export type LiveKind = Extract<
  ArgKind,
  'channel' | 'nick' | 'setting' | 'settingValue' | 'theme' | 'network' | 'avatarSet'
>;

const LIVE: ReadonlySet<ArgKind> = new Set<LiveKind>([
  'channel',
  'nick',
  'setting',
  'settingValue',
  'theme',
  'network',
  'avatarSet',
]);

/** One thing the token under the caret could be. */
export type Slot =
  | {
      readonly type: 'keyword';
      readonly value: string;
      readonly usage: string;
      readonly summary?: string;
    }
  | { readonly type: 'flag'; readonly flag: FlagSpec }
  | { readonly type: 'choice'; readonly values: readonly string[] }
  | { readonly type: 'live'; readonly kind: LiveKind };

export type CompletionContext =
  | {
      readonly type: 'command';
      /** The text after the slash, up to the caret. */
      readonly query: string;
      /** The whole verb token, slash included: what a pick replaces. */
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: 'argument';
      readonly spec: CommandSpec;
      /** The verb as typed, lowercased: the alias when an alias was used. */
      readonly verb: string;
      /** Which token after the verb the caret is in, counting from 0. */
      readonly index: number;
      /**
       * The kind of the first form the line fits, which is what the mobile apps
       * report. `nick` and `channel` send the composer to their own pickers.
       */
      readonly kind: ArgKind | null;
      readonly slots: readonly Slot[];
      readonly query: string;
      /** The token a pick replaces, tail included, so `/jo|in` isn't welded onto. */
      readonly start: number;
      readonly end: number;
      /** The whole tokens between the verb and this one. */
      readonly preceding: readonly string[];
    };

const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * Classify the caret. Null when the line isn't a command, is a `//` escape,
 * names an unknown verb, or the caret is in a slot with nothing to suggest.
 */
export function completionContext(value: string, caret: number): CompletionContext | null {
  if (caret < 0 || caret > value.length) return null;
  // The command must open the line. ` /join` is text to the channel, here as in
  // the dispatcher, irssi and the apps.
  if (value[0] !== '/' || value[1] === '/') return null;
  // A caret sitting on the slash has nothing to complete.
  if (caret < 1) return null;

  let i = 1;
  while (i < value.length && !isSpace(value[i])) i++;
  const verbEnd = i;

  if (caret <= verbEnd) {
    return { type: 'command', query: value.slice(1, caret), start: 0, end: verbEnd };
  }

  // Past the verb. An unknown one goes raw on send, so its arguments are opaque.
  const verb = value.slice(1, verbEnd).toLowerCase();
  const spec = specFor(verb);
  if (!spec) return null;

  // Find the token the caret is in, or the empty slot it is poised to start.
  const preceding: string[] = [];
  const starts: number[] = [];
  let query = '';
  let start = caret;
  let end = caret;
  let scan = verbEnd;
  while (scan < value.length) {
    while (scan < value.length && isSpace(value[scan])) scan++;
    const tokenStart = scan;
    // In the gap before this token: an empty new argument here.
    if (caret < tokenStart) break;
    while (scan < value.length && !isSpace(value[scan])) scan++;
    if (caret <= scan) {
      query = value.slice(tokenStart, caret);
      start = tokenStart;
      end = scan;
      break;
    }
    preceding.push(value.slice(tokenStart, scan));
    starts.push(tokenStart);
  }

  const fits = fittingForms(spec, preceding, query);
  const first = fits.find((f) => f.arg);
  // A slot that runs to the end of the line and names something that can hold
  // spaces (a theme called "My Theme") is completed as one value: everything
  // from where it began, not just the word under the caret.
  if (first?.arg?.rest && SPANNING.has(first.arg.kind)) {
    if (first.restFrom >= 0 && first.restFrom < starts.length) start = starts[first.restFrom];
    query = value.slice(start, caret);
    end = value.length;
  }

  const slots = slotsFor(verb, fits, query);
  if (!slots.length) return null;
  return {
    type: 'argument',
    spec,
    verb,
    index: preceding.length,
    kind: first?.arg?.kind ?? null,
    slots,
    query,
    start,
    end,
    preceding,
  };
}

const SPANNING: ReadonlySet<ArgKind> = new Set<ArgKind>(['theme', 'avatarSet', 'settingValue']);

/** The kind of the argument being typed, as the mobile apps' `argKind` gives it. */
export function argKind(
  spec: CommandSpec,
  preceding: readonly string[],
  typing = '',
): ArgKind | null {
  return fittingForms(spec, preceding, typing).find((f) => f.arg)?.arg?.kind ?? null;
}

interface Fit {
  readonly form: FormSpec;
  /** The positional slot the typed token would fill; null when none is left. */
  readonly arg: ArgSpec | null;
  /** Which preceding token a `rest` slot began at; `preceding.length` if this one. */
  readonly restFrom: number;
  /** The typed token is the value of this flag (`-time |`), not a positional. */
  readonly valueOf: FlagSpec | null;
}

/**
 * The forms the typed tokens fit. A form whose filled slots agree with their
 * tokens wins first: a channel in each channel slot, no channel in a nick slot.
 * That is what picks `/invite #chan <nick>` over `/invite <nick> [#chan]`.
 * Failing that, every form the tokens fit at all, so `/msg #chan hi` still
 * reads as a message.
 */
function fittingForms(spec: CommandSpec, preceding: readonly string[], typing: string): Fit[] {
  for (const strict of [true, false]) {
    const fits = spec.forms.flatMap((form) => fit(form, preceding, typing, strict) ?? []);
    if (fits.length) return fits;
  }
  return [];
}

function findFlag(form: FormSpec, token: string): FlagSpec | undefined {
  if (!token.startsWith('-')) return undefined;
  const lower = token.toLowerCase();
  return form.flags?.find((f) => f.name === lower);
}

function keywordMatches(arg: ArgSpec, token: string): boolean {
  const lower = token.toLowerCase();
  return arg.label === lower || (arg.values?.includes(lower) ?? false);
}

/** Whether `token` can fill `arg` on the strict pass. Only channel and nick slots care. */
function agrees(arg: ArgSpec, token: string): boolean {
  if (arg.kind !== 'channel' && arg.kind !== 'nick') return true;
  return isChannelTarget(token) === (arg.kind === 'channel');
}

/** Walk one form. Null when the typed tokens don't fit it. */
function fit(
  form: FormSpec,
  preceding: readonly string[],
  typing: string,
  strict: boolean,
): Fit | null {
  const { args } = form;
  const last = args.at(-1);
  let slot = 0;
  let restFrom = -1;
  for (let i = 0; i < preceding.length; i++) {
    const token = preceding[i];
    const flag = findFlag(form, token);
    if (flag) {
      if (!flag.takes) continue;
      // Its value is the next token: this one being typed, or one to step over.
      if (i === preceding.length - 1) return { form, arg: null, restFrom: -1, valueOf: flag };
      i++;
      continue;
    }
    if (slot >= args.length) {
      // Past the end, only a trailing `rest` slot takes more.
      if (last?.rest) continue;
      return null;
    }
    const arg = args[slot];
    if (arg.kind === 'keyword' && !keywordMatches(arg, token)) return null;
    if (strict && !agrees(arg, token)) return null;
    if (arg.rest && restFrom === -1) restFrom = i;
    slot++;
  }
  if (slot < args.length) {
    const arg = args[slot];
    // The half-typed token counts too, once there is one: `/invite #ot` is a channel.
    if (strict && typing && !agrees(arg, typing)) return null;
    return { form, arg, restFrom: preceding.length, valueOf: null };
  }
  if (last?.rest) return { form, arg: last, restFrom, valueOf: null };
  // Every slot is filled. The form still fits, for the options it takes.
  return form.flags?.length ? { form, arg: null, restFrom: -1, valueOf: null } : null;
}

function slotsFor(verb: string, fits: readonly Fit[], query: string): Slot[] {
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const add = (key: string, slot: Slot) => {
    if (seen.has(key)) return;
    seen.add(key);
    slots.push(slot);
  };
  for (const { form, arg, valueOf } of fits) {
    // A flag's own value is opaque: a duration, a host, a password.
    if (valueOf) continue;
    // Options are offered once a `-` says one is being typed.
    if (query.startsWith('-')) {
      for (const flag of form.flags ?? []) add(`flag:${flag.name}`, { type: 'flag', flag });
    }
    if (!arg) continue;
    if (arg.kind === 'keyword') {
      add(`keyword:${arg.label}`, {
        type: 'keyword',
        value: arg.label,
        usage: formUsage(verb, form),
        ...(form.summary ? { summary: form.summary } : {}),
      });
    } else if (arg.kind === 'choice') {
      add(`choice:${(arg.values ?? []).join(' ')}`, { type: 'choice', values: arg.values ?? [] });
    } else if (LIVE.has(arg.kind)) {
      add(`live:${arg.kind}`, { type: 'live', kind: arg.kind as LiveKind });
    }
  }
  return slots;
}

// ── Candidates ──────────────────────────────────────────────────────────────

/** One row of the popover, one chip of the strip. */
export interface Candidate {
  /** What a pick puts in place of the token. */
  readonly value: string;
  /** What the row shows first; the value itself when absent. */
  readonly label?: string;
  /** The dim half of the row: a summary, a setting's current value. */
  readonly detail?: string;
  readonly kind: 'command' | 'keyword' | 'flag' | 'choice' | LiveKind;
}

export interface CandidateSource {
  /** The system buffer: only commands that run without a network. */
  readonly agnosticOnly?: boolean;
  /**
   * The live lists. Called with what has been typed of the token; returns its
   * own matches, best first, since each list ranks its own way (recent
   * speakers, joined channels). `preceding` is there for a slot that depends on
   * an earlier one: a setting's values need the key.
   */
  readonly live?: (
    kind: LiveKind,
    query: string,
    preceding: readonly string[],
  ) => readonly Candidate[];
}

/** The rows for a context, best first. Empty when nothing matches what's typed. */
export function candidatesFor(
  context: CompletionContext,
  source: CandidateSource = {},
): Candidate[] {
  if (context.type === 'command') {
    return matchingCommands(context.query, { agnosticOnly: source.agnosticOnly }).map(
      ({ spec, name }) => ({
        value: `/${name}`,
        label: commandUsage(spec, name),
        detail: name === spec.names[0] ? spec.summary : `alias of /${spec.names[0]}`,
        kind: 'command',
      }),
    );
  }
  const needle = context.query.toLowerCase();
  const rows: Candidate[] = [];
  for (const slot of context.slots) {
    if (slot.type === 'keyword') {
      if (!slot.value.startsWith(needle)) continue;
      rows.push({
        value: slot.value,
        label: slot.usage,
        ...(slot.summary ? { detail: slot.summary } : {}),
        kind: 'keyword',
      });
    } else if (slot.type === 'flag') {
      if (!slot.flag.name.startsWith(needle)) continue;
      rows.push({
        value: slot.flag.name,
        ...(slot.flag.takes ? { label: `${slot.flag.name} <${slot.flag.takes}>` } : {}),
        ...(slot.flag.summary ? { detail: slot.flag.summary } : {}),
        kind: 'flag',
      });
    } else if (slot.type === 'choice') {
      for (const value of slot.values) {
        if (value.toLowerCase().startsWith(needle)) rows.push({ value, kind: 'choice' });
      }
    } else {
      rows.push(...(source.live?.(slot.kind, context.query, context.preceding) ?? []));
    }
  }
  return rows;
}

/**
 * Whether what's typed is already something that can be sent as it stands: a
 * whole command name, a whole keyword or value. Enter sends then; otherwise,
 * with a candidate up, it completes. Nothing typed yet is also "send": an empty
 * optional slot must not swallow the Enter that runs `/part `.
 */
export function isComplete(context: CompletionContext, candidates: readonly Candidate[]): boolean {
  if (context.type === 'command') return specFor(context.query) !== undefined;
  if (!context.query) return true;
  const typed = context.query.toLowerCase();
  return candidates.some((c) => c.value.toLowerCase() === typed);
}
