// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The order a buffer's rows are shown in: by the time the server stamped them,
// with id as the tiebreak. Ids are the order rows were STORED in, and the two
// agree for everything heard live. They part on a line fetched after the fact
// (`replay`, #1283): a history page filled after a reconnect holds lines from
// before the rejoin, stored after its JOIN row with fresh ids, and shown by id
// they would sit under the join they precede. gamja, goguma and halloy all
// place a history line by its time. Ids stay what they are everywhere else:
// the paging cursor, the dedupe key, the unread boundary (CLIENT_PROTOCOL §9).
//
// `time` is the server's canonical UTC ISO form, so it compares as a string.
// A row without one (an ephemeral echo) keeps its place against its
// neighbours by id. A row without an id is being sent now; its time says so,
// and among rows of its time it stays last.

interface Ordered {
  id?: number | null;
  time?: string;
}

function compare(a: Ordered, b: Ordered): number {
  if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
  const ai = a.id ?? Number.POSITIVE_INFINITY;
  const bi = b.id ?? Number.POSITIVE_INFINITY;
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}

/** `rows` in display order. The array itself when it already is, which is
 *  every buffer that holds nothing replayed, so a live line costs one pass. */
export function orderByTime<T extends Ordered>(rows: readonly T[]): readonly T[] {
  for (let i = 1; i < rows.length; i++) {
    if (compare(rows[i - 1]!, rows[i]!) > 0) return rows.toSorted(compare);
  }
  return rows;
}
