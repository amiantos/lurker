// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Search, off the event loop.
//
// better-sqlite3 is synchronous, and a search can be a long walk: a term in
// one buffer is found by visiting every message on the instance that holds
// the term, newest first, until a page of them turns out to be in that buffer.
// On 2026-11-10 one such search (one word, inside a DM) held a hosted cell's
// event loop for 106 s: no socket was served, the engine link was lost, and
// all 42 connections re-attached (#1302). So the statement runs in a child
// process, on its own read-only connection (WAL readers don't block the
// server's writes), one at a time, and the server's loop only waits for rows.
// Every free-text read of `messages` goes this way: search, and the
// highlights and activity feeds, which take the same text filter.
//
// A process, not a worker thread, because a walk must be stoppable: nothing
// reaches into a running sqlite3_step from JavaScript (better-sqlite3 exposes
// no interrupt), and worker.terminate() waits for the native call to return —
// measured: still running 15 s after terminate(), where a SIGKILL ended the
// child in 2 ms. The child starts in ~60 ms and is started again on the next
// search; idle for SEARCH_IDLE_EXIT_MS it is let go.
//
// When a search is stopped:
//   - its asker went away (a request the client aborted, a socket that
//     closed): dropped if it still waited, killed if it ran — the old
//     in-process search ran every superseded request to completion;
//   - SEARCH_TIME_LIMIT_MS after it was ASKED, waiting included: a read that
//     long holds back WAL checkpoints for as long as it runs, and nobody
//     should wait longer than that for a turn either.
//
// One slot is shared by everyone on the instance, so turns are fair and the
// line is bounded: the next search to run is the one whose owner was served
// longest ago; an owner may have MAX_WAITING_PER_OWNER searches waiting (one
// more displaces their oldest, which is what a newer search-as-you-type
// keystroke means anyway); and past MAX_WAITING in all a search is refused
// (`search_busy`) rather than kept.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATABASE_FILE } from '../db/index.js';
import {
  searchMessagesSql,
  searchRowsToEvents,
  type MessageEventWithNetwork,
  type SearchMessagesOptions,
} from '../db/messages.js';
import { envInt } from '../utils/envInt.js';

/** How long after it is asked a search may still be waiting or running.
 *  `LURKER_SEARCH_TIME_LIMIT_MS`. */
export const SEARCH_TIME_LIMIT_MS = 30_000;
/** The most searches one owner may have waiting; the oldest gives way. */
export const MAX_WAITING_PER_OWNER = 4;
/** The most searches that may wait in all. */
export const MAX_WAITING = 64;
/** The search process is let go after this long with nothing to do. */
const SEARCH_IDLE_EXIT_MS = 5 * 60_000;
/** A search slower than this is logged, by shape (never its text). */
const SLOW_SEARCH_LOG_MS = 1000;
/** setTimeout's ceiling: past it a delay overflows and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const CHILD_ENTRY = fileURLToPath(new URL('../searchProcess.ts', import.meta.url));

export type SearchErrorCode =
  /** Past the time limit, waiting included. */
  | 'search_timeout'
  /** Its asker went away, or a newer search of the same owner displaced it. */
  | 'search_aborted'
  /** Too many searches are waiting already. */
  | 'search_busy'
  /** The statement threw, or the process died. */
  | 'search_failed';

export interface SearchError extends Error {
  code: SearchErrorCode;
}

function searchError(code: SearchErrorCode, message: string): SearchError {
  const err = new Error(message) as SearchError;
  err.code = code;
  return err;
}

export interface SearchRunOptions {
  /** Aborted when the asker stopped waiting. */
  signal?: AbortSignal;
  /** Whose search this is: turns are taken, and the waiting line bounded, per
   *  owner. A user id; absent, the search is nobody's and shares one turn. */
  owner?: number;
  /** What kind of search, for the log: which filters, never their values. */
  shape?: string;
}

interface Job {
  id: number;
  sql: string;
  params: Array<string | number>;
  shape: string;
  owner: number | null;
  resolve: (rows: unknown[]) => void;
  reject: (err: SearchError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  askedAt: number;
  /** Fires SEARCH_TIME_LIMIT_MS after the search was asked. */
  deadline: ReturnType<typeof setTimeout>;
  startedAt?: number;
  /** The process it runs in. */
  proc?: ChildProcess;
  /** Why the child was killed under this job. */
  stopped?: 'search_timeout' | 'search_aborted';
}

let child: ChildProcess | null = null;
let running: Job | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
const queue: Job[] = [];
let nextId = 1;
/** When each owner's search last started, as a job id: who waits longest. */
const lastServed = new Map<number | null, number>();
let exitHooked = false;

function timeLimitMs(): number {
  const ms = envInt('LURKER_SEARCH_TIME_LIMIT_MS', SEARCH_TIME_LIMIT_MS) || SEARCH_TIME_LIMIT_MS;
  return Math.min(ms, MAX_TIMER_MS);
}

// The job is over, one way or another: nothing of it is left armed.
function settle(job: Job): void {
  clearTimeout(job.deadline);
  if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
}

// Whether `proc` keeps this process's event loop alive.
function hold(proc: ChildProcess, on: boolean): void {
  const channel = proc.channel as { ref?: () => void; unref?: () => void } | null | undefined;
  if (on) {
    proc.ref();
    channel?.ref?.();
  } else {
    proc.unref();
    channel?.unref?.();
  }
}

function start(): ChildProcess {
  // If this process goes, the child goes with it. 'exit' runs on every exit
  // this process makes itself (process.exit, a fatal error); for the death it
  // cannot see (SIGKILL), the child watches for it (searchProcess.ts).
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      (running?.proc ?? child)?.kill('SIGKILL');
      child?.kill('SIGKILL');
    });
  }
  const proc = fork(CHILD_ENTRY, [DATABASE_FILE], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  // Idle, it is never the reason this process stays up; with a search
  // running it is, as any pending request would be (pump / finish).
  hold(proc, false);
  proc.on('message', (reply: { id: number; rows?: unknown[]; error?: string }) => {
    const job = running;
    if (!job || reply.id !== job.id) return;
    finish();
    const took = Date.now() - job.startedAt!;
    if (took >= SLOW_SEARCH_LOG_MS) console.warn(`[search] took ${took}ms (${job.shape})`);
    if (reply.rows) job.resolve(reply.rows);
    else job.reject(searchError('search_failed', reply.error || 'search failed'));
    pump();
  });
  const gone = (why: string) => {
    if (child === proc) child = null;
    const job = running;
    // A job of the next process is not this one's to end.
    if (!job || job.proc !== proc) return;
    finish();
    const took = Date.now() - job.startedAt!;
    if (job.stopped === 'search_timeout') {
      console.warn(`[search] stopped after ${took}ms, past the time limit (${job.shape})`);
      job.reject(searchError('search_timeout', 'search took too long'));
    } else if (job.stopped === 'search_aborted') {
      if (took >= SLOW_SEARCH_LOG_MS)
        console.warn(`[search] abandoned by its asker after ${took}ms (${job.shape})`);
      job.reject(searchError('search_aborted', 'search abandoned'));
    } else {
      console.warn(`[search] the search process ${why} mid-search (${job.shape})`);
      job.reject(searchError('search_failed', 'search failed'));
    }
    pump();
  };
  proc.on('exit', (code, signal) => gone(`exited (${signal ?? code})`));
  proc.on('error', (err) => gone(`failed (${err.message})`));
  return proc;
}

// The running job is over, one way or another.
function finish(): void {
  if (running) {
    settle(running);
    if (running.proc) hold(running.proc, false);
  }
  running = null;
}

// End the running job by ending its process.
function stop(job: Job, why: 'search_timeout' | 'search_aborted'): void {
  if (running !== job || job.stopped) return;
  job.stopped = why;
  // Let go of at once: nothing more is sent to a process on its way out. The
  // job stays the running one until that process has exited (or, the kill
  // having lost a race, answered).
  if (child === job.proc) child = null;
  job.proc?.kill('SIGKILL');
}

// Take a waiting job out of the line and tell its asker why.
function dropWaiting(job: Job, code: SearchErrorCode, message: string): boolean {
  const at = queue.indexOf(job);
  if (at === -1) return false;
  queue.splice(at, 1);
  settle(job);
  job.reject(searchError(code, message));
  return true;
}

// The next to run: the waiting job whose owner was served longest ago, and
// among one owner's the oldest.
function takeNext(): Job | undefined {
  let pick = -1;
  let pickServed = Infinity;
  for (let i = 0; i < queue.length; i++) {
    const served = lastServed.get(queue[i].owner) ?? 0;
    if (served < pickServed) {
      pick = i;
      pickServed = served;
    }
  }
  return pick === -1 ? undefined : queue.splice(pick, 1)[0];
}

function pump(): void {
  if (running) return;
  const job = takeNext();
  if (!job) {
    // Nothing to do: the process is let go after a while, and the owners'
    // turns forgotten with nobody left in line.
    lastServed.clear();
    idle ??= setTimeout(() => {
      idle = null;
      if (running || queue.length) return;
      child?.kill('SIGKILL');
      child = null;
    }, SEARCH_IDLE_EXIT_MS);
    idle.unref();
    return;
  }
  if (idle) clearTimeout(idle);
  idle = null;
  running = job;
  lastServed.set(job.owner, job.id);
  job.startedAt = Date.now();
  try {
    child ??= start();
    job.proc = child;
    hold(child, true);
    child.send({ id: job.id, sql: job.sql, params: job.params });
  } catch (err) {
    finish();
    child = null;
    job.reject(searchError('search_failed', err instanceof Error ? err.message : 'search failed'));
    pump();
  }
}

/**
 * Run one read-only statement in the search process and resolve with its rows.
 * Rejects with a SearchError. `signal` aborted: the search is dropped if it
 * still waits, stopped if it runs.
 */
export function runSearchQuery(
  sql: string,
  params: Array<string | number>,
  opts: SearchRunOptions = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(searchError('search_aborted', 'search abandoned'));
      return;
    }
    const owner = opts.owner ?? null;
    const mine = queue.filter((q) => q.owner === owner);
    // One more than an owner may have waiting displaces their oldest.
    if (mine.length >= MAX_WAITING_PER_OWNER)
      dropWaiting(mine[0], 'search_aborted', 'search displaced by a newer one');
    if (queue.length >= MAX_WAITING) {
      reject(searchError('search_busy', 'too many searches are waiting'));
      return;
    }
    const job: Job = {
      id: nextId++,
      sql,
      params,
      shape: opts.shape ?? 'query',
      owner,
      resolve,
      reject,
      signal,
      askedAt: Date.now(),
      deadline: setTimeout(() => {
        if (dropWaiting(job, 'search_timeout', 'search took too long')) {
          console.warn(
            `[search] gave up waiting for a turn after ${timeLimitMs()}ms (${job.shape})`,
          );
        } else {
          stop(job, 'search_timeout');
        }
      }, timeLimitMs()),
    };
    if (signal) {
      job.onAbort = () => {
        if (!dropWaiting(job, 'search_aborted', 'search abandoned')) stop(job, 'search_aborted');
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    queue.push(job);
    pump();
  });
}

// Which filters a search carries, for the log line. Never what they hold: a
// hosted cell's log must not collect what its users search for.
function shapeOf(opts: SearchMessagesOptions): string {
  const parts: string[] = [];
  if (typeof opts.query === 'string' && opts.query.trim()) parts.push('text');
  if (opts.target) parts.push('in:');
  if (opts.networkId) parts.push('on:');
  if (opts.nick || opts.nicks?.length) parts.push('from:');
  if (opts.matched) parts.push('highlights');
  if (opts.before) parts.push('older page');
  return parts.join(' + ') || 'query';
}

/** db/messages.ts's searchMessages, with the statement run off the event loop. */
export async function searchMessagesOffLoop(
  userId: number,
  opts: SearchMessagesOptions = {},
  signal?: AbortSignal,
): Promise<MessageEventWithNetwork[]> {
  // Built here: the caller's networks and the in: buffer are a few indexed
  // lookups, and they are the access boundary, which stays in the server.
  const built = searchMessagesSql(userId, opts);
  if (!built) return [];
  const rows = await runSearchQuery(built.sql, built.params, {
    signal,
    owner: userId,
    shape: shapeOf(opts),
  });
  return searchRowsToEvents(rows);
}

/** The HTTP answer for a search that did not return rows, or null for an
 *  error that is not the runner's (or that nobody is left to hear). */
export function searchErrorResponse(err: unknown): { status: number; error: string } | null {
  switch ((err as { code?: string } | null)?.code) {
    case 'search_timeout':
      return { status: 503, error: 'search took too long' };
    case 'search_busy':
      return { status: 503, error: 'search is busy, try again' };
    default:
      return null;
  }
}

/** Shutdown: the process goes, and whoever still waits is told so. */
export function stopSearchRunner(): void {
  for (const job of queue.splice(0)) {
    settle(job);
    job.reject(searchError('search_aborted', 'search stopped'));
  }
  if (idle) clearTimeout(idle);
  idle = null;
  // Stopped on purpose: not the crash an unexplained exit is logged as.
  if (running) stop(running, 'search_aborted');
  child?.kill('SIGKILL');
  child = null;
}
