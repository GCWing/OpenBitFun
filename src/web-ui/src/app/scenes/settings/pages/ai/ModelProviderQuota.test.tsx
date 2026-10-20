// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AIModelConfig } from '@/infrastructure/config/types';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';
import { ModelProviderQuota } from './ModelProviderQuota';
import { canReadSavedPlanQuota, modelPlanQuotaKind } from './modelPlanQuota';
const manage = vi.hoisted(() => vi.fn());
vi.mock('@/infrastructure/api/service-api/AIApi', () => ({ aiApi: { manageModelQuotaConnection: manage } }));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/infrastructure/config/components/common', () => ({ ConfigPageRow: ({ children, description }: { children: React.ReactNode; description: React.ReactNode }) => <div>{description}{children}</div> }));
vi.mock('@openbitfun/ui', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Input: ({ size: _size, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & { size: string }) => <input {...props} />,
}));
vi.mock('./SubscriptionQuotaPanel', () => ({ SubscriptionQuotaPanel: ({ provider, accountId }: { provider: string; accountId: string }) => <section>{provider}:{accountId}</section> }));
const saved = { id: 'step', base_url: 'https://api.stepfun.com/v1', api_key: 'synthetic', auth: { type: 'api_key' } } as AIModelConfig;
const setup = { connected: false, account: null, signInUrl: 'https://platform.stepfun.com/step-plan', bookmarklet: 'javascript:fixture' };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetDeviceSurfaceForTest(); manage.mockReset(); manage.mockResolvedValue(setup);
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); resetDeviceSurfaceForTest(); });
it('recognizes only official plan routes and binds to the saved authorization', () => {
  expect(modelPlanQuotaKind({ base_url: 'https://api.kimi.com/coding' })).toBe('kimi_code');
  expect(modelPlanQuotaKind({ base_url: 'https://api.moonshot.cn/v1' })).toBeNull();
  expect(modelPlanQuotaKind({ base_url: 'https://api.minimax.io.evil.test/v1' })).toBeNull();
  expect(canReadSavedPlanQuota(saved, saved)).toBe(true);
  for (const draft of [{ ...saved, api_key: 'new' }, { ...saved, id: 'other' }, { ...saved, base_url: 'https://api.stepfun.ai/v1' }, { ...saved, auth: { type: 'subscription', provider: 'grok' } }]) {
    expect(canReadSavedPlanQuota(draft as Partial<AIModelConfig>, saved)).toBe(false);
  }
});
it('does not invoke an old peer or query a draft key', async () => {
  await act(async () => root.render(<ModelProviderQuota draft={saved} saved={saved} active supported={false} />));
  expect(manage).not.toHaveBeenCalled();
  expect(container.textContent).toContain('quota.hostUnsupported');
  await act(async () => root.render(<ModelProviderQuota draft={{ ...saved, api_key: 'draft-key' }} saved={saved} active supported />));
  expect(manage).not.toHaveBeenCalled();
  expect(container.textContent).toContain('quota.planSaveBeforeQuery');
});
it('does not publish an old host session after activating a peer', async () => {
  let complete!: (value: unknown) => void;
  manage.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue(setup);
  await act(async () => root.render(<ModelProviderQuota draft={saved} saved={saved} active supported />));
  await act(async () => { activateSurface('peer-a'); });
  await act(async () => { complete({ ...setup, connected: true, account: 'previous-private-account' }); });
  expect(container.textContent).not.toContain('quota.stepfunDisconnect');
  expect(container.textContent).not.toContain('previous-private-account');
  expect(container.querySelector('section')?.textContent).toBe('stepfun:model:step');
});
