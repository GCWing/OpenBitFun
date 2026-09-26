import { describe, expect, it } from 'vitest';
import {
  preferredSubscriptionLoginMethod,
  subscriptionLoginMethodsForSurface,
  settleSubscriptionLoginStart,
  subscriptionLoginRequiresLocalDevice,
  SubscriptionLoginCoordinator,
} from './subscriptionLoginCoordinator';

describe('subscriptionLoginMethodsForSurface', () => {
  it('exposes both advertised Codex methods locally and device login through a peer', () => {
    expect(subscriptionLoginMethodsForSurface('codex', ['browser', 'device'], true))
      .toEqual(['browser', 'device']);
    expect(subscriptionLoginMethodsForSurface('codex', ['browser', 'device'], false))
      .toEqual(['device']);
  });

  it('preserves the device-only providers and browser-only Antigravity contract', () => {
    for (const provider of ['opencode', 'grok', 'hermes'] as const) {
      expect(subscriptionLoginMethodsForSurface(provider, ['device'], true)).toEqual(['device']);
      expect(subscriptionLoginMethodsForSurface(provider, ['device'], false)).toEqual(['device']);
    }
    expect(subscriptionLoginMethodsForSurface('antigravity', ['browser'], true)).toEqual(['browser']);
  });

  it('keeps legacy backends on default login without inventing unadvertised capabilities', () => {
    expect(subscriptionLoginMethodsForSurface('codex', undefined, true)).toEqual([]);
    expect(subscriptionLoginMethodsForSurface('codex', [], false)).toEqual([]);
    expect(subscriptionLoginMethodsForSurface('codex', ['browser'], true)).toEqual(['browser']);
  });
});

describe('preferredSubscriptionLoginMethod', () => {
  it('uses Codex device authorization when the callback browser is not local', () => {
    expect(preferredSubscriptionLoginMethod('codex', false)).toBe('device');
    expect(preferredSubscriptionLoginMethod('codex', true)).toBeUndefined();
  });

  it('lets single-method providers choose their backend default', () => {
    expect(preferredSubscriptionLoginMethod('antigravity', false)).toBeUndefined();
    expect(preferredSubscriptionLoginMethod('opencode', false)).toBeUndefined();
    expect(preferredSubscriptionLoginMethod('grok', false)).toBeUndefined();
    expect(preferredSubscriptionLoginMethod('hermes', false)).toBeUndefined();
  });

  it('identifies the browser-only provider that cannot sign in through a peer', () => {
    expect(subscriptionLoginRequiresLocalDevice('antigravity')).toBe(true);
    expect(subscriptionLoginRequiresLocalDevice('codex')).toBe(false);
    expect(subscriptionLoginRequiresLocalDevice('opencode')).toBe(false);
    expect(subscriptionLoginRequiresLocalDevice('grok')).toBe(false);
    expect(subscriptionLoginRequiresLocalDevice('hermes')).toBe(false);
  });
});

describe('SubscriptionLoginCoordinator', () => {
  it('assigns an immutable session id to each operation', () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const coordinator = new SubscriptionLoginCoordinator(() => ids.shift()!);
    const first = coordinator.begin('codex')!;
    expect(first.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    coordinator.complete(first);
    const second = coordinator.begin('codex')!;
    expect(second.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(first.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('allows only one provider authorization at a time', () => {
    const coordinator = new SubscriptionLoginCoordinator();
    const codex = coordinator.begin('codex');

    expect(codex).not.toBeNull();
    expect(coordinator.begin('opencode')).toBeNull();
    expect(coordinator.current()).toBe(codex);
  });

  it('does not let stale completion clear a newer operation', () => {
    const coordinator = new SubscriptionLoginCoordinator();
    const codex = coordinator.begin('codex')!;
    coordinator.requestCancel('codex');

    expect(coordinator.begin('opencode')).toBeNull();
    expect(coordinator.current()).toBe(codex);
    expect(coordinator.complete(codex)).toBe(true);
    const opencode = coordinator.begin('opencode')!;
    expect(coordinator.complete(codex)).toBe(false);
    expect(coordinator.current()).toBe(opencode);
    expect(coordinator.complete(opencode)).toBe(true);
    expect(coordinator.current()).toBeNull();
  });

  it('cancels only the matching active provider', () => {
    const coordinator = new SubscriptionLoginCoordinator();
    const active = coordinator.begin('antigravity')!;

    expect(coordinator.requestCancel('codex')).toBeNull();
    expect(coordinator.isCurrent(active)).toBe(true);
    expect(coordinator.requestCancel('antigravity')).toBe(active);
    expect(active.cancelled).toBe(true);
    expect(coordinator.current()).toBe(active);
  });

  it('cancels a backend session created after an early UI cancellation', async () => {
    const coordinator = new SubscriptionLoginCoordinator();
    const operation = coordinator.begin('opencode')!;
    coordinator.requestCancel('opencode');
    let backendCancels = 0;

    const settlement = await settleSubscriptionLoginStart(
      coordinator,
      operation,
      async () => { backendCancels += 1; },
    );

    expect(settlement).toEqual({ shouldContinue: false });
    expect(operation.startSettled).toBe(true);
    expect(backendCancels).toBe(1);
    expect(coordinator.current()).toBe(operation);
  });

  it('continues a start that has not been cancelled', async () => {
    const coordinator = new SubscriptionLoginCoordinator();
    const operation = coordinator.begin('codex')!;

    const settlement = await settleSubscriptionLoginStart(
      coordinator,
      operation,
      async () => { throw new Error('must not cancel'); },
    );

    expect(settlement).toEqual({ shouldContinue: true });
    expect(operation.startSettled).toBe(true);
  });
});
