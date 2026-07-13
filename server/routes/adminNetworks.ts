// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin CRUD for instance network presets + the network lockdown (#298).
// Modelled on adminUploaders.ts, and mounted under it in admin.ts, so it
// inherits requireAuth + requireAdmin rather than re-declaring them.
//
// Two independent knobs, same as the uploader pane:
//
//   presets            — the networks this instance recommends. They float to
//                        the top of every user's picker, with their recommended
//                        channels pre-checked in the first-run flow.
//   allow_user_defined — the lockdown. When off, users may only connect to the
//                        hosts listed above. Enforced in services/networkPolicy,
//                        which the connect path consults, NOT just hidden in the
//                        UI. Nothing is deleted when it's flipped; off-list
//                        networks stop connecting and say why.
//
// No refuseOnNode() guard here, unlike the uploader routes. Those 409 on the
// hosted edition because the control plane re-derives uploader config from the
// environment on boot and would silently revert a write. Nothing in the control
// plane manages networks — a hosted customer is simply the admin of their own
// cell — so these writes are safe there.

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listInstanceNetworks,
  getInstanceNetwork,
  createInstanceNetwork,
  updateInstanceNetwork,
  deleteInstanceNetwork,
  type InstanceNetworkInput,
} from '../db/instanceNetworks.js';
import { allowUserDefinedNetworks, setAllowUserDefinedNetworks } from '../db/instanceSettings.js';

const router = Router();

function bool(body: unknown, key: string): boolean | undefined {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === 'boolean' ? v : undefined;
}

// Channel names arrive as an array from the pane, but be tolerant of a
// comma-separated string too — it's what the REST API's other channel field
// (default_channel) takes, and an admin poking at this with curl will reach for
// the same shape.
function parseChannels(raw: unknown): string[] | undefined {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : undefined;
  if (!list) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const channel = entry.trim();
    if (!channel) continue;
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(channel);
  }
  return out;
}

// How many presets users could actually connect to. The lockdown is only
// meaningful relative to this count: drop it to zero while locked down and the
// instance has no reachable networks at all — for anyone, admin included. Three
// separate routes can drive it to zero (delete a preset, un-offer a preset, or
// switch the lockdown on with none), so all three consult this.
function usablePresetCount(): number {
  return listInstanceNetworks().filter((p) => p.enabled).length;
}

const STRANDED =
  'that would leave users with no network they are allowed to connect to — allow user-defined networks first, or add another';

// Shared by create and update. Returns an error string rather than throwing so
// both routes answer 400 with the same wording.
function readInput(body: unknown, partial: boolean): InstanceNetworkInput | { error: string } {
  const b = (body || {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : undefined;
  const host = typeof b.host === 'string' ? b.host.trim() : undefined;

  // Required on create — and, when present at all, required to be non-empty on
  // update too. Without the second half, PATCH {host: '   '} would trim to '' and
  // write it, quietly leaving a preset that names no server and (under lockdown)
  // authorizes nothing.
  if (!partial && (!name || !host)) return { error: 'name and host are required' };
  if (name !== undefined && !name) return { error: 'name cannot be empty' };
  if (host !== undefined && !host) return { error: 'host cannot be empty' };

  let port: number | undefined;
  if (b.port !== undefined) {
    port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `invalid port: ${String(b.port)}` };
    }
  }

  const input: InstanceNetworkInput = {} as InstanceNetworkInput;
  if (name !== undefined) input.name = name;
  if (host !== undefined) input.host = host;
  if (port !== undefined) input.port = port;
  const tls = bool(b, 'tls');
  if (tls !== undefined) input.tls = tls;
  const sasl = bool(b, 'saslLikelyRequired');
  if (sasl !== undefined) input.saslLikelyRequired = sasl;
  const enabled = bool(b, 'enabled');
  if (enabled !== undefined) input.enabled = enabled;
  const channels = parseChannels(b.channels);
  if (channels !== undefined) input.channels = channels;
  return input;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({
    presets: listInstanceNetworks(),
    allowUserDefined: allowUserDefinedNetworks(),
  });
});

router.post('/', (req: Request, res: Response) => {
  const input = readInput(req.body, false);
  if ('error' in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  res.status(201).json({ preset: createInstanceNetwork(input) });
});

router.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getInstanceNetwork(id);
  if (!existing) {
    res.status(404).json({ error: 'preset not found' });
    return;
  }
  const input = readInput(req.body, true);
  if ('error' in input) {
    res.status(400).json({ error: input.error });
    return;
  }
  // Un-offering the last usable preset strands the instance exactly as deleting
  // it would — same hole, different door.
  if (
    input.enabled === false &&
    existing.enabled &&
    !allowUserDefinedNetworks() &&
    usablePresetCount() <= 1
  ) {
    res.status(409).json({ error: STRANDED });
    return;
  }
  res.json({ preset: updateInstanceNetwork(id, input) });
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = getInstanceNetwork(id);
  if (!existing) {
    res.status(404).json({ error: 'preset not found' });
    return;
  }
  // Deleting the last usable preset while locked down would strand every user
  // with nothing they're permitted to connect to — including the admin. Refuse,
  // and make them lift the lockdown first; recoverable either way, but a 409
  // beats a silently unusable server.
  if (existing.enabled && !allowUserDefinedNetworks() && usablePresetCount() <= 1) {
    res.status(409).json({ error: STRANDED });
    return;
  }
  deleteInstanceNetwork(id);
  res.json({ ok: true });
});

/** The lockdown switch. */
router.put('/policy', (req: Request, res: Response) => {
  const allow = bool(req.body, 'allowUserDefined');
  if (allow === undefined) {
    res.status(400).json({ error: 'allowUserDefined must be a boolean' });
    return;
  }
  // Locking down with no presets configured would leave every user — the admin
  // included — unable to connect to anything at all. That's never what's meant.
  if (!allow && usablePresetCount() === 0) {
    res.status(409).json({
      error: 'add at least one network before restricting users to the listed ones',
    });
    return;
  }
  setAllowUserDefinedNetworks(allow);
  res.json({ ok: true, allowUserDefined: allow });
});

export default router;
