// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The two translator clients. DEVICE-LOCAL by design: these fetches run in the
// user's browser against an endpoint the user configured — the Lurker server
// never sees the text or the credentials. That is what makes a local-network
// translator (Ollama, LM Studio, self-hosted LibreTranslate) work at all, and
// it is why the endpoint must speak CORS to the Lurker origin (stated in the
// setting's description, because it is the #1 "nothing happens" cause).
//
// Both functions THROW on transport/HTTP failure and RETURN a result otherwise.
// The store depends on that split (rule 10): a thrown error is transient and
// must not be cached — the translator may simply be off right now — while a
// returned low-confidence verdict is a property of the text and caches forever.

export interface TranslateResult {
  /** The translated text, verbatim from the backend. */
  text: string;
  /** Detected source language code, or null when the backend can't say
   *  (OpenAI-compatible has no detection API). */
  detectedLang: string | null;
  /** Detection confidence 0–100, or null when unavailable. The caller applies
   *  the rule-3 gate — the backend client just reports. */
  confidence: number | null;
}

export interface TranslateConfig {
  backend: 'libretranslate' | 'openai';
  endpoint: string;
  apiKey: string;
  model: string;
  targetLang: string;
}

/** One knob for both backends; a hung translator must not pin a message row's
 *  overlay on "translating…" forever. */
const TIMEOUT_MS = 20_000;

async function post(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Include the status in the thrown message — it is the difference between
    // "wrong API key" (401), "wrong endpoint" (404) and "translator down"
    // (5xx) when the posting flow surfaces a failure (rule 7).
    throw new Error(`translator returned ${res.status}`);
  }
  return res.json();
}

/**
 * LibreTranslate: POST {endpoint}/translate. Free and self-hostable; known weak
 * on CJK (drops register and grammatical person — proposal, Known
 * Limitations). Detection rides along in the same response.
 */
async function libretranslate(cfg: TranslateConfig, text: string): Promise<TranslateResult> {
  const base = cfg.endpoint.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    q: text,
    source: 'auto',
    target: cfg.targetLang,
    format: 'text',
  };
  if (cfg.apiKey) body.api_key = cfg.apiKey;
  const json = (await post(`${base}/translate`, body, {})) as {
    translatedText?: string;
    detectedLanguage?: { language?: string; confidence?: number };
  };
  if (typeof json.translatedText !== 'string') throw new Error('translator returned no text');
  return {
    text: json.translatedText,
    detectedLang: json.detectedLanguage?.language ?? null,
    confidence: json.detectedLanguage?.confidence ?? null,
  };
}

/** Append /v1 only when absent — an endpoint pasted WITH /v1 must not become
 *  /v1/v1 (a confirmed paper-cut from the reference implementations). */
export function openAiBase(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

/**
 * OpenAI-compatible chat completion (Ollama, LM Studio, cloud gateways). No
 * detection API, so detectedLang/confidence are null — the store treats
 * "genuinely changed" (rule 4) as the only signal a translation happened.
 */
async function openai(cfg: TranslateConfig, text: string): Promise<TranslateResult> {
  const headers: Record<string, string> = {};
  // Bearer only when a key is configured: a local Ollama rejects nothing, but
  // sending "Bearer " with an empty key trips some gateways' auth parsing.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const json = (await post(
    `${openAiBase(cfg.endpoint)}/chat/completions`,
    {
      model: cfg.model,
      messages: [
        {
          role: 'system',
          // The proposal's prompt, verbatim. "Output ONLY the translation" is
          // load-bearing: chat models love to add quotes and commentary, and
          // either one would badge every message as changed (rule 4).
          content:
            `You are a translator for a live chat. Translate each message into ` +
            `${cfg.targetLang}. Output ONLY the translation—no commentary, no quotes.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0,
    },
    headers,
  )) as { choices?: Array<{ message?: { content?: string } }> };
  const out = json.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error('translator returned no text');
  return { text: out.trim(), detectedLang: null, confidence: null };
}

/** Translate `text` with whichever backend is configured. Throws on transport
 *  failure (transient — do not cache); returns on success (cacheable). */
export function translate(cfg: TranslateConfig, text: string): Promise<TranslateResult> {
  return cfg.backend === 'libretranslate' ? libretranslate(cfg, text) : openai(cfg, text);
}
