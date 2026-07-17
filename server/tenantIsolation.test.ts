// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-tenant isolation regression suite (D1, lurker.chat hosted service).
//
// The hosted service inverts the self-hosted threat model: co-tenants are
// adversaries to each other, so one missing `WHERE user_id = ?` or a
// mis-targeted broadcast leaks private messages. The route + WS/verb layers
// were audited clean by hand; this suite turns that audit into executable
// proof so a future refactor that drops a scope check fails CI instead of
// shipping a co-tenant DM leak.
//
// Shape: seed data owned by tenant A, then assert tenant B cannot read or
// mutate it across all three surfaces — HTTP routes, the transport-agnostic
// verb layer (the enforcement core shared by WebSocket + MCP), and the DB
// primitives. Positive controls confirm A *can* reach A's own data, so a
// blanket "everything 404s" bug couldn't make this suite pass.
//
// Covered HTTP routes: networks, uploads, highlight-rules, api-tokens,
// bookmarks, highlights, push, drafts, exports (download-by-job-id IDOR).
// Covered verbs: recent_messages, send_message, send_action, get_nick_note,
// set_nick_note, search_messages, list_buffers, list_networks — plus the
// read-only-ctx → `forbidden` scope gate on write verbs (re-audited via a
// route/verb/DB sweep for #113; no gaps found, this locks it into CI).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import {
  setupTestDb,
  createTestApp,
  createAuthedAgent,
  type LurkerTestAgent,
} from './test-utils/testApp.js';

// MUST run at module top level so DATABASE_PATH is set before any dynamic
// import touches db/index.js.
const ctx = setupTestDb('tenant-isolation');

const SECRET_TOKEN = 'isolationcanary'; // distinctive single FTS token in A's message
const SECRET_TARGET = '#secret';

let app: Express;
let agentA: LurkerTestAgent;
let agentB: LurkerTestAgent;

let userAId: number;
let userBId: number;
let netAId: number;
let netBId: number;
let msgIdA: number;
let matchedMsgIdA: number;
let uploadIdA: number;
let ruleIdA: number;
let tokenIdA: number;
let exportJobIdA: number;

const PUSH_ENDPOINT_A = 'https://push.test/endpoint-A';

// Late-bound module fns (imported after setupTestDb).
let callVerb: typeof import('./services/verbRegistry.js').callVerb;
let searchMessages: typeof import('./db/messages.js').searchMessages;
let getNetwork: typeof import('./db/networks.js').getNetwork;
let addBookmark: typeof import('./db/bookmarks.js').addBookmark;
let listBookmarkIdsForUser: typeof import('./db/bookmarks.js').listBookmarkIdsForUser;
let listDraftsForUser: typeof import('./db/drafts.js').listForUser;
let listPushForUser: typeof import('./db/pushSubscriptions.js').listAllForUser;

// Asserts callVerb rejects with a specific error code (verbRegistry attaches
// `.code` to its boundary errors). Captures the thrown value, then asserts
// unconditionally — a silent "didn't throw" leaves `thrown` undefined and
// fails the expect.
function expectVerbError(fn: () => unknown, code: string): void {
  let thrown: { code?: string } | undefined;
  try {
    fn();
  } catch (err) {
    thrown = err as { code?: string };
  }
  expect(thrown?.code).toBe(code);
}

function verbCtx(userId: number, scope: 'read' | 'read-write' = 'read') {
  return { userId, scope, transport: 'test' };
}

// POST /api/drafts/flush takes a sendBeacon-style text/plain body, so post raw
// JSON the way the real client does — express.json would otherwise swallow an
// application/json body before the handler's JSON.parse, masking the check.
function flushDrafts(agent: LurkerTestAgent, drafts: unknown[]) {
  return agent
    .post('/api/drafts/flush')
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ drafts }));
}

beforeAll(async () => {
  const { createUser } = await import('./db/users.js');
  const networksDb = await import('./db/networks.js');
  const { insertMessage, searchMessages: search } = await import('./db/messages.js');
  const { insertUpload } = await import('./db/uploadHistory.js');
  const { createToken } = await import('./db/apiTokens.js');
  const bookmarks = await import('./db/bookmarks.js');
  const drafts = await import('./db/drafts.js');
  const push = await import('./db/pushSubscriptions.js');
  const { createExportJob } = await import('./db/dataExports.js');
  const { default: highlightRulesService } = await import('./services/highlightRulesService.js');
  // Side-effecting import registers every verb into the shared registry.
  await import('./services/verbs/index.js');
  const registry = await import('./services/verbRegistry.js');

  callVerb = registry.callVerb;
  searchMessages = search;
  getNetwork = networksDb.getNetwork;
  addBookmark = bookmarks.addBookmark;
  listBookmarkIdsForUser = bookmarks.listBookmarkIdsForUser;
  listDraftsForUser = drafts.listForUser;
  listPushForUser = push.listAllForUser;

  userAId = createUser('tenant-a').id;
  userBId = createUser('tenant-b').id;

  netAId = networksDb.createNetwork(userAId, { name: 'netA', host: 'irc.a.test', nick: 'a' })!.id;
  netBId = networksDb.createNetwork(userBId, { name: 'netB', host: 'irc.b.test', nick: 'b' })!.id;

  // A private message in A's buffer — the thing a leak would expose.
  msgIdA = Number(
    insertMessage({
      networkId: netAId,
      target: SECRET_TARGET,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'someone',
      text: SECRET_TOKEN,
    }).id,
  );

  // B's own '#secret' buffer on B's own network — a deliberate target-name
  // collision with A's buffer. Proves isolation keys on network ownership, not
  // on the buffer name (the case Copilot flagged on PR #157).
  insertMessage({
    networkId: netBId,
    target: SECRET_TARGET,
    time: new Date().toISOString(),
    type: 'message',
    nick: 'b-side',
    text: 'b-own-message',
  });

  uploadIdA = insertUpload(userAId, {
    provider: 'test',
    url: 'https://example.test/a.png',
    filename: 'a.png',
    mime: 'image/png',
    byte_size: 10,
    width: 1,
    height: 1,
    thumbnail: Buffer.from('thumb-a'),
  });

  const created = highlightRulesService.create(userAId, { pattern: 'a-rule', kind: 'plain' });
  ruleIdA = (created as { ok: true; rule: { id: number } }).rule.id;

  tokenIdA = createToken({ userId: userAId, name: 'A token', scope: 'read-write' }).id;

  // A bookmarks A's own message: positive control + the row B must not see.
  addBookmark(userAId, msgIdA);

  // A *matched* (highlight) message in A's buffer — the thing B's highlight
  // feed must never surface. matchedRuleId set => searchMessages({matched:true})
  // includes it.
  matchedMsgIdA = Number(
    insertMessage({
      networkId: netAId,
      target: SECRET_TARGET,
      time: new Date().toISOString(),
      type: 'message',
      nick: 'someone',
      text: `${SECRET_TOKEN}-highlight`,
      matchedRuleId: ruleIdA,
    }).id,
  );

  // A draft on A's network — B must not be able to read it or clobber it by
  // flushing into A's network id.
  drafts.upsertDraft(userAId, netAId, SECRET_TARGET, 'A-draft');

  // A push subscription owned by A — B must not be able to delete or hijack it.
  push.upsertSubscription(userAId, {
    transport: 'webpush',
    endpoint: PUSH_ENDPOINT_A,
    p256dh: 'pA',
    auth: 'aA',
  });

  // A pending export job — the enumerable :id/download is the classic
  // "fetch-by-job-id-without-owner-check" IDOR surface.
  exportJobIdA = createExportJob(userAId, false).id;

  const networksRouter = (await import('./routes/networks.js')).default;
  const uploadsRouter = (await import('./routes/uploads.js')).default;
  const highlightRulesRouter = (await import('./routes/highlightRules.js')).default;
  const apiTokensRouter = (await import('./routes/apiTokens.js')).default;
  const bookmarksRouter = (await import('./routes/bookmarks.js')).default;
  const highlightsRouter = (await import('./routes/highlights.js')).default;
  const pushRouter = (await import('./routes/push.js')).default;
  const draftsRouter = (await import('./routes/drafts.js')).default;
  const { exportsRouter } = await import('./routes/exports.js');

  app = createTestApp({
    '/api/networks': networksRouter,
    '/api/uploads': uploadsRouter,
    '/api/highlight-rules': highlightRulesRouter,
    '/api/api-tokens': apiTokensRouter,
    '/api/bookmarks': bookmarksRouter,
    '/api/highlights': highlightsRouter,
    '/api/push': pushRouter,
    '/api/drafts': draftsRouter,
    '/api/exports': exportsRouter,
  });
  agentA = await createAuthedAgent(app, userAId);
  agentB = await createAuthedAgent(app, userBId);
});

afterAll(() => ctx.cleanup());

describe('HTTP routes — tenant B cannot reach tenant A', () => {
  it('networks: list returns only B; A’s network is absent', async () => {
    const res = await agentB.get('/api/networks');
    expect(res.status).toBe(200);
    const ids = res.body.networks.map((n: { id: number }) => n.id);
    expect(ids).toContain(netBId);
    expect(ids).not.toContain(netAId);
  });

  it('networks: patch/delete/connect on A’s network 404 for B', async () => {
    expect((await agentB.patch(`/api/networks/${netAId}`).send({ name: 'pwned' })).status).toBe(
      404,
    );
    expect((await agentB.delete(`/api/networks/${netAId}`)).status).toBe(404);
    expect((await agentB.post(`/api/networks/${netAId}/connect`)).status).toBe(404);
  });

  it('uploads: B cannot read A’s thumbnail or delete A’s upload', async () => {
    expect((await agentB.get(`/api/uploads/${uploadIdA}/thumb`)).status).toBe(404);
    expect((await agentB.delete(`/api/uploads/${uploadIdA}`)).status).toBe(404);
    const list = await agentB.get('/api/uploads');
    expect(list.body.items.map((u: { id: number }) => u.id)).not.toContain(uploadIdA);
  });

  it('highlight rules: B cannot patch/delete A’s rule', async () => {
    expect(
      (await agentB.patch(`/api/highlight-rules/${ruleIdA}`).send({ enabled: false })).status,
    ).toBe(404);
    expect((await agentB.delete(`/api/highlight-rules/${ruleIdA}`)).status).toBe(404);
  });

  it('api tokens: B cannot revoke A’s token, nor see it listed', async () => {
    expect((await agentB.delete(`/api/api-tokens/${tokenIdA}`)).status).toBe(404);
    const list = await agentB.get('/api/api-tokens');
    expect(list.body.items.map((t: { id: number }) => t.id)).not.toContain(tokenIdA);
  });

  it('bookmarks: B’s list is empty (A’s bookmark is invisible)', async () => {
    const res = await agentB.get('/api/bookmarks');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('highlights: B’s feed never surfaces A’s matched message', async () => {
    const res = await agentB.get('/api/highlights');
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { id: number }) => m.id)).not.toContain(matchedMsgIdA);
  });

  it('exports: B cannot download A’s export job by id (job-id IDOR)', async () => {
    // The owner check lives at the riskiest moment — download by enumerable id.
    expect((await agentB.get(`/api/exports/${exportJobIdA}/download`)).status).toBe(404);
  });

  it('push: B cannot delete A’s subscription, nor hijack A’s endpoint', async () => {
    // Unsubscribe is double-keyed on (user_id, endpoint), so B passing A’s
    // endpoint deletes nothing. Assert the route actually succeeded (200) so a
    // wrong-route/4xx couldn’t make the "A’s sub still present" check vacuous.
    const del = await agentB.delete('/api/push/subscriptions').send({ endpoint: PUSH_ENDPOINT_A });
    expect(del.status).toBe(200);
    expect(listPushForUser(userAId).some((s) => s.endpoint === PUSH_ENDPOINT_A)).toBe(true);

    // B tries to register A’s endpoint under B’s account — rejected 409, so B
    // can’t rebind A’s browser registration to itself.
    const res = await agentB
      .post('/api/push/subscriptions')
      .send({ endpoint: PUSH_ENDPOINT_A, keys: { p256dh: 'pB', auth: 'aB' } });
    expect(res.status).toBe(409);
    expect(listPushForUser(userBId).some((s) => s.endpoint === PUSH_ENDPOINT_A)).toBe(false);
  });

  it('drafts: B flushing into A’s network is a silent no-op (cannot clobber A’s draft)', async () => {
    // Positive control: B *can* write a draft into B’s own network — proves the
    // flush path works, so the A-network block below is really ownsNetwork.
    await flushDrafts(agentB, [{ networkId: netBId, target: SECRET_TARGET, body: 'B-own-draft' }]);
    expect(
      listDraftsForUser(userBId).some((d) => d.networkId === netBId && d.body === 'B-own-draft'),
    ).toBe(true);

    // B flushes into A’s network: ownsNetwork() skips it, so no row lands for B
    // and A’s existing draft is untouched.
    await flushDrafts(agentB, [{ networkId: netAId, target: SECRET_TARGET, body: 'B-was-here' }]);
    expect(listDraftsForUser(userBId).some((d) => d.networkId === netAId)).toBe(false);
    const aDraft = listDraftsForUser(userAId).find(
      (d) => d.networkId === netAId && d.target === SECRET_TARGET,
    );
    expect(aDraft?.body).toBe('A-draft');
  });
});

describe('HTTP routes — owner A can reach own data (positive controls)', () => {
  it('A sees A’s network, reads A’s thumbnail, and sees A’s bookmark', async () => {
    const nets = await agentA.get('/api/networks');
    expect(nets.body.networks.map((n: { id: number }) => n.id)).toContain(netAId);

    const thumb = await agentA.get(`/api/uploads/${uploadIdA}/thumb`);
    expect(thumb.status).toBe(200);

    const bm = await agentA.get('/api/bookmarks');
    expect(bm.body.items.map((m: { id: number }) => m.id)).toContain(msgIdA);
  });

  it('A sees A’s highlight feed and reaches A’s export row (409, not 404)', async () => {
    const hl = await agentA.get('/api/highlights');
    expect(hl.body.items.map((m: { id: number }) => m.id)).toContain(matchedMsgIdA);

    // The seeded job is pending, so A’s download is 409 "not ready" — crucially
    // NOT a 404. Asserting the exact 409 proves A reaches the row (so the B→404
    // above is real isolation, not a blanket "every export id 404s" bug) and
    // that an unrelated 500 wouldn’t slip through.
    const dl = await agentA.get(`/api/exports/${exportJobIdA}/download`);
    expect(dl.status).toBe(409);
  });
});

describe('Verb layer (WebSocket + MCP core) — tenant B is denied', () => {
  it('network-keyed verbs throw unknown_network for B against A’s network', () => {
    expectVerbError(
      () =>
        callVerb('recent_messages', verbCtx(userBId), { networkId: netAId, target: SECRET_TARGET }),
      'unknown_network',
    );
    expectVerbError(
      () =>
        callVerb('send_message', verbCtx(userBId, 'read-write'), {
          networkId: netAId,
          target: SECRET_TARGET,
          text: 'hi',
        }),
      'unknown_network',
    );
    expectVerbError(
      () => callVerb('get_nick_note', verbCtx(userBId), { networkId: netAId, nick: 'someone' }),
      'unknown_network',
    );
  });

  // The two write verbs not otherwise exercised above. Same registry gate, but
  // assert it explicitly so a future refactor can’t silently drop the check for
  // these.
  it('write verbs send_action / set_nick_note throw unknown_network for B', () => {
    expectVerbError(
      () =>
        callVerb('send_action', verbCtx(userBId, 'read-write'), {
          networkId: netAId,
          target: SECRET_TARGET,
          text: '/me waves',
        }),
      'unknown_network',
    );
    expectVerbError(
      () =>
        callVerb('set_nick_note', verbCtx(userBId, 'read-write'), {
          networkId: netAId,
          nick: 'someone',
          note: 'pwned',
        }),
      'unknown_network',
    );
  });

  // Scope gate: a read-only ctx must not be able to invoke a write verb, even
  // on the caller’s OWN network. Using A’s own network isolates the scope check
  // from the ownership check (which would otherwise also reject).
  it('read-only ctx cannot invoke write verbs (forbidden, even on own network)', () => {
    expectVerbError(
      () =>
        callVerb('send_message', verbCtx(userAId, 'read'), {
          networkId: netAId,
          target: SECRET_TARGET,
          text: 'hi',
        }),
      'forbidden',
    );
    expectVerbError(
      () =>
        callVerb('set_nick_note', verbCtx(userAId, 'read'), {
          networkId: netAId,
          nick: 'someone',
          note: 'x',
        }),
      'forbidden',
    );
  });

  it('global search/list verbs never surface A’s data to B', () => {
    const search = callVerb('search_messages', verbCtx(userBId), { query: SECRET_TOKEN }) as {
      messages: unknown[];
    };
    expect(search.messages).toHaveLength(0);

    const buffers = callVerb('list_buffers', verbCtx(userBId), {}) as Array<{
      networkId: number;
      target: string;
    }>;
    // Isolation is by network ownership, not target name. B has its own
    // same-named '#secret' buffer (seeded below), so the invariant is "B sees
    // NOTHING on A's network" — not "no buffer is named #secret". The `some`
    // check confirms B does see its own colliding buffer, so this isn't
    // vacuously passing on an empty list.
    expect(buffers.every((b) => b.networkId !== netAId)).toBe(true);
    expect(buffers.some((b) => b.networkId === netBId && b.target === SECRET_TARGET)).toBe(true);

    const networks = callVerb('list_networks', verbCtx(userBId), {}) as Array<{ id: number }>;
    expect(networks.map((n) => n.id)).not.toContain(netAId);
  });
});

describe('Verb layer — owner A can (positive controls)', () => {
  it('A reads A’s buffer, finds A’s message in search, sees A’s network', () => {
    const recent = callVerb('recent_messages', verbCtx(userAId), {
      networkId: netAId,
      target: SECRET_TARGET,
    }) as { messages: Array<{ id: number }> };
    expect(recent.messages.map((m) => m.id)).toContain(msgIdA);

    const search = callVerb('search_messages', verbCtx(userAId), { query: SECRET_TOKEN }) as {
      messages: Array<{ id: number }>;
    };
    expect(search.messages.map((m) => m.id)).toContain(msgIdA);

    const networks = callVerb('list_networks', verbCtx(userAId), {}) as Array<{ id: number }>;
    expect(networks.map((n) => n.id)).toContain(netAId);
  });
});

describe('DB isolation primitives', () => {
  it('getNetwork is user-scoped', () => {
    expect(getNetwork(netAId, userBId)).toBeUndefined();
    expect(getNetwork(netAId, userAId)).toBeDefined();
  });

  it('addBookmark cannot cross tenants (the messageId IDOR is closed)', () => {
    // B tries to bookmark A's message by id — must be a silent no-op so it
    // can't then be read back through B's bookmarks list.
    expect(addBookmark(userBId, msgIdA)).toBe(false);
    expect(listBookmarkIdsForUser(userBId)).toHaveLength(0);
    // Positive control: A's own bookmark is present.
    expect(listBookmarkIdsForUser(userAId)).toContain(msgIdA);
  });

  it('searchMessages is user-scoped at the SQL layer', () => {
    expect(searchMessages(userBId, { query: SECRET_TOKEN })).toHaveLength(0);
    expect(searchMessages(userAId, { query: SECRET_TOKEN }).length).toBeGreaterThan(0);
  });
});
