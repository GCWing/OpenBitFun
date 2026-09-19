// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillMarketSettings } from './SkillMarketSettings';
import type { SkillMarketConfig } from '../types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), saved: vi.fn() }));
const translate = (key: string) => key;
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({ useI18n: () => ({ t: translate }) }));
vi.mock('@/infrastructure/api/service-api/ConfigAPI', () => ({ configAPI: { getConfig: mocks.get } }));
vi.mock('../services/ConfigManager', () => ({ configManager: { updateConfig: mocks.update } }));

vi.mock('./common', () => ({
  ConfigCollectionItem: ({ label, badge, control, details, expanded, onToggle }: { label: string; badge: React.ReactNode; control: React.ReactNode; details: React.ReactNode; expanded: boolean; onToggle: () => void }) => (
    <section><button aria-expanded={expanded} onClick={onToggle}>{label}</button>{badge}{control}{expanded && details}</section>
  ),
}));

// Form behavior is tested separately from the design system's picker rendering.
vi.mock('@openbitfun/ui', () => ({
  Field: ({ children, label, description }: { children: React.ReactNode; label: string; description?: string }) => <label>{label}{children}{description}</label>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Icon: () => null,
  IconButton: ({ icon: _icon, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.ReactNode; size: string }) => <button {...props} />,
  Switch: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input type="checkbox" {...props} />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Select: ({ value, options, onValueChange, disabled }: { value: string; options: { value: string; label: string }[]; onValueChange: (value: string) => void; disabled?: boolean }) =>
    <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>,
}));

const official = { id: 'skills-sh', name: 'skills.sh', provider: 'skills-sh', url: 'https://skills.sh', enabled: true, api_token: '' };
const defaults = { sources: [official] };
describe('SkillMarketSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.get.mockReset().mockResolvedValue(defaults);
    mocks.update.mockReset().mockImplementation(async (_path, update) => update(defaults));
    mocks.saved.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async () => { await act(async () => root.render(<SkillMarketSettings onSaved={mocks.saved} />)); };
  const changeInput = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const chooseSkillHub = async () => {
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'skillhub';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const click = async (label: string) => { await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === label || button.getAttribute('aria-label')?.startsWith(label))!.click()); };
  const expand = (label = 'skills.sh') => click(label);
  const save = () => click('market.settings.save');
  const field = (label: string, index = 0) => Array.from(container.querySelectorAll('label')).filter(node => node.textContent?.startsWith(label))[index].querySelector('input')!;


  it('keeps existing and added sources collapsed until the user edits one', async () => {
    await render();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('input[type=password]')).toBeNull();
    await click('market.settings.add');
    expect(container.querySelectorAll('button[aria-expanded=false]')).toHaveLength(2);
    expect(container.querySelector('select')).toBeNull();
    await expand('market.settings.newSource');
    expect(container.querySelectorAll('select')).toHaveLength(1);
    expect(container.querySelectorAll('button[aria-expanded=true]')).toHaveLength(1);
  });
  it('preserves edits when switching the expanded source', async () => {
    await render();
    await expand();
    await changeInput(field('market.settings.token'), 'draft-key');
    await click('market.settings.add');
    await expand('market.settings.newSource');
    expect(field('market.settings.token').value).toBe('');
    await expand();
    expect(field('market.settings.token').value).toBe('draft-key');
    expect(container.querySelectorAll('button[aria-expanded=true]')).toHaveLength(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('toggles enablement while collapsed without opening the editor', async () => {
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    expect(container.querySelector('select')).toBeNull();
    await save();
    expect(mocks.update.mock.calls[0][1](defaults).sources[0].enabled).toBe(false);
  });
  it('saves a custom registry and masked token, then refreshes the marketplace', async () => {
    await render();
    await expand();
    await chooseSkillHub();
    expect(field('market.settings.token').type).toBe('password');
    await changeInput(field('market.settings.url'), ' https://skills.corp/hub/ ');
    await changeInput(field('market.settings.token'), ' test-token ');
    await save();
    expect(mocks.update).toHaveBeenCalledWith('app.skill_market', expect.any(Function));
    const next = mocks.update.mock.calls[0][1]({ ...defaults, future_field: true });
    expect(next).toEqual({ sources: [{ ...official, provider: 'skillhub', url: 'https://skills.corp/hub', api_token: 'test-token' }], future_field: true });
    expect(mocks.saved).toHaveBeenCalledTimes(1);
  });
  it('saves multiple API formats with independent tokens and enabled states', async () => {
    await render();
    await click('market.settings.add');
    await expand('market.settings.newSource');
    await chooseSkillHub();
    await changeInput(field('market.settings.name'), 'Private');
    await changeInput(field('market.settings.url'), 'https://corp/hub');
    await changeInput(field('market.settings.token'), 'private-key');
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    await save();
    const next = mocks.update.mock.calls[0][1](defaults);
    expect(next.sources).toEqual([
      { ...official, enabled: false },
      { id: expect.any(String), name: 'Private', provider: 'skillhub', url: 'https://corp/hub', enabled: true, api_token: 'private-key' },
    ]);
  });
  it('allows deleting the official source and persists an empty list', async () => {
    await render();
    await click('market.settings.remove');
    expect(container.querySelector('select')).toBeNull();
    await save();
    expect(mocks.update.mock.calls[0][1](defaults).sources).toEqual([]);
  });
  it('allows customizing a skills.sh-compatible API URL and token', async () => {
    await render();
    await expand();
    await changeInput(field('market.settings.url'), 'https://corp/skills-api');
    await changeInput(field('market.settings.token'), 'skills-key');
    await save();
    expect(mocks.update.mock.calls[0][1](defaults).sources[0]).toEqual({ ...official, url: 'https://corp/skills-api', api_token: 'skills-key' });
  });
  it('opens an invalid collapsed source when saving so the user can fix it', async () => {
    await render();
    await click('market.settings.add');
    expect(container.querySelector('select')).toBeNull();
    await save();
    expect(container.querySelector('select')).not.toBeNull();
    expect(field('market.settings.url').value).toBe('');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('market.settings.invalidUrl');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects invalid registry URLs before changing host settings', async () => {
    await render();
    await expand();
    await chooseSkillHub();
    await changeInput(field('market.settings.url'), 'https://user:token@skills.corp');
    await save();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('market.settings.invalidUrl');
  });
  it('shows an explicit unsupported state for older hosts', async () => {
    mocks.get.mockResolvedValue(undefined);
    await render();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('market.settings.unsupported');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('retries a failed settings read without guessing a marketplace', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Host unavailable'));
    await render();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host unavailable');
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('select')).toBeNull();
    await expand();
    expect(container.querySelector('select')?.value).toBe('skills-sh');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('refuses a queued save after leaving the settings host', async () => {
    let update: ((current: SkillMarketConfig) => SkillMarketConfig) | undefined;
    let complete: (() => void) | undefined;
    mocks.update.mockImplementation((_path, callback) => {
      update = callback;
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    await render();
    await save();
    await act(async () => root.render(null));
    expect(() => update?.(defaults)).toThrow('Marketplace settings surface changed');
    await act(async () => complete?.());
    expect(mocks.saved).not.toHaveBeenCalled();
  });
  it('retains edits and reports a failed save without refreshing', async () => {
    mocks.get.mockResolvedValue({ sources: [{ ...official, provider: 'skillhub', url: 'https://skills.corp' }] });
    mocks.update.mockRejectedValue(new Error('Host unavailable'));
    await render();
    await save();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Host unavailable');
    await expand();
    expect(field('market.settings.url').value).toBe('https://skills.corp');
    expect(mocks.saved).not.toHaveBeenCalled();
  });
});
