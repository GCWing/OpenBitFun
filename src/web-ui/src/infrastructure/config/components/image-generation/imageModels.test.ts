import { describe, expect, it } from 'vitest';
import type { ImageServiceConfig } from '../../types';
import { duplicateImageService, sameImageService } from './imageModels';

const service: ImageServiceConfig = {
  id: 'saved', name: 'Images', dialect: 'openai_images', base_url: 'https://images.example/v1',
  model_name: 'image-model', api_key: 'secret', enabled: true, params: { n: 1 },
};

describe('image service identity', () => {
  it('recognizes the same request regardless of id, name, enabled state, or explicit defaults', () => {
    expect(sameImageService(service, { ...service, id: 'new', name: 'Renamed', enabled: false,
      base_url: `${service.base_url}/`, request_url: 'https://images.example/v1/images/generations',
      auth: { type: 'api_key' }, custom_headers: {}, custom_headers_mode: 'merge', skip_ssl_verify: false,
      params: { size: undefined } })).toBe(true);
  });

  it.each<Partial<ImageServiceConfig>>([
    { model_name: 'other-image-model' },
    { base_url: 'https://other.example/v1' },
    { api_key: 'different-account' },
    { params: { n: 2 } },
    { params: { size: '1536x1024' } },
    { params: { seed: 42 } },
    { custom_headers: { 'X-Tenant': 'another' } },
    { custom_headers_mode: 'replace' },
    { skip_ssl_verify: true },
  ])('keeps different request configurations separate (%j)', difference => {
    expect(sameImageService(service, { ...service, ...difference })).toBe(false);
  });

  it('ignores property order for headers and advanced generation parameters', () => {
    expect(sameImageService({ ...service, custom_headers: { a: 'a', b: 'b' }, params: { seed: 1, n: 1 } },
      { ...service, custom_headers: { b: 'b', a: 'a' }, params: { n: 1, seed: 1 } })).toBe(true);
  });

  it('recognizes subscription imports without comparing unused API keys', () => {
    const subscription: ImageServiceConfig = { ...service, dialect: 'chatgpt_codex', model_name: '',
      base_url: 'https://chatgpt.com/backend-api/codex', auth: { type: 'subscription', provider: 'codex' } };
    expect(duplicateImageService([subscription], { ...subscription, id: 'new', name: 'Codex', api_key: '' })).toEqual(subscription);
    expect(sameImageService(subscription, { ...subscription, model_name: 'other-driver' })).toBe(false);
  });

  it('blocks an edit that collides with another record but allows unchanged legacy duplicates to be edited', () => {
    const second = { ...service, id: 'second', model_name: 'other-model' };
    expect(duplicateImageService([service, second], { ...second, model_name: service.model_name })).toEqual(service);
    expect(duplicateImageService([service, { ...service, id: 'legacy-duplicate' }], { ...service, name: 'Renamed' })).toBeUndefined();
  });
});
