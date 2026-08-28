// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A bare app-side link to the engine for tests: speaks the frame protocol and
// nothing else, so engine behaviour can be asserted frame by frame without
// irc-framework or the real transport in the loop.

import net from 'node:net';
import { once } from 'node:events';
import { FrameReader, PROTOCOL_MAJOR, encodeFrame } from '../engine/protocol.js';
import type { AppToEngine, EngineToApp } from '../engine/protocol.js';

export const TEST_INSTANCE = 'test-instance-a';

export class TestLink {
  readonly frames: EngineToApp[] = [];
  hello: Extract<EngineToApp, { op: 'hello' }> | null = null;
  closed = false;
  private readonly reader = new FrameReader();
  private waiters: Array<{ pred: (f: EngineToApp) => boolean; resolve: (f: EngineToApp) => void }> =
    [];

  private constructor(readonly socket: net.Socket) {}

  static async open(port: number, host = '127.0.0.1'): Promise<TestLink> {
    const socket = net.connect(port, host);
    await once(socket, 'connect');
    socket.setEncoding('utf8');
    const link = new TestLink(socket);
    socket.on('data', (chunk: string) => {
      for (const f of link.reader.push(chunk) as EngineToApp[]) {
        link.frames.push(f);
        if (f.op === 'hello') link.hello = f;
        link.waiters = link.waiters.filter((w) => {
          if (!w.pred(f)) return true;
          w.resolve(f);
          return false;
        });
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      link.closed = true;
    });
    return link;
  }

  // Open + hello in one go; resolves once the engine has answered.
  static async connect(
    port: number,
    secret: string,
    opts: { protocol?: number; version?: string; instance?: string; startedAt?: number } = {},
  ): Promise<TestLink> {
    const link = await TestLink.open(port);
    link.send({
      op: 'hello',
      protocol: opts.protocol ?? PROTOCOL_MAJOR,
      secret,
      // One default instance, so the ordinary tests all speak for the same
      // "database"; the cross-instance cases pass their own.
      instance: opts.instance ?? TEST_INSTANCE,
      // startedAt is the process generation; omitted, the engine reads 0.
      app: { version: opts.version ?? 'test', startedAt: opts.startedAt },
    });
    await link.waitFor((f) => f.op === 'hello' || f.op === 'error');
    return link;
  }

  send(frame: AppToEngine): void {
    this.socket.write(encodeFrame(frame));
  }

  // Lines received for `id`, in order.
  lines(id: string): string[] {
    return this.frames
      .filter((f): f is Extract<EngineToApp, { op: 'line' }> => f.op === 'line' && f.id === id)
      .map((f) => f.line);
  }

  waitFor<T extends EngineToApp = EngineToApp>(
    pred: (f: EngineToApp) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(
          new Error(
            `TestLink: timed out waiting; last frames: ${JSON.stringify(this.frames.slice(-3))}`,
          ),
        );
      }, timeoutMs);
      const done = (f: EngineToApp) => {
        clearTimeout(timer);
        resolve(f as T);
      };
      this.waiters.push({ pred, resolve: done });
    });
  }

  // Like waitFor, but only for frames that arrive AFTER this call — for a
  // second `open` on an id that already had one.
  waitForNew<T extends EngineToApp = EngineToApp>(
    pred: (f: EngineToApp) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    const skip = this.frames.length;
    return this.waitFor<T>((f) => this.frames.indexOf(f) >= skip && pred(f), timeoutMs);
  }

  // Wait for an inbound IRC line on `id` matching `re`.
  waitForLine(id: string, re: RegExp, timeoutMs = 5000): Promise<string> {
    return this.waitFor<Extract<EngineToApp, { op: 'line' }>>(
      (f) => f.op === 'line' && f.id === id && re.test(f.line),
      timeoutMs,
    ).then((f) => f.line);
  }

  waitForClose(timeoutMs = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('TestLink: socket did not close')),
        timeoutMs,
      );
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Simulate the app dying: no detach, no goodbye.
  kill(): void {
    this.socket.destroy();
  }
}
