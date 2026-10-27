/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import CreateAgentDialog from './CreateAgentDialog';
import CreateAgentPage from './CreateAgentPage';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  detail: vi.fn(),
  update: vi.fn(),
  editingId: null as string | null,
  tools: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  workspace: { id: 'workspace-1' } as { id: string } | null,
}));
vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, formatNumber: String }),
}));
vi.mock('@/infrastructure/contexts/WorkspaceContext', () => ({
  useCurrentWorkspace: () => ({ workspace: mocks.workspace, hasWorkspace: Boolean(mocks.workspace) }),
}));
vi.mock('@/infrastructure/api/service-api/CustomAgentAPI', () => ({
  CustomAgentAPI: { createCustomAgent: mocks.create, getCustomAgentDetail: mocks.detail, updateCustomAgent: mocks.update },
}));
vi.mock('@/infrastructure/api/service-api/ToolAPI', () => ({
  toolAPI: { getAllToolsInfo: mocks.tools },
}));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => ({ error: mocks.error, success: mocks.success }),
}));
vi.mock('../agentsStore', () => ({
  useAgentsStore: () => ({ openHome: vi.fn(), agentEditorMode: mocks.editingId ? 'edit' : 'create', editingAgentId: mocks.editingId }),
}));
vi.mock('./useUserToolGroups', () => ({
  useUserToolGroups: () => ({ groups: [], saveGroups: vi.fn() }),
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmDanger: vi.fn() }));
vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

const tools = [
  { name: 'Read', description: 'Read files', is_readonly: true },
  { name: 'Write', description: 'Write files', is_readonly: false },
  { name: 'WebFetch', description: 'Fetch pages', is_readonly: true },
  { name: 'mcp__github__list_issues', description: 'List GitHub issues', is_readonly: true },
];
let container: HTMLDivElement;
let root: Root;
let onCreated: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;
const copy = (key: string) => `agentsOverview.form.${key}`;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const field = (key: string) => dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id$="-custom-agent-${key}"]`)!;
const promptGroup = () => dialog().querySelector<HTMLElement>('[id$="-custom-agent-prompt"]')!;
const promptEditor = () => (promptGroup().querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
const button = (label: string) => [...dialog().querySelectorAll('button')].find(control => control.textContent === label)!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const submit = async () => {
  await act(async () => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};
const fill = (key: string, value: string) => {
  if (key === 'prompt') {
    act(() => promptEditor().commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
    }));
    return;
  }
  const control = field(key);
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const render = async () => {
  await act(async () => root.render(<CreateAgentDialog onClose={onClose} onCreated={onCreated} />));
};
const completeBasics = async () => {
  fill('id', 'research-helper');
  fill('name', 'Research helper');
  fill('description', 'Research a topic');
  await click(copy('wizard.next'));
  await act(async () => { await vi.dynamicImportSettled(); });
};
const reachTools = async () => {
  await completeBasics();
  fill('prompt', 'Return a summary with sources.');
  await click(copy('wizard.next'));
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.clearAllMocks();
  mocks.workspace = { id: 'workspace-1' };
  mocks.editingId = null;
  mocks.tools.mockReset().mockResolvedValue(tools);
  mocks.create.mockReset().mockResolvedValue(undefined);
  activateSurface('local');
  onCreated = vi.fn();
  onClose = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  activateSurface('local');
});

describe('guided agent creation', () => {
  it('validates each stage and submits only on the tools stage with all drafts intact', async () => {
    await render();
    expect(dialog().querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(dialog().querySelector('textarea')).toBeNull();
    await submit();
    expect(field('name').getAttribute('aria-invalid')).toBe('true');
    expect(field('id').value).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(field('description').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('name'));
    fill('id', '9-invalid');
    fill('description', 'Research a topic');
    await submit();
    expect(field('id').getAttribute('aria-invalid')).toBe('true');
    expect(mocks.create).not.toHaveBeenCalled();

    await completeBasics();
    expect(promptGroup().querySelector('p[data-placeholder]')?.getAttribute('data-placeholder')).toBe(copy('promptPlaceholder'));
    act(() => promptEditor().view.dom.focus());
    expect(promptGroup().querySelector('p[data-placeholder]')?.getAttribute('data-placeholder')).toBe(copy('promptPlaceholder'));
    expect(dialog().querySelector('[id$="-custom-agent-id"]')).toBeNull();
    await submit();
    expect(promptGroup().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(promptEditor().view.dom);
    fill('prompt', 'Return a summary with sources.');
    await submit();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-testid="custom-agent-tool-groups"]')).not.toBeNull();
    expect(dialog().querySelector('.tool-group-picker__sections')).not.toBeNull();
    expect(dialog().querySelector('input[aria-label^="mcp__github__list_issues"]')).toBeNull();
    const write = dialog().querySelector<HTMLInputElement>('input[aria-label^="Write"]')!;
    expect(write.checked).toBe(true);
    act(() => write.click());
    await click(copy('wizard.back'));
    expect(promptEditor().getText()).toBe('Return a summary with sources.');
    await click(copy('wizard.back'));
    expect(field('id').value).toBe('research-helper');
    expect(field('name').value).toBe('Research helper');
    expect(field('description').value).toBe('Research a topic');
    await submit();
    await submit();
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label^="Write"]')!.checked).toBe(false);
    await submit();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: 'research-helper', name: 'Research helper', kind: 'mode', level: 'user',
      description: 'Research a topic', prompt: 'Return a summary with sources.',
      tools: ['Read', 'WebFetch'], userContextPolicy: ['workspace_context', 'workspace_instructions'],
    }));
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens and suggests an ID in a WebView without randomUUID', async () => {
    vi.stubGlobal('crypto', {});
    try {
      await render();
      fill('name', '中文智能体');
      expect(field('id').value).toMatch(/^agent-[a-z0-9]+-[a-z0-9]*$/);
      expect(document.activeElement).toBe(field('name'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps advanced permissions collapsed in the full page and creates from the task template', async () => {
    await act(async () => root.render(<div role="dialog"><CreateAgentPage /></div>));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(field('name').placeholder).toBe(copy('createNamePlaceholder'));
    const permissions = [...dialog().querySelectorAll('summary')].find(summary => summary.textContent === copy('permissionsStandard'))!;
    expect(permissions.closest('details')?.open).toBe(false);
    fill('name', 'Research helper');
    fill('description', 'Research a topic');
    expect(field('id').value).toBe('research-helper');
    await click(copy('usePromptTemplate'));
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'research-helper', name: 'Research helper', description: 'Research a topic',
      prompt: copy('promptTemplate'), readonly: false,
    }));
  });

  it('keeps an existing identifier when the display name changes', async () => {
    mocks.editingId = 'legacy-id';
    mocks.detail.mockResolvedValue({ kind: 'mode', level: 'user', agentId: 'legacy-id', name: 'Existing',
      description: 'Existing goal', prompt: 'Existing instructions', readonly: false, review: false,
      tools: ['Read'], userContextPolicy: ['workspace_context'] });
    mocks.update.mockResolvedValue(undefined);
    await act(async () => root.render(<div role="dialog"><CreateAgentPage /></div>));
    await act(async () => { await vi.dynamicImportSettled(); });
    fill('name', 'New display name');
    expect(field('id').disabled).toBe(true);
    expect(field('id').value).toBe('legacy-id');
    await submit();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'legacy-id', name: 'New display name' }));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('starts with a name, generates a portable ID and preserves a manual override', async () => {
    await render();
    expect(document.activeElement).toBe(field('name'));
    fill('name', 'Research helper');
    expect(field('id').value).toBe('research-helper');
    fill('id', 'my-stable-id');
    fill('name', 'Renamed helper');
    expect(field('id').value).toBe('my-stable-id');
    fill('description', 'Research a topic');
    await submit();
    await act(async () => { await vi.dynamicImportSettled(); });
    await click(copy('usePromptTemplate'));
    expect(promptEditor().getText()).toContain(copy('promptTemplate'));
    expect(button(copy('usePromptTemplate'))).toBeUndefined();
    await submit();
    expect(dialog().querySelector('[data-testid="custom-agent-tool-groups"]')?.closest('details')?.open).toBe(false);
  });

  it.each(['text', 'source-html', 'markdown-editor'])('renders pasted Markdown from %s and keeps its structure across steps', async (format) => {
    await render();
    await completeBasics();
    expect(promptGroup().querySelector('textarea')).toBeNull();
    const markdown = '## Role\n\n{PERSONA}\n\n- Return evidence.';
    const sourceHtml = document.createElement('div');
    for (const line of markdown.split('\n')) {
      sourceHtml.appendChild(document.createElement('div')).textContent = line || '\u00a0';
    }
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: {
      getData: (type: string) => {
        if (type === 'text/plain') return markdown;
        if (type === 'text/html' && format !== 'text') return sourceHtml.outerHTML;
        if (type === 'vscode-editor-data' && format === 'markdown-editor') return '{"version":1,"mode":"markdown"}';
        return '';
      },
      files: [],
      types: format === 'text' ? ['text/plain'] : ['text/plain', 'text/html'],
    } });
    act(() => { promptEditor().view.dom.dispatchEvent(paste); });
    expect(promptGroup().querySelector('h2')?.textContent).toBe('Role');
    expect(promptGroup().getAttribute('aria-invalid')).toBeNull();
    await click(copy('wizard.next'));
    await click(copy('wizard.back'));
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(promptGroup().querySelector('h2')?.textContent).toBe('Role');
    expect(promptGroup().querySelector('li')?.textContent).toBe('Return evidence.');
    await click(copy('wizard.next'));
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '## Role\n\n{PERSONA}\n\n- Return evidence.',
    }));
  });

  it('keeps project subagent selection and enforces readonly tools for review', async () => {
    await render();
    await click('filters.subagent');
    await click('agentsOverview.filterProject');
    await reachTools();
    const review = dialog().querySelector<HTMLInputElement>(`input[aria-label="${copy('review')}"]`)!;
    act(() => review.click());
    const readonly = dialog().querySelector<HTMLInputElement>(`input[aria-label="${copy('readonly')}"]`)!;
    expect(readonly.checked).toBe(true);
    expect(readonly.disabled).toBe(true);
    expect(dialog().querySelector('input[aria-label^="Write"]')).toBeNull();
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'subagent', level: 'project', workspaceId: 'workspace-1', review: true, readonly: true, tools: ['Read'],
    }));
  });

  it('shows tool load errors and allows retry without losing the completed fields', async () => {
    mocks.tools.mockRejectedValueOnce(new Error('Peer offline'));
    await render();
    await reachTools();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(copy('wizard.toolsLoadFailed'));
    expect(button(copy('submit')).disabled).toBe(true);
    await submit();
    expect(mocks.create).not.toHaveBeenCalled();
    await click(copy('wizard.retry'));
    expect(button(copy('submit')).disabled).toBe(false);
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'research-helper', prompt: 'Return a summary with sources.' }));
  });

  it('blocks creation while tools load and preserves a failed submission for retry', async () => {
    let resolveTools!: (value: typeof tools) => void;
    mocks.tools.mockReturnValueOnce(new Promise(resolve => { resolveTools = resolve; }));
    await render();
    await reachTools();
    expect(dialog().querySelector('[role="status"]')?.textContent).toBe(copy('wizard.loadingTools'));
    expect(button(copy('submit')).disabled).toBe(true);
    await submit();
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () => resolveTools(tools));
    mocks.create.mockRejectedValueOnce(new Error('Connection lost'));
    await submit();
    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
    expect(button(copy('submit')).disabled).toBe(false);
    await submit();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('preserves project scope and context choices when tools finish loading later', async () => {
    let resolveTools!: (value: typeof tools) => void;
    mocks.tools.mockReturnValueOnce(new Promise(resolve => { resolveTools = resolve; }));
    await render();
    await click('filters.subagent');
    await click('agentsOverview.filterProject');
    await completeBasics();
    await click(copy('contextProjectLayout'));
    fill('prompt', 'Review project changes.');
    await submit();
    const readonly = dialog().querySelector<HTMLInputElement>(`input[aria-label="${copy('readonly')}"]`)!;
    act(() => readonly.click());
    await act(async () => resolveTools(tools));
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'subagent', level: 'project', workspaceId: 'workspace-1', readonly: false,
      userContextPolicy: ['workspace_context', 'workspace_instructions', 'project_layout'],
    }));
  });

  it('ignores completion from the previous peer after switching surfaces', async () => {
    let finishCreate!: () => void;
    mocks.create.mockReturnValueOnce(new Promise<void>(resolve => { finishCreate = resolve; }));
    await render();
    await reachTools();
    await submit();
    await act(async () => { activateSurface('peer-device'); });
    await act(async () => finishCreate());
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(field('id').value).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(field('name').value).toBe('');
  });

  it('resets the draft when the workspace or peer surface changes', async () => {
    await render();
    await completeBasics();
    mocks.workspace = { id: 'workspace-2' };
    await render();
    expect(field('id').value).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(field('name').value).toBe('');
    expect(dialog().querySelector('textarea')).toBeNull();
    await completeBasics();
    await act(async () => { activateSurface('peer-device'); });
    expect(field('id').value).toMatch(/^agent-[a-f0-9]{8}$/);
    expect(field('name').value).toBe('');
    expect(dialog().querySelector('textarea')).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
