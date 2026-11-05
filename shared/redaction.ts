// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// IRCv3 message redaction (draft/message-redaction, #1013): the shape a deleted
// line carries, shared by the server (which stamps it) and the clients (which
// draw the placeholder). The line's text is gone — NULL on the row — and this
// says that it went, when, by whom, and why if a reason came. Absent on a line
// that wasn't deleted, like `bookmarked`.
export interface Redaction {
  // The nick that sent the REDACT: the author, or an op who removed it.
  by: string;
  // The REDACT's optional trailing reason, as given. Never a default one.
  reason?: string;
  // When, as server-time (or arrival) — ISO 8601, like a row's `time`.
  time: string;
}

// The placeholder a deleted line shows in place of its text: "message deleted",
// naming who did it when it wasn't the author, and the reason when one came.
// Case-insensitive on the nick — the deleter is named the way the REDACT came,
// which can differ in case from the line's stored nick.
export function redactionLabel(r: Redaction, authorNick: string | null | undefined): string {
  const own = !!authorNick && r.by.toLowerCase() === authorNick.toLowerCase();
  let label = own || !r.by ? 'message deleted' : `message deleted by ${r.by}`;
  if (r.reason) label += `: ${r.reason}`;
  return label;
}
