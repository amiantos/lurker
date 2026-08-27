// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Set env knobs for the span of a test (or a harness) and hand back the way to
// put them back — each to the value it had, or unset — so what one test sets
// is invisible to the next, whether they share a file or a worker.

export function setEnv(name: string, value: string): () => void {
  const prev = process.env[name];
  process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

export function setEnvAll(vars: Record<string, string>): () => void {
  const restores = Object.entries(vars).map(([k, v]) => setEnv(k, v));
  return () => {
    for (const restore of restores) restore();
  };
}
