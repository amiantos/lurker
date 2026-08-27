// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Operator escape hatch for account recovery (#855).
//
// Recovery links are normally issued from Admin → Users, which covers everyone
// except the person who would have to click the button: an instance's only
// admin, locked out of their own account. This is the same link, minted from a
// shell on the box. Self-hosters have that shell by definition, and holding it
// is already equivalent to holding the database.
//
// Usage (inside the container, or wherever the server runs):
//   tsx tools/recovery-link.ts alice
//   tsx tools/recovery-link.ts alice --url https://lurker.example.com
//   npm run recovery-link -- alice
//
// The URL is printed once and nowhere else — only its SHA-256 is stored — so
// losing it means minting another, which invalidates the first. The link is
// single-use and expires in 24 hours.
//
// DATABASE_PATH selects the database (same env the server uses); the base URL
// defaults to the first entry in WEBAUTHN_ORIGIN, which is already the public
// origin on any instance where passkeys work.
//
// ⚠ Opens its OWN bare connection rather than importing server/db/index.ts, the
// same way tools/fold-buffer-case.ts does. That module's body runs the entire
// migration + seed pipeline, and this tool is documented as `docker compose
// exec` against a RUNNING server — importing it would make this a second
// process migrating a database the server is actively writing, risking
// SQLITE_BUSY at precisely the moment (sole admin locked out) when this has to
// work. The token rules are shared through server/db/accountRecoveryToken.ts,
// which is db-free, so there is still exactly one definition of them.

import Database from 'better-sqlite3';
import path from 'path';
import {
  generateRecoveryToken,
  hashRecoveryToken,
  recoveryExpiresAt,
} from '../server/db/accountRecoveryToken.js';

const argv = process.argv.slice(2);

function usage(): never {
  console.log(
    [
      'Mint a single-use account recovery link.',
      '',
      'Usage: tsx tools/recovery-link.ts <username> [--url <origin>]',
      '',
      '  <username>      The account to recover. Matched case-insensitively.',
      '  --url <origin>  Public origin for the link (e.g. https://lurker.example.com).',
      '                  --url=<origin> works too. Defaults to the first entry',
      '                  in WEBAUTHN_ORIGIN.',
      '',
      'DATABASE_PATH selects the database.',
    ].join('\n'),
  );
  process.exit(0);
}

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage();

// Both spellings. Accepting only the space-separated form meant `--url=https://x`
// fell through the flag filter, silently fell back to WEBAUTHN_ORIGIN, and
// handed a locked-out admin a link pointing at the wrong host — after the token
// was already written, so recovering from it costs a reissue.
const inlineUrl = argv.find((a) => a.startsWith('--url='));
const urlIndex = argv.indexOf('--url');
const originArg = inlineUrl ? inlineUrl.slice('--url='.length) : (argv[urlIndex + 1] ?? null);
if ((urlIndex !== -1 || inlineUrl) && !originArg) {
  console.error('--url needs a value, e.g. --url https://lurker.example.com');
  process.exit(1);
}
// Only skip the NEXT argv slot when --url took a separate value; with --url=…
// there is no separate slot, and urlIndex + 1 would otherwise eat the username.
const skipIndex = urlIndex === -1 ? -1 : urlIndex + 1;
const username = argv.filter((a, i) => !a.startsWith('--') && i !== skipIndex)[0];
if (!username) usage();

// A cell's sign-in belongs to the control plane, which has its own email-based
// reset — the admin routes refuse there for the same reason. The CLI ships in
// the same image cells run, so it has to refuse too, rather than minting a link
// whose redemption would drop CP-injected sessions the CP still believes live.
if ((process.env.LURKER_EDITION || '').trim().toLowerCase() === 'node') {
  console.error(
    'This is a hosted cell — sign-in is managed by the control plane, which has its own password reset.',
  );
  process.exit(1);
}

const origin = (originArg || (process.env.WEBAUTHN_ORIGIN || '').split(',')[0] || '').trim();
if (!origin) {
  console.error(
    'No base URL: pass --url https://lurker.example.com, or set WEBAUTHN_ORIGIN in the environment.',
  );
  process.exit(1);
}

// Same default as db/index.ts, so `DATABASE_PATH` unset means the same file the
// server would open.
const dbPath = process.env.DATABASE_PATH || path.join(import.meta.dirname, '../data/lurker.db');

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// The table is created by the server's migration, not here — a tool that runs
// before the server has ever started has nothing to recover anyway.
const hasTable = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_recovery_tokens'`)
  .get();
if (!hasTable) {
  console.error(
    `${dbPath} has no account_recovery_tokens table — start the server once to migrate it.`,
  );
  process.exit(1);
}

// Case-insensitive, matching findUserByUsername.
const user = db
  .prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE')
  .get(username) as { id: number; username: string } | undefined;
if (!user) {
  console.error(`No account named '${username}' in ${dbPath}.`);
  process.exit(1);
}

// created_by is null: nobody in the users table issued this one, and recording a
// stand-in admin would misattribute it in the panel.
const token = generateRecoveryToken();
db.prepare(
  `INSERT INTO account_recovery_tokens (token_hash, user_id, created_by, expires_at)
   VALUES (?, ?, NULL, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     token_hash = excluded.token_hash,
     created_by = excluded.created_by,
     expires_at = excluded.expires_at,
     created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
).run(hashRecoveryToken(token), user.id, recoveryExpiresAt());

console.log('');
console.log(`Recovery link for ${user.username} (expires in 24 hours, single use):`);
console.log('');
console.log(`  ${origin.replace(/\/+$/, '')}/recover/${token}`);
console.log('');
console.log('This is the only time it is shown. Any previous link for this account is now dead.');
