// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Admin → General: the instance's Jitsi Meet server (#527).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { LurkerTestAgent } from '../test-utils/testApp.js';
import { setupTestDb, createTestApp, createAuthedAgent } from '../test-utils/testApp.js';

const ctx = setupTestDb('routes-admin-general');

const fanOutJitsiUrlToAll = vi.fn<() => void>();
vi.mock('../services/wsHub.js', async (orig) => ({
  ...(await orig<typeof import('../services/wsHub.js')>()),
  fanOutJitsiUrlToAll: () => fanOutJitsiUrlToAll(),
}));

let adminAgent: LurkerTestAgent;
let userAgent: LurkerTestAgent;
let instanceJitsiUrl: () => string | null;

beforeAll(async () => {
  const { createUser } = await import('../db/users.js');
  const adminRouter = (await import('./admin.js')).default;
  ({ instanceJitsiUrl } = await import('../db/instanceSettings.js'));
  const app = createTestApp({ '/api/admin': adminRouter });
  adminAgent = await createAuthedAgent(app, createUser('general-root', { role: 'admin' }).id);
  userAgent = await createAuthedAgent(app, createUser('general-user').id);
});

afterAll(() => ctx.cleanup());
beforeEach(() => fanOutJitsiUrlToAll.mockClear());

describe('admin general: Jitsi server', () => {
  it('is unset to begin with', async () => {
    const res = await adminAgent.get('/api/admin/general');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jitsiUrl: null });
  });

  it('stores a server in the form a room name appends to, and tells open clients', async () => {
    const res = await adminAgent
      .put('/api/admin/general/jitsi')
      .send({ url: ' https://meet.example.org/ ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jitsiUrl: 'https://meet.example.org' });
    expect(instanceJitsiUrl()).toBe('https://meet.example.org');
    expect(fanOutJitsiUrlToAll).toHaveBeenCalledTimes(1);
  });

  it.each(['meet.example.org', 'ftp://meet.example.org', 'https://meet.example.org/?jwt=x'])(
    'refuses %s and keeps what was set',
    async (url) => {
      const res = await adminAgent.put('/api/admin/general/jitsi').send({ url });
      expect(res.status).toBe(400);
      expect(instanceJitsiUrl()).toBe('https://meet.example.org');
      expect(fanOutJitsiUrlToAll).not.toHaveBeenCalled();
    },
  );

  it('refuses a body with no url', async () => {
    expect((await adminAgent.put('/api/admin/general/jitsi').send({})).status).toBe(400);
  });

  it('clears with an empty value', async () => {
    const res = await adminAgent.put('/api/admin/general/jitsi').send({ url: '' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jitsiUrl: null });
    expect(instanceJitsiUrl()).toBeNull();
    expect(fanOutJitsiUrlToAll).toHaveBeenCalledTimes(1);
  });

  it('is admin only', async () => {
    expect((await userAgent.get('/api/admin/general')).status).toBe(403);
    expect((await userAgent.put('/api/admin/general/jitsi').send({ url: '' })).status).toBe(403);
  });
});
