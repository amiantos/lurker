<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <RenderSegments
    v-if="shownSegments.length"
    :segments="shownSegments"
    :self-color="selfColor"
    :network-id="networkId"
    :interactive-nicks="interactiveNicks"
    @nick-click="(nick: string, ev: MouseEvent) => $emit('nickClick', nick, ev)"
  />
  <!-- ⚠⚠ `body-only` tells the ROW that this body has no text in it, and MessageList's
       `align-items: baseline` needs to know. A block container's baseline is its first in-flow
       LINE BOX, and an attachments-only body has none — so the baseline falls through to
       whatever the attachment happens to expose: an image's bottom margin edge (nick at the
       foot of the picture), a card's title (nick apparently centred), a mosaic's first row.
       Three different wrong answers from one missing line box, which is why hiding the URL text
       made the nick and timestamp look like they had stopped sticking to the top. -->
  <MessageAttachments
    v-if="visible.length"
    :class="{ 'body-only': !shownSegments.length }"
    :previews="visible"
    @measured="$emit('measured')"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import {
  previewableUrls,
  hideableUrls,
  segmentsWithoutUrls,
  MAX_CARDS_PER_MESSAGE,
} from '../utils/previewUrls.js';
import type { RenderSegment } from '../utils/nickColor.js';
import {
  useLinkPreview,
  usePreviewsSettled,
  type LinkPreview,
} from '../composables/useLinkPreview.js';
import RenderSegments from './RenderSegments.vue';
import MessageAttachments from './MessageAttachments.vue';

/**
 * A message's TEXT and its attachments, together.
 *
 * ⚠⚠ They are one component because hiding a URL from the body is a decision about the
 * attachments. Rendered as siblings — which is how MessageList had them — the text would need
 * its own copy of the reveal latch to know when an image had appeared, and two monotone latches
 * over the same module state agree at every tick right up until they don't: a settings flip
 * grows `urls`, and whichever one was created later seeds from a different `settled`. The whole
 * class of defect this feature keeps producing is two derivations of one fact drifting apart, so
 * there is one derivation and the text reads it.
 *
 * ⚠ Mounted only where an attachment could actually appear (`previewsActive && mightHaveLink` at
 * the call site, per message/action). MessageList used to gate MessageAttachments that way for
 * cost — 500 rows each building a computed and running the URL regex — and that gate now covers
 * this component instead. Everything else still renders a bare RenderSegments.
 *
 * Resolution is NOT triggered here: previews are primed at message ingest and this only reads.
 */
const props = withDefaults(
  defineProps<{
    /** The raw message text. The URL source, and what edge positions are measured against. */
    text: string | null | undefined;
    /**
     * The body, already split by the caller's nick/emoji pass.
     *
     * ⚠ For an action this is `"<nick> <text>"` while `text` is just the text — deliberately.
     * Position is a property of what the author typed, so `/me shares https://x.png` ends with
     * its URL and the prepended nick does not change that.
     */
    segments: RenderSegment[];
    selfColor?: string | null;
    networkId?: number | null;
    interactiveNicks?: boolean;
  }>(),
  { selfColor: null, networkId: null, interactiveNicks: false },
);

defineEmits<{
  nickClick: [nick: string, ev: MouseEvent];
  measured: [];
}>();

const settings = useSettingsStore();
const config = useConfigStore();

// ⚠ ANDed with the instance feature flag. A stored `true` from an instance that had the feature
// on must not render anything on one that doesn't — the routes aren't even mounted there, so a
// preview could never resolve and the setting rows aren't shown either. One choke point, so the
// render path and the priming path can't disagree.
const toggles = computed(() => ({
  inlineMedia: config.linkPreviews && settings.effective('chat.inline_media.enabled') === true,
  linkPreviews: config.linkPreviews && settings.effective('chat.link_previews.enabled') === true,
  hideInlineUrls: settings.effective('chat.inline_media.hide_urls') === true,
}));

const urls = computed(() => previewableUrls(props.text, toggles.value));

// One ref per URL, read-only. `useLinkPreview` on a URL nobody primed returns a permanently
// null ref, which is exactly the "render nothing" case.
const entries = computed(() => urls.value.map((url) => useLinkPreview(url)));

// ─── Atomic reveal ────────────────────────────────────────────────────────────
//
// A message shows NONE of its attachments until every URL in it has an answer, then the whole
// block appears at once.
//
// The rule this serves: no layout may depend on WHEN A SIBLING RESOLVES. Deriving the
// arrangement from the resolved set meant a message with three images, one of which was already
// cached from an earlier post, painted as a lone image and then re-arranged into a mosaic when
// the other two landed. That is a sibling-timing dependency, and it is invisible to a scrolled-up
// reader's re-pin because the growth has already happened by the time anything hears about it.
//
// ⚠ Deciding the arrangement from the URL list instead was considered and does NOT work:
// `mediaKindForUrl` charges extensionless hosts to the CARD budget (previewUrls.ts), so an imgur
// or twimg link — the common case on IRC — is predicted as a card and flips to media when it
// resolves. The prediction is wrong exactly where it matters.
//
// ⚠⚠ It now gates the TEXT as well, and that is the point of the merge. A URL vanishing from the
// body is a layout change of the same kind as an image appearing, so the two have to be the same
// event: `shownSegments` and `visible` are both functions of `shown`, so the body loses the
// address in the very frame the picture takes its place. Driving the text off `settled` instead
// would un-hide the URL for a tick whenever a settings flip admitted a new one.
//
// ⚠⚠ Asked, never timed. An earlier version revealed on a 1500ms deadline, on the reasoning that
// a message's URLs all land in one batch "~24ms after ingest" — which was the coalescing debounce
// (`FLUSH_MS`) mistaken for the round trip. The server allows 10s of queue wait plus a 30s
// resolve deadline per URL, so the deadline fired on any cold link and revealed a PARTIAL set.
const settled = usePreviewsSettled(urls);

/**
 * The URLs this message has already committed to showing.
 *
 * ⚠⚠ A PER-URL latch, not a per-component boolean, and the difference is a defect. The boolean
 * had to be re-derived whenever `urls` changed — otherwise a settings flip grew the set under an
 * already-open latch and the new images painted one at a time — and re-deriving it meant
 * `revealed = settled`, which could go true→false and tear the whole block down. Enabling inline
 * media with ten resolved cards on screen therefore collapsed all ten, buffer-wide, in one frame:
 * ~1200px of uncompensated shrink, for a setting that has nothing to do with cards.
 *
 * A set only ever grows. New URLs stay hidden until the whole set settles, which is the property
 * the gate exists for; anything already painted stays painted, which is the property the latch
 * exists for.
 *
 * ⚠⚠ Watches `urls` AS WELL, and watching `settled` alone was a bug. Vue runs a watcher when its
 * source's VALUE changes, so a flip that admits a URL which is ALREADY resolved — the same image
 * posted earlier in the session, or previewed in another buffer — left `settled` true before and
 * true after. The watcher never ran, the URL was never admitted, and its attachment stayed hidden
 * for the life of the row with everything about it resolved and ready.
 *
 * The array identity churns on any settings write (`urls` allocates a fresh array each
 * evaluation), so this fires more often than it strictly needs to. That is harmless HERE and was
 * not in the version this replaced: the callback only ever ADDS, and re-adding a URL already in
 * the set changes nothing, so no spurious render can follow. The defect before was a callback
 * that could REMOVE.
 */
const shown = ref<ReadonlySet<string>>(new Set());
watch(
  [settled, urls],
  ([ok]) => {
    if (!ok) return;
    const next = new Set(shown.value);
    for (const url of urls.value) next.add(url);
    if (next.size !== shown.value.size) shown.value = next;
  },
  { immediate: true },
);

/**
 * Previews that are resolved AND allowed by the settings.
 *
 * Re-checked against the server's answer rather than the extension guess that prompted the
 * request: an extensionless URL that turns out to be a PNG is inline media, and a `.jpg` that
 * redirects to an HTML login page is not. Otherwise "link previews off" could still be talked
 * into rendering a card.
 */
const visible = computed<LinkPreview[]>(() => {
  const out: LinkPreview[] = [];
  let cards = 0;
  for (const entry of entries.value) {
    const p = entry.value;
    if (!p || p.status !== 'ok') continue;
    // All-or-nothing, per URL: see `shown` above.
    if (!shown.value.has(p.url)) continue;
    if (isMedia(p) ? !toggles.value.inlineMedia : !toggles.value.linkPreviews) continue;
    // ⚠ The card cap is re-applied to the SERVER's answer, not just to the extension guess that
    // prompted the request. `previewableUrls` charges anything that looks like media to the
    // generous media budget (20), so twenty image-looking URLs that all resolve as pages —
    // extensionless CDN links, a `.png` that redirects to an HTML login page — arrived as twenty
    // stacked cards and took over the screen. The tight cap exists because a card costs real
    // vertical space, and only the resolved kind knows whether one is being built.
    if (!rendersInline(p)) {
      if (cards >= MAX_CARDS_PER_MESSAGE) continue;
      cards++;
    }
    out.push(p);
  }
  return out;
});

/** A link that IS a file, as the SERVER classified it — never as the extension guessed.
 *
 * ⚠ This answers "which SETTING governs it", and nothing else. It still counts video and audio
 * even though they no longer render inline, because `previewableUrls` charges them to the same
 * toggle on the way in — moving them to the card toggle would start showing cards to people who
 * turned inline media off and stop showing them to people who turned it on, which is a product
 * decision and not this change's to make. */
function isMedia(p: LinkPreview): boolean {
  return p.kind === 'image' || p.kind === 'video' || p.kind === 'audio';
}

/** A link whose CONTENT is put on screen, rather than a card describing it.
 *
 * ⚠⚠ IMAGES ONLY, and the split from `isMedia` is the whole point. Video and audio used to be
 * players — the file itself, on screen — and are now cards naming a file, so every rule that
 * asks "is the thing itself visible?" has to follow them across. Two rules did, and both broke
 * quietly when the kinds moved:
 *
 *   · the card cap (below) counted only `!isMedia`, so twenty pasted `.mp4` links rendered
 *     twenty uncapped full-width cards — the exact screenful MAX_CARDS_PER_MESSAGE exists to
 *     prevent, and which twenty page links or twenty images both avoid.
 *   · `hiddenUrls` dropped their address from the message, on the reasoning that the file was
 *     already on screen. Nothing is on screen now but a filename, so the address became
 *     unreadable and uncopyable — and this file's own rule is that a card never takes its
 *     link away. */
function rendersInline(p: LinkPreview): boolean {
  return p.kind === 'image' || ((p.kind === 'video' || p.kind === 'audio') && !!p.thumb);
}

/**
 * URLs whose address is dropped from the body because the thing itself is on screen.
 *
 * ⚠⚠ INLINE-RENDERED ONLY, and the asymmetry is deliberate. An image IS the message — the
 * address above it is a machine-readable duplicate of something the reader is already looking
 * at, and on a giphy link it is most of the row. A CARD is a note ABOUT something: its heading
 * is different text from the URL, the URL is what somebody would copy or read before deciding
 * to click, and a card can legitimately be titled with nothing but a filename or a hostname. So
 * a card never takes its link away.
 *
 * ⚠ `rendersInline`, not `isMedia` — and for video/audio the line moved WITH the rendering,
 * twice. As players they hid their URL; as cards they kept it (a card saying `a1b2c3.mp4`
 * with the address gone from the text was the defect); with a stored POSTER they render
 * inline again — media, not citation — and the address is a machine-readable duplicate of
 * the thing on screen, exactly the image rule. Posterless they are still cards, still on
 * the right of the line: nothing is ever hidden without something rendered in its place.
 *
 * Drawn from `visible` rather than from `urls`, so a URL that failed to resolve, was capped, or
 * is switched off keeps its text. Nothing is ever hidden without something rendered in its place.
 */
const hiddenUrls = computed(() =>
  hideableUrls(props.text, new Set(visible.value.filter(rendersInline).map((p) => p.url))),
);

const shownSegments = computed(() =>
  toggles.value.hideInlineUrls
    ? segmentsWithoutUrls(props.segments, hiddenUrls.value)
    : props.segments,
);
</script>
