// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The fserve command interpreter (#270 follow-on) — the pure, sandboxed core of
// the file server. An fserve is an FTP-over-DCC-CHAT: a peer navigates a
// directory tree with dir/cd/get commands over the chat socket, and each `get`
// triggers a DCC SEND of that file. This module turns one command line into a
// response + an optional action (change directory, send a file, close), given
// the current working directory and the archive root.
//
// SECURITY: this is the sandbox boundary. Every path is resolved against the
// root and REJECTED if it escapes — a peer must never be able to `cd ..` above
// the archive or `get /etc/passwd`. The interpreter is filesystem-read-only (it
// stats + lists) and never writes. Kept pure + unit-tested so the traversal
// rules are pinned in isolation, exactly like the DCC parsers.

import fs from 'fs';
import path from 'path';

export interface FserveState {
  /** Absolute, canonical archive root — the sandbox ceiling. */
  root: string;
  /** Absolute current directory; an invariant of every result is cwd ⊆ root. */
  cwd: string;
}

export interface FserveResult {
  /** Lines to send back over the chat socket. */
  lines: string[];
  /** Set when `cd` moved us — the caller updates the session's cwd. */
  newCwd?: string;
  /** Set when `get` resolved a readable file — the caller DCC-SENDs it. */
  sendPath?: string;
  /** Set when the peer asked to leave. */
  close?: boolean;
}

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

const HELP_LINES = [
  'Commands:',
  '  dir | ls          list this directory',
  '  cd <dir>          change directory (cd .. up, cd / root)',
  '  pwd               show current directory',
  '  get <file>        download a file (sent over DCC)',
  '  help | ?          this help',
  '  quit | exit       leave',
];

/**
 * Run one fserve command line. Read-only against the filesystem; the caller
 * applies newCwd / performs the DCC send for sendPath / closes on close.
 */
export function runFserveCommand(state: FserveState, rawLine: string): FserveResult {
  const line = rawLine.trim();
  if (line === '') return { lines: [] };
  const sp = line.indexOf(' ');
  const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? '' : line.slice(sp + 1).trim();

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
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(state.cwd, { withFileTypes: true });
  } catch {
    return { lines: ['Cannot read this directory.'] };
  }
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`Directory ${displayPath(state.root, state.cwd)}:`];
  for (const d of dirs) lines.push(`  [DIR]  ${d.name}/`);
  for (const f of files) {
    let size = 0;
    try {
      size = fs.statSync(path.join(state.cwd, f.name)).size;
    } catch {
      /* unreadable — show 0 */
    }
    lines.push(`  ${fmtSize(size).padStart(9)}  ${f.name}`);
  }
  if (dirs.length === 0 && files.length === 0) lines.push('  (empty)');
  return { lines };
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
  return { lines: [`Now in ${displayPath(state.root, target)}`], newCwd: target };
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
  return {
    lines: [`Sending "${path.basename(target)}" (${fmtSize(stat.size)})…`],
    sendPath: target,
  };
}
