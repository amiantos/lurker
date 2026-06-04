// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Network } from '../db/networks.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-exportjobs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('../db/users.js').createUser;
let createNetwork: typeof import('../db/networks.js').createNetwork;
let insertMessage: typeof import('../db/messages.js').insertMessage;
let jobs: typeof import('./exportJobs.js');
let dataExports: typeof import('../db/dataExports.js');

beforeAll(async () => {
  await import('../db/index.js');
  ({ createUser } = await import('../db/users.js'));
  ({ createNetwork } = await import('../db/networks.js'));
  ({ insertMessage } = await import('../db/messages.js'));
  jobs = await import('./exportJobs.js');
  dataExports = await import('../db/dataExports.js');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('exportJobs lifecycle', () => {
  it('builds an artifact on disk and marks the job done', async () => {
    const u = createUser('jobs-alice');
    createNetwork(u.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'a',
    }) as Network;

    const { job, alreadyRunning } = jobs.startExport(u.id, false);
    expect(alreadyRunning).toBe(false);

    await waitFor(() => dataExports.getExportJob(job.id)?.status === 'done');
    const done = dataExports.getExportJob(job.id)!;
    expect(done.status).toBe('done');
    expect(done.byte_size).toBeGreaterThan(0);
    expect(done.file_path).toBeTruthy();
    expect(fs.existsSync(done.file_path!)).toBe(true);
    expect(done.expires_at).toBeTruthy();
  });

  it('persists the worker-reported total so progress never exceeds 100%', async () => {
    const u = createUser('jobs-total');
    const net = createNetwork(u.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 't',
    }) as Network;
    for (let i = 0; i < 2500; i += 1) {
      insertMessage({
        networkId: net.id,
        target: '#t',
        time: '2026-05-17T10:00:00Z',
        type: 'message',
        nick: 't',
        text: `m ${i}`,
        self: false,
      });
    }

    const { job } = jobs.startExport(u.id, true);
    await waitFor(() => dataExports.getExportJob(job.id)?.status === 'done');
    const done = dataExports.getExportJob(job.id)!;
    expect(done.total_rows).toBe(2500);
    expect(done.processed_rows).toBe(2500);
    // The invariant the relay fix guarantees: the denominator never trails.
    expect(done.processed_rows).toBeLessThanOrEqual(done.total_rows);
  });

  it('updateProgress overwrites a stale initial total with the worker-reported one', () => {
    // Guards the relay fix deterministically: the worker's count is
    // authoritative, so a progress frame carrying a total corrects a wrong
    // initial markRunning estimate; a frame without one leaves it intact.
    const u = createUser('jobs-progress');
    const j = dataExports.createExportJob(u.id, true);
    dataExports.markRunning(j.id, 1); // deliberately wrong estimate
    dataExports.updateProgress(j.id, 2000, 5000);
    expect(dataExports.getExportJob(j.id)!.total_rows).toBe(5000);
    expect(dataExports.getExportJob(j.id)!.processed_rows).toBe(2000);
    dataExports.updateProgress(j.id, 3000);
    expect(dataExports.getExportJob(j.id)!.total_rows).toBe(5000);
    expect(dataExports.getExportJob(j.id)!.processed_rows).toBe(3000);
  });

  it('refuses a second concurrent export for the same user', () => {
    const u = createUser('jobs-bob');
    const existing = dataExports.createExportJob(u.id, false);
    dataExports.markRunning(existing.id, 0);

    const { job, alreadyRunning } = jobs.startExport(u.id, false);
    expect(alreadyRunning).toBe(true);
    expect(job.id).toBe(existing.id);
  });

  it('keeps only the newest completed export per user', async () => {
    const u = createUser('jobs-erin');
    createNetwork(u.id, {
      name: 'libera',
      host: 'irc.libera.chat',
      port: 6697,
      tls: true,
      nick: 'e',
    });

    const first = jobs.startExport(u.id, false).job;
    await waitFor(() => dataExports.getExportJob(first.id)?.status === 'done');
    const firstPath = dataExports.getExportJob(first.id)!.file_path!;

    const second = jobs.startExport(u.id, false).job;
    await waitFor(() => dataExports.getExportJob(second.id)?.status === 'done');

    // The earlier export's row + artifact are gone; only the newest survives.
    expect(dataExports.getExportJob(first.id)).toBeUndefined();
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(dataExports.getExportJob(second.id)?.status).toBe('done');
  });

  it('sweeps expired artifacts', () => {
    const u = createUser('jobs-carol');
    const j = dataExports.createExportJob(u.id, false);
    const p = jobs.exportArtifactPath(j.token);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'artifact');
    // ttlHours -1 → expires_at is in the past.
    dataExports.markDone(j.id, { filePath: p, filename: 'x.lurk', byteSize: 8, ttlHours: -1 });

    const removed = jobs.sweepExpiredExports();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(p)).toBe(false);
    expect(dataExports.getExportJob(j.id)).toBeUndefined();
  });

  it('fails interrupted jobs and drops partials on boot recovery', () => {
    const u = createUser('jobs-dave');
    const j = dataExports.createExportJob(u.id, true);
    dataExports.markRunning(j.id, 100);
    const p = jobs.exportArtifactPath(j.token);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'partial');

    jobs.recoverInterruptedExports();

    const after = dataExports.getExportJob(j.id)!;
    expect(after.status).toBe('error');
    expect(after.error).toMatch(/restart/i);
    expect(fs.existsSync(p)).toBe(false);
  });
});
