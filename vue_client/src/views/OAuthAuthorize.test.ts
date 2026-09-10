// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// The OAuth approval page (#891). What matters here lives in what the page does
// with a response, which no server test can see: framed, it shows and asks for
// nothing; a rejected request stays on the page; and only a click navigates.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';

const h = vi.hoisted(() => ({
  api: vi.fn<(url: string, opts?: { method?: string; body?: unknown }) => Promise<any>>(),
}));
vi.mock('../api.js', () => ({ api: h.api }));

import OAuthAuthorize from './OAuthAuthorize.vue';

const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const PARAMS = {
  client_id: 'cid',
  redirect_uri: OOB,
  response_type: 'code',
  code_challenge: 'challenge',
  code_challenge_method: 'S256',
  state: 's1',
};
const QUERY = `?${new URLSearchParams(PARAMS)}`;

// GET answers with the approval details; POST answers with `decision`.
function serve(destination: object, decision: object) {
  h.api.mockImplementation(async (_url, opts) =>
    opts?.method === 'POST'
      ? decision
      : { app: { name: 'Ivory', website: 'ivory.example' }, destination },
  );
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((b) => b.text() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

beforeEach(() => {
  h.api.mockReset();
  window.history.replaceState(null, '', `/oauth/authorize${QUERY}`);
});
afterEach(() => vi.restoreAllMocks());

describe('OAuthAuthorize', () => {
  it('renders nothing and calls no API inside a frame', async () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.find('.card').exists()).toBe(false);
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.text()).toBe('');
    expect(h.api).not.toHaveBeenCalled();
  });

  it('shows the code for an out-of-band approval, without navigating', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    serve({ kind: 'code' }, { code: 'the-code' });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    // The query string reaches the server exactly as the app sent it.
    expect(h.api).toHaveBeenCalledWith(`/api/oauth/authorize${QUERY}`);
    expect(wrapper.text()).toContain('Ivory');
    expect(wrapper.text()).toContain("You'll get a code to paste into the app");

    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();

    expect(h.api).toHaveBeenLastCalledWith('/api/oauth/authorize', {
      method: 'POST',
      body: { ...PARAMS, decision: 'approve' },
    });
    expect(wrapper.find('code.code').text()).toBe('the-code');
    expect(assign).not.toHaveBeenCalled();
  });

  it('navigates to the redirect only after a click', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const redirect = 'https://app.example/cb?code=c1&state=s1';
    serve({ kind: 'web', host: 'app.example' }, { redirect });

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();
    expect(wrapper.text()).toContain('Returns to app.example');
    expect(assign).not.toHaveBeenCalled();

    await button(wrapper, 'Approve').trigger('click');
    await flushPromises();
    expect(assign).toHaveBeenCalledWith(redirect);
  });

  // Registration is open, so a rejected request's redirect could be anyone's.
  it('shows a rejected request on the page and never navigates', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    h.api.mockRejectedValue(
      Object.assign(new Error('invalid_redirect_uri'), {
        status: 400,
        data: {
          error: 'invalid_redirect_uri',
          error_description: 'redirect_uri is not registered for this app',
        },
      }),
    );

    const wrapper = mount(OAuthAuthorize);
    await flushPromises();

    expect(wrapper.text()).toContain('redirect_uri is not registered for this app');
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(assign).not.toHaveBeenCalled();
  });
});
