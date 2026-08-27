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

import path from 'path';

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
      '                  Defaults to the first entry in WEBAUTHN_ORIGIN.',
      '',
      'DATABASE_PATH selects the database.',
    ].join('\n'),
  );
  process.exit(0);
}

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage();

const urlIndex = argv.indexOf('--url');
const originArg = urlIndex === -1 ? null : argv[urlIndex + 1];
if (urlIndex !== -1 && !originArg) {
  console.error('--url needs a value, e.g. --url https://lurker.example.com');
  process.exit(1);
}
const skipIndex = urlIndex === -1 ? -1 : urlIndex + 1;
const username = argv.filter((a, i) => !a.startsWith('--') && i !== skipIndex)[0];
if (!username) usage();

const origin = (originArg || (process.env.WEBAUTHN_ORIGIN || '').split(',')[0] || '').trim();
if (!origin) {
  console.error(
    'No base URL: pass --url https://lurker.example.com, or set WEBAUTHN_ORIGIN in the environment.',
  );
  process.exit(1);
}

// db/index.ts resolves DATABASE_PATH at import time, so the default has to be in
// place before anything below it loads.
process.env.DATABASE_PATH =
  process.env.DATABASE_PATH || path.join(import.meta.dirname, '../data/lurker.db');

const { findUserByUsername } = await import('../server/db/users.js');
const { createRecoveryToken } = await import('../server/db/accountRecovery.js');

const user = findUserByUsername(username);
if (!user) {
  console.error(`No account named '${username}' in ${process.env.DATABASE_PATH}.`);
  process.exit(1);
}

// createdBy is null: nobody in the users table issued this one, and recording a
// stand-in admin would misattribute it in the panel.
const token = createRecoveryToken(user.id, null);

console.log('');
console.log(`Recovery link for ${user.username} (expires in 24 hours, single use):`);
console.log('');
console.log(`  ${origin.replace(/\/+$/, '')}/recover/${token}`);
console.log('');
console.log('This is the only time it is shown. Any previous link for this account is now dead.');
