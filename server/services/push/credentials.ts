// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Native push credentials (#490).
//
// These follow the LURKER_SECRET_KEY precedent, not the VAPID one. VAPID's model
// — auto-generate on first use, store plaintext in app_meta — is wrong here: an
// APNs .p8 and an FCM service account are issued by Apple and Google, cannot be
// generated, and are per-APP-BUNDLE rather than per-user. On hosted they're a
// fleet-wide secret injected by the orchestrator, exactly like LURKER_SECRET_KEY.
//
// Unset is NORMAL, not an error: a self-hosted server has no reason to hold the
// first-party app's signing key, and Web Push still works for it. Set-but-broken
// is an error, and fails loud at boot rather than as a mystery 403 on the first
// push six hours later.
//
// Why a self-hoster cannot simply supply their own: an APNs key only signs for
// the bundle ID it was issued to, and an FCM token is scoped to the Firebase
// project baked into the APK (a mismatch returns MismatchSenderId). So these
// credentials only ever push to OUR builds. See the #490 discussion.

/**
 * Accept either base64 or the raw value. Base64 is what an env var can carry
 * without newline mangling (a PEM is multi-line, and `docker run -e` will not
 * preserve it); the raw form is what a human pastes into a compose file with a
 * heredoc. The discriminator is the value's own syntax, so neither is guessed.
 */
function decodeMaybeBase64(raw: string, rawPrefix: string, envName: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith(rawPrefix)) return trimmed;
  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    throw new Error(`${envName} is neither valid base64 nor a value starting with ${rawPrefix}`);
  }
  if (!decoded.trim().startsWith(rawPrefix)) {
    throw new Error(
      `${envName} must be a value starting with ${rawPrefix}, or that value base64-encoded ` +
        `(decoded to something starting with ${JSON.stringify(decoded.slice(0, 12))})`,
    );
  }
  return decoded.trim();
}

export interface ApnsCredentials {
  /** The .p8 private key, PEM-encoded. */
  keyPem: string;
  /** Apple's key identifier for that .p8 (the `kid` claim). */
  keyId: string;
  /** The Apple developer team id (the `iss` claim). */
  teamId: string;
  /** The app's bundle id — APNs' `apns-topic`. */
  bundleId: string;
  /** Sandbox routes to Apple's development gateway; TestFlight/dev builds need it. */
  sandbox: boolean;
}

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
}

let apnsCache: ApnsCredentials | null | undefined;
let fcmCache: FcmCredentials | null | undefined;

/** Test-only: forget parsed credentials so a test can re-read a changed env. */
export function resetCredentialCache(): void {
  apnsCache = undefined;
  fcmCache = undefined;
}

/** Parsed APNs credentials, or null when unconfigured. Throws when misconfigured. */
export function apnsCredentials(): ApnsCredentials | null {
  if (apnsCache !== undefined) return apnsCache;
  const key = process.env.LURKER_APNS_KEY;
  const keyId = process.env.LURKER_APNS_KEY_ID;
  const teamId = process.env.LURKER_APNS_TEAM_ID;
  const bundleId = process.env.LURKER_APNS_BUNDLE_ID;
  if (!key && !keyId && !teamId && !bundleId) {
    apnsCache = null;
    return null;
  }
  // Partially set is a mistake, not a choice — say which piece is missing rather
  // than silently disabling push for every iOS device.
  const missing = [
    !key && 'LURKER_APNS_KEY',
    !keyId && 'LURKER_APNS_KEY_ID',
    !teamId && 'LURKER_APNS_TEAM_ID',
    !bundleId && 'LURKER_APNS_BUNDLE_ID',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`APNs push is partially configured; missing: ${missing.join(', ')}`);
  }
  apnsCache = {
    keyPem: decodeMaybeBase64(key as string, '-----BEGIN', 'LURKER_APNS_KEY'),
    keyId: (keyId as string).trim(),
    teamId: (teamId as string).trim(),
    bundleId: (bundleId as string).trim(),
    sandbox: /^(1|true|yes|sandbox)$/i.test(process.env.LURKER_APNS_SANDBOX || ''),
  };
  return apnsCache;
}

/** Parsed FCM credentials, or null when unconfigured. Throws when misconfigured. */
export function fcmCredentials(): FcmCredentials | null {
  if (fcmCache !== undefined) return fcmCache;
  const raw = process.env.LURKER_FCM_SERVICE_ACCOUNT;
  if (!raw) {
    fcmCache = null;
    return null;
  }
  const json = decodeMaybeBase64(raw, '{', 'LURKER_FCM_SERVICE_ACCOUNT');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`LURKER_FCM_SERVICE_ACCOUNT is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const projectId = parsed.project_id;
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    throw new Error(
      'LURKER_FCM_SERVICE_ACCOUNT must be a Google service-account JSON with ' +
        'project_id, client_email and private_key',
    );
  }
  fcmCache = {
    projectId,
    clientEmail,
    // Google's JSON carries the PEM with literal \n escapes. Anything that has
    // round-tripped through an env var or a YAML string may too, so unescape
    // rather than hand crypto a key it will reject as malformed.
    privateKeyPem: privateKey.replace(/\\n/g, '\n'),
  };
  return fcmCache;
}
