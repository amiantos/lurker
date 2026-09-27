// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A reply thread as rows of a tree, drawn the way `tree(1)` draws a directory:
//
//   <alice> the first line
//   ├─ <bob> a reply
//   │  └─ <carol> a reply to bob
//   └─ <dave> another reply
//
// Framework-free so the shape can be tested without mounting anything.

export interface ThreadLine {
  id: number;
  msgid?: string;
  replyTo?: { msgid: string } | null;
}

export interface ThreadRow<T extends ThreadLine> {
  // null only for the stand-in first line when we don't hold it.
  line: T | null;
  depth: number;
  // For each ancestor level 1..depth-1: does that ancestor have a later sibling
  // — i.e. does a rail run down through this row at that level.
  rails: boolean[];
  // The last of its siblings: drawn `└─` rather than `├─`.
  last: boolean;
  hasChildren: boolean;
}

interface Node<T> {
  line: T | null;
  children: Node<T>[];
}

/**
 * The rows, in reading order (depth first, siblings oldest first).
 *
 * A reply hangs off the line its `replyTo.msgid` names when that line is in
 * the thread and older than it; otherwise off the first line — its parent is
 * gone to retention, or came from before our history. "Older" is also what
 * keeps a tree: a backfilled pair naming each other can't form a loop, because
 * every edge points from a lower id to a higher one.
 *
 * `root` null (we don't hold the first line) still yields a row for it, so the
 * replies keep their shape under a stand-in.
 */
export function threadRows<T extends ThreadLine>(root: T | null, replies: T[]): ThreadRow<T>[] {
  const top: Node<T> = { line: root, children: [] };
  const byMsgid = new Map<string, Node<T>>();
  if (root?.msgid) byMsgid.set(root.msgid, top);
  const sorted = [...replies].sort((a, b) => a.id - b.id);
  const nodes = sorted.map((line) => ({ line, children: [] as Node<T>[] }));
  for (const n of nodes) {
    const m = n.line.msgid;
    // The first copy of a repeated msgid keeps it.
    if (m && !byMsgid.has(m)) byMsgid.set(m, n);
  }
  for (const n of nodes) {
    const parent = n.line.replyTo?.msgid ? byMsgid.get(n.line.replyTo.msgid) : undefined;
    const usable = parent && parent !== n && (parent.line == null || parent.line.id < n.line.id);
    (usable ? parent : top).children.push(n);
  }

  const rows: ThreadRow<T>[] = [];
  const walk = (node: Node<T>, depth: number, rails: boolean[], last: boolean) => {
    rows.push({ line: node.line, depth, rails, last, hasChildren: node.children.length > 0 });
    node.children.forEach((child, i) => {
      const childLast = i === node.children.length - 1;
      // Below the first line there's no rail to carry: its children start the gutter.
      walk(child, depth + 1, depth === 0 ? [] : [...rails, !last], childLast);
    });
  };
  walk(top, 0, [], true);
  return rows;
}
