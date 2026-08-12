// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Live message translation. DEVICE-LOCAL: the browser calls the translator the
// user configured (chat.translate.* settings); the Lurker server is never in
// the path and never learns which messages were translated. Translation is a
// RENDER-TIME OVERLAY — the stored message text is never modified, so links,
// media, highlights and search all keep scanning the original (rule 5 is
// satisfied structurally, not by discipline at every call site).
//
// ⚠ REQUESTS ARE SCOPED TO THIS STORE, NOT TO MESSAGE ROWS (rule 11). The
// message list is virtualized: rows unmount as they scroll away, and a request
// owned by a row would be cancelled mid-flight — in the reference Android
// client that left cache entries pinned "in flight" forever, permanently
// breaking those messages. Here a row merely *asks*; the fetch and the cache
// entry belong to the store and outlive any row.
//
// Cache verdicts vs transient failures (rule 10): a low-confidence detection is
// a property of the TEXT and caches permanently — retrying it would produce
// the same wrong guess with the same wrong translation. A network/HTTP failure
// is a property of the MOMENT and is deliberately NOT cached, so a translator
// that comes online later works retroactively as rows re-request.
//
// E2E POLICY (explicit, per the proposal — silence here would be indefensible):
// messages that rode the wire encrypted (msg.e2e, RPE2E #382) are NEVER sent to
// a translator, even a local one. The sender chose end-to-end encryption;
// shipping their plaintext to any third endpoint — however trusted by the
// *reader* — breaks a promise the reader can't waive on the sender's behalf.
// There is no opt-in for this. The overlay for such messages simply never
// exists.

import { defineStore } from 'pinia';
import { useSettingsStore } from './settings.js';
import { translate, type TranslateConfig } from '../lib/translate/backends.js';
import {
  isNoise,
  genuinelyChanged,
  passesConfidenceGate,
  stripUrls,
} from '../lib/translate/rules.js';

/** A cached, final verdict for one (message, target-language). */
export type Verdict =
  | { kind: 'translated'; text: string; srcLang: string | null }
  // Rule 4: the backend answered but nothing genuinely changed — no badge, no
  // overlay. Cached so the message is never re-sent.
  | { kind: 'unchanged' }
  // Rule 3+10: detection below the gate. A permanent negative — see header.
  | { kind: 'low-confidence' }
  // Rule 2: never sent at all (noise/URL-only). Cached to keep the skip free.
  | { kind: 'skipped' };

function cacheKey(msgId: number, targetLang: string): string {
  return `${msgId}|${targetLang}`;
}

// Device-local persistence for the per-conversation switches. localStorage, not
// server settings, deliberately: which conversations you translate is as
// private as the messages themselves, and the whole feature is premised on the
// server never learning either. Keyed by bufferId (stable across renames,
// #744-style) — an optimistic buffer with no id yet simply can't be toggled,
// which is fine: it has no history to translate either.
const LS_KEY = 'lurker:translate:buffers';

interface BufferPrefs {
  /** Translate incoming messages in this conversation. */
  read?: boolean;
  /** Translate outgoing messages before sending (with approval). */
  post?: boolean;
}

function loadPrefs(): Record<string, BufferPrefs> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, BufferPrefs>) : {};
  } catch {
    return {};
  }
}

/** How many fetches may be in flight at once. Translators are usually local
 *  and fast, but a cold Ollama model load can take seconds — an unbounded
 *  burst on first render of a busy channel would queue-bomb it. */
const MAX_IN_FLIGHT = 3;

export const useTranslateStore = defineStore('translate', {
  state: () => ({
    /** cacheKey → final verdict. Reactive so overlays appear as results land. */
    verdicts: {} as Record<string, Verdict>,
    /** cacheKey set for requests currently on the wire — dedupe, not ownership. */
    inFlight: {} as Record<string, true>,
    /** bufferId(string) → per-conversation switches. */
    prefs: loadPrefs() as Record<string, BufferPrefs>,
    /** FIFO of pending cache keys + their fetch thunks (bounded concurrency). */
    queueDepth: 0,
  }),

  getters: {
    /** The whole feature exists only when a backend is configured. Off hides
     *  every toggle and overlay — a switch that does nothing is worse than no
     *  switch (same doctrine as requiresFeature in the registry). */
    enabled(): boolean {
      const s = useSettingsStore();
      return s.effective('chat.translate.backend') !== 'off';
    },

    config(): TranslateConfig | null {
      const s = useSettingsStore();
      const backend = s.effective('chat.translate.backend') as string;
      if (backend !== 'libretranslate' && backend !== 'openai') return null;
      const endpoint = String(s.effective('chat.translate.endpoint') ?? '').trim();
      if (!endpoint) return null;
      return {
        backend,
        endpoint,
        apiKey: String(s.effective('chat.translate.api_key') ?? ''),
        model: String(s.effective('chat.translate.model') ?? ''),
        targetLang: String(s.effective('chat.translate.target_lang') ?? 'en'),
      };
    },

    readingEnabled(state) {
      return (bufferId: number | null | undefined): boolean =>
        bufferId != null && state.prefs[String(bufferId)]?.read === true;
    },

    postingEnabled(state) {
      return (bufferId: number | null | undefined): boolean =>
        bufferId != null && state.prefs[String(bufferId)]?.post === true;
    },

    /** The overlay for a rendered row, or null. Null for: feature off, reading
     *  off for the buffer, no verdict yet, or a verdict with nothing to show. */
    overlayFor() {
      return (
        bufferId: number | null | undefined,
        msgId: number | null | undefined,
      ): { text: string; srcLang: string | null } | null => {
        if (msgId == null || !this.enabled || !this.readingEnabled(bufferId)) return null;
        const cfg = this.config;
        if (!cfg) return null;
        const v = this.verdicts[cacheKey(msgId, cfg.targetLang)];
        return v?.kind === 'translated' ? { text: v.text, srcLang: v.srcLang } : null;
      };
    },
  },

  actions: {
    persistPrefs() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.prefs));
      } catch {
        /* storage full/blocked — the toggles just don't survive reload */
      }
    },

    setReading(bufferId: number, on: boolean) {
      const k = String(bufferId);
      this.prefs[k] = { ...this.prefs[k], read: on };
      this.persistPrefs();
      // Rule 6: toggling invalidates. Without this, flipping read off and on
      // (or after changing backend/endpoint) shows stale overlays produced by
      // the previous configuration.
      if (!on) this.invalidate();
    },

    setPosting(bufferId: number, on: boolean) {
      const k = String(bufferId);
      this.prefs[k] = { ...this.prefs[k], post: on };
      this.persistPrefs();
    },

    /** Drop every cached verdict (config change, reading toggled). In-flight
     *  requests are left to land — their results key on the OLD target lang,
     *  so they simply become unreachable rather than wrong. */
    invalidate() {
      this.verdicts = {};
    },

    /**
     * A rendered row asks for its translation. Idempotent and cheap to call on
     * every render: cached, in-flight-deduped, and rule-gated before any
     * network. The request survives the row unmounting (rule 11).
     */
    request(msg: {
      id?: number | null;
      text?: unknown;
      self?: unknown;
      e2e?: unknown;
      type?: string;
    }) {
      if (!this.enabled) return;
      const cfg = this.config;
      if (!cfg) return;
      const msgId = msg.id;
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (msgId == null || !text) return;
      // Only chat-shaped rows: joins/quits/topics are protocol events, not prose.
      if (msg.type !== 'message' && msg.type !== 'action') return;
      // Rule 1: NEVER the user's own messages. Auto-detection on your own text
      // produces false positives ("that's not even the right language") and
      // there is no reader-side value: you wrote it, you can read it.
      if (msg.self === true) return;
      // E2E policy — see the header. Not a setting, not an opt-in.
      if (msg.e2e === true) return;

      const key = cacheKey(msgId, cfg.targetLang);
      if (this.verdicts[key] || this.inFlight[key]) return;

      // Rule 2 + 8: noise never leaves the device. Cached as a verdict so the
      // check runs once per message, not once per render.
      if (isNoise(text)) {
        this.verdicts[key] = { kind: 'skipped' };
        return;
      }

      this.inFlight[key] = true;
      void this.run(key, cfg, text);
    },

    async run(key: string, cfg: TranslateConfig, text: string) {
      // Bounded concurrency: naive spin-wait-free FIFO — each runner defers
      // while MAX_IN_FLIGHT peers are on the wire. Order isn't important
      // (verdicts land keyed), only the bound is.
      while (this.queueDepth >= MAX_IN_FLIGHT) {
        await new Promise((r) => setTimeout(r, 120));
      }
      this.queueDepth++;
      try {
        const res = await translate(cfg, text);
        // Rule 3: gate the DETECTION, not the transport. LibreTranslate reports
        // confidence; OpenAI-compatible reports null, which passes — "changed"
        // (rule 4) is that backend's only signal, by design.
        if (res.confidence != null && !passesConfidenceGate(res.confidence)) {
          // Rule 10: permanent negative — same text would yield the same bad
          // guess. Distinct from the catch below, which caches NOTHING.
          this.verdicts[key] = { kind: 'low-confidence' };
          return;
        }
        // A message that is URLs + text translates as its text; compare against
        // the original with URLs intact so a translator that ate the URL still
        // counts as changed only when the words changed.
        this.verdicts[key] = genuinelyChanged(stripUrls(text), stripUrls(res.text))
          ? { kind: 'translated', text: res.text, srcLang: res.detectedLang }
          : { kind: 'unchanged' };
      } catch {
        // Rule 10: transient — translator down, CORS, timeout. Cache nothing;
        // the next render re-requests, so a translator coming online works
        // retroactively for everything still on screen.
      } finally {
        this.queueDepth--;
        delete this.inFlight[key];
      }
    },

    /**
     * Outgoing path (rule 7): translate what the user typed, for preview.
     * Returns the translation or throws — the caller owns the
     * preview→approve→send workflow and the failure bypass. Rule 9: NO
     * confidence gate here — the user chose the target language explicitly, so
     * detection has no veto.
     */
    async translateOutgoing(text: string, targetLang?: string): Promise<string> {
      const cfg = this.config;
      if (!cfg) throw new Error('no translator configured');
      const res = await translate(targetLang ? { ...cfg, targetLang } : cfg, text);
      return res.text;
    },
  },
});
