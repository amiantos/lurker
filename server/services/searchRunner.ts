// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Search, off the event loop.
//
// better-sqlite3 is synchronous, and a search can be a long walk: a term in
// one buffer is found by visiting every message on the instance that holds
// the term, newest first, until a page of them turns out to be in that buffer.
// On 2026-11-10 one such search ("attachments", inside a DM) held a hosted
// cell's event loop for 106 s: no socket was served, the engine link was lost,
// and all 42 connections re-attached. So the statement runs in a child
// process, on its own read-only connection (WAL readers don't block the
// server's writes), one at a time, and the server's loop only waits for rows.
//
// A process, not a worker thread, because a walk must be stoppable: nothing
// reaches into a running sqlite3_step from JavaScript (better-sqlite3 exposes
// no interrupt), and worker.terminate() waits for the native call to return —
// measured: still running 15 s after terminate(), where a SIGKILL ended the
// child in 2 ms. The child starts in ~60 ms and is started again on the next
// search.
//
// When a search is stopped:
//   - its asker went away (a search-as-you-type request the client aborted):
//     dropped from the queue if it had not started, killed if it had — the old
//     in-process search ran every superseded request to completion;
//   - it ran past SEARCH_TIME_LIMIT_MS: a read that long holds back WAL
//     checkpoints for as long as it runs, and everyone else's search waits
//     behind it.

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

/** How long one search may run before it is stopped. `LURKER_SEARCH_TIME_LIMIT_MS`. */
export const SEARCH_TIME_LIMIT_MS = 30_000;
/** A search slower than this is logged, by shape (never its text). */
const SLOW_SEARCH_LOG_MS = 1000;

const CHILD_ENTRY = fileURLToPath(new URL('../searchProcess.ts', import.meta.url));

export interface SearchError extends Error {
  /** `search_timeout` (ran past the limit), `search_aborted` (its asker went
   *  away), or `search_failed` (the statement threw, or the process died). */
  code: 'search_timeout' | 'search_aborted' | 'search_failed';
}

function searchError(code: SearchError['code'], message: string): SearchError {
  const err = new Error(message) as SearchError;
  err.code = code;
  return err;
}

interface Job {
  id: number;
  sql: string;
  params: Array<string | number>;
  /** What kind of search, for the log: which filters, never their values. */
  shape: string;
  resolve: (rows: unknown[]) => void;
  reject: (err: SearchError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  startedAt?: number;
  /** The process it runs in. */
  proc?: ChildProcess;
  /** Why the child was killed under this job. */
  stopped?: 'search_timeout' | 'search_aborted';
}

let child: ChildProcess | null = null;
let running: Job | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const queue: Job[] = [];
let nextId = 1;

function timeLimitMs(): number {
  return envInt('LURKER_SEARCH_TIME_LIMIT_MS', SEARCH_TIME_LIMIT_MS) || SEARCH_TIME_LIMIT_MS;
}

function settle(job: Job): void {
  if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
}

function start(): ChildProcess {
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

// The running job is over, one way or another.
function finish(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (running) {
    settle(running);
    if (running.proc) hold(running.proc, false);
  }
  running = null;
}

function stop(job: Job, why: 'search_timeout' | 'search_aborted'): void {
  if (running !== job || job.stopped) return;
  job.stopped = why;
  // Let go of at once: nothing more is sent to a process on its way out. The
  // job stays the running one until that process has exited (or, the kill
  // having lost a race, answered).
  if (child === job.proc) child = null;
  job.proc?.kill('SIGKILL');
}

function pump(): void {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
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
    return;
  }
  timer = setTimeout(() => stop(job, 'search_timeout'), timeLimitMs());
}

/**
 * Run one read-only statement in the search process and resolve with its rows.
 * Rejects with a SearchError. `signal` aborted: the search is dropped if it
 * still waits, stopped if it runs.
 */
export function runSearchQuery(
  sql: string,
  params: Array<string | number>,
  opts: { signal?: AbortSignal; shape?: string } = {},
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const { signal } = opts;
    if (signal?.aborted) {
      reject(searchError('search_aborted', 'search abandoned'));
      return;
    }
    const job: Job = {
      id: nextId++,
      sql,
      params,
      shape: opts.shape ?? 'query',
      resolve,
      reject,
      signal,
    };
    if (signal) {
      job.onAbort = () => {
        const at = queue.indexOf(job);
        if (at !== -1) {
          queue.splice(at, 1);
          settle(job);
          reject(searchError('search_aborted', 'search abandoned'));
        } else {
          stop(job, 'search_aborted');
        }
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
  const rows = await runSearchQuery(built.sql, built.params, { signal, shape: shapeOf(opts) });
  return searchRowsToEvents(rows);
}

/** Shutdown: the process goes, and whoever still waits is told it failed. */
export function stopSearchRunner(): void {
  for (const job of queue.splice(0)) {
    settle(job);
    job.reject(searchError('search_failed', 'search stopped'));
  }
  const proc = running?.proc ?? child;
  child = null;
  proc?.kill('SIGKILL');
}
