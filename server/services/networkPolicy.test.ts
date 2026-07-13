// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../test-utils/testApp.js';

const ctx = setupTestDb('services-network-policy');

// Everything that touches the DB is imported lazily: a static import would
// evaluate db/index.js while the module graph loads, i.e. before setupTestDb has
// pointed DATABASE_PATH at an isolated file — and that refuses to open at all.
type Mods = {
  isNetworkHostAllowed: (host: string) => boolean;
  createInstanceNetwork: typeof import('../db/instanceNetworks.js').createInstanceNetwork;
  updateInstanceNetwork: typeof import('../db/instanceNetworks.js').updateInstanceNetwork;
  setAllowUserDefinedNetworks: (allow: boolean) => void;
  db: typeof import('../db/index.js').default;
};
let m: Mods;

beforeAll(async () => {
  m = {
    isNetworkHostAllowed: (await import('./networkPolicy.js')).isNetworkHostAllowed,
    createInstanceNetwork: (await import('../db/instanceNetworks.js')).createInstanceNetwork,
    updateInstanceNetwork: (await import('../db/instanceNetworks.js')).updateInstanceNetwork,
    setAllowUserDefinedNetworks: (await import('../db/instanceSettings.js'))
      .setAllowUserDefinedNetworks,
    db: (await import('../db/index.js')).default,
  };
});

afterAll(() => ctx.cleanup());

beforeEach(() => {
  m.db.prepare('DELETE FROM instance_network').run();
  m.setAllowUserDefinedNetworks(true);
});

describe('isNetworkHostAllowed', () => {
  // The default, and the one that matters most: an instance nobody has locked
  // down must not start refusing connections because this code now exists.
  it('allows anything while user-defined networks are permitted', () => {
    expect(m.isNetworkHostAllowed('irc.libera.chat')).toBe(true);
    expect(m.isNetworkHostAllowed('irc.anything-at-all.example')).toBe(true);
  });

  it('allows a listed host once locked down', () => {
    m.createInstanceNetwork({ name: 'Corp', host: 'irc.corp.example' });
    m.setAllowUserDefinedNetworks(false);
    expect(m.isNetworkHostAllowed('irc.corp.example')).toBe(true);
  });

  it('refuses an unlisted host once locked down', () => {
    m.createInstanceNetwork({ name: 'Corp', host: 'irc.corp.example' });
    m.setAllowUserDefinedNetworks(false);
    expect(m.isNetworkHostAllowed('irc.libera.chat')).toBe(false);
  });

  it('matches hosts case-insensitively, as DNS does', () => {
    m.createInstanceNetwork({ name: 'Corp', host: 'IRC.Corp.Example' });
    m.setAllowUserDefinedNetworks(false);
    expect(m.isNetworkHostAllowed('irc.corp.example')).toBe(true);
    expect(m.isNetworkHostAllowed('  IRC.CORP.EXAMPLE  ')).toBe(true);
  });

  // The allowed set is what's *offered*, so a preset the admin switched off has
  // to stop authorizing connections too — otherwise "stop offering this" would
  // quietly mean "hide it, but keep letting people connect to it".
  it('does not count a disabled preset', () => {
    const preset = m.createInstanceNetwork({ name: 'Corp', host: 'irc.corp.example' });
    m.setAllowUserDefinedNetworks(false);
    expect(m.isNetworkHostAllowed('irc.corp.example')).toBe(true);

    m.updateInstanceNetwork(preset.id, { enabled: false });

    expect(m.isNetworkHostAllowed('irc.corp.example')).toBe(false);
  });

  it('refuses an empty host rather than defaulting it open', () => {
    m.createInstanceNetwork({ name: 'Corp', host: 'irc.corp.example' });
    m.setAllowUserDefinedNetworks(false);
    expect(m.isNetworkHostAllowed('')).toBe(false);
    expect(m.isNetworkHostAllowed('   ')).toBe(false);
  });
});
