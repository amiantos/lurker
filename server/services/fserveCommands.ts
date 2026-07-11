// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The fserve command interpreter (#270 follow-on) — the pure, sandboxed core of
// the file server. An fserve is an FTP-over-DCC-CHAT: a peer navigates a
// directory tree with dir/cd/get commands over the chat socket, and each `get`
// hands a file to the send queue for a DCC SEND. This module turns one command
// line into a response + an optional action (change directory, request a file,
// close, or run a stateful "control" command), given the current working
// directory and the archive root.
//
// Two navigation styles, both classic-fserve: full commands (dir/cd/get) and the
// number-letter shorthand (`1d` = first subdir, `2F` = second file, `0d` = up).
// The directory listing prints those tokens so a peer can just type them back.
//
// SECURITY: this is the sandbox boundary. Every path is resolved against the
// root and REJECTED if it escapes — a peer must never be able to `cd ..` above
// the archive or `get /etc/passwd`. The interpreter is filesystem-read-only (it
// stats + lists) and never writes. Kept pure + unit-tested so the traversal
// rules are pinned in isolation, exactly like the DCC parsers. Stateful commands
// (queue/stats/who) are recognised here but delegated to the caller via a
// `control` marker, since their data lives outside this pure module.

import fs from 'fs';
import path from 'path';

/** Optional visibility filter for what a peer may see/get. Undefined = no
 *  filtering (everything visible). Directories are always browsable; the
 *  extension filter applies to files only. */
export interface FserveFilter {
  /** Hide entries whose name starts with "." */
  hideDotfiles: boolean;
  /** Lowercased extensions (no dot) a file must have to be visible; empty = all. */
  allowedExts: string[];
}

export interface FserveState {
  /** Absolute, canonical archive root — the sandbox ceiling. */
  root: string;
  /** Absolute current directory; an invariant of every result is cwd ⊆ root. */
  cwd: string;
  /** Optional visibility filter (hidden files / allowed extensions). */
  filter?: FserveFilter;
}

// Whether an entry is visible under a filter. Dotfiles are hidden when
// hideDotfiles is set; the extension allow-list applies to FILES only (dirs stay
// browsable). No filter → always visible.
function passesFilter(name: string, isDir: boolean, filter?: FserveFilter): boolean {
  if (!filter) return true;
  if (filter.hideDotfiles && name.startsWith('.')) return false;
  if (isDir) return true;
  if (filter.allowedExts.length === 0) return true;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return filter.allowedExts.includes(ext);
}

export interface FserveResult {
  /** Lines to send back over the chat socket. */
  lines: string[];
  /** Set when `cd` moved us — the caller updates the session's cwd. */
  newCwd?: string;
  /** Set when `get` resolved a readable file — the caller queues a DCC SEND. */
  sendPath?: string;
  /** Set when the peer asked to leave. */
  close?: boolean;
  /** A stateful command (queue/stats/who/…) the pure module can't answer alone;
   *  the caller runs it against live session/queue state and sends the result. */
  control?: { name: string; arg: string };
}

// Stateful commands that depend on runtime state (the send queue, live sessions,
// cumulative stats) rather than the filesystem. Recognised here, executed by the
// caller (ircConnection) which holds that state.
export const FSERVE_CONTROL_COMMANDS = new Set([
  'queues',
  'queue',
  'sends',
  'stats',
  'who',
  'clr_queue',
  'clr_queues',
]);

// 1024-based size, one decimal. Mirrors dcc.formatBytes but kept local so this
// module stays dependency-free and independently testable.
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// The path of `cwd` relative to `root`, as a leading-slash display path
// ("/" at the root, "/sub/dir" below). Never leaks the server's absolute path.
export function displayPath(root: string, cwd: string): string {
  const rel = path.relative(root, cwd);
  return rel === '' ? '/' : '/' + rel.split(path.sep).join('/');
}

// Resolve a user-supplied path argument against cwd (or root for an absolute
// "/..."), then confirm it stays within root. Returns the canonical absolute
// path, or null if it escapes or is malformed. This is the single choke point
// every navigation/get flows through.
function resolveWithin(root: string, cwd: string, arg: string): string | null {
  // A leading slash means "from the archive root", not the server's fs root.
  const base = arg.startsWith('/') ? root : cwd;
  const rel = arg.replace(/^\/+/, '');
  const resolved = path.resolve(base, rel);
  // Containment: resolved must equal root or sit strictly beneath it. Compare
  // with a trailing separator so "/archive-evil" can't pass as under "/archive".
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

// The sorted directory/file split used by both listing and number-letter
// navigation, so the indices a peer sees in `dir` match what `2F` selects.
function readEntries(
  dir: string,
  filter?: FserveFilter,
): { dirs: string[]; files: string[] } | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && passesFilter(e.name, true, filter))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b));
  const files = entries
    .filter((e) => e.isFile() && passesFilter(e.name, false, filter))
    .map((e) => e.name)
    .toSorted((a, b) => a.localeCompare(b));
  return { dirs, files };
}

const HELP_LINES = [
  'Commands:',
  '  dir | ls          list this directory (shows 1d / 2F selectors)',
  '  cd <dir>          change directory (cd .. up, cd / root)',
  '  1d / 2F           shorthand: Nd = Nth dir (0d = up), NF = Nth file',
  '  pwd               show current directory',
  '  get <file>        queue a file for download (sent over DCC)',
  '  queues            show the waiting queue',
  '  sends             show transfers in progress',
  '  clr_queue         remove your queued files',
  '  stats             server stats (files/bytes sent, slots)',
  '  who               who is browsing right now',
  '  help | ?          this help',
  '  quit | exit       leave',
];

/**
 * Run one fserve command line. Read-only against the filesystem; the caller
 * applies newCwd / queues the DCC send for sendPath / closes on close / runs the
 * control command.
 */
export function runFserveCommand(state: FserveState, rawLine: string): FserveResult {
  const line = rawLine.trim();
  if (line === '') return { lines: [] };

  // Number-letter shorthand: "1d", "0d" (up), "2F". Checked before word parsing
  // so a bare token like "3F" navigates instead of being an unknown command.
  const nav = /^(\d+)([dDfF])$/.exec(line);
  if (nav) return numberedNav(state, parseInt(nav[1], 10), nav[2].toLowerCase());

  const sp = line.indexOf(' ');
  const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? '' : line.slice(sp + 1).trim();

  if (FSERVE_CONTROL_COMMANDS.has(cmd)) {
    // Normalise the two spellings so the caller only handles canonical names.
    const name = cmd === 'queue' ? 'queues' : cmd;
    return { lines: [], control: { name, arg } };
  }

  switch (cmd) {
    case 'help':
    case '?':
      return { lines: HELP_LINES };

    case 'pwd':
      return { lines: [displayPath(state.root, state.cwd)] };

    case 'quit':
    case 'exit':
    case 'bye':
      return { lines: ['Bye.'], close: true };

    case 'ls':
    case 'dir':
      return listDir(state);

    case 'cd':
      return changeDir(state, arg);

    case 'get':
      return getFile(state, arg);

    default:
      return { lines: [`Unknown command "${cmd}". Type help for commands.`] };
  }
}

function listDir(state: FserveState): FserveResult {
  const ent = readEntries(state.cwd, state.filter);
  if (!ent) return { lines: ['Cannot read this directory.'] };
  const { dirs, files } = ent;
  const here = displayPath(state.root, state.cwd);
  const lines = [`Directory ${here}:`];
  if (here !== '/') lines.push('  0d  ../');
  dirs.forEach((name, i) => lines.push(`  ${i + 1}d  ${name}/`));
  files.forEach((name, i) => {
    let size = 0;
    try {
      size = fs.statSync(path.join(state.cwd, name)).size;
    } catch {
      /* unreadable — show 0 */
    }
    lines.push(`  ${i + 1}F  ${fmtSize(size).padStart(9)}  ${name}`);
  });
  if (dirs.length === 0 && files.length === 0) lines.push('  (empty)');
  lines.push(`End of list — ${dirs.length} dir(s), ${files.length} file(s).`);
  return { lines };
}

// Resolve a number-letter token against the current listing. `kind` is 'd' or
// 'f'; index is 1-based (with 0d meaning "up one"). Selecting a dir cd's into it;
// selecting a file routes through getFile so the same sandbox + queue apply.
function numberedNav(state: FserveState, index: number, kind: string): FserveResult {
  if (kind === 'd' && index === 0) return changeDir(state, '..');
  const ent = readEntries(state.cwd, state.filter);
  if (!ent) return { lines: ['Cannot read this directory.'] };
  const list = kind === 'd' ? ent.dirs : ent.files;
  if (index < 1 || index > list.length) {
    const token = `${index}${kind === 'd' ? 'd' : 'F'}`;
    return { lines: [`No ${kind === 'd' ? 'directory' : 'file'} ${token} here.`] };
  }
  const name = list[index - 1];
  return kind === 'd' ? changeDir(state, name) : getFile(state, name);
}

function changeDir(state: FserveState, arg: string): FserveResult {
  if (!arg) return { lines: [displayPath(state.root, state.cwd)] };
  const target = resolveWithin(state.root, state.cwd, arg);
  if (target === null) return { lines: ['Access denied.'] };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { lines: [`No such directory: ${arg}`] };
  }
  if (!stat.isDirectory()) return { lines: [`Not a directory: ${arg}`] };
  // Can't cd into a hidden directory when dotfiles are filtered (root always ok).
  if (target !== state.root && !passesFilter(path.basename(target), true, state.filter)) {
    return { lines: [`No such directory: ${arg}`] };
  }
  return { lines: [`Now in ${displayPath(state.root, target)}`], newCwd: target };
}

export interface SearchHit {
  /** Archive-relative display path ("/dir/file.ext"), never the server abs path. */
  path: string;
  size: number;
}

export interface SearchResult {
  results: SearchHit[];
  /** More matches existed than were returned (hit the result/scan/time cap). */
  truncated: boolean;
  /** Entries inspected — for logging/tuning. */
  scanned: number;
}

export interface SearchOptions {
  maxResults?: number;
  /** Hard cap on entries visited (protects a huge archive from a full walk). */
  maxScan?: number;
  /** Wall-clock budget in ms; the walk stops when exceeded. */
  budgetMs?: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
  /** Visibility filter — hidden dirs aren't descended, filtered files aren't
   *  returned, matching the interpreter's listings. */
  filter?: FserveFilter;
}

/**
 * Bounded, sandboxed archive search for the `@find` trigger. Case-insensitively
 * matches every whitespace-separated term against each file's archive-relative
 * path, walking breadth-first and stopping at the result / scan / time cap. Only
 * ever descends within `root` (it starts there and never follows to a parent),
 * so like the interpreter it cannot leak paths outside the archive. Read-only.
 */
export function searchArchive(root: string, query: string, opts: SearchOptions = {}): SearchResult {
  const maxResults = Math.max(1, opts.maxResults ?? 15);
  const maxScan = Math.max(1, opts.maxScan ?? 200_000);
  const budgetMs = Math.max(1, opts.budgetMs ?? 400);
  const now = opts.now ?? Date.now;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const results: SearchHit[] = [];
  if (terms.length === 0) return { results, truncated: false, scanned: 0 };

  const start = now();
  let scanned = 0;
  let truncated = false;
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (results.length >= maxResults || scanned >= maxScan || now() - start > budgetMs) {
      truncated = queue.length > 0;
      break;
    }
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      scanned++;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (passesFilter(e.name, true, opts.filter)) queue.push(abs);
      } else if (e.isFile()) {
        if (!passesFilter(e.name, false, opts.filter)) continue;
        const rel = displayPath(root, abs).toLowerCase();
        if (terms.every((t) => rel.includes(t))) {
          let size = 0;
          try {
            size = fs.statSync(abs).size;
          } catch {
            /* unreadable — report 0 */
          }
          results.push({ path: displayPath(root, abs), size });
          if (results.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }
  }
  return { results, truncated, scanned };
}

function getFile(state: FserveState, arg: string): FserveResult {
  if (!arg) return { lines: ['Usage: get <file>'] };
  const target = resolveWithin(state.root, state.cwd, arg);
  if (target === null) return { lines: ['Access denied.'] };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { lines: [`No such file: ${arg}`] };
  }
  if (stat.isDirectory()) return { lines: [`"${arg}" is a directory — use cd, or get a file.`] };
  if (!stat.isFile()) return { lines: [`Not a regular file: ${arg}`] };
  // Hidden/disallowed by the filter → behave as if it isn't there (don't confirm
  // a filtered file exists by giving it a distinct error).
  if (!passesFilter(path.basename(target), false, state.filter)) {
    return { lines: [`No such file: ${arg}`] };
  }
  // No status line here: the caller queues the send and reports the authoritative
  // outcome ("sending now" vs "queued in slot N"). We only hand back the path.
  return { lines: [], sendPath: target };
}
