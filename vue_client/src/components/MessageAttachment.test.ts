// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Three levels, matching the split in the components:
//   - MessageAttachment renders ONE resolved preview.
//   - MessageAttachments decides the ARRANGEMENT (mosaic vs stacked) from a list it is handed.
//   - MessageBody owns the resolved set — the reveal latch, the settings gating and which URLs
//     the body text drops — because the text and the attachments have to agree on all three.
//
// ⚠ Most of the suites below mount MessageBody even where the assertion is about arrangement.
// That is deliberate: MessageAttachments is now presentational, so mounting it directly would
// test a hand-built list rather than the one the app produces.
//
// The first suite exists because QA saw no YouTube card while the server was verified to be
// answering correctly — nothing was testing the span between those two facts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, nextTick, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageAttachment from './MessageAttachment.vue';
import MessageBody from './MessageBody.vue';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { MAX_CARDS_PER_MESSAGE } from '../utils/previewUrls.js';
import { splitTextByTokens } from '../utils/nickColor.js';

// Resolution is driven by message ingest, so components only read — stub the read. A real
// `ref` is required: the templates rely on Vue's auto-unwrapping, which is keyed on `isRef`.
//
// ⚠ ONE ref per URL, cached, rather than a fresh one per call. The real composable does the same
// (`entryFor`), and the atomic-reveal suite depends on it: answering a URL AFTER mount has to
// reach the ref the component is already watching. Cleared by the top-level `beforeEach` below.
const resolved = new Map<string, LinkPreview>();
const refs = new Map<string, Ref<LinkPreview | null>>();
function entryRef(url: string): Ref<LinkPreview | null> {
  let entry = refs.get(url);
  if (!entry) {
    entry = ref<LinkPreview | null>(resolved.get(url) ?? null);
    refs.set(url, entry);
  }
  return entry;
}

// URLs the real module would say an answer is still expected for. Kept separate from `resolved`
// because the whole point of the reveal gate is that "no value yet" and "no answer coming" are
// DIFFERENT states — a stub that conflated them could not observe the distinction it exists for.
const inFlight = new Set<string>();
const flightBump = ref(0);

// ⚠ Every export is a lazy arrow, so nothing here is dereferenced at factory time. A `vi.mock`
// factory runs before this file's module-level consts initialise, which is why a value export
// (`previewRevision: ref(0)`) dies at collection and these do not.
vi.mock('../composables/useLinkPreview.js', () => ({
  useLinkPreview: (url: string) => entryRef(url),
  usePreviewsSettled: (urls: Ref<readonly string[]>) =>
    computed(() => {
      void flightBump.value;
      return urls.value.every((url) => !inFlight.has(url));
    }),
}));

/** Mark URLs as awaiting an answer. */
function setInFlight(...urls: string[]): void {
  for (const url of urls) inFlight.add(url);
  flightBump.value++;
}

/** Deliver an answer into the ref the component is already watching. */
function answer(p: LinkPreview): void {
  entryRef(p.url).value = p;
  inFlight.delete(p.url);
  flightBump.value++;
}

function preview(over: Partial<LinkPreview> & { url: string }): LinkPreview {
  return {
    status: 'ok',
    kind: 'page',
    expiresAt: '2099-01-01T00:00:00Z',
    ...over,
  } as LinkPreview;
}

const YOUTUBE = preview({
  url: 'https://www.youtube.com/watch?v=6yRUqNmcI_M',
  kind: 'video-embed',
  title: 'PAPA NUGS & DJ ADHD - THE VOICES',
  siteName: 'YouTube',
  author: 'Maslow Unknown',
  thumb: '/api/link-preview/media/tok',
  embedUrl: 'https://www.youtube-nocookie.com/embed/6yRUqNmcI_M?autoplay=1&rel=0',
});

const IMAGE = preview({
  url: 'https://e.test/a.png',
  kind: 'image',
  src: '/api/link-preview/media/tok2',
  thumbWidth: 800,
  thumbHeight: 600,
  mime: 'image/png',
});

// ⚠ TOP-LEVEL, not inside `seedSettings`. The ref cache lived there and so was skipped by the one
// test that builds its own Pinia (it needs `image_modal` off), which then rendered the PREVIOUS
// test's refs — its own `resolved.set` calls were dead, and planting a null ref made it crash on
// an undefined element rather than fail its stated assertion.
beforeEach(() => {
  refs.clear();
  inFlight.clear();
});

function seedSettings({ inlineMedia = true, linkPreviews = true, feature = true } = {}) {
  setActivePinia(createPinia());
  // The instance feature flag gates both user settings — a stored `true` must not render on an
  // instance that has the feature off, where the routes aren't even mounted. Defaults on here so
  // the suite is about the user settings; `feature: false` covers the gate itself.
  useConfigStore().features = { linkPreviews: feature, bouncer: false, dcc: false };
  const settings = useSettingsStore();
  // Real store values rather than a mocked getter: `effective` is a Pinia getter returning a
  // closure, so it can't be spied — and seeding state exercises the same lookup the app does.
  settings.values = {
    'chat.inline_media.enabled': inlineMedia,
    'chat.link_previews.enabled': linkPreviews,
    'chat.image_modal.enabled': true,
  };
  settings.loaded = true;
}

describe('MessageAttachment — video embed', () => {
  beforeEach(() => seedSettings());

  it('renders a card for a resolved YouTube descriptor', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain('PAPA NUGS');
    // ⚠ ...and NOT the site or author. `siteName` and `author` stay on the wire — iOS may want
    // them, and the hostname fallback is computed server-side — but the web card doesn't spend a
    // line on naming a URL that is already in the message a word above it.
    expect(wrapper.text()).not.toContain('YouTube');
    expect(wrapper.text()).not.toContain('Maslow Unknown');
  });

  it('gives a video the player box whatever shape its thumbnail is', () => {
    // ⚠ The layout rule below is about SHARE IMAGES. A video's box is the player's geometry —
    // an iframe replaces it — so a square oEmbed thumbnail must not talk it into the small
    // square, which would leave the play control in a 72px box and the video effectively gone.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, thumbWidth: 480, thumbHeight: 480 }) },
    });
    expect(wrapper.find('.card-media .card-play').exists()).toBe(true);
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
  });

  it('shows the play facade, and NOT an iframe, before any click', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card-play').exists()).toBe(true);
    // The privacy property: nothing reaches the video host on render.
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('creates the iframe only once the play button is clicked', async () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    await wrapper.find('.card-play').trigger('click');
    expect(wrapper.find('iframe').attributes('src')).toContain('youtube-nocookie.com');
  });

  it('sends the origin to the player, because no-referrer breaks every video', async () => {
    // ⚠⚠ This looks like a privacy REGRESSION and is the opposite: it is what makes the player
    // work at all. YouTube's embedded player validates the embedding page from the `Referer`
    // header, and `referrerpolicy="no-referrer"` — which this shipped with — meant every video
    // answered "Error 153, Video player configuration error" instead of playing. Proven by A/B:
    // two iframes, same embed URL, same `allow`, differing only in this attribute.
    //
    // So the assertion is on the exact value, not on "some policy is set". `origin` sends
    // `scheme://host` and never the path, and the property that does the real privacy work is
    // the facade — nothing reaches the video host until the reader presses play, which the two
    // tests above guard.
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    await wrapper.find('.card-play').trigger('click');
    expect(wrapper.find('iframe').attributes('referrerpolicy')).toBe('origin');
  });

  it('points the thumbnail at our proxy, never at the origin', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card-thumb-wide').attributes('src')).toBe('/api/link-preview/media/tok');
  });

  it('keeps the play control when the video thumbnail fails to load', async () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    await wrapper.find('.card-thumb-wide').trigger('error');
    expect(wrapper.find('.card-thumb-wide').exists()).toBe(false);
    expect(wrapper.find('.card-play').exists()).toBe(true);
  });

  it('falls back to a plain card when the kind says video but no embedUrl came with it', () => {
    // ⚠ `kind: 'video-embed'` and `embedUrl` are NOT a guaranteed pair on the wire. The origin
    // allowlist can recognise a page as a video and still withhold the embed URL, and while the
    // server currently downgrades that case to `page`, a client that assumes the pairing renders
    // a play button wired to `src="undefined"` — a facade that swallows the click and can never
    // produce a player. Degrade to the ordinary card, which still links out.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, embedUrl: undefined }) },
    });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.find('.card-play').exists()).toBe(false);
    expect(wrapper.find('iframe').exists()).toBe(false);
    // The thumbnail survives — as an ordinary page card's image, and YOUTUBE declares no
    // dimensions, so it takes the default hero. See the layout suite below.
    expect(wrapper.find('.card-hero-img').attributes('src')).toBe('/api/link-preview/media/tok');
    expect(wrapper.find('.card-title').attributes('href')).toBe(YOUTUBE.url);
  });

  it('keeps the box, and the play control, for a video with no thumbnail at all', () => {
    // ⚠ The box is gated on `isVideo` alone and must stay that way: an oEmbed reply carrying a
    // title but no thumbnail_url (or an og:image `normalizeUrl` refused) leaves `thumb` undefined
    // with `embedUrl` set. Gating the block on the thumbnail instead put the card in a state with
    // no branch true at all — a title, and a video that could never be played.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, thumb: undefined }) },
    });
    expect(wrapper.find('.card-media').exists()).toBe(true);
    expect(wrapper.find('.card-play').exists()).toBe(true);
    expect(wrapper.find('.card-thumb-wide').exists()).toBe(false);
  });

  it('names the degraded embed record the server deliberately stores', () => {
    // ⚠ `pageRecord` keeps a video embed that has NO title, no description and no thumbnail —
    // the provider oEmbed call was rate-limited and the scrape found nothing past the 512 KB
    // cap — because the play affordance is real content. It gives that record the FAILURE ttl
    // for the same reason, describing it in so many words as one whose "whole visible content
    // is the hostname". So the client has to actually render a hostname: without the `heading`
    // fallback this was a wordless black 16:9 box with a ▶ and no way to reach the page.
    const wrapper = mount(MessageAttachment, {
      props: {
        preview: preview({
          url: 'https://www.youtube.com/watch?v=abc123',
          kind: 'video-embed',
          siteName: 'www.youtube.com',
          embedUrl: 'https://www.youtube-nocookie.com/embed/abc123',
        }),
      },
    });
    expect(wrapper.find('.card-play').exists()).toBe(true);
    expect(wrapper.find('a.card-title').text()).toBe('www.youtube.com');
    expect(wrapper.find('a.card-title').attributes('href')).toBe(
      'https://www.youtube.com/watch?v=abc123',
    );
    // ⚠ ...and the CONTROL is named from the same string. It read `Play ${preview.title ?? 'video'}`
    // — so on the one record this whole fallback exists for, every play button in the buffer was
    // called "Play video", which is the identical-names defect `imageLabel` was written to avoid.
    expect(wrapper.find('.card-play').attributes('aria-label')).toBe('Play www.youtube.com');
  });
});

describe('MessageAttachment — the two card shapes', () => {
  beforeEach(() => seedSettings());

  // A card is a hero band under its text, a small square beside it, or text on its own — chosen
  // by the DECLARED shape of the image (`og:image:width`/`og:image:height`, resolver v4).
  //
  // ⚠⚠ The hero was built once before and REMOVED after looking at it on real links. It is back
  // because the input it needed did not exist then: `imageWidth`/`imageHeight` were populated
  // only from an oEmbed thumbnail, so for an ordinary og:image card they were null and the choice
  // fired essentially at random. The property those tests were really guarding is unchanged and
  // is asserted below: whatever shape a card takes, it takes from the DESCRIPTOR and never from
  // the image. Measuring the picture on load would make layout depend on bytes, so every card
  // would lay out once and re-arrange on decode (R1).
  //
  // ⚠ The LINE BUDGET half of #692 (title 2, description 3) is pure CSS with no class binding to
  // observe, and happy-dom applies no stylesheet — so there is deliberately no test for it here
  // rather than one that would stay green with every clamp deleted. Same for the hero's own
  // `aspect-ratio` and `object-fit: contain`.

  const page = (over: Partial<LinkPreview> = {}) =>
    preview({
      url: 'https://news.example/article',
      kind: 'page',
      title: 'A headline',
      description: 'A standfirst.',
      thumb: '/api/link-preview/media/tokP',
      ...over,
    });

  // Every pair below is real markup, read off the live sites.
  it('gives a landscape image the hero band, under the text', () => {
    for (const [w, h] of [
      [1200, 600], // GitHub
      [1200, 630], // firecore.com/infuse — the og:image convention
    ]) {
      const wrapper = mount(MessageAttachment, {
        props: { preview: page({ thumbWidth: w, thumbHeight: h }) },
      });
      expect(wrapper.find('.card-hero-img').attributes('src')).toBe('/api/link-preview/media/tokP');
      expect(wrapper.find('.card-thumb').exists()).toBe(false);
      // ⚠⚠ The column class, and it is not cosmetic: in a ROW the hero's `width: 100%` basis sits
      // beside `.card-text`'s 0% basis, the two consume the line, and the text resolves to 0px
      // wide — title and description vanish behind their own `overflow: hidden` with nothing to
      // hint at it. Same failure the video card carries a warning about.
      expect(wrapper.find('.card').classes()).toContain('card-column');
      // Text still leads in source order — nothing is re-ordered visually.
      const kids = [...wrapper.find('.card').element.children].map((el) => el.className);
      expect(kids).toEqual(['card-text', 'card-hero']);
    }
  });

  // lurker#1240: an image host that answers "not now" left a broken-image glyph in the band for
  // the life of the row. A card whose picture fails is the text-only card.
  it('drops a hero that fails to load, and tells the scroller the row changed', async () => {
    const wrapper = mount(MessageAttachment, {
      props: { preview: page({ thumbWidth: 1200, thumbHeight: 600 }) },
    });
    await wrapper.find('.card-hero-img').trigger('error');
    await nextTick();
    expect(wrapper.find('.card-hero').exists()).toBe(false);
    expect(wrapper.find('.card').classes()).not.toContain('card-column');
    expect(wrapper.find('.card-title').exists()).toBe(true);
    expect(wrapper.emitted('measured')).toHaveLength(1);
  });

  it('drops a square thumbnail that fails to load', async () => {
    const wrapper = mount(MessageAttachment, {
      props: { preview: page({ thumbWidth: 256, thumbHeight: 256 }) },
    });
    await wrapper.find('.card-thumb').trigger('error');
    await nextTick();
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
    expect(wrapper.find('.card-title').exists()).toBe(true);
  });

  it('shows the picture again when the preview brings a different one', async () => {
    const wrapper = mount(MessageAttachment, {
      props: { preview: page({ thumbWidth: 1200, thumbHeight: 600 }) },
    });
    await wrapper.find('.card-hero-img').trigger('error');
    await wrapper.setProps({
      preview: page({ thumbWidth: 1200, thumbHeight: 600, thumb: '/api/link-preview/media/tokQ' }),
    });
    expect(wrapper.find('.card-hero-img').attributes('src')).toBe('/api/link-preview/media/tokQ');
  });

  it('keeps the small square for a logo, which is what reddit ships', () => {
    // ⚠ Square AND portrait. A hero band would crop a portrait's subject out, and a 256px logo
    // stretched across a card reads as a picture of nothing.
    for (const [w, h] of [
      [256, 256], // reddit.com and /r/irc
      [512, 512], // Ars Technica — a LOGO, beside which it declares `summary_large_image`
      [869, 1200], // Wikipedia — portrait
    ]) {
      const wrapper = mount(MessageAttachment, {
        props: { preview: page({ thumbWidth: w, thumbHeight: h }) },
      });
      expect(wrapper.find('.card-thumb').attributes('src')).toBe('/api/link-preview/media/tokP');
      expect(wrapper.find('.card-hero').exists()).toBe(false);
      expect(wrapper.find('.card').classes()).not.toContain('card-column');
      const kids = [...wrapper.find('.card').element.children].map((el) => el.className);
      expect(kids).toEqual(['card-text', 'card-thumb']);
    }
  });

  it('defaults an UNDECLARED image to the hero', () => {
    // ⚠⚠ The deliberate trade. NYT, BBC and bradroot.me declare an og:image and no size at all —
    // all three editorial, all three wanting a hero — so the default serves the common case. What
    // it costs is an undeclared square logo letterboxed in a wide frame, which `object-fit:
    // contain` makes survivable: small and centred rather than cropped into a band.
    const wrapper = mount(MessageAttachment, { props: { preview: page() } });
    expect(wrapper.find('.card-hero-img').exists()).toBe(true);
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
  });

  it('treats a HALF-declared shape as undeclared', () => {
    // A page shipping a width and no height yields no ratio. Reading the one number as though it
    // were a shape is how a logo ends up in a band.
    for (const over of [{ thumbWidth: 256 }, { thumbHeight: 256 }, { thumbWidth: 0 }]) {
      const wrapper = mount(MessageAttachment, { props: { preview: page(over) } });
      expect(wrapper.find('.card-hero-img').exists()).toBe(true);
    }
  });

  it('never lets the PLAYER box be talked into a card shape', () => {
    // A video's box is the embed's geometry, so `isVideo` claims the branch before `cardShape` is
    // consulted — even for the square oEmbed thumbnail that would otherwise select the chip.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, thumbWidth: 480, thumbHeight: 480 }) },
    });
    expect(wrapper.find('.card-media .card-play').exists()).toBe(true);
    expect(wrapper.find('.card-hero').exists()).toBe(false);
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
  });

  it('degrades to text only when the card has no image', () => {
    // ⚠ `pageRecord` returns ok on a title OR an image, so this is an ordinary answer and not an
    // edge case. Reserving the square regardless would leave an empty box beside the text —
    // furniture for a picture that is never coming.
    const wrapper = mount(MessageAttachment, { props: { preview: page({ thumb: undefined }) } });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain('A headline');
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
  });

  it('is never empty, never nameless, and never without a link', () => {
    // ⚠⚠ The regression this suite exists for now. `pageRecord` returns ok on a title OR an
    // image, so a titleless card is an ordinary answer — and with the heading gated on `title`,
    // each of these rendered as a tinted panel with NO anchor: a preview that goes nowhere,
    // looks finished, and reads to a screen reader as an empty div, because the thumbnail is
    // `alt=""`. The last one rendered as literally `<div class="card"></div>`.
    //
    // Reachable, not theoretical: `pageRecord` deliberately stores ok records with title,
    // description and imageUrl all null (the `!embed` clause), and `toDescriptor` downgrades
    // such a row to `kind: 'page'` whenever `isEmbeddableOrigin` refuses its cached embedUrl.
    // ⚠⚠ The `siteName` rung is the one PRODUCTION ACTUALLY TAKES, and an earlier version of this
    // test could not see it: every fixture omitted `siteName`, so deleting that rung outright
    // left the suite green (mutation-checked). `pageRecord` sets
    // `providerName || og:site_name || url.hostname` on EVERY ok record, so a real titleless card
    // always has one — and dropping the rung would silently downgrade "The Guardian" to
    // "www.theguardian.com" everywhere with nothing red. The value here is deliberately NOT equal
    // to the URL's host, or it could not tell the two rungs apart.
    const cases = [
      [
        'an image, no title, real site name',
        page({ title: undefined, siteName: 'Example News' }),
        'Example News',
      ],
      ['a description and no title', page({ title: undefined }), 'news.example'],
      [
        'nothing at all',
        preview({ url: 'https://news.example/article', kind: 'page' }),
        'news.example',
      ],
      // ⚠ The URL rung must spell a host the way the SERVER spells it. `pageRecord` clamps
      // `url.hostname`, and `URL.host` — which this used — appends the port, so one site was
      // named `nas.local` or `nas.local:8096` depending on which rung fired. A non-default port
      // is ordinary on exactly the self-hosted and LAN links this client is for. (Copilot found
      // it; two `/code-review max` rounds did not.)
      [
        'a non-default port',
        preview({ url: 'https://nas.local:8096/share/x', kind: 'page' }),
        'nas.local',
      ],
    ] as const;

    for (const [what, p, expected] of cases) {
      const wrapper = mount(MessageAttachment, { props: { preview: p } });
      const link = wrapper.find('a.card-title');
      // ⚠ `${what}` in the assertion, not just in a comment: four mounts in one test otherwise
      // report an anonymous failure and the reader has to count them.
      expect(`${what}: ${link.exists()}`).toBe(`${what}: true`);
      // ⚠ Against the case's OWN url. Hardcoded, this asserted the fixture rather than the
      // component, and a case carrying a different URL failed on the wrong line.
      expect(`${what}: ${link.attributes('href')}`).toBe(`${what}: ${p.url}`);
      expect(`${what}: ${link.text()}`).toBe(`${what}: ${expected}`);
    }
  });

  it('prefers the page title over the fallback, so the host shows up nowhere', () => {
    // The other direction, and the reason `heading` is not the site line returning: when a page
    // HAS a title that is the whole heading, and the hostname appears in no part of the card.
    const wrapper = mount(MessageAttachment, { props: { preview: page() } });
    expect(wrapper.find('a.card-title').text()).toBe('A headline');
    expect(wrapper.text()).not.toContain('news.example');
  });

  it('keeps a video card a COLUMN, or its text collapses to nothing', () => {
    // ⚠⚠ The one load-bearing class binding here, and it had no guard: deleting
    // `:class="{ 'card-video': isVideo }"` left the whole suite green.
    //
    // Losing it does not merely re-arrange the card, it DELETES the text. `.card` stays a row;
    // `.card-text` is `flex: 1` (basis 0%) while `.card-media` carries `width: 100%` (basis =
    // the entire content box), so the bases already fill the line and the text resolves to 0px
    // wide — title and description vanish behind their own `overflow: hidden`, silently.
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card').classes()).toContain('card-video');
    // ...and a page card must NOT get it, or its thumbnail drops below the text.
    const card = mount(MessageAttachment, { props: { preview: page() } });
    expect(card.find('.card').classes()).not.toContain('card-video');
  });
});

describe('MessageAttachment — inline image', () => {
  beforeEach(() => seedSettings());

  it('renders through the proxy with its real dimensions', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('img.inline-image');
    expect(img.attributes('src')).toBe('/api/link-preview/media/tok2');
    // ⚠ These do NOT reserve the box, whatever this comment used to say — `.inline-image` sets
    // `width: auto`, which beats the presentational hint and leaves an unloaded image with no box
    // at all in Blink (lurker#705). The wrapper is the reserver; these stay for the UA ratio,
    // which is what still sizes the image inside that box.
    expect(img.attributes('width')).toBe('800');
    expect(img.attributes('height')).toBe('600');
  });

  it('fills its cell, and drops its own sizing, when it is a mosaic tile', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE, tiled: true } });
    expect(wrapper.find('img').classes()).toContain('tile-item');
    expect(wrapper.find('img').classes()).not.toContain('in-reserve');
  });
});

describe('MessageAttachment — the click must not be eaten', () => {
  it('lets the click reach the row when the media viewer is switched off', async () => {
    // ⚠⚠ `@click.stop` runs its modifier BEFORE the handler, so propagation died and the
    // handler's own `image_modal` guard then discarded the event. On touch the row's click is
    // the only opener of the message-actions sheet — hover actions are desktop-only and there
    // is no long-press path — so an image became a dead zone over the biggest target in the row:
    // no viewer, no sheet, nothing at all.
    seedSettings();
    useSettingsStore().values['chat.image_modal.enabled'] = false;
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('.inline-image');

    let reachedRow = false;
    img.element.addEventListener('click', (e) => {
      // Whatever the row would do, it must at least still SEE the event.
      if (!e.cancelBubble) reachedRow = true;
    });
    await img.trigger('click');
    expect(reachedRow).toBe(true);
    expect(wrapper.emitted('activate')).toBeUndefined();
    // Nor does it advertise a click it won't honour.
    expect(img.attributes('role')).toBeUndefined();
    expect(img.attributes('tabindex')).toBeUndefined();
  });

  it('is reachable from the keyboard when the viewer IS on, and is NAMED', () => {
    // ⚠ The name is the half that's easy to miss. `alt=""` is correct for a decorative image and
    // stops being sufficient the instant `role="button"` is applied — the img role that gave the
    // empty alt its meaning is gone, leaving a focusable control with no accessible name. The
    // filename is carried so a mosaic of several doesn't present identically-named buttons.
    seedSettings();
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('.inline-image');
    expect(img.attributes('role')).toBe('button');
    expect(img.attributes('tabindex')).toBe('0');
    expect(img.attributes('aria-label')).toBe('Open image: a.png');
  });

  it('carries no name, and no role, when it is not a control', () => {
    seedSettings();
    useSettingsStore().values['chat.image_modal.enabled'] = false;
    const img = mount(MessageAttachment, { props: { preview: IMAGE } }).find('.inline-image');
    expect(img.attributes('role')).toBeUndefined();
    expect(img.attributes('aria-label')).toBeUndefined();
    // Still decorative, which is what an empty alt is for.
    expect(img.attributes('alt')).toBe('');
  });

  it('activates on Enter and Space, not only on a mouse click', async () => {
    seedSettings();
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    await wrapper.find('.inline-image').trigger('keydown.enter');
    await wrapper.find('.inline-image').trigger('keydown.space');
    expect(wrapper.emitted('activate')).toHaveLength(2);
  });
});

describe('MessageAttachment — growth the list can react to', () => {
  // ⚠⚠ MOUNTS NO PLAYER AT ALL — the media-policy change, and the reason it is asserted as an
  // ABSENCE. A `<video>` fetches before anyone asks (`preload="metadata"` at minimum, and the
  // `#t=0.1` poster trick this replaces made it a range request for real frames), so the element
  // existing IS the involuntary fetch the proxy is meant to prevent. It is also what had one
  // clip relayed per viewer, per view, forever — the byte cache stores images only — which
  // exhausted the control plane's socket memory on 2026-08-10.
  // The policy is stated for operators in docs/SELF_HOSTING.md.
  //
  // ⚠ `src` is set on the fixture DELIBERATELY, though the server no longer mints one. A
  // descriptor from before the change may still be in an open tab, and honouring it would mount
  // a player against a token the route now 404s — a broken source instead of a card.
  for (const [kind, url, glyph] of [
    ['video', 'https://e.test/c.mp4', '▶'],
    ['audio', 'https://e.test/s.mp3', '♪'],
  ] as const) {
    it(`renders ${kind} as a file card, never a player, even with a stale src`, () => {
      seedSettings();
      const p = preview({ url, kind, src: '/api/lp/media/x', mime: `${kind}/mp4` });
      const wrapper = mount(MessageAttachment, { props: { preview: p } });
      expect(wrapper.find('video').exists()).toBe(false);
      expect(wrapper.find('audio').exists()).toBe(false);
      expect(wrapper.find('.card-file').exists()).toBe(true);
      expect(wrapper.find('.file-badge').text()).toBe(glyph);
      // ⚠ The link points at the ORIGIN, not at the proxy. That is the whole hand-off: a
      // deliberate click goes where the bytes actually live.
      expect(wrapper.find('.card-file .card-title').attributes('href')).toBe(url);
    });
  }

  it('names a media file by its filename, not by its hostname', () => {
    // ⚠ These records have no title and no siteName — nothing was scraped, because the URL IS
    // the content — so the shared `heading` falls through to the hostname. Three clips from one
    // CDN would then present as three identical cards.
    seedSettings();
    const p = preview({
      url: 'https://cdn.e.test/holiday%20clip.mp4',
      kind: 'video',
      mime: 'video/mp4',
    });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    expect(wrapper.find('.card-file .card-title').text()).toBe('holiday clip.mp4');
    expect(wrapper.find('.card-file .card-desc').text()).toBe('Video · MP4');
  });

  it('renders a stored poster as inline MEDIA — no card, badge, viewer on click', async () => {
    // Media, not citation: a clip whose first frame we hold renders the way an image does.
    // The frame is our own decode served from our own route, so showing it unasked fetches
    // nothing from the origin — the policy's line is bytes of the CLIP, which still move only
    // on the deliberate click this test performs.
    seedSettings();
    const p = preview({
      url: 'https://cdn.e.test/holiday.mp4',
      kind: 'video',
      mime: 'video/mp4',
      thumb: '/api/link-preview/poster/abc123',
      thumbWidth: 640,
      thumbHeight: 360,
    });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    expect(wrapper.find('.card').exists()).toBe(false);
    const img = wrapper.find('.media-reserve img.inline-image');
    expect(img.attributes('src')).toBe('/api/link-preview/poster/abc123');
    expect(img.attributes('role')).toBe('button');
    expect(wrapper.find('.media-badge').text()).toBe('▶');
    // The reserve span carries the poster's geometry, image-style: byte-independent box.
    expect(wrapper.find('.media-reserve').attributes('style')).toContain('aspect-ratio');
    // Still no player mounted and no clip bytes anywhere — the click asks the VIEWER to play.
    expect(wrapper.find('video').exists()).toBe(false);
    await img.trigger('click');
    expect(wrapper.emitted('activate')).toHaveLength(1);
  });

  it('audio cover art gets the same treatment, with its own glyph', () => {
    seedSettings();
    const p = preview({
      url: 'https://cdn.e.test/song.mp3',
      kind: 'audio',
      mime: 'audio/mpeg',
      thumb: '/api/link-preview/poster/def456',
      thumbWidth: 300,
      thumbHeight: 300,
    });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    expect(wrapper.find('.media-badge').text()).toBe('♪');
    expect(wrapper.find('.card').exists()).toBe(false);
  });

  it('keeps the poster reachable as a plain link when the viewer is off', () => {
    // ⚠ The body hides the URL text for inline-rendered media, so with the viewer switched
    // off this anchor is the ONLY remaining path to the clip — an inert poster would be a
    // picture of a play button that plays nothing, pointing at nothing.
    seedSettings();
    useSettingsStore().values['chat.image_modal.enabled'] = false;
    const p = preview({
      url: 'https://cdn.e.test/holiday.mp4',
      kind: 'video',
      mime: 'video/mp4',
      thumb: '/api/link-preview/poster/abc123',
      thumbWidth: 640,
      thumbHeight: 360,
    });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    const link = wrapper.find('a.media-link');
    expect(link.attributes('href')).toBe('https://cdn.e.test/holiday.mp4');
    expect(link.find('img').attributes('src')).toBe('/api/link-preview/poster/abc123');
  });

  it('keeps the posterless file card, whose title now plays in place', async () => {
    // Cache off, decode failed, or a row from before posters existed: the compact card is
    // the complete state everything degrades to — but a plain click still owes the same
    // deliberate-act-in-place behaviour the poster gets.
    seedSettings();
    const p = preview({ url: 'https://e.test/c.mp4', kind: 'video', mime: 'video/mp4' });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    expect(wrapper.find('.media-reserve').exists()).toBe(false);
    expect(wrapper.find('.file-badge').text()).toBe('▶');
    const title = wrapper.find('.card-title');
    expect(title.attributes('href')).toBe('https://e.test/c.mp4');
    await title.trigger('click');
    expect(wrapper.emitted('activate')).toHaveLength(1);
  });

  it('leaves modifier-clicks on the file card title to the browser', async () => {
    // ⚠ preventDefault on a cmd-click would eat open-in-new-tab — the affordance keeping
    // this element an <a> at all.
    seedSettings();
    const p = preview({ url: 'https://e.test/c.mp4', kind: 'video', mime: 'video/mp4' });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    await wrapper.find('.card-title').trigger('click', { metaKey: true });
    expect(wrapper.emitted('activate')).toBeUndefined();
  });

  it('emits no measurement for a file card, which has nothing to load', () => {
    // The player it replaces laid out at the UA default 300x150 and jumped when metadata
    // arrived, which is what `measured` existed to report. A card's height is final at first
    // paint, so there is no late growth for the scroller to chase.
    seedSettings();
    const p = preview({ url: 'https://e.test/c.mp4', kind: 'video', mime: 'video/mp4' });
    const wrapper = mount(MessageAttachment, { props: { preview: p } });
    expect(wrapper.emitted('measured')).toBeUndefined();
  });

  it('tells the list when an image decodes, even though its box was reserved', async () => {
    // ⚠⚠ The NET, and it is deliberately kept rather than reasoned away. This emit was deleted
    // once on the argument that a reserved box makes late growth impossible, and the box being
    // reserved was itself false in Blink (0x0 until the bytes landed) — so the one thing that
    // would have noticed lurker#705 had been removed on the strength of the belief the bug
    // disproves. `reserveStyle` should now make this redundant; "should" is why it stays.
    //
    // It costs nothing when redundant: `repinAfterPreviewGrowth(true)` in MessageList returns
    // immediately unless the reader is at the tail, and for one who is, the correction is an
    // idempotent `scrollTop = scrollHeight`.
    seedSettings();
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    await wrapper.find('img.inline-image').trigger('load');
    expect(wrapper.emitted('measured')).toHaveLength(1);
  });
});

describe('MessageAttachments — arrangement', () => {
  beforeEach(() => resolved.clear());

  function seed(...previews: LinkPreview[]) {
    for (const p of previews) resolved.set(p.url, p);
  }

  const img = (n: number, w: number, h: number) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: w,
      thumbHeight: h,
    });

  function mountFor(text: string, opts = {}) {
    seedSettings(opts);
    return mount(MessageBody, { props: { text, segments: [] } });
  }

  it('leaves a single image on its own rather than in a one-cell mosaic', () => {
    seed(img(1, 800, 600));
    const wrapper = mountFor('https://e.test/1.png');
    expect(wrapper.find('.mosaic').exists()).toBe(false);
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
  });

  it('puts two or more images into one mosaic', () => {
    // Three portrait screenshots stacked is most of a screen of somebody else's message.
    seed(img(1, 800, 600), img(2, 800, 600));
    const mosaic = mountFor('https://e.test/1.png https://e.test/2.png').find('.mosaic');
    expect(mosaic.exists()).toBe(true);
    expect(mosaic.findAll('img').length).toBe(2);
  });

  it('takes the mosaic shape from the COUNT, never from the pictures', () => {
    // ⚠⚠ The property the whole grid rests on, and the reason it replaced a strip whose height
    // was derived from `thumbWidth`/`thumbHeight`. Two groups of the same size get the same
    // layout no matter what shape their images are, so no descriptor — and therefore no
    // late-arriving answer — can change a message's height. Asserted as the class binding
    // because the geometry itself is CSS and happy-dom applies no stylesheet.
    seed(img(1, 800, 600), img(2, 1200, 500));
    expect(
      mountFor('https://e.test/1.png https://e.test/2.png').find('.mosaic').classes(),
    ).not.toContain('odd');

    resolved.clear();
    seed(img(1, 600, 900), img(2, 500, 1000));
    expect(
      mountFor('https://e.test/1.png https://e.test/2.png').find('.mosaic').classes(),
    ).not.toContain('odd');
  });

  it('leads an ODD count with the three-up block, at three and at nine alike', () => {
    // A 2x2 grid holding three items leaves a hole; stretching the third across the bottom makes
    // it the subject of the message. The full-height first cell is what gives an odd count a
    // shape, and `.odd` is what selects it — at any count, because whatever the three-up block
    // doesn't take is even by construction and pairs up behind it.
    //
    // ⚠ The class used to be `n${count}` with the CSS keyed on `.n3`, which was correct only
    // because nothing past the fourth image was ever drawn. At five that spelling silently
    // degrades to a two-column grid with a hole in its last row.
    for (const n of [3, 5, 9]) {
      resolved.clear();
      const urls: string[] = [];
      for (let i = 1; i <= n; i++) {
        urls.push(`https://e.test/${i}.png`);
        seed(img(i, 800, 600));
      }
      const mosaic = mountFor(urls.join(' ')).find('.mosaic');
      expect(mosaic.classes()).toContain('odd');
      expect(mosaic.findAll('.tile').length).toBe(n);
    }
  });

  it('tiles EVERY image, with no four-cell cap and no overflow count', () => {
    // lurker#773. The grid used to draw four tiles and a `+N` badge over the last one; lurker-ios
    // shows the lot, and the badge was advertising pictures as hidden from inside a layout whose
    // whole point is that the message is on screen at once. What bounds the worst case is
    // `MAX_MEDIA_PER_MESSAGE` (20), applied long before this component sees anything.
    const urls: string[] = [];
    for (let n = 1; n <= 6; n++) {
      urls.push(`https://e.test/${n}.png`);
      seed(img(n, 800, 600));
    }
    const wrapper = mountFor(urls.join(' '));
    expect(wrapper.findAll('.mosaic .tile')).toHaveLength(6);
    expect(wrapper.find('.more').exists()).toBe(false);
  });

  it('renders each image exactly ONCE — in the grid, never again below it', () => {
    // ⚠⚠ Regression, /code-review high, from when the cap existed: `stacked` subtracted the four
    // DRAWN tiles, so every image from the fifth on fell through and rendered a SECOND time at
    // full size underneath, while the `+2` badge above announced those same pictures as hidden.
    //
    // ⚠ The test above this one could not catch it: it counts `.mosaic .tile`, which was correct
    // the whole time. Counting what the grid took is not counting what RENDERED — so this counts
    // every image in the block, and goes on doing so now that the two sets should agree.
    const urls: string[] = [];
    for (let n = 1; n <= 6; n++) {
      urls.push(`https://e.test/${n}.png`);
      seed(img(n, 800, 600));
    }
    const wrapper = mountFor(urls.join(' '));
    expect(wrapper.findAll('.mosaic .tile')).toHaveLength(6);
    expect(wrapper.findAll('img.inline-image')).toHaveLength(6);
  });

  it('still stacks a LONE image, which the mosaic never stands in for', () => {
    // The other side of the fix: with no mosaic nothing is spoken for, so the single image has to
    // reach `stacked` or a one-image message renders no picture at all.
    seed(img(1, 800, 600));
    const wrapper = mountFor('https://e.test/1.png');
    expect(wrapper.find('.mosaic').exists()).toBe(false);
    expect(wrapper.findAll('img.inline-image')).toHaveLength(1);
  });

  it('caps CARDS against the server answer, not against the extension guess', () => {
    // ⚠ `previewableUrls` charges anything that LOOKS like media to the generous media budget
    // (20), because half a grid row is not what a card costs. But an image-looking URL that resolves
    // as a page — an extensionless CDN link, a .png that redirects to an HTML login page —
    // becomes a CARD, and a card costs real vertical space. Applying the tight cap only to the
    // guess meant twenty such links rendered twenty stacked cards and took over the screen.
    const urls: string[] = [];
    for (let n = 0; n < 8; n++) {
      const url = `https://e.test/looks-like-media${n}.png`;
      urls.push(url);
      resolved.set(url, preview({ url, kind: 'page', title: `T${n}` }));
    }
    const wrapper = mountFor(urls.join(' '));
    expect(wrapper.findAll('.card')).toHaveLength(MAX_CARDS_PER_MESSAGE);
  });

  it('keeps cards out of the mosaic', () => {
    seed(img(1, 800, 600), img(2, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png https://e.test/2.png ${YOUTUBE.url}`);
    expect(wrapper.find('.mosaic').findAll('img').length).toBe(2);
    expect(wrapper.find('.card').exists()).toBe(true);
  });

  it('stacks a video card at full width instead of cropping it into a cell', () => {
    // ⚠ The mosaic is a grid of PICTURES and a file card is not one — cropped into a cell it
    // would lose the filename, which is the whole of it. Two images plus a video is a two-cell
    // mosaic and a stacked card, not a three-cell grid.
    seed(img(1, 800, 600), img(2, 800, 600));
    const video = preview({ url: 'https://e.test/c.mp4', kind: 'video', mime: 'video/mp4' });
    seed(video);
    const wrapper = mountFor(`https://e.test/1.png https://e.test/2.png ${video.url}`);
    expect(wrapper.findAll('.mosaic .tile')).toHaveLength(2);
    expect(wrapper.find('.mosaic .card-file').exists()).toBe(false);
    expect(wrapper.find('.card-file').exists()).toBe(true);
  });

  // ⚠⚠ Both of these are regressions the media-policy change introduced and a review caught.
  // Video and audio crossed from "the file, on screen" to "a card about a file", and every rule
  // keyed on the old meaning had to cross with them. Neither failure was visible from the
  // component's own tests, because both live in MessageBody's arrangement rather than in the
  // card.
  it('charges video cards to the CARD cap, not the generous media budget', () => {
    // A card costs real vertical space whatever kind produced it. Charged to the media budget
    // (20) and skipped by the card counter, a message of pasted clips rendered a full-width
    // card per link — the screenful MAX_CARDS_PER_MESSAGE exists to prevent, and which the
    // same count of images (a 4-tile mosaic) or pages (3 cards) both avoid.
    const clips = Array.from({ length: 8 }, (_, i) =>
      preview({ url: `https://e.test/clip${i}.mp4`, kind: 'video', mime: 'video/mp4' }),
    );
    seed(...clips);
    const wrapper = mountFor(clips.map((c) => c.url).join(' '));
    expect(wrapper.findAll('.card-file').length).toBe(MAX_CARDS_PER_MESSAGE);
  });

  // ⚠ These two mount with real SEGMENTS. `mountFor` passes `segments: []` because the tests
  // around it are about arrangement, and with no segments there is no body text for a URL to be
  // kept in or dropped from — the assertion would pass vacuously either way.
  function mountWithBody(url: string) {
    seedSettings();
    return mount(MessageBody, {
      props: {
        text: `look at this ${url}`,
        segments: [{ text: 'look at this ' }, { text: url, url }],
      },
    });
  }

  it('keeps the address in the text for a POSTERLESS video, which is still a card', () => {
    // ⚠ The URL is dropped from the body only when the thing itself is on screen. A card names
    // a file — it is not the file — so removing the address leaves a reader with "look at this"
    // and a filename, unable to read or copy where it points.
    const video = preview({ url: 'https://e.test/a1b2c3.mp4', kind: 'video', mime: 'video/mp4' });
    seed(video);
    const wrapper = mountWithBody(video.url);
    expect(wrapper.find('.card-file').exists()).toBe(true);
    expect(wrapper.text()).toContain(video.url);
  });

  it('drops the address for a video whose poster is on screen, the image rule exactly', () => {
    // With a stored frame the clip renders as MEDIA, and the address becomes a
    // machine-readable duplicate of the thing the reader is looking at — same reasoning,
    // same rule, same test shape as the image below.
    const video = preview({
      url: 'https://e.test/framed.mp4',
      kind: 'video',
      mime: 'video/mp4',
      thumb: '/api/link-preview/poster/abc123',
      thumbWidth: 640,
      thumbHeight: 360,
    });
    seed(video);
    const wrapper = mountWithBody(video.url);
    expect(wrapper.find('.media-reserve').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(video.url);
  });

  it('still drops the address for an image, which IS on screen', () => {
    // The other half of the same rule — asserted so a fix for the above can't quietly delete it.
    seed(img(1, 800, 600));
    const wrapper = mountWithBody('https://e.test/1.png');
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('https://e.test/1.png');
  });

  it('renders nothing at all when both settings are off', () => {
    seed(img(1, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png ${YOUTUBE.url}`, {
      inlineMedia: false,
      linkPreviews: false,
    });
    expect(wrapper.find('.attachments').exists()).toBe(false);
  });

  it('gates media and cards on their own settings, by the server answer', () => {
    seed(img(1, 800, 600), YOUTUBE);
    const text = `https://e.test/1.png ${YOUTUBE.url}`;

    const mediaOnly = mountFor(text, { inlineMedia: true, linkPreviews: false });
    expect(mediaOnly.find('img.inline-image').exists()).toBe(true);
    expect(mediaOnly.find('.card').exists()).toBe(false);

    const pagesOnly = mountFor(text, { inlineMedia: false, linkPreviews: true });
    expect(pagesOnly.find('img.inline-image').exists()).toBe(false);
    expect(pagesOnly.find('.card').exists()).toBe(true);
  });

  it('renders nothing when the INSTANCE has the feature off', () => {
    // Both user settings on, feature flag off: nothing renders. A stored `true` carried over
    // from another instance must not draw a card the server here could never resolve.
    seed(img(1, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png ${YOUTUBE.url}`, { feature: false });
    expect(wrapper.find('.attachments').exists()).toBe(false);
  });

  it('renders nothing for an unavailable preview', () => {
    seed(preview({ url: 'https://e.test/gone', status: 'unavailable' }));
    expect(mountFor('https://e.test/gone').find('.attachments').exists()).toBe(false);
  });

  it('renders nothing while a preview is still unresolved', () => {
    // The ingest-driven model's normal early state, and the case a row must render as
    // "nothing" rather than as a placeholder that later collapses.
    expect(mountFor('https://e.test/not-primed').find('.attachments').exists()).toBe(false);
  });
});

describe('MessageBody — atomic reveal', () => {
  // The rule: no layout may depend on WHEN A SIBLING RESOLVES. A message with two image URLs, one
  // of them already cached from an earlier post, used to paint as a lone image and then
  // re-arrange into a group when the second landed. That moved a scrolled-up reader with no way
  // to compensate, because the growth had already happened by the time anything heard about it.
  //
  // ⚠ The mosaic removed one HALF of this hazard for free — its geometry comes from the count, so
  // no late descriptor can re-pick a height the way the strip's portrait/landscape rule could.
  // The count itself still changes as siblings land, which is what the gate is still for.

  beforeEach(() => resolved.clear());

  const img = (n: number, w = 800, h = 600) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: w,
      thumbHeight: h,
    });

  const TWO = 'https://e.test/1.png https://e.test/2.png';

  it('shows nothing while a sibling is still in flight, then the whole block at once', async () => {
    // ⚠ The FIRST assertion is the one that bites: without the gate this renders a lone
    // `.inline-image`, which is the arrangement that then flips.
    resolved.set(img(1).url, img(1));
    seedSettings();
    setInFlight(img(2).url);
    const wrapper = mount(MessageBody, { props: { text: TWO, segments: [] } });
    expect(wrapper.find('.attachments').exists()).toBe(false);
    expect(wrapper.find('.inline-image').exists()).toBe(false);

    answer(img(2));
    await nextTick();

    expect(wrapper.find('.mosaic').exists()).toBe(true);
    expect(wrapper.findAll('.mosaic img')).toHaveLength(2);
  });

  it('decides the mosaic SHAPE once, from the complete group', async () => {
    // ⚠ TWO images arrive first, so that without the gate there IS a mosaic mid-flight — a single
    // paired row — which then becomes a three-up block over a pair, three rows tall, when the rest
    // land. An earlier draft of the strip-era version of this test seeded ONE image and passed
    // with the gate reverted, because one image is never a group either way; two is the smallest
    // count that can be wrong.
    //
    // ⚠ FIVE in total, not four, so the finished shape differs from the mid-flight one in the
    // class as well as the tile count: parity is what the layout keys on now, and 2 and 4 are
    // both even. A count that only changed the number of tiles would still catch this, but only
    // by the assertion the cap-era version happened to have.
    resolved.set(img(1).url, img(1));
    resolved.set(img(2).url, img(2));
    seedSettings();
    setInFlight(img(3).url, img(4).url, img(5).url);
    const wrapper = mount(MessageBody, {
      props: {
        text: `${TWO} https://e.test/3.png https://e.test/4.png https://e.test/5.png`,
        segments: [],
      },
    });
    expect(wrapper.find('.mosaic').exists()).toBe(false);

    answer(img(3));
    answer(img(4));
    answer(img(5));
    await nextTick();

    expect(wrapper.find('.mosaic').classes()).toContain('odd');
    expect(wrapper.findAll('.mosaic .tile')).toHaveLength(5);
  });

  it('does not stall on a URL no answer is coming for', () => {
    // ⚠⚠ The property the whole gate rests on, and the reason it asks the module rather than
    // running a timer. `useLinkPreview` hands back a permanently-null ref for a URL nobody primed,
    // so a gate of "every entry has a value" would blank this message for the life of the tab.
    // Not in flight means not coming, and the block renders now.
    //
    // ⚠ This one does NOT fail if the gate is deleted, and it CANNOT observe the pending rule
    // itself — this suite mocks `usePreviewsSettled`, so mutating `previewPending` leaves it
    // green. (Checked, after an earlier version of this comment claimed otherwise.) The real rule
    // is guarded in `useLinkPreview.test.ts` → "is an answer still coming?", where all three of
    // its clauses are revert-proven. What this asserts is the component half: that a settled-but-
    // valueless URL is rendered past rather than waited on.
    resolved.set(img(1).url, img(1));
    seedSettings();
    const wrapper = mount(MessageBody, { props: { text: TWO, segments: [] } });
    expect(wrapper.find('.inline-image').exists()).toBe(true);
  });

  it('does not hide a block already on screen when a URL goes back in flight', async () => {
    // A transient failure is re-asked (`runReask` re-queues it), which puts a settled URL back
    // into the pending set. Un-revealing would be a SHRINK, which disturbs a reader exactly as
    // much as the growth this gate exists to prevent.
    resolved.set(img(1).url, img(1));
    resolved.set(img(2).url, img(2));
    seedSettings();
    const wrapper = mount(MessageBody, { props: { text: TWO, segments: [] } });
    expect(wrapper.find('.mosaic').exists()).toBe(true);

    setInFlight(img(2).url);
    await nextTick();

    expect(wrapper.find('.mosaic').exists()).toBe(true);
  });

  it('survives an unrelated settings write while a URL is back in flight', async () => {
    // ⚠⚠ `urls` is a computed that allocates a fresh array every evaluation, and it re-evaluates
    // on ANY settings write, because the store replaces `values` wholesale. Watching the array
    // IDENTITY therefore fired the re-gate on a byte-identical URL list — so toggling the channel
    // list, or a highlight sound, or a cross-device sync, re-derived `revealed` from a `settled`
    // that can legitimately be false and made a group vanish mid-read. That is the same shrink
    // the latch exists to prevent, reintroduced by the line meant to scope it.
    resolved.set(img(1).url, img(1));
    resolved.set(img(2).url, img(2));
    seedSettings();
    const wrapper = mount(MessageBody, { props: { text: TWO, segments: [] } });
    expect(wrapper.find('.mosaic').exists()).toBe(true);

    // A cache eviction plus a repost re-primes a URL against a fresh null ref, so `settled` goes
    // false again under a latch that is holding the mosaic on screen.
    setInFlight(img(2).url);
    // ...and now something entirely unrelated writes a setting.
    useSettingsStore().values = {
      ...useSettingsStore().values,
      'chat.highlight_sound.enabled': true,
    };
    await nextTick();

    expect(wrapper.find('.mosaic').exists()).toBe(true);
  });

  it('shows a URL added by a settings flip that was ALREADY resolved', async () => {
    // ⚠⚠ `shown` grows inside a watcher on `settled`, and Vue only runs that when the VALUE
    // changes. If the flip adds a URL that is already in the cache — the same image posted
    // earlier in the session, or previewed in another buffer — `settled` is true before and true
    // after, so the watcher never fires and the URL is never admitted. The attachment then stays
    // hidden for the life of the row, with everything about it resolved and ready.
    const CARD = 'https://news.example/article';
    resolved.set(CARD, preview({ url: CARD, kind: 'page', title: 'A page' }));
    resolved.set(img(1).url, img(1));
    seedSettings({ inlineMedia: false, linkPreviews: true });
    const wrapper = mount(MessageBody, {
      props: { text: `https://e.test/1.png ${CARD}`, segments: [] },
    });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.find('.inline-image').exists()).toBe(false);

    // Nothing goes in flight: the image was resolved all along, it simply wasn't previewable.
    useSettingsStore().values['chat.inline_media.enabled'] = true;
    await nextTick();

    expect(wrapper.find('.inline-image').exists()).toBe(true);
    expect(wrapper.find('.card').exists()).toBe(true);
  });

  it('holds back only the NEW URLs when a settings flip grows the set', async () => {
    // ⚠⚠ The one path that changes `urls` without remounting: `/set` from the composer, or a
    // settings sync from another device. Two things have to be true at once here, and an earlier
    // version got the second exactly backwards.
    //
    //   1. The newly-previewable image must NOT paint until it has settled — otherwise the flip
    //      renders it piecemeal, which is what the gate exists to prevent.
    //   2. The card that was ALREADY on screen must stay on screen. Re-deriving one shared
    //      `revealed` flag from `settled` tore the whole block down instead: ten resolved cards
    //      collapsing buffer-wide, ~1200px of uncompensated shrink, for a setting about images.
    const CARD = 'https://news.example/article';
    resolved.set(CARD, preview({ url: CARD, kind: 'page', title: 'A page' }));
    seedSettings({ inlineMedia: false, linkPreviews: true });
    const wrapper = mount(MessageBody, {
      props: { text: `https://e.test/1.png ${CARD}`, segments: [] },
    });
    expect(wrapper.find('.card').exists()).toBe(true);

    setInFlight(img(1).url);
    useSettingsStore().values['chat.inline_media.enabled'] = true;
    await nextTick();

    expect(wrapper.find('.inline-image').exists()).toBe(false);
    expect(wrapper.find('.card').exists()).toBe(true);

    answer(img(1));
    await nextTick();
    expect(wrapper.find('.inline-image').exists()).toBe(true);
    expect(wrapper.find('.card').exists()).toBe(true);
  });
});

describe('MessageAttachment — a box that does not depend on bytes', () => {
  beforeEach(() => seedSettings());

  // ⚠ These assert the CLASS BINDING, which is the load-bearing logic; the height itself is CSS
  // and happy-dom applies no stylesheet. Stated rather than implied, because a test that can't
  // observe what it names is the trap this feature has already been caught by once.

  const unmeasured = preview({
    url: 'https://e.test/exotic',
    kind: 'image',
    src: '/api/link-preview/media/tokX',
  });

  it('reserves the box on a WRAPPER for every untiled image, measured or not', () => {
    // ⚠ All three cases in ONE test, deliberately. Split apart, the negative case asserted
    // `not.toContain(...)` and stayed green with the binding deleted entirely — vacuous against
    // the very mutation it looks like it guards.
    //
    // ⚠⚠ The geometry is on the WRAPPER and that is the assertion that matters. Pinned on the
    // `<img>`, the empty letterbox around a 16x16 favicon became part of a 240px-tall control
    // that calls `stopPropagation` — swallowing the row tap that is the only opener of the
    // message-actions sheet on touch. A wrapper with no handlers leaves those pixels to the row.
    //
    // `imageDimensions` returns null for a format sharp can't parse in the 64 KB it reads — ico
    // and bmp both arrive as `kind: 'image'` with null dimensions. With no ratio to derive a box
    // from, that case falls back to the flat height `.dim-fallback` carries.
    const lone = mount(MessageAttachment, { props: { preview: unmeasured } });
    expect(lone.find('.dim-reserve').exists()).toBe(true);
    expect(lone.find('.dim-reserve img.inline-image').exists()).toBe(true);
    expect(lone.find('.dim-reserve').classes()).toContain('dim-fallback');
    expect(lone.find('.dim-reserve').attributes('style')).toBeUndefined();

    // ⚠⚠ lurker#705. A MEASURED image used to get no wrapper box at all, on the belief that its
    // width/height attributes reserved one — which is false wherever author CSS sets `width:
    // auto` (this component does). Measured against a `src` that never resolves: Safari reserved
    // 319x240, Chrome reserved 0x0, and the 240px it gained at decode time is what stopped a
    // buffer opening at its own tail. The wrapper now carries a definite width and the ratio.
    const measured = mount(MessageAttachment, { props: { preview: IMAGE } });
    const box = measured.find('.dim-reserve');
    expect(box.exists()).toBe(true);
    expect(box.classes()).not.toContain('dim-fallback');
    // 800x600 (see IMAGE): 240 * 4/3 = 320px of width, so the height lands on the 240 cap exactly
    // as the loaded image would. The cap is applied to the WIDTH because `max-height` cannot bite
    // until the natural width is known — which is the whole reason the old box arrived late.
    expect(box.attributes('style')).toContain('width: 320px');
    expect(box.attributes('style')).toContain('aspect-ratio: 800 / 600');

    // Never upscaled: a 16x16 favicon takes its own width, not the 240px cap. (`.dim-fallback`
    // has no ratio to do this with, which is why an unmeasured image gets the flat box instead.)
    const tiny = mount(MessageAttachment, {
      props: { preview: preview({ ...IMAGE, thumbWidth: 16, thumbHeight: 16 }) },
    });
    expect(tiny.find('.dim-reserve').attributes('style')).toContain('width: 16px');

    // ⚠⚠ A SLIVER, and the width stays fractional. `aspect-ratio` derives the height by dividing
    // this width, so a rounding error is multiplied by h/w: 13x1200 rounded to a whole 3px makes
    // the box 277px tall, and a 2x1000 floored to 1px makes it 500px — against a cap of 240. The
    // fraction is what keeps `MAX_IMAGE_HEIGHT` true for the shapes it exists for (Copilot, #737).
    const sliver = mount(MessageAttachment, {
      props: { preview: preview({ ...IMAGE, thumbWidth: 13, thumbHeight: 1200 }) },
    });
    expect(sliver.find('.dim-reserve').attributes('style')).toContain('width: 2.6px');

    // In a mosaic the CELL already decides the box; a second one would fight it. The wrapper
    // generates no box at all (`display: contents`), which is also what lets `.tile` clip and
    // round the picture directly.
    const tile = mount(MessageAttachment, { props: { preview: unmeasured, tiled: true } });
    expect(tile.find('.dim-reserve').exists()).toBe(false);
    expect(tile.find('img').classes()).toContain('tile-item');
    const measuredTile = mount(MessageAttachment, { props: { preview: IMAGE, tiled: true } });
    expect(measuredTile.find('.dim-passthrough').attributes('style')).toBeUndefined();
  });
});

describe('MessageAttachments — the lightbox is a gallery over the whole message', () => {
  beforeEach(() => {
    resolved.clear();
    useMediaViewer().close();
  });

  const img = (n: number) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: 800,
      thumbHeight: 600,
    });

  it('opens every image in the mosaic, positioned on the one clicked', async () => {
    // This is what makes a generous media cap safe: however many images a message carries,
    // all of them are reachable by arrowing through the viewer.
    for (const n of [1, 2, 3]) resolved.set(img(n).url, img(n));
    seedSettings();
    const wrapper = mount(MessageBody, {
      props: {
        text: 'https://e.test/1.png https://e.test/2.png https://e.test/3.png',
        segments: [],
      },
    });

    await wrapper.findAll('.mosaic img')[1].trigger('click');

    const viewer = useMediaViewer();
    expect(viewer.isOpen.value).toBe(true);
    expect(viewer.count.value).toBe(3);
    expect(viewer.index.value).toBe(1);
    // ⚠ OUR proxy path, not the origin URL. Handing the viewer `preview.url` broke the promise
    // the setting makes in words ("the site hosting it never sees your device") — the image
    // rendered inline via the proxy and then the click went straight to the remote host — and
    // made an `http://` image fail as mixed content once the lightbox loaded it directly.
    // ⚠ ...under a query of its own: the inline `<img>` has already drawn these bytes small,
    // and Safari 27 gives a second `<img>` on the SAME URL the small decode's size — the
    // lightbox opened at thumbnail size (lurker#1163). See `ownDecodeUrl`.
    expect(viewer.url.value).toBe('/api/link-preview/media/t2?view=full');
    expect(viewer.items.value.map((i) => i.url)).toEqual([
      '/api/link-preview/media/t1?view=full',
      '/api/link-preview/media/t2?view=full',
      '/api/link-preview/media/t3?view=full',
    ]);
    // And the arrows are live in both directions, which is the whole point.
    expect(viewer.hasPrev.value).toBe(true);
    expect(viewer.hasNext.value).toBe(true);
    // ⚠ ...but "copy link" must hand over the ORIGIN. The rendered path is relative and behind
    // requireAuth, so copying it produced something that resolves to nothing for anybody else —
    // not even another user on the same instance — while the link TEXT in the same message
    // copied the real URL. Two controls, two answers, one of them useless.
    expect(viewer.shareUrl.value).toBe('https://e.test/2.png');
    expect(viewer.items.value.map((i) => i.shareUrl)).toEqual([
      'https://e.test/1.png',
      'https://e.test/2.png',
      'https://e.test/3.png',
    ]);
  });

  it('opens a clip’s poster on the ORIGIN url — a player, not a gallery entry', async () => {
    // ⚠ The inverse of the proxy rule the image test above pins, and both are the media
    // policy: an image renders unasked so its bytes must come through us; a clip plays only
    // on this deliberate click, and the click goes straight to the origin because relaying
    // deliberate playback is the relay the policy retired. A gallery of one — the arrow set
    // is pictures, and a player inside a picture gallery is a mode switch.
    const clip = preview({
      url: 'https://cdn.e.test/holiday.mp4',
      kind: 'video',
      mime: 'video/mp4',
      thumb: '/api/link-preview/poster/abc123',
      thumbWidth: 640,
      thumbHeight: 360,
    });
    resolved.set(clip.url, clip);
    seedSettings();
    const wrapper = mount(MessageBody, {
      props: { text: clip.url, segments: [{ text: clip.url, url: clip.url }] },
    });

    await wrapper.find('.media-reserve img').trigger('click');

    const viewer = useMediaViewer();
    expect(viewer.isOpen.value).toBe(true);
    expect(viewer.count.value).toBe(1);
    expect(viewer.url.value).toBe('https://cdn.e.test/holiday.mp4');
    expect(viewer.shareUrl.value).toBe('https://cdn.e.test/holiday.mp4');
    // ⚠ The SERVER's kind rides along, so the viewer doesn't have to guess it from the URL
    // extension — an extensionless clip would otherwise open as a broken <img>.
    expect(viewer.current.value?.kind).toBe('video');
  });

  it('arrows through the whole message from whichever tile was clicked', async () => {
    // ⚠⚠ The gallery is built from EVERY image in the message, positioned on the one clicked. It
    // used to be the guarantee that made the four-tile cap a crop rather than a truncation — the
    // sixth image was one arrow key from the fourth even though nothing drew it. The cap is gone
    // (lurker#773) and the guarantee is not: a TILE is itself a crop, and the arrow set is what
    // says the middle of a photograph is not all there is of it.
    for (const n of [1, 2, 3, 4, 5, 6]) resolved.set(img(n).url, img(n));
    seedSettings();
    const wrapper = mount(MessageBody, {
      props: {
        text: [1, 2, 3, 4, 5, 6].map((n) => `https://e.test/${n}.png`).join(' '),
        segments: [],
      },
    });
    expect(wrapper.findAll('.mosaic .tile')).toHaveLength(6);

    await wrapper.findAll('.mosaic img')[3].trigger('click');
    const viewer = useMediaViewer();
    expect(viewer.count.value).toBe(6);
    expect(viewer.index.value).toBe(3);
    expect(viewer.hasNext.value).toBe(true);
  });

  it('carries the origin for a lone image too', () => {
    const one = img(9);
    resolved.set(one.url, one);
    seedSettings();
    const wrapper = mount(MessageBody, { props: { text: one.url, segments: [] } });
    void wrapper.find('.inline-image').trigger('click');
    const viewer = useMediaViewer();
    expect(viewer.url.value).toBe('/api/link-preview/media/t9?view=full');
    expect(viewer.shareUrl.value).toBe('https://e.test/9.png');
  });

  it('opens a lone image as a gallery of one, also through the proxy', () => {
    resolved.set(img(1).url, img(1));
    seedSettings();
    const wrapper = mount(MessageBody, {
      props: { text: 'https://e.test/1.png', segments: [] },
    });
    wrapper.find('img.inline-image').trigger('click');
    expect(useMediaViewer().count.value).toBe(1);
    expect(useMediaViewer().url.value).toBe('/api/link-preview/media/t1?view=full');
  });

  it('does not open anything when the media viewer is switched off', async () => {
    for (const n of [1, 2]) resolved.set(img(n).url, img(n));
    // Hand-built rather than via seedSettings because this one needs image_modal OFF.
    setActivePinia(createPinia());
    useConfigStore().features = { linkPreviews: true, bouncer: false, dcc: false };
    const settings = useSettingsStore();
    settings.values = {
      'chat.inline_media.enabled': true,
      'chat.link_previews.enabled': true,
      'chat.image_modal.enabled': false,
    };
    settings.loaded = true;
    const wrapper = mount(MessageBody, {
      props: { text: 'https://e.test/1.png https://e.test/2.png', segments: [] },
    });
    await wrapper.findAll('.mosaic img')[0].trigger('click');
    expect(useMediaViewer().isOpen.value).toBe(false);
  });
});

describe('MessageBody — the address gives way to the picture', () => {
  beforeEach(() => resolved.clear());

  const IMG = 'https://e.test/1.png';
  const PAGE = 'https://news.example/article';

  function seedImage() {
    resolved.set(
      IMG,
      preview({
        url: IMG,
        kind: 'image',
        src: '/api/link-preview/media/t1',
        thumbWidth: 800,
        thumbHeight: 600,
      }),
    );
  }

  // The real body split, not a hand-built list: the whole point is that what the renderer shows
  // and what the resolver asked about come from the same parse of the same string.
  function mountBody(text: string, opts = {}) {
    seedSettings(opts);
    return mount(MessageBody, {
      props: { text, segments: splitTextByTokens(text, null, null, null) },
    });
  }

  it('drops the address of a message that is nothing but a link', () => {
    seedImage();
    const wrapper = mountBody(IMG);
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(IMG);
  });

  it('drops it from the end of a sentence, and keeps the sentence', () => {
    seedImage();
    const wrapper = mountBody(`look at this ${IMG}`);
    expect(wrapper.text()).toContain('look at this');
    expect(wrapper.text()).not.toContain(IMG);
    // ⚠ And the space the URL was sitting on goes with it, or the line ends in a dangling gap.
    expect(wrapper.text().trim()).toBe('look at this');
  });

  it('KEEPS an address with prose on both sides of it', () => {
    seedImage();
    const wrapper = mountBody(`I read ${IMG} this morning`);
    expect(wrapper.text()).toContain(IMG);
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
  });

  it('never takes a CARD its link, because the card is a note ABOUT a page', () => {
    // ⚠⚠ The asymmetry is the design. A card's heading is different text from its URL, and the
    // URL is what a reader copies or reads before deciding to click — on a titleless card the
    // heading is nothing but the hostname. An image, by contrast, IS the message.
    resolved.set(PAGE, preview({ url: PAGE, kind: 'page', title: 'An article' }));
    const wrapper = mountBody(PAGE);
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain(PAGE);
  });

  it('keeps the address until the picture is actually on screen', async () => {
    // ⚠⚠ Both halves are the SAME event, which is why the latch is shared rather than copied.
    // Hiding the text on `settled` instead would blank the URL before anything replaced it, and
    // re-show it for a tick whenever a settings flip admitted a new URL.
    seedImage();
    setInFlight(IMG);
    const wrapper = mountBody(IMG);
    expect(wrapper.text()).toContain(IMG);
    expect(wrapper.find('img.inline-image').exists()).toBe(false);

    answer(
      preview({
        url: IMG,
        kind: 'image',
        src: '/api/link-preview/media/t1',
        thumbWidth: 800,
        thumbHeight: 600,
      }),
    );
    await nextTick();

    expect(wrapper.text()).not.toContain(IMG);
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
  });

  it('keeps the address of a link that never resolves', () => {
    // Nothing is ever hidden without something rendered in its place.
    const wrapper = mountBody(`${IMG} https://e.test/never.png`);
    expect(wrapper.text()).toContain('https://e.test/never.png');
  });

  it('marks an attachments-only body, so the row can top-align its nick', () => {
    // ⚠ The class binding is the load-bearing half; the `align-items: start` it selects is CSS,
    // and happy-dom applies no stylesheet. Without it the row keeps `align-items: baseline` over
    // a body with no line box, and the nick lands at the bottom of the image — or halfway down
    // it, or level with a card's title, depending on the attachment.
    seedImage();
    expect(mountBody(IMG).find('.attachments').classes()).toContain('body-only');

    // ⚠ It is about the TEXT THAT SURVIVES, not about whether a URL was hidden — and the first
    // draft of this test had it as the latter. `words <url>` hides the address and still leaves
    // "words" behind, so the body has a line box, `baseline` has something real to align to, and
    // overriding it would move the nick off the text it belongs beside.
    expect(mountBody(`words ${IMG}`).find('.attachments').classes()).not.toContain('body-only');
    expect(mountBody(`I read ${IMG} today`).find('.attachments').classes()).not.toContain(
      'body-only',
    );
  });

  it('renders no preview at all for a bracketed link, and keeps its text', () => {
    seedImage();
    const wrapper = mountBody(`<${IMG}>`);
    expect(wrapper.find('img.inline-image').exists()).toBe(false);
    expect(wrapper.text()).toContain(IMG);
    // ...and the brackets themselves are plumbing, not punctuation the reader asked for.
    expect(wrapper.text()).not.toContain('<');
    expect(wrapper.text()).not.toContain('>');
  });
});
