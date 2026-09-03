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

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

// Drive the file input the way a picker would: attach the files and fire
// `change`, which is the event the component listens for.
async function pickFiles(form: ReturnType<typeof mount>, contents: string[]): Promise<void> {
  const input = form.find('.cert-file input[type="file"]');
  const files = contents.map(
    (text, i) => new File([text], `part-${i}.pem`, { type: 'text/plain' }),
  );
  Object.defineProperty(input.element, 'files', { value: files, configurable: true });
  await input.trigger('change');
  // The handler reads the files asynchronously.
  await new Promise((r) => setTimeout(r, 0));
  await form.vm.$nextTick();
}

const DIGEST = {
  sha256: 'a'.repeat(64),
  sha1: 'b'.repeat(40),
  sha512: '9'.repeat(128),
  subject: 'CN=nick',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2036-01-01T00:00:00.000Z',
};

let mounted: ReturnType<typeof mount>[] = [];

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
    for (const wrapper of mounted) wrapper.unmount();
    mounted = [];
  });

  // The add flow has no network to write to yet, so the certificate is an
  // intent the create request carries — and the server mints it before the
  // first dial, because "connect with it, then register it from that
  // connection" is what every network's instructions say.
  // The add flow offers the SAME two choices as editing. Only the timing
  // differs, and it has to: there is no network to write to yet, so the choice
  // rides along with the create request.
  async function openAddForm() {
    const form = mount(NetworkForm, { props: { network: null } });
    mounted.push(form);
    // The add flow opens on the network picker; the form is the second step.
    await form
      .findAll('button')
      .find((b) => b.text().includes('Enter details manually'))!
      .trigger('click');
    const toggle = form.findAll('button').find((b) => b.text().includes('Advanced options'));
    if (toggle) await toggle.trigger('click');
    return form;
  }

  it('offers both generate and import while adding a network', async () => {
    const form = await openAddForm();
    const labels = form.findAll('button').map((b) => b.text());
    expect(form.text()).toContain('Client certificate');
    expect(labels).toContain('Generate');
    expect(labels).toContain('Import');
    // None of the states that need a network to exist.
    expect(labels).not.toContain('Download');
  });

  it('queues a generated certificate onto the create request', async () => {
    const store = useNetworksStore();
    const create = vi.spyOn(store, 'create').mockResolvedValue({ id: 9 } as never);
    const form = await openAddForm();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Generate')!
      .trigger('click');

    // Said plainly, and undoable — nothing has been created yet.
    expect(form.text()).toContain('will be created with this network');
    await form.find('form').trigger('submit');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ generate_client_cert: true, client_cert: '' }),
    );
  });

  it('carries a pasted pair onto the create request instead', async () => {
    const store = useNetworksStore();
    const create = vi.spyOn(store, 'create').mockResolvedValue({ id: 9 } as never);
    const form = await openAddForm();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Import')!
      .trigger('click');
    const areas = form.findAll('textarea');
    await areas[areas.length - 2].setValue('-----BEGIN CERTIFICATE-----x');
    await areas[areas.length - 1].setValue('-----BEGIN PRIVATE KEY-----y');
    await form
      .findAll('button')
      .find((b) => b.text() === 'Use this certificate')!
      .trigger('click');

    expect(form.text()).toContain('will be attached to this network');
    await form.find('form').trigger('submit');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_cert: '-----BEGIN CERTIFICATE-----x',
        client_key: '-----BEGIN PRIVATE KEY-----y',
        generate_client_cert: false,
      }),
    );
  });

  it('lets a queued certificate be undone before saving', async () => {
    const form = await openAddForm();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Generate')!
      .trigger('click');
    await form
      .findAll('button')
      .find((b) => b.text() === 'undo')!
      .trigger('click');
    expect(form.text()).not.toContain('will be created with this network');
    expect(form.findAll('button').map((b) => b.text())).toContain('Generate');
  });

  // v-if / v-else-if / v-else is one chain: an element inserted into the middle
  // of it silently detaches the tail, and two states render at once.
  it('renders exactly one certificate state at a time', () => {
    const bad = open({ client_cert: { unusable: true } });
    expect(bad.text()).toMatch(/can’t be read/);
    expect(bad.findAll('button').map((b) => b.text())).not.toContain('Generate');

    const good = open({ client_cert: DIGEST });
    expect(good.text()).not.toMatch(/can’t be read/);
    expect(good.findAll('button').map((b) => b.text())).not.toContain('Generate');
  });

  it('offers to generate one when the network has none', async () => {
    const text = (await openWithAdvanced()).text();
    expect(text).toContain('Client certificate');
    expect(text).toContain('Generate');
    expect(text).toContain('Import');
  });

  // No fingerprints in the form, deliberately: `CERT ADD` with no argument is
  // what nearly every network wants, and the exceptions are served by
  // `/network cert <network>`. TheLounge shows none for the same reason; soju
  // puts them behind a command. Asserted, not just absent, so putting them back
  // is a decision rather than a drift.
  it('offers the pair to download, and no fingerprints to paste', () => {
    const form = open({ client_cert: DIGEST });
    const labels = form.findAll('button').map((b) => b.text());
    expect(labels).toContain('Download');
    expect(labels).not.toContain('SHA-512');
    expect(form.text()).not.toContain(DIGEST.sha512);
    expect(form.text()).not.toContain(DIGEST.sha256);
    expect(form.text()).not.toContain(DIGEST.sha1);
    // Expiry stays: data about this certificate, not instructions.
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

    const form = await openWithAdvanced();
    const generate = form
      .findAll('button')
      .find((b) => b.text() === 'Generate' || b.text() === 'Working…')!;
    await generate.trigger('click');
    await new Promise((r) => setTimeout(r, 0));

    expect(attach).toHaveBeenCalledWith(7, { mode: 'generate' });
    // The block is in its attached state without a refetch — the certificate
    // exists only once written, and the form has to reflect that immediately.
    expect(form.findAll('button').map((b) => b.text())).toContain('Download');
  });

  // We hand out a .pem from the Download button; asking for it back as two
  // text boxes means a trip through a text editor to split a file we produced.
  it('fills both fields from a picked .pem file', async () => {
    const form = await openWithAdvanced();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Import')!
      .trigger('click');
    await pickFiles(form, [`${KEY_PEM}\n${CERT_PEM}\n`]);

    const areas = form.findAll('textarea');
    expect((areas[areas.length - 2].element as HTMLTextAreaElement).value).toBe(CERT_PEM);
    expect((areas[areas.length - 1].element as HTMLTextAreaElement).value).toBe(KEY_PEM);
  });

  // A certificate and its key are as often two files as one.
  it('takes the two halves from two files', async () => {
    const form = await openWithAdvanced();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Import')!
      .trigger('click');
    await pickFiles(form, [CERT_PEM, KEY_PEM]);

    const areas = form.findAll('textarea');
    expect((areas[areas.length - 2].element as HTMLTextAreaElement).value).toBe(CERT_PEM);
    expect((areas[areas.length - 1].element as HTMLTextAreaElement).value).toBe(KEY_PEM);
  });

  it('says so when the file holds neither half', async () => {
    const form = await openWithAdvanced();
    await form
      .findAll('button')
      .find((b) => b.text() === 'Import')!
      .trigger('click');
    await pickFiles(form, ['just some text']);
    expect(form.text()).toContain("doesn't contain a certificate");
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
