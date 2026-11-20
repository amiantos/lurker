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
import { aliasTarget, type Alias } from '../../../../shared/aliases.js';
import {
  matchingCommands,
  specFor,
  commandUsage,
  formUsage,
  formUsageParts,
  type ArgKind,
  type ArgSpec,
  type CommandSpec,
  type FlagSpec,
  type FormSpec,
} from './registry.js';

/** The kinds whose candidates are live lists the composer has to supply. */
export type LiveKind = Extract<
  ArgKind,
  'channel' | 'nick' | 'setting' | 'settingValue' | 'theme' | 'network' | 'avatarSet' | 'alias'
>;

const LIVE: ReadonlySet<ArgKind> = new Set<LiveKind>([
  'channel',
  'nick',
  'setting',
  'settingValue',
  'theme',
  'network',
  'avatarSet',
  'alias',
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
      /**
       * The verb as typed, lowercased: `hop` for `/hop`, not `cycle`. For one of
       * the user's own aliases, the command it stands for.
       */
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
 * Where the token starting at `from` ends. With `quoted`, as `tokenizeArgs`
 * reads it: a quoted span and a backslashed character don't end a token.
 */
function tokenEnd(value: string, from: number, quoted: boolean): number {
  let i = from;
  let quote = '';
  while (i < value.length) {
    const ch = value[i];
    if (quoted && ch === '\\' && i + 1 < value.length) {
      i += 2;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
    } else if (quoted && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (isSpace(ch)) {
      break;
    }
    i++;
  }
  return i;
}

/** Whether the line is a command at all, and the caret somewhere in it. */
function isCommandLine(value: string, caret: number): boolean {
  if (caret < 0 || caret > value.length) return false;
  // The command must open the line. ` /join` is text to the channel, here as in
  // the dispatcher, irssi and the apps.
  if (value[0] !== '/' || value[1] === '/') return false;
  // A caret sitting on the slash has nothing to complete.
  return caret >= 1;
}

function verbEndOf(value: string): number {
  let i = 1;
  while (i < value.length && !isSpace(value[i])) i++;
  return i;
}

/** The argument the caret is in, once it is past the verb of a known command. */
interface ArgumentAt {
  readonly spec: CommandSpec;
  readonly verb: string;
  readonly preceding: string[];
  /** Where each preceding token began; -1 for one an alias's body supplied. */
  readonly starts: number[];
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

function argumentAt(
  value: string,
  caret: number,
  verbEnd: number,
  aliases: readonly Alias[],
): ArgumentAt | null {
  // An unknown verb goes raw on send, so its arguments are opaque.
  const typed = value.slice(1, verbEnd).toLowerCase();
  const alias = aliases.find((a) => a.name === typed);
  // One level, as WeeChat has it: the body names a command, not another alias.
  // Its own name there is the command it replaced, so that case falls out too.
  const target = alias ? aliasTarget(alias.body) : null;
  if (alias && !target) return null;
  // The command it names is itself replaced by another alias: not that command.
  if (target && target.verb !== typed && aliases.some((a) => a.name === target.verb)) return null;
  const verb = target?.verb ?? typed;
  const spec = specFor(verb);
  if (!spec) return null;

  // Find the token the caret is in, or the empty slot it is poised to start.
  // The words an alias's body supplies come first; they have no place in the
  // line, which the -1 says.
  const preceding: string[] = [...(target?.words ?? [])];
  const starts: number[] = preceding.map(() => -1);
  let query = '';
  let start = caret;
  let end = caret;
  let scan = verbEnd;
  while (scan < value.length) {
    while (scan < value.length && isSpace(value[scan])) scan++;
    const tokenStart = scan;
    // In the gap before this token: an empty new argument here.
    if (caret < tokenStart) break;
    scan = tokenEnd(value, scan, spec.quoted === true);
    if (caret <= scan) {
      query = value.slice(tokenStart, caret);
      start = tokenStart;
      end = scan;
      break;
    }
    preceding.push(value.slice(tokenStart, scan));
    starts.push(tokenStart);
  }
  return { spec, verb, preceding, starts, query, start, end };
}

/**
 * Classify the caret. Null when the line isn't a command, is a `//` escape,
 * names an unknown verb, or the caret is in a slot with nothing to suggest.
 *
 * `aliases` are the user's own (#276). An alias wins over a command of its
 * name, as it does on send, and one that is a plain rename (`/alias j2 /join`)
 * completes its arguments as the command it stands for.
 */
export function completionContext(
  value: string,
  caret: number,
  aliases: readonly Alias[] = [],
): CompletionContext | null {
  if (!isCommandLine(value, caret)) return null;
  const verbEnd = verbEndOf(value);

  if (caret <= verbEnd) {
    return { type: 'command', query: value.slice(1, caret), start: 0, end: verbEnd };
  }

  const at = argumentAt(value, caret, verbEnd, aliases);
  if (!at) return null;
  const { spec, verb, preceding, starts } = at;
  let { query, start, end } = at;

  const fits = fittingForms(spec, preceding, query);
  const first = fits.find((f) => f.arg);
  // A slot that runs to the end of the line and names something that can hold
  // spaces (a theme called "My Theme") is completed as one value: everything
  // from where it began, not just the word under the caret.
  if (first?.arg?.rest && SPANNING.has(first.arg.kind)) {
    if (first.restFrom >= 0 && first.restFrom < starts.length) {
      // Begun in an alias's body: what can be replaced starts at the first typed word.
      start = starts.slice(first.restFrom).find((at) => at >= 0) ?? start;
    }
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
  /** How many arguments, keywords aside, came before the typed one. */
  readonly filled: number;
  /** How many options came before it. */
  readonly flagged: number;
  /** A `--` came before it: what follows is text, dashes and all. */
  readonly literal: boolean;
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
  return form.flags?.find((f) => f.name === lower || (f.also?.includes(lower) ?? false));
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
  let filled = 0;
  let flagged = 0;
  let literal = false;
  let restFrom = -1;
  const at = () => ({ filled, flagged, literal });
  for (let i = 0; i < preceding.length; i++) {
    const token = preceding[i];
    if (form.flags?.length && !literal && token === '--') {
      literal = true;
      continue;
    }
    const flag = literal ? undefined : findFlag(form, token);
    if (flag) {
      flagged++;
      if (!flag.takes) continue;
      // Its value is the next token: this one being typed, or one to step over.
      if (i === preceding.length - 1) {
        return { form, arg: null, restFrom: -1, valueOf: flag, ...at() };
      }
      i++;
      // `-time 7 days`: a bare count takes its unit with it.
      if (
        flag.takes === 'dur' &&
        /^\d+$/.test(preceding[i]) &&
        /^[a-z]+$/i.test(preceding[i + 1] ?? '')
      ) {
        i++;
      }
      continue;
    }
    if (args[Math.min(slot, args.length - 1)]?.kind !== 'keyword') filled++;
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
    // A word in an optional channel slot is more likely the text that follows
    // it: `/topic Lurker rocks` sets a topic, it doesn't name #lurker.
    if (typing && arg.optional && arg.kind === 'channel' && !isChannelTarget(typing)) return null;
    return { form, arg, restFrom: preceding.length, valueOf: null, ...at() };
  }
  if (last?.rest) return { form, arg: last, restFrom, valueOf: null, ...at() };
  // Every slot is filled. The form still fits, for the options it takes.
  return form.flags?.length ? { form, arg: null, restFrom: -1, valueOf: null, ...at() } : null;
}

function takesFlagHere({ form, filled, flagged, literal }: Fit): boolean {
  if (literal) return false;
  if (!form.flagsAt) return true;
  return filled === 0 && (form.flagsAt === 'lead' || flagged === 0);
}

function slotsFor(verb: string, fits: readonly Fit[], query: string): Slot[] {
  const slots: Slot[] = [];
  const seen = new Set<string>();
  const add = (key: string, slot: Slot) => {
    if (seen.has(key)) return;
    seen.add(key);
    slots.push(slot);
  };
  for (const fit of fits) {
    const { form, arg, valueOf } = fit;
    // A flag's own value is opaque: a duration, a host, a password.
    if (valueOf) continue;
    // Options are offered once a `-` says one is being typed, and only where
    // the handler reads them.
    if (query.startsWith('-') && takesFlagHere(fit)) {
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

// ── The usage line ──────────────────────────────────────────────────────────

/** The usage of the command being typed, with the argument under the caret marked (#1369). */
export interface UsageHint {
  readonly parts: readonly { readonly text: string; readonly active: boolean }[];
  readonly summary: string;
}

/**
 * What to keep in view while a command's arguments are typed. It answers
 * wherever the verb is known, including the slots `completionContext` has
 * nothing to suggest for: a message, a reason, a channel key. Null while the
 * verb itself is being typed, where the rows already show each usage.
 */
export function usageHint(
  value: string,
  caret: number,
  aliases: readonly Alias[] = [],
): UsageHint | null {
  if (!isCommandLine(value, caret)) return null;
  const verbEnd = verbEndOf(value);
  if (caret <= verbEnd) return null;
  const at = argumentAt(value, caret, verbEnd, aliases);
  if (!at) return null;
  const { spec, verb, preceding, query } = at;
  const family: UsageHint = {
    parts: [{ text: commandUsage(spec, verb), active: false }],
    summary: spec.summary,
  };
  const fits = fittingForms(spec, preceding, query);
  // More words than any form takes: the usage still says what it wanted.
  if (!fits.length) return family;
  // A subcommand is being chosen, and the rows list them. No one form yet.
  const keywords = new Set(fits.map((f) => (f.arg?.kind === 'keyword' ? f.arg.label : null)));
  keywords.delete(null);
  if (keywords.size > 1) return family;

  const fit = fits.find((f) => f.arg) ?? fits[0];
  const option = query.startsWith('-') && takesFlagHere(fit);
  return {
    parts: formUsageParts(verb, fit.form).map((part) => ({
      text: part.text,
      active: fit.valueOf
        ? part.flag === fit.valueOf || part.flag === 'all'
        : option && fit.form.flags?.length
          ? part.flag !== undefined
          : part.arg !== undefined && part.arg === fit.arg,
    })),
    summary: fit.form.summary ?? spec.summary,
  };
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
  /** The user's own aliases (#276), listed with the commands. */
  readonly aliases?: readonly Alias[];
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
    const needle = context.query.toLowerCase();
    const own = (source.aliases ?? [])
      .filter((a) => a.name.startsWith(needle))
      .map((a): Candidate => ({ value: `/${a.name}`, detail: `→ ${a.body}`, kind: 'command' }));
    const taken = new Set(own.map((row) => row.value));
    const commands = matchingCommands(context.query, { agnosticOnly: source.agnosticOnly })
      .map(({ spec, name }): Candidate => ({
        value: `/${name}`,
        label: commandUsage(spec, name),
        detail: name === spec.names[0] ? spec.summary : `alias of /${spec.names[0]}`,
        kind: 'command',
      }))
      // An alias replaces the command of its name, here as on send.
      .filter((row) => !taken.has(row.value));
    // A name typed in full leads, so the highlighted row is the one Enter runs.
    const exact = own.filter((row) => row.value === `/${needle}`);
    const rest = own.filter((row) => row.value !== `/${needle}`);
    return [...exact, ...commands, ...rest];
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
  if (context.type === 'command') {
    const typed = `/${context.query.toLowerCase()}`;
    return specFor(context.query) !== undefined || candidates.some((c) => c.value === typed);
  }
  // A value that holds spaces keeps the one a pick left after it.
  const typed = context.query.trimEnd().toLowerCase();
  if (!typed) return true;
  return candidates.some((c) => c.value.toLowerCase() === typed);
}
