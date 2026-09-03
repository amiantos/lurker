// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The CertFP block in the network form (#459). Mounted rather than unit-tested
// because what matters here is what a user can see and reach: the fingerprint
// they have to paste into NickServ, and — in the two states where the network
// cannot connect — something to click that fixes it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('../composables/useSocket.js', () => ({
  socketSend: vi.fn<(payload: Record<string, unknown>) => boolean>(() => true),
}));

import { useNetworksStore, type Network } from '../stores/networks.js';
import NetworkForm from './NetworkForm.vue';

const DIGEST = {
  sha256: 'a'.repeat(64),
  sha1: 'b'.repeat(40),
  subject: 'CN=nick',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2036-01-01T00:00:00.000Z',
};

function network(extra: Record<string, unknown> = {}): Network {
  return {
    id: 7,
    name: 'Libera',
    host: 'irc.libera.chat',
    port: 6697,
    nick: 'nick',
    tls: true,
    autoconnect: true,
    trusted_certificates: true,
    ...extra,
  } as Network;
}

function open(extra: Record<string, unknown> = {}) {
  return mount(NetworkForm, { props: { network: network(extra) } });
}

// The block lives under Advanced, which stays collapsed for a network with
// nothing advanced set — a certificate is a niche thing to go looking for. It
// opens by itself once one IS attached, which is asserted on its own below.
async function openWithAdvanced(extra: Record<string, unknown> = {}) {
  const form = open(extra);
  const toggle = form.findAll('button').find((b) => b.text().includes('Advanced options'));
  if (toggle) await toggle.trigger('click');
  return form;
}

describe('NetworkForm — client certificate', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('offers to generate one when the network has none', async () => {
    const text = (await openWithAdvanced()).text();
    expect(text).toContain('Client certificate');
    expect(text).toContain('Generate');
    expect(text).toContain('Import');
  });

  it('shows the fingerprint to register, and how to register it', () => {
    const text = open({ client_cert: DIGEST }).text();
    expect(text).toContain(DIGEST.sha256);
    // The command is the whole point: a fingerprint nobody registers does
    // nothing at all.
    expect(text).toContain('NickServ CERT ADD');
    // SHA-1 for the older ratbox-family networks that still hash that way.
    expect(text).toContain(DIGEST.sha1);
  });

  // The section is buried under Advanced, which stays collapsed by default —
  // but a certificate the user cannot see is one they cannot remove, and two of
  // its states block connecting.
  it('opens Advanced by itself when a certificate is attached', () => {
    expect(open({ client_cert: DIGEST }).text()).toContain(DIGEST.sha256);
  });

  // Reachable through archive import, which writes the columns verbatim. The
  // dial refuses while it is attached, so this state has to say so and offer
  // the way out rather than looking like "no certificate".
  it('says an unreadable certificate is blocking the connection, and offers remove', () => {
    const form = open({ client_cert: { unusable: true } });
    expect(form.text()).toMatch(/can’t be read/);
    expect(form.text()).toContain('remove');
    expect(form.text()).not.toContain('Generate');
  });

  it('writes through to the server rather than waiting for Save', async () => {
    const store = useNetworksStore();
    const attach = vi
      .spyOn(store, 'attachCertificate')
      .mockResolvedValue({ ...DIGEST, sha256: 'c'.repeat(64) });

    const form = await openWithAdvanced();
    const generate = form
      .findAll('button')
      .find((b) => b.text() === 'Generate' || b.text() === 'Working…')!;
    await generate.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(attach).toHaveBeenCalledWith(7, { mode: 'generate' });
    // And the new fingerprint is on screen without a refetch: it only exists
    // once the pair has been written, and it is what the user must go paste.
    expect(form.text()).toContain('c'.repeat(64));
  });

  it('reports a rejected import where the user pasted it', async () => {
    const store = useNetworksStore();
    vi.spyOn(store, 'attachCertificate').mockRejectedValue({
      data: { error: "that private key doesn't match that certificate" },
    });

    const form = await openWithAdvanced();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Import')!
      .trigger('click');
    const areas = form.findAll('textarea');
    await areas[areas.length - 2].setValue('-----BEGIN CERTIFICATE-----');
    await areas[areas.length - 1].setValue('-----BEGIN PRIVATE KEY-----');
    await form
      .findAll('button')
      .find((b) => b.text() === 'Attach')!
      .trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(form.text()).toContain("doesn't match");
  });

  // A certificate is presented during a TLS handshake, and the server refuses
  // to attach one to a plaintext network — so don't offer the button.
  it('does not offer to generate one on a plaintext network', async () => {
    const form = await openWithAdvanced({ tls: false, port: 6667 });
    const generate = form.findAll('button').find((b) => b.text() === 'Generate')!;
    expect(generate.attributes('disabled')).toBeDefined();
    expect(form.text()).toContain('TLS only');
  });
});
