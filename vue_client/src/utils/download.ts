// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Trigger a browser "save as" for in-memory text (no server round-trip / HTTP
// route). Used by the E2E keyring export so the private-key material lands in a
// file the user controls rather than being rendered into the message view.
export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Defer cleanup to the next tick: revoking the object URL synchronously after
  // click() can cancel an in-flight download in some browsers.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
