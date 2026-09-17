import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { activateSurface, getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { FileOperationToolCard } from './FileOperationToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  dispatchSession: false,
  openDispatchFile: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  snapshotsAvailable: true,
  emitSnapshotEvent: vi.fn(),
  getOperationSummary: vi.fn(async () => null),
  currentWorkspace: undefined as undefined | { rootPath: string; connectionId?: string },
  createDiffEditorTab: vi.fn(),
  openFile: vi.fn(),
  codePreviewProps: [] as Array<Record<string, unknown>>,
  inlineDiffPreviewProps: [] as Array<Record<string, unknown>>,
  getOperationDiff: vi.fn(async () => ({
    originalContent: '',
    modifiedContent: '',
    anchorLine: undefined,
  })),
  typewriterMode: 'passthrough' as 'passthrough' | 'partial',
  writePlanDisplayProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('../session-drivers/sessionFileNavigation', () => ({
  hasSessionFileProvider: () => mocks.dispatchSession,
  openFileThroughSession: (...args: unknown[]) => {
    if (!mocks.dispatchSession) return false;
    void mocks.openDispatchFile(...args);
    return true;
  },
}));

vi.mock('./WritePlanDisplay', () => ({
  WritePlanDisplay: (props: Record<string, unknown>) => {
    mocks.writePlanDisplayProps.push(props);
    return <div data-testid="write-plan-display" />;
  },
}));

vi.mock('../hooks/useTypewriter', () => ({
  useTypewriter: (targetText: string, animate: boolean) => {
    if (mocks.typewriterMode === 'partial' && animate) {
      return {
        displayText: targetText.slice(0, Math.max(0, Math.floor(targetText.length / 2))),
        isRevealing: true,
      };
    }
    return {
      displayText: targetText,
      isRevealing: false,
    };
  },
}));

vi.mock('../hooks/typewriterRevealGateContext', () => ({
  useReportTypewriterReveal: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../tools/snapshot_system/hooks/useSnapshotState', () => ({
  useSnapshotState: () => ({
    surfaceEpoch: getActiveSurfaceScope().epoch,
    snapshotsAvailable: mocks.snapshotsAvailable,
    files: [],
    error: null,
    clearError: vi.fn(),
  }),
}));

vi.mock('../../tools/snapshot_system/core/SnapshotEventBus', () => ({
  SNAPSHOT_EVENTS: {
    FILE_OPERATION_COMPLETED: 'file-operation-completed',
  },
  SnapshotEventBus: {
    getInstance: () => ({
      emit: mocks.emitSnapshotEvent,
    }),
  },
}));

vi.mock('../components/CodePreview', () => ({
  CodePreview: (props: Record<string, unknown>) => {
    mocks.codePreviewProps.push(props);
    return <pre>{String(props.content ?? '')}</pre>;
  },
}));

vi.mock('../components/InlineDiffPreview', () => ({
  InlineDiffPreview: (props: Record<string, unknown>) => {
    mocks.inlineDiffPreviewProps.push(props);
    return <pre>{String(props.modifiedContent ?? '')}</pre>;
  },
}));

vi.mock('../../shared/utils/tabUtils', () => ({
  createDiffEditorTab: mocks.createDiffEditorTab,
}));

vi.mock('../../shared/services/FileTabManager', () => ({
  fileTabManager: {
    openFile: mocks.openFile,
  },
}));

vi.mock('../../infrastructure/api', () => ({
  snapshotAPI: {
    getOperationDiff: mocks.getOperationDiff,
    getOperationSummary: mocks.getOperationSummary,
  },
}));

vi.mock('../../infrastructure/contexts/WorkspaceContext', () => ({
  useOptionalCurrentWorkspace: () => ({
    workspace: mocks.currentWorkspace,
  }),
}));

describe('FileOperationToolCard', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    activateSurface('local');
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

    mocks.currentWorkspace = undefined;
    mocks.snapshotsAvailable = true;
    mocks.emitSnapshotEvent.mockClear();
    mocks.getOperationSummary.mockClear();
    mocks.createDiffEditorTab.mockReset();
    mocks.openFile.mockReset();
    mocks.codePreviewProps = [];
    mocks.inlineDiffPreviewProps = [];
    mocks.typewriterMode = 'passthrough';
    mocks.writePlanDisplayProps = [];
    mocks.getOperationDiff.mockReset();
    mocks.getOperationDiff.mockResolvedValue({
      originalContent: '',
      modifiedContent: '',
      anchorLine: undefined,
    });
  });

  it('routes recorded target snapshots through the target file query without controller snapshot IO', async () => {
    mocks.dispatchSession = true;
    try {
      const toolItem = {
        id: 'dispatch-edit', type: 'tool', toolName: 'Edit', status: 'completed', endTime: 10,
        toolCall: { id: 'call-1', name: 'Edit', input: { file_path: '/target/file.ts', old_string: 'before', new_string: 'after' } },
        toolResult: { success: true, result: { snapshot_recorded: true } },
      } as FlowToolItem;
      const config = { toolName: 'Edit', displayName: 'Edit', icon: 'EDIT', requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'standard' } as ToolCardConfig;
      await act(async () => root.render(<FileOperationToolCard toolItem={toolItem} config={config} sessionId="dispatch-session" />));
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="chat-file-change-open-file"]')?.click(); });
      expect(mocks.openDispatchFile).toHaveBeenCalledWith('dispatch-session', '/target/file.ts', 'file.ts');
      expect(mocks.getOperationSummary).not.toHaveBeenCalled();
      expect(mocks.getOperationDiff).not.toHaveBeenCalled();
      expect(mocks.openFile).not.toHaveBeenCalled();
    } finally {
      mocks.dispatchSession = false;
    }
  });

  it('keeps remote file results usable without summary, diff, or refresh snapshot requests', async () => {
    mocks.snapshotsAvailable = false;
    const config = {
      toolName: 'Edit', displayName: 'Edit', icon: 'EDIT',
      requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'standard',
    } as ToolCardConfig;
    const running = {
      id: 'remote-edit', type: 'tool', toolName: 'Edit', status: 'running',
      toolCall: {
        id: 'remote-call', name: 'Edit',
        input: { file_path: '/workspace/file.ts', old_string: 'old\n', new_string: 'new\nnext\n' },
      },
    } as FlowToolItem;
    await act(async () => {
      root.render(<FileOperationToolCard toolItem={running} config={config} sessionId="ssh-session" />);
    });
    await act(async () => {
      root.render(<FileOperationToolCard
        toolItem={{ ...running, status: 'completed', endTime: 10, toolResult: { success: true, result: {} } }}
        config={config} sessionId="ssh-session"
      />);
    });

    expect(mocks.getOperationSummary).not.toHaveBeenCalled();
    expect(mocks.emitSnapshotEvent).not.toHaveBeenCalled();
    expect(container.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+2');
    expect(container.querySelector('[data-openbitfun-change="removed"]')?.textContent).toBe('-1');
    const openButton = container.querySelector('[data-testid="chat-file-change-open-file"]');
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.getOperationDiff).not.toHaveBeenCalled();
    expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/workspace/file.ts', mode: 'agent',
    }));
  });

  it('loads a recorded remote operation without enabling incomplete Session snapshots', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.snapshotsAvailable = false;
    mocks.getOperationDiff.mockResolvedValueOnce({ originalContent: 'before', modifiedContent: 'after', anchorLine: undefined });
    const config = {
      toolName: 'Edit', displayName: 'Edit', icon: 'EDIT',
      requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'standard',
    } as ToolCardConfig;
    const item = {
      id: 'recorded-remote-edit', type: 'tool', toolName: 'Edit', status: 'completed', endTime: 10,
      toolCall: {
        id: 'recorded-call', name: 'Edit',
        input: { file_path: '/workspace/file.ts', old_string: 'old', new_string: 'new' },
      },
      toolResult: { success: true, result: { snapshot_recorded: true } },
    } as FlowToolItem;
    await act(async () => {
      root.render(<FileOperationToolCard toolItem={item} config={config} sessionId="ssh-session" />);
    });
    expect(mocks.getOperationSummary).toHaveBeenCalledWith('ssh-session', 'recorded-call');
    expect(mocks.emitSnapshotEvent).not.toHaveBeenCalled();
    const openButton = container.querySelector('[data-testid="chat-file-change-open-file"]');
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.getOperationDiff).toHaveBeenCalledWith('ssh-session', '/workspace/file.ts', 'recorded-call');
    await act(async () => { await vi.advanceTimersByTimeAsync(260); });
    expect(mocks.createDiffEditorTab).toHaveBeenCalledWith(
      '/workspace/file.ts', 'file.ts', 'before', 'after', true, 'agent', undefined, undefined, true,
    );
    expect(mocks.openFile).not.toHaveBeenCalled();

    mocks.createDiffEditorTab.mockClear();
    await act(async () => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    activateSurface('peer-b');
    await act(async () => { await vi.advanceTimersByTimeAsync(260); });
    expect(mocks.createDiffEditorTab).not.toHaveBeenCalled();

  });

  it('replaces an existing remote diff in the same Workbench resource', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.snapshotsAvailable = false;
    const tabUtils = await vi.importActual<typeof import('../../shared/utils/tabUtils')>(
      '../../shared/utils/tabUtils',
    );
    const { useContentResourceStore } = await vi.importActual<
      typeof import('../../app/workbench/contentResourceStore')
    >('../../app/workbench/contentResourceStore');
    const { useSceneStore } = await vi.importActual<typeof import('../../app/stores/sceneStore')>(
      '../../app/stores/sceneStore',
    );
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
    mocks.createDiffEditorTab.mockImplementation(tabUtils.createDiffEditorTab);
    const config = {
      toolName: 'Edit', displayName: 'Edit', icon: 'EDIT',
      requiresConfirmation: false, resultDisplayType: 'detailed', displayMode: 'standard',
    } as ToolCardConfig;
    for (const operationId of ['operation-1', 'operation-2']) {
      mocks.getOperationDiff.mockResolvedValueOnce({
        originalContent: `${operationId} before`, modifiedContent: `${operationId} after`, anchorLine: undefined,
      });
      const item = {
        id: operationId, type: 'tool', toolName: 'Edit', status: 'completed', endTime: 10,
        toolCall: {
          id: operationId, name: 'Edit',
          input: { file_path: '/workspace/file.ts', old_string: 'old', new_string: 'new' },
        },
        toolResult: { success: true, result: { snapshot_recorded: true } },
      } as FlowToolItem;
      await act(async () => root.render(<FileOperationToolCard toolItem={item} config={config} sessionId="ssh-session" />));
      await act(async () => {
        container.querySelector('[data-testid="chat-file-change-open-file"]')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(260); });
    }
    const resources = Object.values(useContentResourceStore.getState().resources);
    expect(resources).toHaveLength(1);
    expect(resources[0].content).toMatchObject({
      type: 'diff-code-editor',
      data: {
        originalCode: 'operation-2 before',
        modifiedCode: 'operation-2 after',
        readOnly: true,
      },
    });
    expect(useSceneStore.getState().openTabs.filter(tab => tab.contentId)).toEqual([
      expect.objectContaining({ contentId: resources[0].id }),
    ]);
  });

  it('routes only successful Write calls for .plan.md files to the plan display', async () => {
    mocks.currentWorkspace = {
      rootPath: 'D:/workspace/project',
      connectionId: 'remote-1',
    };
    const content = '---\nname: Plan\noverview: Test the plan card.\ntodos: []\n---\n\n# Plan\n\nDetails.';
    const toolItem: FlowToolItem = {
      id: 'tool-plan',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      toolCall: {
        id: 'call-plan',
        name: 'Write',
        input: {
          payload: `+++ .openbitfun/plans/test.plan.md\n${content}`,
        },
      },
      toolResult: {
        success: true,
        result: { file_path: '.openbitfun/plans/test.plan.md' },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={{} as ToolCardConfig}
          sessionId="session-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="write-plan-display"]')).not.toBeNull();
    expect(mocks.writePlanDisplayProps).toHaveLength(1);
    expect(mocks.writePlanDisplayProps[0]).toMatchObject({
      planFilePath: 'D:/workspace/project/.openbitfun/plans/test.plan.md',
      initialContent: content,
      workspacePath: 'D:/workspace/project',
      remoteConnectionId: 'remote-1',
    });
  });

  it('keeps Edit calls for .plan.md files on the normal file operation card', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-plan-edit',
      type: 'tool',
      toolName: 'Edit',
      status: 'completed',
      toolCall: {
        id: 'call-plan-edit',
        name: 'Edit',
        input: {
          file_path: '.openbitfun/plans/test.plan.md',
          old_string: 'Old',
          new_string: 'New',
        },
      },
      toolResult: {
        success: true,
        result: { file_path: '.openbitfun/plans/test.plan.md' },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={{} as ToolCardConfig}
          sessionId="session-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="write-plan-display"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-card"]')).not.toBeNull();
  });

  it('keeps failed .plan.md writes on the normal error card', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-plan-error',
      type: 'tool',
      toolName: 'Write',
      status: 'error',
      toolCall: {
        id: 'call-plan-error',
        name: 'Write',
        input: {
          payload: '+++ .openbitfun/plans/test.plan.md\npartial',
        },
      },
      toolResult: {
        success: false,
        error: 'Write failed',
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={{} as ToolCardConfig}
          sessionId="session-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="write-plan-display"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-card"]')).not.toBeNull();
  });

  it('does not treat a successful fallback write as a completed plan', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-plan-fallback',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      toolCall: {
        id: 'call-plan-fallback',
        name: 'Write',
        input: {
          payload: '+++ .openbitfun/plans/test.plan.md\npartial',
        },
      },
      toolResult: {
        success: true,
        result: {
          file_path: '.openbitfun/tmp/write-callplanfallback.txt',
          used_fallback_path: true,
        },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={{} as ToolCardConfig}
          sessionId="session-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="write-plan-display"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-card"]')).not.toBeNull();
  });

  afterEach(() => {
    vi.useRealTimers();
    activateSurface('local');
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  it('keeps failed write cards compact until the user expands the error', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'error',
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'src/newFile.ts',
          content: 'export const value = 1;',
        },
      },
      toolResult: {
        success: false,
        error: 'Arguments are invalid JSON.',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    expect(() => {
      act(() => {
        root.render(
          <FileOperationToolCard
            toolItem={toolItem}
            config={config}
            sessionId="session-1"
          />
        );
      });
    }).not.toThrow();

    expect(container.textContent).toContain('toolCards.file.write');
    expect(container.textContent).toContain('toolCards.file.failed');
    expect(container.textContent).toContain('newFile.ts');
    expect(container.textContent).not.toContain('Arguments are invalid JSON.');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).not.toBeNull();
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();

    const toggle = container.querySelector(
      '[data-openbitfun-part="affordanceButton"]',
    ) as HTMLButtonElement | null;
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="chat-file-change-card"]')?.getAttribute('data-expanded')).toBe('true');
    expect(container.querySelector('[data-openbitfun-part="error"]')).not.toBeNull();
    expect(container.textContent).toContain('Arguments are invalid JSON.');
  });

  it('collapses an open edit preview when the operation changes to failed', async () => {
    const config: ToolCardConfig = {
      toolName: 'Edit',
      displayName: 'Edit',
      icon: 'EDIT',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Edit a file',
      displayMode: 'standard',
    };
    const running = {
      id: 'tool-edit-transition',
      type: 'tool',
      toolName: 'Edit',
      status: 'running',
      toolCall: {
        id: 'call-edit-transition',
        name: 'Edit',
        input: {
          file_path: 'src/index.ts',
          old_string: 'before',
          new_string: 'after',
        },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(<FileOperationToolCard toolItem={running} config={config} sessionId="session-1" />);
    });
    expect(container.querySelector('[data-testid="chat-file-change-card"]')?.getAttribute('data-expanded')).toBe('true');

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={{
            ...running,
            status: 'error',
            toolResult: { success: false, error: 'The target text was not found.' },
          }}
          config={config}
          sessionId="session-1"
        />,
      );
    });

    expect(container.querySelector('[data-testid="chat-file-change-card"]')?.getAttribute('data-expanded')).toBe('false');
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();
    expect(container.textContent).not.toContain('The target text was not found.');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).not.toBeNull();
  });

  it('opens completed write cards with the resolved result path', async () => {
    mocks.currentWorkspace = { rootPath: 'D:/workspace/project' };

    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'newFile.ts',
          content: 'export const value = 1;',
        },
      },
      toolResult: {
        success: true,
        result: {
          file_path: 'D:/workspace/project/src/newFile.ts',
          bytes_written: 23,
          success: true,
        },
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    const openButton = container.querySelector('[data-testid="chat-file-change-open-file"]') as HTMLButtonElement | null;
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.getOperationDiff).toHaveBeenCalledWith(
      'session-1',
      'D:/workspace/project/src/newFile.ts',
      'call-1',
    );
    expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'D:/workspace/project/src/newFile.ts',
      fileName: 'newFile.ts',
      mode: 'agent',
    }));
  });

  it('renders only the expand and open-panel controls after change metadata', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          filepath: 'src/newFile.ts',
          content: 'export const value = 1;\n',
        },
      },
      toolResult: {
        success: true,
        result: {
          success: true,
        },
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };
    const openInEditor = vi.fn();

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          onOpenInEditor={openInEditor}
        />
      );
    });

    const contentRegion = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="content"]',
    );
    const extraRegion = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="extra"]',
    );
    const changeSummary = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="changeSummary"]',
    );
    expect(contentRegion?.querySelector('[data-testid="chat-file-change-path"]')).not.toBeNull();
    expect(contentRegion?.querySelector('[data-openbitfun-part="changeSummary"]')).toBeNull();
    expect(extraRegion?.contains(changeSummary)).toBe(true);
    expect(changeSummary?.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+1');
    expect(changeSummary?.querySelector('[data-openbitfun-change="removed"]')?.textContent).toBe('-0');
    expect(changeSummary?.querySelector('svg')).toBeNull();

    const actionRegion = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="actionRegion"]',
    );
    const actionButtons = Array.from(actionRegion?.querySelectorAll('button') ?? []);
    const openButton = container.querySelector(
      '[data-testid="chat-file-change-open-file"]',
    ) as HTMLButtonElement | null;

    expect(container.querySelector('[data-testid="chat-file-change-open-diff"]')).toBeNull();
    expect(actionButtons).toHaveLength(2);
    expect(actionButtons[0]?.getAttribute('data-openbitfun-part')).toBe('affordanceButton');
    expect(actionButtons[1]).toBe(openButton);
    expect(openButton?.getAttribute('data-openbitfun-affordance')).toBe('open-panel-right');
    expect(openButton?.querySelector('[data-openbitfun-icon="open-panel-right"]')).not.toBeNull();
    expect(openButton?.closest('[data-openbitfun-part="trailingActions"]')?.getAttribute('data-divider')).toBe('true');

    await act(async () => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.getOperationDiff).not.toHaveBeenCalled();
    expect(openInEditor).toHaveBeenCalledWith('src/newFile.ts');
  });

  it('places completed edit changes in the right-side summary without git decoration', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-edit',
      type: 'tool',
      toolName: 'Edit',
      status: 'completed',
      toolCall: {
        id: 'call-edit',
        name: 'Edit',
        input: {
          file_path: 'src/styles.css',
          old_string: 'color: red;\n',
          new_string: 'color: blue;\nbackground: white;\n',
        },
      },
      toolResult: {
        success: true,
        result: {
          file_path: 'src/styles.css',
        },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={{
            toolName: 'Edit',
            displayName: 'Edit',
            icon: 'EDIT',
            requiresConfirmation: false,
            resultDisplayType: 'detailed',
            description: 'Edit a file',
            displayMode: 'standard',
          }}
        />
      );
    });

    const contentRegion = container.querySelector('[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="content"]');
    const extraRegion = container.querySelector('[data-openbitfun-part="extra"]');
    const changeSummary = extraRegion?.querySelector('[data-openbitfun-part="changeSummary"]');

    expect(contentRegion?.textContent).toContain('styles.css');
    expect(contentRegion?.querySelector('[data-openbitfun-part="changeSummary"]')).toBeNull();
    expect(changeSummary?.querySelector('[data-openbitfun-change="added"]')?.textContent).toBe('+2');
    expect(changeSummary?.querySelector('[data-openbitfun-change="removed"]')?.textContent).toBe('-1');
    expect(changeSummary?.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-testid="chat-file-change-open-diff"]')).toBeNull();
  });

  it('renders completed ACP file cards from result locations when input has no path', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          title: 'Run Write',
        },
      },
      toolResult: {
        success: true,
        result: {
          content: [],
          locations: [
            {
              path: 'src/from-acp-location.ts',
            },
          ],
        },
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(container.textContent).toContain('from-acp-location.ts');
    expect(container.textContent).not.toContain('toolCards.file.parsingPath');
  });

  it('renders write guardrail blocks as guidance instead of hard failure', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'error',
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'docs/report.md',
        },
      },
      toolResult: {
        success: false,
        error:
          '[guidance] Use Read to load the current contents of docs/report.md before calling Write on it.',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(container.textContent).not.toContain('toolCards.file.guidanceHint');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.failed');
    expect(container.textContent).toContain('report.md');
    expect(container.textContent).not.toContain(
      'Use Read to load the current contents of docs/report.md before calling Write on it.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();

    await act(async () => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain(
      'Use Read to load the current contents of docs/report.md before calling Write on it.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"] [data-guidance="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.guidanceTitle');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
  });

  it('renders edit guardrail blocks as guidance instead of hard failure', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-2',
      type: 'tool',
      toolName: 'Edit',
      status: 'error',
      toolCall: {
        id: 'call-2',
        name: 'Edit',
        input: {
          file_path: 'src/main.rs',
          old_string: 'foo',
          new_string: 'bar',
        },
      },
      toolResult: {
        success: false,
        error:
          '[guidance] Use Read to load the current contents of src/main.rs before calling Edit on it.',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Edit',
      displayName: 'Edit',
      icon: 'EDIT',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Edit a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(container.textContent).not.toContain('toolCards.file.guidanceHint');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.failed');
    expect(container.textContent).toContain('main.rs');
    expect(container.textContent).not.toContain(
      'Use Read to load the current contents of src/main.rs before calling Edit on it.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();

    await act(async () => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain(
      'Use Read to load the current contents of src/main.rs before calling Edit on it.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"] [data-guidance="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.guidanceTitle');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
  });

  it.each(['edit_no_change', 'edit_target_not_found', 'edit_target_ambiguous'])('renders structured %s quietly even when the outer status is completed', async (code) => {
    const toolItem: FlowToolItem = {
      id: 'tool-2',
      type: 'tool',
      toolName: 'Edit',
      status: 'completed',
      toolCall: {
        id: 'call-2',
        name: 'Edit',
        input: {
          file_path: 'src/main.rs',
          old_string: 'foo',
          new_string: 'bar',
        },
      },
      toolResult: {
        success: false,
        result: { error_detail: { code, kind: 'guidance' } },
        error:
          'Edit inputs need correction.',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Edit',
      displayName: 'Edit',
      icon: 'EDIT',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Edit a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(container.textContent).not.toContain('toolCards.file.guidanceHint');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.failed');
    expect(container.textContent).toContain('main.rs');
    expect(container.textContent).not.toContain(
      'Edit inputs need correction.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"]')).toBeNull();

    await act(async () => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')
        ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain(
      'Edit inputs need correction.',
    );
    expect(container.querySelector('[data-openbitfun-part="error"] [data-guidance="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('toolCards.file.guidanceTitle');
    expect(container.querySelector('[data-openbitfun-icon="warning"]')).toBeNull();
  });

  it('shows receiving content label while write content streams before file_path', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'receiving',
      isParamsStreaming: true,
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          content: 'const value = 1;',
        },
      },
      partialParams: {
        content: 'const value = 1;',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(container.textContent).toContain('toolCards.file.receivingContent');
    expect(container.textContent).not.toContain('toolCards.file.parsingPath');
  });

  it('disables nested code-preview autoscroll while write content is streaming', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'streaming',
      isParamsStreaming: true,
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'src/generated.ts',
          content: 'const value = 1;\nconst value2 = 2;',
        },
      },
      partialParams: {
        file_path: 'src/generated.ts',
        content: 'const value = 1;\nconst value2 = 2;',
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(mocks.codePreviewProps).toHaveLength(1);
    expect(mocks.codePreviewProps[0]).toMatchObject({
      isStreaming: true,
      autoScrollToBottom: false,
    });
  });

  it('applies typewriter reveal to write streaming content preview', async () => {
    mocks.typewriterMode = 'partial';
    const fullContent = 'const value = 1;\nconst value2 = 2;\nconst value3 = 3;';
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'streaming',
      isParamsStreaming: true,
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'src/generated.ts',
          content: fullContent,
        },
      },
      partialParams: {
        file_path: 'src/generated.ts',
        content: fullContent,
      },
    } as FlowToolItem;

    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    expect(mocks.codePreviewProps).toHaveLength(1);
    const previewContent = String(mocks.codePreviewProps[0].content ?? '');
    expect(previewContent.length).toBeGreaterThan(0);
    expect(previewContent.length).toBeLessThan(fullContent.length);
    expect(mocks.codePreviewProps[0]).toMatchObject({
      isStreaming: true,
      autoScrollToBottom: false,
    });
    // Status still reflects received bytes, not only revealed characters.
    expect(container.textContent).toContain(`${fullContent.length} chars received`);
  });

  it('retains a compact completed write preview until newer content supersedes it', async () => {
    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };
    const streamingToolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'streaming',
      isParamsStreaming: true,
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'src/generated.ts',
          content: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
        },
      },
      partialParams: {
        file_path: 'src/generated.ts',
        content: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
      },
    } as FlowToolItem;
    const completedToolItem: FlowToolItem = {
      ...streamingToolItem,
      status: 'completed',
      isParamsStreaming: false,
      toolResult: {
        success: true,
        result: {
          file_path: 'src/generated.ts',
        },
      },
    } as FlowToolItem;

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={streamingToolItem}
          config={config}
          sessionId="session-1"
          isLastItem
        />
      );
    });

    mocks.codePreviewProps = [];
    mocks.inlineDiffPreviewProps = [];

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={completedToolItem}
          config={config}
          sessionId="session-1"
          isLastItem
        />
      );
    });

    expect(container.querySelector('[data-testid="chat-file-change-preview"]')).not.toBeNull();
    expect(mocks.codePreviewProps).toHaveLength(2);
    expect(mocks.codePreviewProps.at(-1)).toMatchObject({
      isStreaming: false,
      maxHeight: 88,
    });
    expect(mocks.inlineDiffPreviewProps).toHaveLength(0);

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={completedToolItem}
          config={config}
          sessionId="session-1"
          isLastItem={false}
        />
      );
    });

    // Auto-collapse animates closed; wait for SmoothHeightCollapse to unmount children.
    expect(container.querySelector('[data-testid="chat-file-change-card"]')?.getAttribute('data-expanded')).toBe('false');
    expect(mocks.inlineDiffPreviewProps).toHaveLength(0);
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 350);
      });
    });
    expect(container.querySelector('[data-testid="chat-file-change-preview"]')).toBeNull();
  });

  it('uses the larger diff preview height after a completed write card is manually expanded', async () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      toolName: 'Write',
      status: 'completed',
      isParamsStreaming: false,
      toolCall: {
        id: 'call-1',
        name: 'Write',
        input: {
          file_path: 'src/generated.ts',
          content: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
        },
      },
      toolResult: {
        success: true,
        result: {
          file_path: 'src/generated.ts',
        },
      },
    } as FlowToolItem;
    const config: ToolCardConfig = {
      toolName: 'Write',
      displayName: 'Write',
      icon: 'WRITE',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
      description: 'Write a file',
      displayMode: 'standard',
    };

    await act(async () => {
      root.render(
        <FileOperationToolCard
          toolItem={toolItem}
          config={config}
          sessionId="session-1"
        />
      );
    });

    mocks.inlineDiffPreviewProps = [];

    const card = container.querySelector(
      '[data-openbitfun-component="flow-chat-tool-card"][data-openbitfun-part="surface"][data-openbitfun-attention="prominent"]',
    ) as HTMLDivElement | null;
    await act(async () => {
      card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.inlineDiffPreviewProps.map(props => props.maxHeight)).toContain(330);
  });
});
