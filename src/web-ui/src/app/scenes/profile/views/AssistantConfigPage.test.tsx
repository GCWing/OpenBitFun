// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AssistantConfigPage from './AssistantConfigPage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => '# Original'),
  writeFile: vi.fn(async () => {}),
  reloadIdentity: vi.fn(async () => {}),
  scheduledMount: vi.fn(),
  notifyError: vi.fn(),
  changeDocument: undefined as ((content: string) => void) | undefined,
}));

vi.mock('@/infrastructure/i18n', () => ({ i18nService: { formatNumber: (n: number) => String(n) } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/types', () => ({ WorkspaceKind: { Assistant: 'assistant' } }));
vi.mock('@/infrastructure/api/service-api/WorkspaceAPI', () => ({
  workspaceAPI: { readWorkspaceFile: mocks.readFile, writeWorkspaceFile: mocks.writeFile },
}));
vi.mock('@/shared/notification-system', () => ({ notificationService: { error: mocks.notifyError } }));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    allAssistantWorkspacesList: [{ id: 'assistant-1', rootPath: '/assistants/one' }],
  }),
}));
vi.mock('../nurseryStore', () => ({
  useNurseryStore: () => ({ activeWorkspaceId: 'assistant-1', openGallery: vi.fn() }),
}));
vi.mock('@/app/scenes/my-agent/myAgentStore', () => ({ useMyAgentStore: () => null }));
vi.mock('@/app/scenes/my-agent/useAgentIdentityDocument', () => ({
  useAgentIdentityDocument: () => ({
    document: { name: 'Assistant', creature: '', vibe: '', avatar: '', emoji: '' },
    saveStatus: 'idle',
    updateField: vi.fn(),
    reload: mocks.reloadIdentity,
  }),
}));
vi.mock('./AssistantAvatarPicker', () => ({ default: () => null }));
vi.mock('./AssistantQuickInput', () => ({ default: () => null }));
vi.mock('@/app/components/NavPanel/sections/sessions/SessionsSection', () => ({ default: () => null }));
vi.mock('@/app/components/scheduled-jobs/ScheduledJobsView', () => ({
  default: () => {
    React.useEffect(() => { mocks.scheduledMount(); }, []);
    return <input aria-label="Scheduled job draft" />;
  },
}));
vi.mock('@/tools/editor/meditor/utils/tiptapMarkdown', () => ({
  analyzeMarkdownEditability: () => ({ mode: 'safe' }),
}));
vi.mock('@/tools/editor/meditor', () => ({
  MEditor: ({ onChange }: { onChange: (content: string) => void }) => {
    mocks.changeDocument = onChange;
    return null;
  },
  EditArea: () => null,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  const media = new EventTarget();
  Object.defineProperty(media, 'matches', { value: false });
  vi.stubGlobal('matchMedia', () => media);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  { index: 0, file: 'IDENTITY.md', close: 'button' },
  { index: 1, file: 'SOUL.md', close: 'escape' },
  { index: 2, file: 'USER.md', close: 'outside' },
])('opens $file in a dialog and saves edits on $close dismissal', async ({ index, file, close }) => {
  await act(async () => { root.render(<AssistantConfigPage />); });
  const scheduleDraft = container.querySelector<HTMLInputElement>('[aria-label="Scheduled job draft"]')!;
  scheduleDraft.value = 'Keep my schedule draft';
  const documentButtons = container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-part="persona"] button');

  const trigger = documentButtons[index];
  trigger.focus();
  await act(async () => { trigger.click(); });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.textContent).toContain(file);
  expect(dialog.querySelector('[data-openbitfun-part="editor"]')).not.toBeNull();
  expect(container.querySelector('[data-openbitfun-part="editor"]')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(mocks.readFile).toHaveBeenCalledWith('assistant-1', `/assistants/one/${file}`);

  act(() => { mocks.changeDocument?.('# Updated document'); });
  expect(mocks.writeFile).not.toHaveBeenCalled();

  await act(async () => {
    if (close === 'button') {
      dialog.querySelector<HTMLButtonElement>('[aria-label="nursery.assistant.closeDetail"]')!.click();
    } else if (close === 'escape') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else {
      dialog.parentElement!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    }
  });
  expect(mocks.writeFile).toHaveBeenCalledWith('assistant-1', `/assistants/one/${file}`, '# Updated document');
  expect(mocks.reloadIdentity).toHaveBeenCalledTimes(file === 'IDENTITY.md' ? 1 : 0);
  expect(dialog.dataset.state).toBe('exiting');
  expect(dialog.textContent).toContain(file);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(scheduleDraft.isConnected).toBe(true);
  expect(scheduleDraft.value).toBe('Keep my schedule draft');
  expect(mocks.scheduledMount).toHaveBeenCalledOnce();
  expect(mocks.writeFile).toHaveBeenCalledOnce();
});

it('saves immediately from the footer and orders subsequent autosaves after the manual save', async () => {
  let finishSave!: () => void;
  mocks.writeFile.mockImplementationOnce(() => new Promise<void>(resolve => { finishSave = resolve; }));
  await act(async () => { root.render(<AssistantConfigPage />); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-openbitfun-part="persona"] button')!.click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('footer button')!;
  expect(save.disabled).toBe(true);
  act(() => { mocks.changeDocument?.('# Manual edit'); });
  expect(save.disabled).toBe(false);
  await act(async () => { save.click(); });
  expect(mocks.writeFile).toHaveBeenCalledWith('assistant-1', '/assistants/one/IDENTITY.md', '# Manual edit');
  expect(save.getAttribute('aria-busy')).toBe('true');
  expect(save.disabled).toBe(true);
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(mocks.writeFile).toHaveBeenCalledOnce();

  act(() => { mocks.changeDocument?.('# Later edit'); });
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(mocks.writeFile).toHaveBeenCalledOnce();
  await act(async () => { finishSave(); });
  expect(mocks.writeFile).toHaveBeenLastCalledWith('assistant-1', '/assistants/one/IDENTITY.md', '# Later edit');
  expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  expect(save.getAttribute('aria-busy')).toBeNull();
  expect(save.disabled).toBe(true);
  expect(dialog.dataset.state).toBe('open');
});

it('keeps failed manual edits available to retry from the save button', async () => {
  mocks.writeFile.mockRejectedValueOnce(new Error('Write failed'));
  await act(async () => { root.render(<AssistantConfigPage />); });
  await act(async () => {
    container.querySelectorAll<HTMLButtonElement>('[data-openbitfun-part="persona"] button')[1].click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const save = dialog.querySelector<HTMLButtonElement>('footer button')!;
  act(() => { mocks.changeDocument?.('# Retry this edit'); });
  await act(async () => { save.click(); });
  expect(mocks.notifyError).toHaveBeenCalledWith('nursery.assistant.personaDocSaveFailed');
  expect(dialog.dataset.state).toBe('open');
  expect(save.disabled).toBe(false);
  await act(async () => { save.click(); });
  expect(mocks.writeFile).toHaveBeenLastCalledWith('assistant-1', '/assistants/one/SOUL.md', '# Retry this edit');
  expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  expect(save.disabled).toBe(true);
});
