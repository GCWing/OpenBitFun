import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '../types';
import {
  getModelTags,
  getModelUserTags,
  normalizeModelTags,
  preserveModelAnnotations,
  withModelUserTags,
} from './modelTags';

const model = (overrides: Partial<AIModelConfig> = {}): AIModelConfig => ({
  id: 'model-a',
  name: 'Private provider',
  model_name: 'model-a',
  provider: 'openai',
  base_url: 'https://example.invalid/v1',
  api_key: 'test-key',
  enabled: true,
  category: 'general_chat',
  capabilities: ['text_chat', 'function_calling'],
  ...overrides,
});

describe('model annotations', () => {
  it('reads legacy configs without tags and tolerates unknown annotation shapes', () => {
    expect(getModelUserTags(model())).toEqual([]);
    expect(getModelTags(model({ recommended_for: ['planning'] }))).toEqual(['planning']);
    expect(getModelUserTags(model({ metadata: { user_tags: 'old external value' } }))).toEqual([]);
    expect(normalizeModelTags([' planning ', null, 'planning', '', 1, 'execution']))
      .toEqual(['planning', 'execution']);
  });

  it('round-trips a legacy config while only adding user annotations', () => {
    const legacy = model({
      metadata: { provider_instance_id: 'connection-a', external: { version: 3 } },
      recommended_for: ['planning'],
      auth: { type: 'subscription', provider: 'codex' },
      custom_headers: { 'x-workspace': 'private' },
    });
    const saved = JSON.parse(JSON.stringify(withModelUserTags(legacy, ['fast', 'fast', ' planning '])));
    expect(saved).toEqual({
      ...legacy,
      metadata: { ...legacy.metadata, user_tags: ['fast', 'planning'] },
    });
    expect(getModelTags(saved)).toEqual(['fast', 'planning']);
    expect(legacy.metadata).not.toHaveProperty('user_tags');
  });

  it('does not copy the first model annotations to siblings during connection editing', () => {
    const first = model({ metadata: { provider_instance_id: 'connection-a', user_tags: ['reasoning'] }, recommended_for: ['code'] });
    const sibling = model({ id: 'model-b', metadata: { provider_instance_id: 'connection-a', user_tags: ['quick'] }, recommended_for: ['titles'] });
    const editedSibling = { ...first, id: sibling.id, base_url: 'https://example.invalid/updated' };
    const savedSibling = preserveModelAnnotations(sibling, editedSibling);
    expect(savedSibling.base_url).toBe(editedSibling.base_url);
    expect(savedSibling.metadata).toEqual({ provider_instance_id: 'connection-a', user_tags: ['quick'] });
    expect(savedSibling.recommended_for).toEqual(['titles']);
    const untaggedSibling = preserveModelAnnotations(model(), editedSibling);
    expect(getModelUserTags(untaggedSibling)).toEqual([]);
    expect(untaggedSibling.recommended_for).toEqual([]);
  });

  it('supports three custom tags independently of recommended tags and ignores duplicates', () => {
    const current = model({ recommended_for: ['vision', 'fast'] });
    const saved = withModelUserTags(current, [' reasoning ', 'planning', 'execution', 'reasoning']);
    expect(getModelUserTags(saved)).toEqual(['reasoning', 'planning', 'execution']);
    expect(saved.recommended_for).toEqual(['vision', 'fast']);
    expect(() => withModelUserTags(saved, ['reasoning', 'planning', 'execution', 'review']))
      .toThrow('up to 3 custom tags');
    expect(getModelUserTags(saved)).toEqual(['reasoning', 'planning', 'execution']);
  });

  it('preserves older tag lists above the limit and allows removing tags without truncation', () => {
    const tags = ['reasoning', 'planning', 'execution', 'review', 'quick'];
    const legacy = model({ metadata: { user_tags: tags } });
    const roundTrip = JSON.parse(JSON.stringify(withModelUserTags(legacy, tags)));
    expect(getModelUserTags(roundTrip)).toEqual(tags);
    expect(getModelUserTags(withModelUserTags(legacy, tags.slice(0, 4)))).toEqual(tags.slice(0, 4));
    expect(() => withModelUserTags(legacy, [...tags, 'vision'])).toThrow('up to 3 custom tags');
    expect(getModelUserTags(withModelUserTags(legacy, ['reasoning', 'planning', 'vision'])))
      .toEqual(['reasoning', 'planning', 'vision']);
  });

  it('preserves freshly saved or cleared tags instead of a stale editor snapshot', () => {
    const stale = model({ metadata: { user_tags: ['old'] }, recommended_for: ['old'] });
    const current = model({ metadata: { user_tags: ['new'] }, recommended_for: ['new'] });
    expect(getModelTags(preserveModelAnnotations(current, stale))).toEqual(['new']);
    expect(getModelUserTags(preserveModelAnnotations(withModelUserTags(current, []), stale))).toEqual([]);
    expect(getModelTags(preserveModelAnnotations(undefined, stale))).toEqual([]);
  });

  it('saves explicit tag edits with model parameters while preserving recommended tags', () => {
    const current = model({ metadata: { user_tags: ['old'] }, recommended_for: ['vision'] });
    const draft = { ...current, context_window: 256000, recommended_for: ['stale'] };
    const saved = preserveModelAnnotations(current, draft, ['planning', 'execution']);
    expect(saved.context_window).toBe(256000);
    expect(getModelUserTags(saved)).toEqual(['planning', 'execution']);
    expect(saved.recommended_for).toEqual(['vision']);
    expect(getModelUserTags(preserveModelAnnotations(saved, draft, []))).toEqual([]);
    expect(getModelUserTags(current)).toEqual(['old']);
    expect(() => preserveModelAnnotations(current, draft, ['a', 'b', 'c', 'd']))
      .toThrow('up to 3 custom tags');
  });

  it('adds tags to a new model without inheriting provider-template annotations', () => {
    const template = model({ metadata: { user_tags: ['other-model'] }, recommended_for: ['other-use'] });
    const saved = preserveModelAnnotations(undefined, template, ['planning']);
    expect(getModelUserTags(saved)).toEqual(['planning']);
    expect(saved.recommended_for).toEqual([]);
  });

  it('leaves unknown stored tag values intact when only editing a connection', () => {
    const current = model({ metadata: { user_tags: { future: true } } });
    const saved = preserveModelAnnotations(current, model({ metadata: { user_tags: ['stale'] } }));
    expect(saved.metadata?.user_tags).toEqual({ future: true });
  });

  it('refuses to silently overwrite unsupported metadata', () => {
    const unsupported = model({ metadata: ['external format'] as unknown as Record<string, unknown> });
    expect(() => withModelUserTags(unsupported, ['planning'])).toThrow('unsupported metadata');
    expect(() => preserveModelAnnotations(unsupported, model())).toThrow('unsupported metadata');
    expect(() => preserveModelAnnotations(model(), unsupported)).toThrow('unsupported metadata');
  });
});
