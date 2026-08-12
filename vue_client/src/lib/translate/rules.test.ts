// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The twelve translation rules, as assertions. Each numbered describe cites
// the rule from the proposal doc; every one was a shipped bug in a reference
// client (Scully desktop / Spooky Android) before it became a rule, so a
// failure here is a regression of something that has already burned us once.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  stripUrls,
  isNoise,
  letterCount,
  collapseRepeats,
  genuinelyChanged,
  passesConfidenceGate,
  badgeLang,
  MIN_DETECT_CONFIDENCE,
} from './rules.js';
import { openAiBase } from './backends.js';

describe('rule 2 — noise skips before transmission', () => {
  it('skips text with ≤2 letters', () => {
    expect(isNoise('ok')).toBe(true);
    expect(isNoise(':)')).toBe(true);
    expect(isNoise('!!')).toBe(true);
    expect(isNoise('a b')).toBe(true);
  });

  it('skips interjections, including repeat-stretched forms (pre-collapsed list)', () => {
    for (const t of ['lol', 'LOOOOL', 'hahahaha', 'lmaooo', 'okkk', 'wow', 'hmm']) {
      expect(isNoise(t), t).toBe(true);
    }
  });

  it('does not skip real sentences', () => {
    expect(isNoise('where are you from?')).toBe(false);
    expect(isNoise('je ne comprends pas')).toBe(false);
  });

  it('is Unicode-aware: short CJK text is not letter-starved noise', () => {
    // "你好吗" is 3 letters — a real question, not noise.
    expect(letterCount('你好吗')).toBe(3);
    expect(isNoise('你好吗')).toBe(false);
  });

  it('collapseRepeats maps stretched interjections onto list entries', () => {
    expect(collapseRepeats('loool')).toBe('lol');
    // Repeated GROUP collapses to its base syllable, which is a listed interjection.
    expect(collapseRepeats('hahahaha')).toBe('ha');
    expect(collapseRepeats('jajaja')).toBe('ja');
    // Legitimate doubles survive: "good" must not become "god".
    expect(collapseRepeats('good')).toBe('good');
  });
});

describe('rule 8 — strip URLs before applying skip rules', () => {
  it('a message that is only a URL is noise (0-letter after strip)', () => {
    // URLs carry many letters but score 0.0 confidence at the translator —
    // without the strip they pass the letter check, get sent, fail, and retry
    // on every render (the confirmed Android bug).
    expect(isNoise('https://example.com/some/long/path?q=hello')).toBe(true);
    expect(isNoise('www.example.com')).toBe(true);
  });

  it('a URL plus real words is NOT noise', () => {
    expect(isNoise('regarde ça https://example.com')).toBe(false);
  });

  it('stripUrls removes both scheme and www forms', () => {
    expect(stripUrls('a https://x.io b www.y.z c').replace(/\s+/g, ' ')).toBe('a b c');
  });
});

describe('rule 3 — incoming detection gated at 60% confidence', () => {
  it('gates below the threshold, passes at and above it', () => {
    expect(passesConfidenceGate(MIN_DETECT_CONFIDENCE - 1)).toBe(false);
    expect(passesConfidenceGate(MIN_DETECT_CONFIDENCE)).toBe(true);
    expect(passesConfidenceGate(100)).toBe(true);
    expect(passesConfidenceGate(0)).toBe(false);
  });

  it('null/undefined confidence PASSES — OpenAI-compatible has no detection API', () => {
    // Gating null would disable that whole backend; "genuinely changed" is its
    // only signal, by design (see rules 4 and 9 notes in the store).
    expect(passesConfidenceGate(null)).toBe(true);
    expect(passesConfidenceGate(undefined)).toBe(true);
  });
});

describe('rule 4 — badge only genuinely-changed messages', () => {
  it('identical text means no translation occurred', () => {
    expect(genuinelyChanged('hello there', 'hello there')).toBe(false);
  });

  it('whitespace and case differences do not count as change', () => {
    expect(genuinelyChanged('hello  there', ' hello there ')).toBe(false);
    expect(genuinelyChanged('Hello', 'hello')).toBe(false);
  });

  it('a real translation counts', () => {
    expect(genuinelyChanged('bonjour', 'hello')).toBe(true);
  });

  it('an empty result never counts as a translation', () => {
    expect(genuinelyChanged('bonjour', '')).toBe(false);
    expect(genuinelyChanged('bonjour', '   ')).toBe(false);
  });
});

describe('unknown language codes render as themselves (known limitation)', () => {
  it('badgeLang falls back to the raw code, then to ?', () => {
    expect(badgeLang('zh-Hans')).toBe('zh-Hans');
    expect(badgeLang('fr')).toBe('fr');
    expect(badgeLang(null)).toBe('?');
    expect(badgeLang('  ')).toBe('?');
  });
});

describe('openAiBase — /v1 appended only when absent', () => {
  it('appends and deduplicates correctly', () => {
    expect(openAiBase('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(openAiBase('http://localhost:11434/')).toBe('http://localhost:11434/v1');
    expect(openAiBase('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(openAiBase('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
  });
});

// ─── Store-level rules (1, 6, 9, 10, 11) ────────────────────────────────────
// Exercised through the real store with a mocked fetch — the rules live in its
// gating, and asserting them any lower would test the mock.

function fetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
}

async function makeStore() {
  const { useTranslateStore } = await import('../../stores/translate.js');
  const { useSettingsStore } = await import('../../stores/settings.js');
  const settings = useSettingsStore();
  settings.values['chat.translate.backend'] = 'libretranslate';
  settings.values['chat.translate.endpoint'] = 'https://tr.test';
  settings.values['chat.translate.target_lang'] = 'en';
  return useTranslateStore();
}

/** The store's bounded-concurrency queue re-polls on a 120ms timer; tests that
 *  need a request to LAND must wait through at least one poll. */
const settle = () => new Promise((r) => setTimeout(r, 250));

describe('store rules', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // node test env has no localStorage; the store guards its own access, but
    // the prefs actions call it — a tiny in-memory shim keeps them exercised.
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    });
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rule 1 — never translates your own messages', async () => {
    const store = await makeStore();
    const f = fetchOk({});
    vi.stubGlobal('fetch', f);
    store.request({ id: 1, text: 'bonjour tout le monde', self: true, type: 'message' });
    await settle();
    expect(f).not.toHaveBeenCalled();
  });

  it('E2E policy — an encrypted message is never sent to a translator', async () => {
    const store = await makeStore();
    const f = fetchOk({});
    vi.stubGlobal('fetch', f);
    store.request({ id: 2, text: 'mensaje privado cifrado', e2e: true, type: 'message' });
    await settle();
    expect(f).not.toHaveBeenCalled();
    // And no verdict either: the overlay for this message must never exist.
    expect(Object.keys(store.verdicts)).toHaveLength(0);
  });

  it('protocol events are not prose — join/quit rows are never sent', async () => {
    const store = await makeStore();
    const f = fetchOk({});
    vi.stubGlobal('fetch', f);
    store.request({ id: 3, text: 'quit message here', type: 'quit' });
    await settle();
    expect(f).not.toHaveBeenCalled();
  });

  it('rule 10 — low-confidence caches permanently; transient failures cache nothing', async () => {
    const store = await makeStore();
    // First: a low-confidence detection → permanent negative verdict.
    vi.stubGlobal(
      'fetch',
      fetchOk({ translatedText: 'x', detectedLanguage: { language: 'pt', confidence: 30 } }),
    );
    store.request({ id: 4, text: 'texto curto ambíguo', type: 'message' });
    await settle();
    expect(store.verdicts['4|en']).toEqual({ kind: 'low-confidence' });

    // Second: a transport failure → NO cache entry, so a later request retries.
    const failing = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', failing);
    store.request({ id: 5, text: 'another real message here', type: 'message' });
    await settle();
    expect(store.verdicts['5|en']).toBeUndefined();

    // Translator comes back: the SAME message now succeeds retroactively.
    vi.stubGlobal(
      'fetch',
      fetchOk({
        translatedText: 'hello again',
        detectedLanguage: { language: 'fr', confidence: 95 },
      }),
    );
    store.request({ id: 5, text: 'another real message here', type: 'message' });
    await settle();
    expect(store.verdicts['5|en']).toEqual({
      kind: 'translated',
      text: 'hello again',
      srcLang: 'fr',
    });
  });

  it('rule 6 — toggling reading off invalidates cached overlays', async () => {
    const store = await makeStore();
    vi.stubGlobal(
      'fetch',
      fetchOk({ translatedText: 'hi', detectedLanguage: { language: 'es', confidence: 90 } }),
    );
    store.request({ id: 6, text: 'hola a todos amigos', type: 'message' });
    await settle();
    expect(store.verdicts['6|en']).toBeTruthy();
    store.setReading(1, false);
    expect(Object.keys(store.verdicts)).toHaveLength(0);
  });

  it('rule 11 — a request is store-owned: nothing a row does can cancel it', async () => {
    const store = await makeStore();
    let resolveFetch!: (v: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolveFetch = r;
        }),
      ),
    );
    // A "row" asks, then unmounts (rows hold no handle to cancel — the API
    // simply offers none). The request must still land.
    store.request({ id: 7, text: 'une phrase complète ici', type: 'message' });
    await new Promise((r) => setTimeout(r, 10));
    resolveFetch({
      ok: true,
      json: () =>
        Promise.resolve({
          translatedText: 'a full sentence here',
          detectedLanguage: { language: 'fr', confidence: 92 },
        }),
    });
    await settle();
    expect(store.verdicts['7|en']?.kind).toBe('translated');
  });

  it('rule 9 — outgoing translation applies no confidence gate', async () => {
    const store = await makeStore();
    // A response with abysmal detection confidence must still return the
    // translation: the user chose the target language explicitly.
    vi.stubGlobal(
      'fetch',
      fetchOk({
        translatedText: 'hola mundo',
        detectedLanguage: { language: 'en', confidence: 5 },
      }),
    );
    await expect(store.translateOutgoing('hello world')).resolves.toBe('hola mundo');
  });

  it('rule 4 at the store — unchanged results verdict as unchanged, no overlay', async () => {
    const store = await makeStore();
    vi.stubGlobal(
      'fetch',
      fetchOk({
        translatedText: 'already english',
        detectedLanguage: { language: 'en', confidence: 99 },
      }),
    );
    store.request({ id: 8, text: 'already english', type: 'message' });
    await settle();
    expect(store.verdicts['8|en']).toEqual({ kind: 'unchanged' });
    store.setReading(9, true);
    expect(store.overlayFor(9, 8)).toBeNull();
  });

  it('rule 2 at the store — noise verdicts as skipped without a network call', async () => {
    const store = await makeStore();
    const f = fetchOk({});
    vi.stubGlobal('fetch', f);
    store.request({ id: 9, text: 'lol', type: 'message' });
    await settle();
    expect(f).not.toHaveBeenCalled();
    expect(store.verdicts['9|en']).toEqual({ kind: 'skipped' });
  });
});
