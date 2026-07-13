// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Nicks accept a narrower alphabet than Lurker account names do, so seeding a
// nick field from a username has to be filtered rather than copied.

// RFC 2812's nick grammar: letter / digit / special, where special is one of
// []\`_^{|} — plus '-', which effectively every ircd allows.
const DISALLOWED = /[^A-Za-z0-9[\]\\`_^{|}-]/g;

// ...but a nick may not *begin* with a digit or a hyphen (RFC 2812 requires the
// first character to be a letter or a special). Servers enforce this: a leading
// digit earns a 432 ERR_ERRONEUSNICKNAME at registration.
const BAD_LEADING = /^[\d-]+/;

// Conservative cap. Servers advertise their real NICKLEN in ISUPPORT (often 9 to
// 30) and we don't have it before connecting, so stay under the common floor;
// this only seeds an editable field, it doesn't constrain what a user can type.
const MAX_SEED_LENGTH = 16;

// Best-effort nick suggestion from an account name. Returns '' when nothing
// usable survives (an all-emoji username), which leaves the field empty for the
// user to fill in rather than prefilling something the server will reject.
export function nickFromUsername(username: string | undefined | null): string {
  return (username ?? '')
    .replace(DISALLOWED, '')
    .replace(BAD_LEADING, '')
    .slice(0, MAX_SEED_LENGTH);
}
