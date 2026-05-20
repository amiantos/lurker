// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Minimal ambient declaration for the `cookie-signature` npm package.
declare module 'cookie-signature' {
  export function sign(val: string, secret: string): string;
  export function unsign(val: string, secret: string): string | false;
}
