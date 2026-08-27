// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The stall line carries the caller's context when there is one — what was in
// flight, not just how long — and is unchanged (and unbroken) when there is
// none or the context provider itself fails.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { startEventLoopMonitor, stopEventLoopMonitor } from './eventLoopMonitor.js';
import { until } from '../test-utils/until.js';

// Well above the warn threshold so the histogram sees an unambiguous stall on
// a loaded CI box, well below anything that would slow the suite.
const BLOCK_MS = 150;
const WARN_MS = 50;

function block(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin: a synchronous stall is the thing under test */
  }
}

async function stallReport(context?: () => string | null): Promise<string> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  startEventLoopMonitor({ intervalMs: 100, warnMs: WARN_MS, context });
  // Node's delay histogram takes its first tick after enable() as the
  // baseline and records nothing for it, so a block that starts before that
  // tick (20 ms resolution) is invisible. Let it pass.
  await new Promise((r) => setTimeout(r, 50));
  block(BLOCK_MS);
  await until(() => warn.mock.calls.length > 0, 3000, 'a stall report');
  return String(warn.mock.calls[0][0]);
}

afterEach(() => {
  stopEventLoopMonitor();
  vi.restoreAllMocks();
});

describe('eventLoopMonitor', () => {
  it('appends the context to the stall line', async () => {
    const line = await stallReport(
      () => 're-attach channel-state refreshes in flight: 2 (net 1 #a, net 2 #b)',
    );
    expect(line).toMatch(/^\[event-loop\] stalled ~\d+ms — synchronous work blocked socket I\/O/);
    expect(line).toMatch(
      /near this line\); re-attach channel-state refreshes in flight: 2 \(net 1 #a, net 2 #b\)$/,
    );
  });

  it('appends nothing when there is no context', async () => {
    const line = await stallReport(() => null);
    expect(line).toMatch(/near this line\)$/);
  });

  it('is unchanged when the context provider throws', async () => {
    const line = await stallReport(() => {
      throw new Error('boom');
    });
    expect(line).toMatch(/near this line\)$/);
  });
});
