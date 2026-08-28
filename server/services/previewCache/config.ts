// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// How the preview byte cache is configured, and the one place that decides
// whether it is on at all.
//
// ⚠ ENV, not instance settings, and that is a deliberate deviation from #681.
// That issue asks for `previews.cache.mode` in `instance_settings` with an admin
// form beside the uploader config, which is the right long-term surface. Every
// other operator-level knob this app has — LURKER_PREVIEWS_URL,
// LURKER_SECRET_KEY, DATABASE_PATH — is already an env var, so this matches what
// a self-hoster is already doing. `resolveCacheConfig` is the seam the admin
// surface slots into; nothing above this module knows where the values came from.
//
// ⚠ "It would need somewhere to keep a secret" is NOT one of the reasons, and is
// worth naming so nobody adds it: `uploader_config` already stores S3 credentials
// encrypted behind a generic admin form, and `local` has no secret at all. The
// reason is the one above — this knob's neighbours are env vars.

import crypto from 'crypto';
import path from 'path';
import { resolveDataDir } from '../../utils/dataDir.js';
import { sanitizeSegment } from '../uploadProviders/s3.js';

export type CacheMode = 'off' | 'local' | 's3' | 'dropper';

export interface LocalCacheConfig {
  mode: 'local';
  dir: string;
  /** Ceiling for the cache directory. Eviction runs BEFORE a write that would exceed it. */
  maxBytes: number;
}

export interface S3CacheConfig {
  mode: 's3';
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where readers are sent. Public by construction — that is the point of the mode. */
  publicBaseUrl: string;
  /** Already sanitised and slash-trimmed; may be empty. */
  prefix: string;
  /**
   * Where bytes are staged on their way to the bucket.
   *
   * ⚠ A file, not a heap buffer, and not optional. SigV4 must hash the payload
   * before it can sign, so the bytes are read twice — and the route streams them
   * in chunk by chunk. Collecting them in memory would cost the per-request 8 MB
   * image ceiling times `mediaPool`'s 24 slots, and worse, an un-awaited store
   * outlives its pool slot, so nothing bounds how many accumulate. Same reasoning
   * as `local`'s writer, which this reuses.
   */
  stagingDir: string;
}

/**
 * The hosted backend: the operator-run dropper service stores the bytes in the
 * fleet's bucket and the CDN serves them. This mode exists because hosted cells
 * deliberately hold NO bucket credentials (CP #63) — the dropper is the only
 * thing that writes to R2, cells only hold an upload key for it.
 */
export interface DropperCacheConfig {
  mode: 'dropper';
  /** The dropper service base, e.g. `http://10.0.0.2:8025`. May be plain http —
   *  this URL is dialled over the fleet's private VPC, never by a browser. */
  url: string;
  /** Bearer key for POST /api/previews — the same upload key the cell already
   *  presents to POST /api/upload. Never a delete-capable key, by design. */
  apiKey: string;
  /**
   * Where readers are sent, INCLUDING the `/previews` prefix — e.g.
   * `https://cdn.lurker.chat/previews`. The dropper always stores previews at
   * the literal `previews/<key>` (its KEY_PREFIX deliberately does not apply),
   * and the cell mints `${base}/${key}` as a pure function of config — a
   * disagreement is caught at store time, when the dropper's answered URL is
   * compared against the mint (see dropper.ts).
   */
  publicBaseUrl: string;
  /** Where bytes are staged before the multipart POST. Same reasoning as the s3
   *  mode's staging file: the POST needs an exact Content-Length up front. */
  stagingDir: string;
}

export type CacheConfig = { mode: 'off' } | LocalCacheConfig | S3CacheConfig | DropperCacheConfig;

/** 2 GiB. Big enough that a normal instance never evicts, small enough to notice. */
const DEFAULT_LOCAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * ⚠ Misconfiguration resolves to `off`, and says so once, rather than throwing.
 *
 * This is a cache. A bad value is a reason to stop caching, never a reason for a
 * server not to boot or for a link preview to stop rendering — the uncached path
 * is a complete, working feature, which is what makes failing soft right here and
 * wrong for, say, a database path.
 */
export function resolveCacheConfig(warn: (msg: string) => void = defaultWarn): CacheConfig {
  const mode = env('LURKER_PREVIEW_CACHE_MODE').toLowerCase();
  if (mode === '' || mode === 'off') return { mode: 'off' };

  if (mode === 'local') {
    const raw = env('LURKER_PREVIEW_CACHE_MAX_BYTES');
    // ⚠ Digits only, and a SAFE integer. `parseInt` would take '2GB' and hand back
    // 2 — a two-byte cache that evicts everything it stores and reads as "caching
    // is broken". The upper bound matters for the same reason in the other
    // direction: past MAX_SAFE_INTEGER the eviction arithmetic stops being exact,
    // and a silently wrong answer about whether we are over the ceiling is worse
    // than refusing the value.
    const parsed = /^\d{1,19}$/.test(raw) ? Number(raw) : Number.NaN;
    const usable = Number.isSafeInteger(parsed) && parsed > 0;
    if (raw !== '' && !usable) {
      warn(
        `[preview-cache] LURKER_PREVIEW_CACHE_MAX_BYTES="${raw}" is not a usable byte count — ` +
          `falling back to ${DEFAULT_LOCAL_MAX_BYTES}.`,
      );
    }
    return {
      mode: 'local',
      dir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
      maxBytes: usable ? parsed : DEFAULT_LOCAL_MAX_BYTES,
    };
  }

  if (mode === 's3') return resolveS3(warn);
  if (mode === 'dropper') return resolveDropper(warn);

  warn(`[preview-cache] unknown LURKER_PREVIEW_CACHE_MODE "${mode}" — caching is OFF.`);
  return { mode: 'off' };
}

/**
 * The bucket backend.
 *
 * ⚠⚠ Unlike `local`, the objects this writes are read DIRECTLY by browsers — the
 * descriptor hands out `publicBaseUrl` rather than a proxy path once an object is
 * known to exist. That is what makes the mode worth having (the cell ships zero
 * bytes for a cached image) and it is also why every field below is validated
 * rather than merely read: a half-configured bucket here does not degrade to slow,
 * it degrades to a public URL that 404s for everyone.
 */
function resolveS3(warn: (msg: string) => void): CacheConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env(name);
    if (!value) missing.push(name);
    return value;
  };
  const endpoint = required('LURKER_PREVIEW_CACHE_S3_ENDPOINT');
  const bucket = required('LURKER_PREVIEW_CACHE_S3_BUCKET');
  const accessKeyId = required('LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID');
  const secretAccessKey = required('LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY');
  const publicBaseUrl = required('LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL');

  if (missing.length) {
    warn(`[preview-cache] mode "s3" needs ${missing.join(', ')} — caching is OFF.`);
    return { mode: 'off' };
  }

  if (!validHttpsBase(publicBaseUrl, 'LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL', warn)) {
    return { mode: 'off' };
  }

  // ⚠ SANITISED, per segment, with the uploader's own function. An operator's
  // prefix reaches `new URL()` and an S3 key; left raw, a '#' in it truncates the
  // signed URL at the fragment so EVERY object PUTs to one key and one person's
  // picture serves under another's. The alphabet is the same URL-unreserved set
  // the uploader's keys use, which is what lets both sides skip percent-encoding
  // and sidesteps the classic SigV4 encoding mismatch.
  const prefix = env('LURKER_PREVIEW_CACHE_S3_PREFIX')
    .split('/')
    .map(sanitizeSegment)
    .filter((part) => part && !/^\.+$/.test(part))
    .join('/');

  return {
    mode: 's3',
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    // R2 wants literally "auto"; MinIO accepts any region. Matches the uploader.
    region: env('LURKER_PREVIEW_CACHE_S3_REGION') || 'auto',
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    prefix,
    stagingDir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
  };
}

/**
 * The hosted backend. Same validation posture as `resolveS3`, and for the same
 * reason: `publicBaseUrl` is handed to browsers as an image source, so a
 * half-configured mode degrades to a public URL that 404s for everyone, not to
 * slow. The one deliberate difference: `url` (the dropper service itself) may be
 * plain http — it is dialled over the fleet's private VPC, never by a browser,
 * and the fleet's provisioning genuinely uses `http://<vpc-ip>:8025`.
 */
function resolveDropper(warn: (msg: string) => void): CacheConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env(name);
    if (!value) missing.push(name);
    return value;
  };
  const url = required('LURKER_PREVIEW_CACHE_DROPPER_URL');
  const apiKey = required('LURKER_PREVIEW_CACHE_DROPPER_API_KEY');
  const publicBaseUrl = required('LURKER_PREVIEW_CACHE_DROPPER_PUBLIC_BASE_URL');

  if (missing.length) {
    warn(`[preview-cache] mode "dropper" needs ${missing.join(', ')} — caching is OFF.`);
    return { mode: 'off' };
  }

  // ⚠ Warnings name the FULL env var, so the log line an operator greps for is
  // the line in their env file.
  let service: URL;
  try {
    service = new URL(url);
  } catch {
    warn(
      `[preview-cache] LURKER_PREVIEW_CACHE_DROPPER_URL "${url}" is not a URL — caching is OFF.`,
    );
    return { mode: 'off' };
  }
  if (service.protocol !== 'https:' && service.protocol !== 'http:') {
    warn(
      `[preview-cache] LURKER_PREVIEW_CACHE_DROPPER_URL must be http(s) (got "${service.protocol}") — caching is OFF.`,
    );
    return { mode: 'off' };
  }
  // ⚠ Scheme://host[:port] ONLY. The backend appends `/api/previews` itself, so
  // an operator who pastes the full endpoint (a natural misread of "the dropper
  // URL") would have every store POST to /api/previews/api/previews and fail —
  // for the life of the process, surfaced only as one throttled warning a
  // minute. That is exactly the working-looking-but-broken state this
  // validation exists to catch at boot instead.
  if ((service.pathname !== '/' && service.pathname !== '') || service.search || service.hash) {
    warn(
      `[preview-cache] LURKER_PREVIEW_CACHE_DROPPER_URL must have no path, query or fragment ` +
        `(got "${url}") — the /api/previews path is appended automatically. Caching is OFF.`,
    );
    return { mode: 'off' };
  }

  if (!validHttpsBase(publicBaseUrl, 'LURKER_PREVIEW_CACHE_DROPPER_PUBLIC_BASE_URL', warn)) {
    return { mode: 'off' };
  }

  return {
    mode: 'dropper',
    url: url.replace(/\/+$/, ''),
    apiKey,
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ''),
    stagingDir: env('LURKER_PREVIEW_CACHE_DIR') || path.join(resolveDataDir(), 'preview-cache'),
  };
}

/**
 * ⚠⚠ https, not merely a valid URL — shared by every remote mode's PUBLIC base,
 * because the rationale is identical: these URLs are handed to browsers as image
 * sources on a page served over https, where an http:// image is blocked as
 * mixed content and simply never renders. Refusing here makes that one warning
 * at boot instead of every cached preview silently going blank.
 */
function validHttpsBase(raw: string, label: string, warn: (msg: string) => void): boolean {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    warn(`[preview-cache] ${label} "${raw}" is not a URL — caching is OFF.`);
    return false;
  }
  if (base.protocol !== 'https:') {
    warn(`[preview-cache] ${label} must be https (got "${base.protocol}") — caching is OFF.`);
    return false;
  }
  return true;
}

function defaultWarn(msg: string): void {
  console.warn(msg);
}

/**
 * The bucket lifecycle rule this cache is designed against, in days.
 *
 * ⚠ Documented here because `MAX_AGE_MS` is only meaningful RELATIVE to it, and the
 * cell can neither run the rule nor observe it. Hosted sets 30 days on the `previews/`
 * prefix (LINK_PREVIEWS_CACHE_PLAN.md); a self-hoster's `s3` bucket is their own to
 * configure, and .env.example says so.
 */
const LIFECYCLE_DAYS = 30;

/**
 * How long a cached object may be served before it is re-fetched.
 *
 * ⚠⚠ A CORRECTNESS bound first and a freshness one second, and the correctness half
 * is what fixes the number. Objects in a bucket are deleted by a lifecycle rule the
 * cell does not run and cannot observe, and a row outliving its object would have
 * `publicByteUrl` mint a public URL that 404s for every user — fetched by the browser
 * directly, so the 404 never reaches us to notice. Staying strictly under
 * `LIFECYCLE_DAYS` is what makes the row provably the shorter-lived of the two.
 *
 * ⚠⚠ NO LONGER TIED TO `link_previews`' OK_TTL, and the coupling was the mistake. The
 * two answer different questions: OK_TTL governs a page's TITLE, which genuinely
 * changes, while this governs IMAGE BYTES, which at the content-addressed URLs most
 * og:images use cannot change at all. Matching them meant every image was re-fetched
 * from its origin every seven days for no reason — measured on app.lurker.chat as a
 * byte-identical re-upload of a GitHub og:image, same ETag, 18 days on — and when the
 * origin refused that re-fetch the card broke (lurker#776). Five days of margin under
 * the lifecycle rule is plenty for a clock skew and a sweep interval.
 *
 * ⚠ The freshness half survives, and it is enforced on the OBJECT rather than only on
 * the row: an image that changed at a stable address — an avatar, a `latest.png` — is
 * bounded by this figure whether or not the index still remembers it. See `lookup`.
 */
export const MAX_AGE_MS = (LIFECYCLE_DAYS - 5) * 24 * 60 * 60 * 1000;

/** Past the age bound, and therefore not to be served or minted. */
export function expired(createdAt: string): boolean {
  return Date.now() - Date.parse(createdAt) > MAX_AGE_MS;
}

/**
 * The cache key for one URL's BYTES.
 *
 * ⚠⚠ Its own digest, deliberately NOT `db/linkPreviews.ts`'s `urlHash`. That one
 * folds in `RESOLVER_VERSION`, a counter whose entire job is to invalidate
 * METADATA when the resolver would produce a different record — it has already
 * been bumped for a WebP/GIF *dimension* change, and its docblock actively invites
 * more. Sharing it would mean a routine metadata bump silently discards every
 * cached byte on the instance and re-fetches every image at once, from a diff that
 * never mentions this module and a reviewer who has no reason to look here. The
 * identity of a cached picture is its URL, and nothing else.
 *
 * ⚠ Canonicalised the way `urlHash` does — fragment stripped — so `#a` and `#b` of
 * one image share an object rather than being fetched and stored twice.
 */
/**
 * Cache key for a STORED POSTER FRAME — bytes this instance decoded itself, which
 * therefore have NO origin URL to fall back to. Kept alongside `byteCacheKey` so the
 * two key spaces visibly cannot collide (distinct version prefixes), and derived from
 * the MEDIA's URL so a re-resolve of the same clip lands on the same object.
 */
/** The shape `posterCacheKey` mints. Exported so the descriptor mint, the token verifier and
 *  any future caller share ONE definition of "is this a poster key" rather than each carrying
 *  a copy of the regex that has to agree with this function by hand. */
export function isPosterKey(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function posterCacheKey(url: string): string {
  let key: string;
  try {
    const canonical = new URL(url);
    canonical.hash = '';
    key = canonical.toString();
  } catch {
    key = url.replace(/#[\s\S]*$/, '');
  }
  return crypto.createHash('sha256').update(`poster-v1|${key}`).digest('hex');
}

export function byteCacheKey(url: string): string {
  let key: string;
  try {
    const canonical = new URL(url);
    canonical.hash = '';
    key = canonical.toString();
  } catch {
    key = url.replace(/#[\s\S]*$/, '');
  }
  return crypto.createHash('sha256').update(`bytes-v1|${key}`).digest('hex');
}

/**
 * ⚠ Resolved ONCE per process, not per request.
 *
 * The config comes from the environment, which cannot change under a running
 * process, and re-reading it per byte request would re-run the validation — and
 * re-log its warnings — on the hottest path this feature has.
 */
let memoised: CacheConfig | null = null;

export function cacheConfig(): CacheConfig {
  memoised ??= resolveCacheConfig();
  return memoised;
}

/** Test seam: drop the memoised config so the next call re-reads the environment. */
export function resetCacheConfigForTests(): void {
  memoised = null;
}

export function cacheEnabled(): boolean {
  return cacheConfig().mode !== 'off';
}
