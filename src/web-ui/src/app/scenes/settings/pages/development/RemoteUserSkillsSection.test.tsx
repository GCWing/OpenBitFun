// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import RemoteUserSkillsSection from './RemoteUserSkillsSection';

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), error: vi.fn() }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({ configManager: {
  hasCachedConfig: () => false, getCachedConfig: () => undefined,
  getConfig: mocks.get, setConfig: mocks.set,
} }));
vi.mock('@openbitfun/ui', async original => ({
  ...await original<typeof import('@openbitfun/ui')>(),
  Select: ({ value, disabled, options, onValueChange }: {
    value: string; disabled: boolean; options: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => <select value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.error } }));

describe('remote user Skill settings', () => {
  let root: Root;
  let container: HTMLDivElement;
  const select = () => container.querySelector('select')!;
  const choose = async (value: string) => act(async () => {
    select().value = value;
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    activateSurface('local');
    vi.clearAllMocks();
    mocks.get.mockReset().mockResolvedValue({ remote_user_skills: 'skill_md_only' });
    mocks.set.mockReset().mockResolvedValue(undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); activateSurface('local'); });

  it('preserves the markdown-only default and saves each choice without replacing other workspace settings', async () => {
    await act(async () => root.render(<RemoteUserSkillsSection />));
    expect(select().value).toBe('skill_md_only');
    expect(container.textContent).toContain('remoteUserSkills.skillMdOnlyDescription');
    await choose('full');
    expect(mocks.set).toHaveBeenLastCalledWith('workspace.remote_user_skills', 'full');
    expect(container.textContent).toContain('remoteUserSkills.syncHint');
    await choose('disabled');
    expect(mocks.set).toHaveBeenLastCalledWith('workspace.remote_user_skills', 'disabled');
    expect(container.textContent).not.toContain('remoteUserSkills.syncHint');
    await choose('skill_md_only');
    expect(mocks.set).toHaveBeenLastCalledWith('workspace.remote_user_skills', 'skill_md_only');
    expect(select().value).toBe('skill_md_only');
  });

  it('locks an older host or unknown future mode instead of writing unsupported configuration', async () => {
    mocks.get.mockResolvedValue({ remote_user_skills: 'future_mode' });
    await act(async () => root.render(<RemoteUserSkillsSection />));
    expect(select().disabled).toBe(true);
    expect(container.textContent).toContain('remoteUserSkills.unsupported');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('keeps older hosts without the field explicitly unsupported', async () => {
    mocks.get.mockResolvedValue({});
    await act(async () => root.render(<RemoteUserSkillsSection />));
    expect(select().disabled).toBe(true);
    expect(container.textContent).toContain('remoteUserSkills.unsupported');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('preserves the persisted mode after a failed write', async () => {
    mocks.set.mockRejectedValue(new Error('Host unavailable'));
    await act(async () => root.render(<RemoteUserSkillsSection />));
    await choose('full');
    expect(select().value).toBe('skill_md_only');
    expect(mocks.error).toHaveBeenCalledWith('remoteUserSkills.saveFailed');
    expect(select().disabled).toBe(false);
  });

  it('locks a failed read and retries without writing a default', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => root.render(<RemoteUserSkillsSection />));
    expect(select()).toBeNull();
    expect(container.textContent).toContain('remoteUserSkills.loadFailed');
    expect(mocks.set).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')!.click());
    expect(select().value).toBe('skill_md_only');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('ignores a completed write from the previously selected device', async () => {
    let finishSave!: () => void;
    mocks.set.mockImplementation(() => new Promise<void>(resolve => { finishSave = resolve; }));
    await act(async () => root.render(<RemoteUserSkillsSection />));
    await choose('full');
    expect(select().disabled).toBe(true);
    activateSurface('peer-device');
    await act(async () => finishSave());
    expect(select().value).toBe('skill_md_only');
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
