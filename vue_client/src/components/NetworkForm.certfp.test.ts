// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The CertFP block in the network form (#459). Mounted rather than unit-tested
// because what matters here is what a user can see and reach: the fingerprint
// they have to paste into NickServ, and — in the two states where the network
// cannot connect — something to click that fixes it.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
  sha512: '9'.repeat(128),
  subject: 'CN=nick',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2036-01-01T00:00:00.000Z',
};

const originalClipboard = navigator.clipboard;

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

  // A stubbed clipboard is a defineProperty, which restoreAllMocks doesn't
  // undo — and one left as `undefined` would send another file's copy path
  // down the reveal branch.
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('offers to generate one when the network has none', async () => {
    const text = (await openWithAdvanced()).text();
    expect(text).toContain('Client certificate');
    expect(text).toContain('Generate');
    expect(text).toContain('Import');
  });

  it('offers every digest to copy, and the pair to download', () => {
    const form = open({ client_cert: DIGEST });
    // All three, because networks disagree: Libera takes SHA-512 and rejects
    // the rest, most Atheme networks and ergo want SHA-256, older
    // ratbox-family ones SHA-1.
    const labels = form.findAll('button').map((b) => b.text());
    expect(labels).toContain('SHA-512');
    expect(labels).toContain('SHA-256');
    expect(labels).toContain('SHA-1');
    expect(labels).toContain('Download');
    // The hex itself is behind the buttons, not on the page.
    expect(form.text()).not.toContain(DIGEST.sha512);
    // Expiry is the one thing here worth reading, because it is data about
    // this certificate rather than instructions about certificates.
    expect(form.text()).toMatch(/Expires \d/);
  });

  // Downloading is a button among the copy buttons, not a link off on its own,
  // and it must not navigate the form away — the anchor is a transient.
  it('downloads the pair without leaving the form', async () => {
    const form = open({ client_cert: DIGEST });
    const clicked: string[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') || '');
    };
    try {
      await form
        .findAll('button')
        .find((b) => b.text() === 'Download')!
        .trigger('click');
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
    expect(clicked).toEqual(['/api/networks/7/certificate/export']);
    expect(document.querySelectorAll('a[href*="certificate/export"]')).toHaveLength(0);
  });

  it('copies the digest whose button was pressed', async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const form = open({ client_cert: DIGEST });
    const button = form.findAll('button').find((b) => b.text() === 'SHA-512')!;
    await button.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(writeText).toHaveBeenCalledWith(DIGEST.sha512);
    // The tick lands on the button that was pressed, and only that one.
    expect(button.attributes('aria-label')).toBe('copied');
    expect(form.find('button[aria-label="copy SHA-256 fingerprint"]').exists()).toBe(true);
  });

  // navigator.clipboard is undefined outside a secure context — which is how a
  // self-host reached over plain http:// on a LAN runs. Copy is then the only
  // route to a value that appears nowhere else on the page.
  it('reveals the fingerprint when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    const form = open({ client_cert: DIGEST });
    await form
      .findAll('button')
      .find((b) => b.text() === 'SHA-256')!
      .trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(form.text()).toContain(DIGEST.sha256);
  });

  // The section is buried under Advanced, which stays collapsed by default —
  // but a certificate the user cannot see is one they cannot remove, and two of
  // its states block connecting.
  it('opens Advanced by itself when a certificate is attached', () => {
    // Reached without clicking the Advanced toggle first.
    expect(open({ client_cert: DIGEST }).text()).toContain('Client certificate');
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
    const minted = { ...DIGEST, sha256: 'c'.repeat(64) };
    const attach = vi.spyOn(store, 'attachCertificate').mockResolvedValue(minted);
    const writeText = vi.fn<(v: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const form = await openWithAdvanced();
    const generate = form
      .findAll('button')
      .find((b) => b.text() === 'Generate' || b.text() === 'Working…')!;
    await generate.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(attach).toHaveBeenCalledWith(7, { mode: 'generate' });
    // The block is in its attached state without a refetch, and what it copies
    // is the pair that was just minted — it only exists once written, and it is
    // what the user has to go and register.
    await form
      .findAll('button')
      .find((b) => b.text() === 'SHA-256')!
      .trigger('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(minted.sha256);
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
