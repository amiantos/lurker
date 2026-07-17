// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import { composeNotification, type PushPayload } from './notificationContent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SW_PATH = path.resolve(here, '../../vue_client/public/sw.js');

function payload(over: Partial<PushPayload> = {}): PushPayload {
  return {
    kind: 'dm',
    networkId: 7,
    networkName: 'Libera',
    target: 'bob',
    nick: 'bob',
    text: 'hey there',
    ...over,
  };
}

describe('composeNotification', () => {
  it('titles a DM with the sender and network', () => {
    // The target would only repeat the nick, so it's left out.
    expect(composeNotification(payload())).toEqual({
      title: 'bob (Libera)',
      body: 'hey there',
      tag: '7::bob',
    });
  });

  it('titles a channel highlight with the sender and where it happened', () => {
    expect(composeNotification(payload({ kind: 'highlight', target: '#lurker' }))).toMatchObject({
      title: 'bob in #lurker',
      tag: '7::#lurker',
    });
  });

  it('titles a notify_always line the same as a highlight', () => {
    expect(composeNotification(payload({ kind: 'always_notify', target: '#lurker' })).title).toBe(
      'bob in #lurker',
    );
  });

  it('names the identity a friend signed on as when it differs', () => {
    expect(
      composeNotification(
        payload({ kind: 'friend_online', target: 'nostimo', displayName: 'Amiantos', text: null }),
      ),
    ).toMatchObject({
      title: 'Amiantos came online (as nostimo · Libera)',
      // No text on a presence transition — the title carries it.
      body: '',
    });
  });

  it('omits the nick when a friend signed on under their display name', () => {
    // Case-insensitively: 'Amiantos' vs 'amiantos' is the same identity, and
    // saying "Amiantos came online (as amiantos)" would be noise.
    expect(
      composeNotification(
        payload({ kind: 'friend_online', target: 'amiantos', displayName: 'Amiantos' }),
      ).title,
    ).toBe('Amiantos came online (Libera)');
  });

  it('falls back when a nick or display name is missing', () => {
    expect(composeNotification(payload({ nick: null })).title).toBe('someone (Libera)');
    // The same fallback on the channel branch, which is a separate expression.
    expect(
      composeNotification(payload({ kind: 'highlight', target: '#lurker', nick: null })).title,
    ).toBe('someone in #lurker');
    expect(
      composeNotification(payload({ kind: 'friend_online', displayName: null, target: '' })).title,
    ).toBe('A friend came online (Libera)');
  });

  it('tags by buffer so a burst in one channel collapses', () => {
    const a = composeNotification(payload({ kind: 'highlight', target: '#lurker', text: 'one' }));
    const b = composeNotification(payload({ kind: 'highlight', target: '#lurker', text: 'two' }));
    expect(a.tag).toBe(b.tag);
    // ...but a different buffer on the same network does not collapse into it.
    expect(composeNotification(payload({ kind: 'highlight', target: '#other' })).tag).not.toBe(
      a.tag,
    );
  });
});

// The comments in notificationContent.ts and sw.js both claim the two
// compositions are byte-for-byte twins, and the phase-2 rollout depends on it: a
// service worker cached before the server started composing falls back to its own
// copy, so if the two disagree, the same push renders differently depending on
// how stale the user's worker is — invisible in every other test.
//
// So rather than trust the claim, run the real sw.js. It's plain browser JS with
// no exports, so it loads in a vm context with a stub `self`; its top-level
// function declarations land on the context's global.
describe('parity with the service worker fallback', () => {
  const sandbox: Record<string, unknown> = {
    self: {
      addEventListener: () => {},
      navigator: {},
      registration: {},
      clients: {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox);
  const legacyTitle = sandbox.legacyTitle as (data: unknown) => string;

  it('loaded the worker (guards against a silent no-op if sw.js moves)', () => {
    expect(typeof legacyTitle).toBe('function');
  });

  const cases: Array<[string, PushPayload]> = [
    ['dm', payload()],
    ['dm with no network name', payload({ networkName: '' })],
    ['dm with no nick', payload({ nick: null })],
    ['highlight', payload({ kind: 'highlight', target: '#lurker' })],
    ['always_notify', payload({ kind: 'always_notify', target: '#lurker' })],
    ['highlight with no target', payload({ kind: 'highlight', target: '' })],
    // The nick fallback lives in a different expression per branch, so a null
    // nick has to be paired with EACH kind or one of them drifts untested.
    ['highlight with no nick', payload({ kind: 'highlight', target: '#lurker', nick: null })],
    [
      'always_notify with no nick',
      payload({ kind: 'always_notify', target: '#lurker', nick: null }),
    ],
    [
      'friend_online under a different nick',
      payload({ kind: 'friend_online', target: 'nostimo', displayName: 'Amiantos' }),
    ],
    [
      'friend_online under the same nick',
      payload({ kind: 'friend_online', target: 'amiantos', displayName: 'Amiantos' }),
    ],
    [
      'friend_online with no display name',
      payload({ kind: 'friend_online', target: 'nostimo', displayName: null }),
    ],
    [
      'friend_online with no network',
      payload({
        kind: 'friend_online',
        target: 'nostimo',
        displayName: 'Amiantos',
        networkName: '',
      }),
    ],
  ];

  it.each(cases)('server and worker compose the same title: %s', (_label, p) => {
    expect(composeNotification(p).title).toBe(legacyTitle(p));
  });
});
