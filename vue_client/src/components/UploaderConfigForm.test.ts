// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// What the form sends on save. An edit is merged into the stored config
// (updateUploaderConfig), so a field the payload leaves out keeps its old value.

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import UploaderConfigForm from './UploaderConfigForm.vue';
import type { UploaderDriver } from '../utils/uploaders.js';

const DRIVER: UploaderDriver = {
  driver: 'test',
  label: 'Test Driver',
  creatable: true,
  configSchema: [
    { key: 'endpoint', label: 'Endpoint', type: 'string', required: true, description: '' },
    { key: 'prefix', label: 'Prefix', type: 'string', required: false, description: '' },
    { key: 'token', label: 'Token', type: 'secret', required: false, description: '' },
  ],
};

async function saveAfterClearing(key: string): Promise<Record<string, string>> {
  const wrapper = mount(UploaderConfigForm, {
    props: {
      driver: DRIVER,
      existing: {
        label: 'Mine',
        config: { endpoint: 'https://example.test', prefix: 'lurker' },
        secretsSet: { token: true },
      },
    },
  });
  const index = DRIVER.configSchema.findIndex((f) => f.key === key) + 1; // after Name
  const input = wrapper.findAll('input')[index];
  await input.setValue('');
  await wrapper.find('form').trigger('submit');
  const [[event]] = wrapper.emitted('save') as [[{ values: Record<string, string> }]];
  wrapper.unmount();
  return event.values;
}

describe('UploaderConfigForm save payload', () => {
  it('sends a cleared optional field as empty, so the edit clears it', async () => {
    expect(await saveAfterClearing('prefix')).toEqual({
      endpoint: 'https://example.test',
      prefix: '',
    });
  });

  it('leaves out a blank secret, which keeps the stored one', async () => {
    const values = await saveAfterClearing('token');
    expect(values).not.toHaveProperty('token');
    expect(values.prefix).toBe('lurker');
  });
});
