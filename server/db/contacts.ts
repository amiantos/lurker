// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

// Friends / watch-list storage. A `contact` is a person (network-agnostic):
// display name + the per-contact "toast me when they come online" flag. Each
// contact has a set of `contact_targets` — the (network, nick) pairs to watch —
// so the same person can be followed under different nicks on different
// networks. Presence rides the existing MONITOR rails; the FRIENDS UI is an
// overview of contacts + their per-network reachability.

/** A contact with its per-network watch targets, as returned to callers. */
export interface ContactRecord {
  id: number;
  displayName: string;
  notifyOnline: boolean;
  targets: Array<{ networkId: number; nick: string; isPrimary: boolean }>;
}

export interface ContactTargetInput {
  networkId: number;
  nick: string;
  isPrimary?: boolean;
}

const insertContactStmt = db.prepare(`
  INSERT INTO contacts (user_id, display_name, notify_online)
  VALUES (@userId, @displayName, @notifyOnline)
`);

const updateContactStmt = db.prepare(`
  UPDATE contacts SET display_name = @displayName, notify_online = @notifyOnline
  WHERE id = @contactId AND user_id = @userId
`);

const deleteContactStmt = db.prepare(`
  DELETE FROM contacts WHERE id = @contactId AND user_id = @userId
`);

const getContactStmt = db.prepare(`
  SELECT id, display_name AS displayName, notify_online AS notifyOnline
  FROM contacts WHERE id = ? AND user_id = ?
`);

const listContactsStmt = db.prepare(`
  SELECT id, display_name AS displayName, notify_online AS notifyOnline
  FROM contacts WHERE user_id = ? ORDER BY display_name COLLATE NOCASE
`);

const deleteTargetsStmt = db.prepare(`
  DELETE FROM contact_targets WHERE contact_id = ?
`);

const insertTargetStmt = db.prepare(`
  INSERT INTO contact_targets (contact_id, network_id, nick, is_primary)
  VALUES (@contactId, @networkId, @nick, @isPrimary)
`);

const targetsForUserStmt = db.prepare(`
  SELECT ct.contact_id AS contactId, ct.network_id AS networkId, ct.nick AS nick,
         ct.is_primary AS isPrimary
  FROM contact_targets ct
  JOIN contacts c ON c.id = ct.contact_id
  WHERE c.user_id = ?
`);

const targetsForNetworkStmt = db.prepare(`
  SELECT contact_id AS contactId, nick FROM contact_targets WHERE network_id = ?
`);

const targetsForContactStmt = db.prepare(`
  SELECT network_id AS networkId, nick, is_primary AS isPrimary
  FROM contact_targets WHERE contact_id = ?
`);

const findContactByTargetStmt = db.prepare(`
  SELECT ct.contact_id AS contactId
  FROM contact_targets ct
  JOIN contacts c ON c.id = ct.contact_id
  WHERE c.user_id = ? AND ct.network_id = ? AND ct.nick = ? COLLATE NOCASE
`);

const notifyContactByTargetStmt = db.prepare(`
  SELECT c.id AS id, c.display_name AS displayName
  FROM contact_targets ct
  JOIN contacts c ON c.id = ct.contact_id
  WHERE c.user_id = ? AND ct.network_id = ? AND ct.nick = ? COLLATE NOCASE
    AND c.notify_online = 1
  LIMIT 1
`);

function rowToContact(row: {
  id: number;
  displayName: string;
  notifyOnline: number;
}): ContactRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    notifyOnline: !!row.notifyOnline,
    targets: [],
  };
}

/** Create a contact and return its new id. */
export function createContact({
  userId,
  displayName,
  notifyOnline,
}: {
  userId: number;
  displayName: string;
  notifyOnline: boolean;
}): number {
  const info = insertContactStmt.run({
    userId,
    displayName,
    notifyOnline: notifyOnline ? 1 : 0,
  });
  return Number(info.lastInsertRowid);
}

/** Update a contact's display name + notify flag. No-op if not owned by user. */
export function updateContactMeta({
  contactId,
  userId,
  displayName,
  notifyOnline,
}: {
  contactId: number;
  userId: number;
  displayName: string;
  notifyOnline: boolean;
}): void {
  updateContactStmt.run({
    contactId,
    userId,
    displayName,
    notifyOnline: notifyOnline ? 1 : 0,
  });
}

/** Replace a contact's watch targets wholesale (delete-then-insert, atomic).
 *  Caller is responsible for ensuring exactly one target has isPrimary. */
export const setContactTargets = db.transaction(
  (contactId: number, targets: ContactTargetInput[]) => {
    deleteTargetsStmt.run(contactId);
    for (const t of targets) {
      const nick = (t.nick || '').trim();
      if (!nick) continue;
      insertTargetStmt.run({
        contactId,
        networkId: t.networkId,
        nick,
        isPrimary: t.isPrimary ? 1 : 0,
      });
    }
  },
);

/** Delete a contact (and its targets, via cascade). Returns true if removed. */
export function deleteContact(contactId: number, userId: number): boolean {
  return deleteContactStmt.run({ contactId, userId }).changes > 0;
}

/** Fetch one contact (with targets) scoped to its owner, or null. */
export function getContact(contactId: number, userId: number): ContactRecord | null {
  const row = getContactStmt.get(contactId, userId) as
    | { id: number; displayName: string; notifyOnline: number }
    | undefined;
  if (!row) return null;
  const contact = rowToContact(row);
  contact.targets = (
    targetsForContactStmt.all(contactId) as Array<{
      networkId: number;
      nick: string;
      isPrimary: number;
    }>
  ).map((t) => ({ networkId: t.networkId, nick: t.nick, isPrimary: !!t.isPrimary }));
  return contact;
}

/** All of a user's contacts with their targets — for snapshot seeding. */
export function listContactsForUser(userId: number): ContactRecord[] {
  const contacts = (
    listContactsStmt.all(userId) as Array<{
      id: number;
      displayName: string;
      notifyOnline: number;
    }>
  ).map(rowToContact);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  for (const t of targetsForUserStmt.all(userId) as Array<{
    contactId: number;
    networkId: number;
    nick: string;
    isPrimary: number;
  }>) {
    byId
      .get(t.contactId)
      ?.targets.push({ networkId: t.networkId, nick: t.nick, isPrimary: !!t.isPrimary });
  }
  return contacts;
}

/** [{ contactId, nick }] for a network — hydrates a connection's friend watch. */
export function listTargetsForNetwork(
  networkId: number,
): Array<{ contactId: number; nick: string }> {
  return targetsForNetworkStmt.all(networkId) as Array<{ contactId: number; nick: string }>;
}

/** Contact id already watching (network, nick) for this user, or null. Used to
 *  keep a (user, network, nick) mapped to at most one contact. */
export function findContactIdByTarget(
  userId: number,
  networkId: number,
  nick: string,
): number | null {
  const row = findContactByTargetStmt.get(userId, networkId, nick) as
    | { contactId: number }
    | undefined;
  return row?.contactId ?? null;
}

/** The notify-on-online contact watching (network, nick) for this user, or null.
 *  Drives the server-side came-online push (fired when no client is visible). */
export function findNotifyContactForTarget(
  userId: number,
  networkId: number,
  nick: string,
): { id: number; displayName: string } | null {
  const row = notifyContactByTargetStmt.get(userId, networkId, nick) as
    | { id: number; displayName: string }
    | undefined;
  return row ?? null;
}
