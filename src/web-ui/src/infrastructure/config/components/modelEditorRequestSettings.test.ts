import { describe, expect, it } from 'vitest';
import { getModelEditorRequestSettings, prepareModelEditorRequestSettingsForSave, updateModelEditorRequestSettings } from './modelEditorRequestSettings';

describe('model editor request drafts', () => {
  it('keeps image limits per model and clears the optional value without changing legacy defaults', () => {
    const drafts = [
      { key: 'limited', requestSettings: getModelEditorRequestSettings({ max_images_per_request: 3 }) },
      { key: 'legacy', requestSettings: getModelEditorRequestSettings() },
    ];
    expect(prepareModelEditorRequestSettingsForSave(drafts[0].requestSettings).max_images_per_request).toBe(3);
    const edited = updateModelEditorRequestSettings(drafts, { max_images_per_request: 2 }, 'legacy');
    expect(edited[0].requestSettings.max_images_per_request).toBe(3);
    expect(edited[1].requestSettings.max_images_per_request).toBe(2);
    const cleared = updateModelEditorRequestSettings(edited, { max_images_per_request: undefined }, 'limited');
    expect(JSON.parse(JSON.stringify(prepareModelEditorRequestSettingsForSave(cleared[0].requestSettings))))
      .not.toHaveProperty('max_images_per_request');
    expect(drafts[1].requestSettings.max_images_per_request).toBeUndefined();
  });
  it.each(['', ' \n\t '])('clears a previously saved custom body when the editor contains %j', body => {
    const persisted = { custom_request_body: '{"temperature":0.2}', custom_request_body_mode: 'trim' as const };
    const drafts = [{ key: 'model', requestSettings: getModelEditorRequestSettings(persisted) }];
    const [edited] = updateModelEditorRequestSettings(drafts, { custom_request_body: body }, 'model');
    const saved = { ...persisted, ...prepareModelEditorRequestSettingsForSave(edited.requestSettings) };
    const reloaded = JSON.parse(JSON.stringify(saved));

    expect(reloaded).not.toHaveProperty('custom_request_body');
    expect(reloaded.custom_request_body_mode).toBe('trim');
    expect(getModelEditorRequestSettings(reloaded).custom_request_body).toBeUndefined();
    expect(edited.requestSettings.custom_request_body).toBe(body);
    expect(persisted.custom_request_body).toBe('{"temperature":0.2}');
  });

  it('preserves non-empty custom JSON verbatim on save', () => {
    const body = ' \n{"temperature":0.2}\n ';
    expect(prepareModelEditorRequestSettingsForSave(getModelEditorRequestSettings({
      custom_request_body: body,
    })).custom_request_body).toBe(body);
  });

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
