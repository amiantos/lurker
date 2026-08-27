// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Poll a predicate every 10 ms until it holds or `ms` pass. `what` names the
// wait in the timeout error; `dump` adds context to it (a wire-log tail, a
// connection's state) so a timeout says where things stood, not just that
// they did.
export function until(
  pred: () => boolean,
  ms = 5000,
  what = 'condition',
  dump?: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() > deadline) {
        const detail = dump ? `; ${dump()}` : '';
        return reject(new Error(`timed out waiting for ${what}${detail}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
