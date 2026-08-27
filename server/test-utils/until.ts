// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Poll a predicate every 10 ms until it holds or `ms` pass. `what` names the
// wait in the timeout error; `dump` adds context to it (a wire-log tail, a
// connection's state) so a timeout says where things stood, not just that
// they did. A predicate that throws rejects with its error rather than
// throwing out of a timer tick — an uncaught exception plus a promise that
// never settles is two confusing failures for one cause — and a dump that
// throws is reported inside the timeout error, never in place of it.
export function until(
  pred: () => boolean,
  ms = 5000,
  what = 'condition',
  dump?: () => string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      let holds: boolean;
      try {
        holds = pred();
      } catch (err) {
        return reject(err instanceof Error ? err : new Error(String(err)));
      }
      if (holds) return resolve();
      if (Date.now() > deadline) {
        let detail = '';
        if (dump) {
          try {
            detail = `; ${dump()}`;
          } catch (err) {
            detail = `; (dump threw: ${(err as Error)?.message ?? err})`;
          }
        }
        return reject(new Error(`timed out waiting for ${what}${detail}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
