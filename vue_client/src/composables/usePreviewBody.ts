// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { computed } from 'vue';
import { useConfigStore } from '../stores/config.js';
import { useSettingsStore } from '../stores/settings.js';

// Whether a row's body goes through MessageBody (link previews) rather than
// straight to RenderSegments — one gate for the message list and the thread
// view, so a change to what may unfurl reaches both.

export interface PreviewLine {
  type?: string;
  text?: unknown;
}

/** Cheap pre-filter: no scheme, no possible attachment. Skips the regex for most rows. */
function mightHaveLink(text: unknown): boolean {
  return typeof text === 'string' && text.includes('://');
}

export function usePreviewBody(): (m: PreviewLine | null | undefined) => boolean {
  const config = useConfigStore();
  const settings = useSettingsStore();
  /**
   * Whether an attachment could render at all right now.
   *
   * ⚠ Checked HERE, at the mount site, rather than only inside MessageAttachments. The component
   * was mounted once per message row regardless — 500 instances, each building a computed and
   * running the URL regex — so every user of a default-off feature paid for it on every buffer
   * switch. Hoisting the gate up also means an unrelated settings write can't invalidate a
   * per-row computed 500 times over.
   */
  const previewsActive = computed(
    () =>
      config.linkPreviews &&
      (settings.effective('chat.inline_media.enabled') === true ||
        settings.effective('chat.link_previews.enabled') === true),
  );

  /**
   * Whether this row's body goes through MessageBody rather than straight to RenderSegments.
   *
   * ⚠ The gate is unchanged from when it guarded MessageAttachments alone — the cost it exists to
   * avoid is the same one. MessageBody builds a computed and runs the URL regex per instance, and
   * mounting it on all 500 rows made every user of a default-off feature pay for it on every
   * buffer switch. Everything that fails this test renders exactly the component it always did.
   *
   * ⚠ `notice` is excluded even though `hasInlineText` accepts it, matching what the attachments
   * mount did: a notice is a service message, and unfurling links in one means unfurling whatever
   * NickServ or a bot happens to send.
   */
  return function previewBody(m: PreviewLine | null | undefined): boolean {
    return (
      (m?.type === 'message' || m?.type === 'action') &&
      previewsActive.value &&
      mightHaveLink(m?.text)
    );
  };
}
