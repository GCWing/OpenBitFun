import { describe, expect, it } from 'vitest';
import type { AIModelConfig } from '../types';
import {
  authForAccounts,
  isEligibleBackup,
  moveItem,
  normalizeChannelRouting,
  pruneChannelReferences,
  selectedAccountIds,
  subscriptionProviderOf,
} from './modelRouting';

const model = (id: string, extra: Partial<AIModelConfig> = {}): AIModelConfig => ({
  id,
  name: id,
  provider: 'openai',
  base_url: 'https://example.invalid',
  model_name: id,
  enabled: true,
  category: 'general_chat',
  capabilities: ['text_chat'],
  context_window: 128000,
  ...extra,
});

describe('account selection', () => {
  it('keeps one account in the shape older hosts read and pools several', () => {
    expect(authForAccounts('codex', ['codex'])).toEqual({ type: 'subscription', provider: 'codex' });
    expect(authForAccounts('grok', ['grok-account-1'])).toEqual({
      type: 'subscription', provider: 'grok', account_id: 'grok-account-1',
    });
    const previous = { type: 'subscription_pool' as const, provider: 'codex' as const, accounts: ['a', 'b'], revision: 7 };
    expect(authForAccounts('codex', ['b', 'a'], previous)).toEqual({ ...previous, accounts: ['b', 'a'] });
    expect(authForAccounts('opencode', ['opencode'], { type: 'subscription', provider: 'opencode', plan: 'zen' }))
      .toEqual({ type: 'subscription', provider: 'opencode', plan: 'zen' });
  });

  it('reads the provider and ordered accounts of every subscription shape', () => {
    expect(subscriptionProviderOf({ type: 'api_key' })).toBeUndefined();
    expect(subscriptionProviderOf({ type: 'subscription_pool', provider: 'hermes', accounts: ['x'], revision: 0 }))
      .toBe('hermes');
    expect(selectedAccountIds({ type: 'subscription', provider: 'antigravity' })).toEqual(['antigravity']);
    expect(selectedAccountIds({ type: 'subscription_pool', provider: 'codex', accounts: ['b', 'a'], revision: 1 }))
      .toEqual(['b', 'a']);
  });
});

describe('backup channels', () => {
  it('mirrors host validation for backup eligibility', () => {
    const primary = { id: 'p', context_window: 128000, capabilities: ['text_chat' as const] };
    expect(isEligibleBackup(primary, model('relay'))).toBe(true);
    expect(isEligibleBackup(primary, model('p'))).toBe(false);
    expect(isEligibleBackup(primary, model('small', { context_window: 32000 }))).toBe(false);
    expect(isEligibleBackup(primary, model('speech', { category: 'speech_recognition' }))).toBe(false);
    expect(isEligibleBackup(primary, model('nested', {
      channel_routing: { version: 1, fallback_model_ids: ['other'] },
    }))).toBe(false);
    expect(isEligibleBackup({ ...primary, capabilities: ['text_chat', 'image_understanding'] }, model('text-only')))
      .toBe(false);
  });

  it('stores empty routes as absent and drops stale manual choices', () => {
    expect(normalizeChannelRouting({ version: 1, fallback_model_ids: [] })).toBeUndefined();
    expect(normalizeChannelRouting({ version: 1, fallback_model_ids: ['b'], manual_channel: 'b' }))
      .toEqual({ version: 1, fallback_model_ids: ['b'], manual_channel: 'b' });
  });

  it('removes deleted models from every route so the host accepts the write', () => {
    const models = [
      model('a', { channel_routing: { version: 1, fallback_model_ids: ['b', 'c'], manual_channel: 'b' } }),
      model('d', { channel_routing: { version: 1, fallback_model_ids: ['b'] } }),
      model('c'),
    ];
    const pruned = pruneChannelReferences(models, new Set(['b']));
    expect(pruned[0].channel_routing).toEqual({ version: 1, fallback_model_ids: ['c'] });
    expect(pruned[1]).not.toHaveProperty('channel_routing');
    expect(pruned[2]).toBe(models[2]);
  });

  it('moves items within bounds only', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
