// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModelConfig } from '@/infrastructure/config/types';
import type { ModelPoolDefinition } from '@/infrastructure/api/service-api/ModelPoolAPI';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { ModelPoolsSection } from './ModelPoolsSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  supported: true,
  list: vi.fn(), save: vi.fn(), status: vi.fn(), remove: vi.fn(), retryMember: vi.fn(),
}));
vi.mock('@/infrastructure/api/service-api/ModelPoolAPI', async original => ({
  ...await original<typeof import('@/infrastructure/api/service-api/ModelPoolAPI')>(),
  supportsModelPools: () => mocks.supported,
  modelPoolAPI: mocks,
}));
vi.mock('react-i18next', async original => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const model = (id: string, provider: string): AIModelConfig => ({
  id, name: provider, model_name: `${id}-chat`, provider: 'openai',
  base_url: `https://${provider.toLowerCase()}.test/v1`, enabled: true,
  category: 'general_chat', capabilities: ['text_chat'],
});
const models: AIModelConfig[] = [
  model('alpha', 'Acme'), model('beta', 'Umbra'),
  { ...model('disabled', 'Acme'), enabled: false },
  { ...model('audio', 'Acme'), category: 'speech_recognition', capabilities: ['speech_recognition'] },
];

describe('model pool editor', () => {
  let host: HTMLDivElement;
  let root: Root;
  const editor = () => document.querySelector<HTMLElement>('[data-testid="settings-model-pool-dialog"]:not([aria-hidden="true"])');
  const picker = () => document.querySelector<HTMLElement>('[data-testid="settings-model-pool-member-dialog"]:not([aria-hidden="true"])');
  const option = (id: string) => picker()!.querySelector<HTMLButtonElement>(`[data-model-id="${id}"]`)!;
  const memberOrder = () => [...editor()!.querySelectorAll<HTMLElement>('[data-testid="settings-model-pool-member"]')]
    .map(member => [member.dataset.modelId, member.querySelector('[data-openbitfun-part="poolMemberOrder"]')?.textContent]);
  const button = (element: HTMLElement, label: string) => [...element.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label)!;
  const click = async (element: HTMLElement) => act(async () => { element.focus(); element.click(); });
  const input = async (element: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const render = async () => act(async () => { root.render(<ModelPoolsSection models={models} />); });
  const create = async () => {
    await render();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="pools.create"]')!);
  };
  const add = async () => click(editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-add"]')!);

  beforeEach(() => {
    activateSurface('local');
    mocks.supported = true;
    mocks.list.mockReset().mockResolvedValue({ version: 1, pools: [] });
    mocks.status.mockReset().mockResolvedValue([]);
    mocks.retryMember.mockReset().mockResolvedValue(undefined);
    mocks.save.mockReset().mockImplementation(async pool => ({ version: 1, pools: [{ ...pool, id: pool.id || 'created' }] }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    activateSurface('local');
  });

  it('chooses a strategy with the keyboard, adds multiple models and saves their explicit order', async () => {
    await create();
    await input(editor()!.querySelector<HTMLInputElement>('[aria-label="pools.name"]')!, 'Daily');
    const ordered = editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-pool-strategy-ordered"]')!;
    const balanced = editor()!.querySelector<HTMLInputElement>('[data-testid="settings-model-pool-strategy-balanced"]')!;
    expect(ordered.checked).toBe(true);
    act(() => {
      ordered.focus();
      ordered.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(balanced.checked).toBe(true);
    expect(document.activeElement).toBe(balanced);

    await add();
    expect(document.activeElement).toBe(picker()!.querySelector('input'));
    expect([...picker()!.querySelectorAll<HTMLElement>('[data-model-id]')].map(item => item.dataset.modelId)).toEqual(['alpha', 'beta']);
    await click(option('alpha'));
    await click(option('beta'));
    expect(option('alpha').getAttribute('aria-pressed')).toBe('true');
    expect(option('alpha').getAttribute('data-openbitfun-variant')).toBe('fill');
    await click(option('alpha'));
    expect(option('alpha').getAttribute('data-openbitfun-variant')).toBe('outline');
    await click(option('alpha'));
    await click(button(picker()!, 'actions.done'));
    expect(picker()).toBeNull();
    expect(memberOrder()).toEqual([['beta', '1'], ['alpha', '2']]);
    await click(editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-member"][data-model-id="alpha"]')!);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-member-menu"] [data-menu-id="up"]')!);
    expect(memberOrder()).toEqual([['alpha', '1'], ['beta', '2']]);
    await click(button(editor()!, 'pools.save'));
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ id: '', name: 'Daily', strategy: 'balanced', member_model_ids: ['alpha', 'beta'] });
  });

  it('searches providers and keeps unknown members and extension fields when editing an existing pool', async () => {
    const legacyPool: ModelPoolDefinition = {
      id: 'existing', name: 'Existing', strategy: 'ordered', member_model_ids: ['missing-model', 'alpha'], extension: { preserved: true },
    };
    mocks.list.mockResolvedValue({ version: 1, pools: [legacyPool] });
    await render();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="shared:tools.edit"]')!);
    await add();
    await input(picker()!.querySelector<HTMLInputElement>('input')!, 'UMBRA');
    expect(picker()!.querySelector('[data-model-id="alpha"]')).toBeNull();
    await click(option('beta'));
    act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(picker()).toBeNull();
    expect(editor()).not.toBeNull();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    await add();
    expect(picker()!.querySelector<HTMLInputElement>('input')!.value).toBe('');
    expect(option('alpha').getAttribute('aria-pressed')).toBe('true');
    await click(button(picker()!, 'actions.done'));
    await click(button(editor()!, 'pools.save'));
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...legacyPool, member_model_ids: ['missing-model', 'alpha', 'beta'] });
  });

  it('retries a member from its capsule menu and removes another member with the capsule action', async () => {
    const pool = { id: 'daily', name: 'Daily', strategy: 'ordered', member_model_ids: ['alpha', 'beta'] };
    mocks.list.mockResolvedValue({ version: 1, pools: [pool] });
    mocks.status.mockResolvedValueOnce([{ modelId: 'alpha', status: 'cooling_down' }])
      .mockResolvedValue([{ modelId: 'alpha', status: 'available' }]);
    await render();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="shared:tools.edit"]')!);
    await click(editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-member"][data-model-id="alpha"]')!);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-member-menu"] [data-menu-id="retry"]')!);
    expect(mocks.retryMember).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(editor()).not.toBeNull();
    await click(editor()!.querySelector<HTMLButtonElement>('[data-testid="settings-model-pool-member-remove"][data-model-id="beta"]')!);
    expect(editor()!.querySelector('[data-testid="settings-model-pool-member"][data-model-id="beta"]')).toBeNull();
    await click(button(editor()!, 'pools.save'));
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...pool, member_model_ids: ['alpha'] });
  });

  it('closes both drafts when switching to a peer without model pool support', async () => {
    await create();
    await add();
    await click(option('alpha'));
    mocks.supported = false;
    await act(async () => { activateSurface('legacy-peer'); });
    expect(editor()).toBeNull();
    expect(picker()).toBeNull();
    expect(host.textContent).toContain('pools.unsupported');
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
