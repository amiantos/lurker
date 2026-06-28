// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Centralized client-identification strings so Lurker shows up as itself when
// it talks to the outside world — image hosts in HTTP User-Agent, IRC peers
// via CTCP VERSION. Admins can override the contact portion with the
// USER_AGENT_CONTACT env var so a service operator who wants to flag a
// misbehaving Lurker can reach the deployment's owner instead of the upstream
// project.

import { readFileSync } from 'fs';
import { join } from 'path';

interface PackageJson {
  version: string;
}

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
) as PackageJson;

const DEFAULT_CONTACT = 'https://github.com/amiantos/lurker';
const contact = (process.env.USER_AGENT_CONTACT || DEFAULT_CONTACT).trim();

export const APP_NAME = 'Lurker';
export const APP_VERSION: string = pkg.version;

// Used as the HTTP User-Agent header on outbound requests to upload providers
// and any future external service. Format follows the conventional
// `Name/Version (+contact)` shape that's friendly to log scanners.
export const USER_AGENT: string = contact
  ? `${APP_NAME}/${APP_VERSION} (+${contact})`
  : `${APP_NAME}/${APP_VERSION}`;

// (The CTCP VERSION reply is no longer built here — it's a user-configurable
// template, `ctcp.version` in the settings registry, defaulting to
// `${name} ${version}`. See server/services/ctcp.ts.)
