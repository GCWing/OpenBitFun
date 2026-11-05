import { describe, expect, it } from 'vitest';
import { resolveGenUIInteractionState } from './genUIInteractionState';

const app = { schemaVersion: 2, id: 'app', title: 'App' } as const;

describe('GenUI interaction lifecycle', () => {
  it('keeps the first empty phase lightweight', () => {
    expect(resolveGenUIInteractionState({ toolStatus: 'preparing' })).toBe('starting');
    expect(resolveGenUIInteractionState({ toolStatus: 'error' })).toBe('failed');
  });

  it('shows a usable streamed source before delivery', () => {
    expect(resolveGenUIInteractionState({ app, toolStatus: 'streaming', isStreaming: true })).toBe('streaming');
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', ownerReady: false })).toBe('interactive');
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', ownerReady: false, requiresDelivery: true })).toBe('delivery-pending');
  });

  it('does not discard a usable preview when delivery fails', () => {
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', ownerReady: true, ownerError: 'CAS conflict' })).toBe('degraded');
    expect(resolveGenUIInteractionState({ app, toolStatus: 'error', isFailed: true })).toBe('degraded');
  });

  it('only reports complete after delivery evidence is present', () => {
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', ownerReady: true, requiresDelivery: true })).toBe('interactive');
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', deliveryAccepted: true, requiresDelivery: true })).toBe('complete');
  });

  it('allows data loading to be represented independently of source streaming', () => {
    expect(resolveGenUIInteractionState({ app, toolStatus: 'completed', dataPending: true, ownerReady: true })).toBe('data-pending');
  });
});
