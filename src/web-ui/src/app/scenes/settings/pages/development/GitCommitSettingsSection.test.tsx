// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GitCommitSettingsSection from './GitCommitSettingsSection';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  aiExperienceConfigService: { getSettingsAsync: mocks.get, saveSettings: mocks.save },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/shared/notification-system', () => ({ useNotification: () => ({ error: mocks.error, success: mocks.success }) }));

let container: HTMLDivElement;
let root: Root;
const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ enable_git_commit_coauthor: false });
  mocks.save.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('Git commit attribution', () => {
  it('keeps older hosts without the optional setting explicitly unsupported', async () => {
    mocks.get.mockResolvedValue({});
    await act(async () => root.render(<GitCommitSettingsSection />));
    expect(toggle().disabled).toBe(true);
    expect(container.textContent).toContain('commitAttribution.unsupported');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('saves only the existing host setting and preserves the previous value on failure', async () => {
    await act(async () => root.render(<GitCommitSettingsSection />));
    mocks.save.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(mocks.error).toHaveBeenCalledWith('messages.saveFailed');
    expect(mocks.success).not.toHaveBeenCalled();
    await act(async () => toggle().click());
    expect(mocks.save).toHaveBeenLastCalledWith({ enable_git_commit_coauthor: true });
    expect(toggle().checked).toBe(true);
  });

  it('locks an unread configuration and retries without writing defaults', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Host unavailable'));
    await act(async () => root.render(<GitCommitSettingsSection />));
    expect(toggle()).toBeNull();
    expect(container.textContent).toContain('messages.loadFailedLocked');
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(toggle().disabled).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
