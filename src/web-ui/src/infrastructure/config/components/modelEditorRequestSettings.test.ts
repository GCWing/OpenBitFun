import { describe, expect, it } from 'vitest';
import { getModelEditorRequestSettings, updateModelEditorRequestSettings } from './modelEditorRequestSettings';

describe('model editor request drafts', () => {
  it('accepts older configurations with no optional request settings and isolates header edits', () => {
    expect(getModelEditorRequestSettings()).toMatchObject({
      inline_think_in_text: true,
      skip_ssl_verify: false,
    });
    const persisted = { custom_headers: { 'X-Route': 'saved' } };
    const draft = getModelEditorRequestSettings(persisted);
    draft.custom_headers!['X-Route'] = 'draft';
    expect(persisted.custom_headers['X-Route']).toBe('saved');
  });

  it('edits only the selected model, using its stable key after a rename', () => {
    const drafts = [
      { key: 'first', modelName: 'renamed', requestSettings: getModelEditorRequestSettings() },
      { key: 'second', modelName: 'second', requestSettings: getModelEditorRequestSettings({ custom_request_body: '{"temperature":0.2}' }) },
    ];
    const updated = updateModelEditorRequestSettings(drafts, { custom_request_body: '{"temperature":0.8}' }, 'first');
    expect(updated[0].requestSettings.custom_request_body).toBe('{"temperature":0.8}');
    expect(updated[1]).toBe(drafts[1]);
    expect(drafts[0].requestSettings.custom_request_body).toBeUndefined();
    expect(updateModelEditorRequestSettings(drafts, { skip_ssl_verify: true }, 'missing')).toEqual(drafts);
  });

  it('applies an explicit service-wide field change without replacing other per-model settings', () => {
    const drafts = [
      { key: 'first', requestSettings: getModelEditorRequestSettings({ custom_request_body: '{"temperature":0.2}' }) },
      { key: 'second', requestSettings: getModelEditorRequestSettings({ custom_request_body: '{"temperature":0.8}' }) },
    ];
    const updated = updateModelEditorRequestSettings(drafts, { inline_think_in_text: false, custom_headers: undefined });
    expect(updated.map(draft => draft.requestSettings.inline_think_in_text)).toEqual([false, false]);
    expect(updated.map(draft => draft.requestSettings.custom_request_body)).toEqual(['{"temperature":0.2}', '{"temperature":0.8}']);
  });
});
