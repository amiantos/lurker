// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// HEIC, decoded off the event loop.
//
// WHY THIS EXISTS. sharp installs a prebuilt libvips whose libheif has an AV1
// decoder and no HEVC one (patents). An iPhone photo is HEVC. So sharp reads its
// header — `format: 'heif', compression: 'hevc'` — and then cannot decode a pixel:
// every HEIC upload failed, and failed late, after the pipeline had already taken
// it for an image. libheif-js is the same libheif compiled to WebAssembly with
// libde265 in it; it turns the file into raw RGBA, and sharp takes it from there
// exactly as it would any other image.
//
// A process, like search (services/searchRunner.ts), and for the same two reasons.
// The decode is one synchronous call of a second or more for a 12-megapixel photo,
// which on the server's loop is a second of no WebSocket fan-out and no IRC. And it
// must be stoppable: a file built to make a decoder spin is ended by ending the
// process. It also keeps the decoder's heap — which only grows — out of the server,
// and gives it back when the process is let go.
//
// One decode at a time, in order. Uploads of HEIC are a person picking photos, not
// a firehose, and a line is simpler to bound than a pool.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A decode still running after this long is ended, and so is its process. */
export const HEIC_TIME_LIMIT_MS = 30_000;
/** The process is let go after this long with nothing to do. */
const HEIC_IDLE_EXIT_MS = 60_000;
/** 100 megapixels: twice the largest iPhone sensor, and 400 MB of RGBA. */
export const HEIC_MAX_PIXELS = 100_000_000;

const CHILD_ENTRY = fileURLToPath(new URL('../heicProcess.ts', import.meta.url));

export interface DecodedHeic {
  /** RGBA, 8 bits a channel, row after row. */
  pixels: Buffer;
  width: number;
  height: number;
}

interface Reply extends Partial<DecodedHeic> {
  id: number;
  /** Arrives as a Uint8Array view over the wire. */
  pixels?: Buffer;
  error?: string;
}

interface Job {
  id: number;
  resolve: (image: DecodedHeic) => void;
  reject: (err: Error) => void;
  deadline: ReturnType<typeof setTimeout>;
}

let child: ChildProcess | null = null;
let running: Job | null = null;
/** The process the running job was handed to. */
let runningIn: ChildProcess | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let line: Promise<unknown> = Promise.resolve();
let nextId = 1;
let exitHooked = false;

// Whether `proc` keeps this process's event loop alive — see searchRunner.ts.
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

function finish(): Job | null {
  const job = running;
  running = null;
  if (job) clearTimeout(job.deadline);
  if (child) hold(child, false);
  idle ??= setTimeout(() => {
    idle = null;
    if (running) return;
    child?.kill('SIGKILL');
    child = null;
  }, HEIC_IDLE_EXIT_MS);
  idle.unref();
  return job;
}

function start(): ChildProcess {
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => child?.kill('SIGKILL'));
  }
  const proc = fork(CHILD_ENTRY, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Structured clone, so the pixels cross as bytes. The default channel is JSON,
    // which would spell a 48 MB buffer out as an array of numbers.
    serialization: 'advanced',
  });
  hold(proc, false);
  proc.on('message', (reply: Reply) => {
    if (!running || reply.id !== running.id) return;
    const job = finish()!;
    if (reply.pixels && reply.width && reply.height) {
      const { buffer, byteOffset, byteLength } = reply.pixels;
      job.resolve({
        pixels: Buffer.from(buffer, byteOffset, byteLength),
        width: reply.width,
        height: reply.height,
      });
    } else {
      job.reject(new Error(reply.error || 'HEIC decode failed'));
    }
  });
  const gone = (why: string) => {
    if (child === proc) child = null;
    // Only the job this process was running is its to end.
    if (!running || proc !== runningIn) return;
    finish()!.reject(new Error(`HEIC decode ${why}`));
  };
  proc.on('exit', (code, signal) =>
    gone(signal === 'SIGKILL' ? 'took too long' : `failed (${code})`),
  );
  proc.on('error', (err) => gone(`failed (${err.message})`));
  return proc;
}

function run(input: Buffer | string): Promise<DecodedHeic> {
  return new Promise((resolve, reject) => {
    if (idle) clearTimeout(idle);
    idle = null;
    const job: Job = {
      id: nextId++,
      resolve,
      reject,
      deadline: setTimeout(() => {
        // Ending the process is the only way to end the decode. Its exit rejects.
        const proc = runningIn;
        if (child === proc) child = null;
        proc?.kill('SIGKILL');
      }, HEIC_TIME_LIMIT_MS),
    };
    running = job;
    try {
      child ??= start();
      runningIn = child;
      hold(child, true);
      child.send({
        id: job.id,
        ...(typeof input === 'string' ? { path: input } : { bytes: input }),
        maxPixels: HEIC_MAX_PIXELS,
      });
    } catch (err) {
      finish();
      child = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Decode an HEVC-coded HEIF image — a file path or its bytes — to raw RGBA, upright.
 * Rejects when the file does not decode, is larger than HEIC_MAX_PIXELS, or takes
 * longer than HEIC_TIME_LIMIT_MS.
 *
 * ⚠ The pixels come back as the file stored them, read as sRGB. An iPhone's photo
 * is Display P3, so its most saturated colours land slightly muted. sharp has no
 * way to be told a raw buffer's profile; converting is a follow-up, not something
 * to guess at here.
 */
export function decodeHeic(input: Buffer | string): Promise<DecodedHeic> {
  const turn = line.then(() => run(input));
  // The line moves on whether or not this one decoded.
  line = turn.catch(() => {});
  return turn;
}

/** Shutdown: the process goes, and a decode in flight is told so by its exit. */
export function stopHeicDecoder(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  child?.kill('SIGKILL');
  child = null;
}
