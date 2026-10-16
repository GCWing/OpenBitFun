import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { FlowChatContext } from './FlowChatContext';
import { UserMessageItem } from './UserMessageItem';
import { globalEventBus } from '@/infrastructure/event-bus';
import { useMessageEditStore } from '../../store/messageEditStore';
import { createMcpPromptReference } from '../../utils/mcpPromptReference';
import {
  SessionExecutionEvent,
  stateMachineManager,
} from '../../state-machine';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activeSessionRef: { current: any } = {
  current: null,
};
const rollbackServiceMock = vi.hoisted(() => ({
  rollbackSessionToTurn: vi.fn(async () => ({
    restoredFiles: [],
    fromTurnIndex: 0,
    composerText: 'restored prompt',
  })),
}));
const imagePayloadMock = vi.hoisted(() => ({
  buildImagePayload: vi.fn(async (_contexts: unknown) => undefined as
    | { imageContexts: unknown[]; imageDisplayData: unknown[] }
    | undefined),
}));
const flowChatManagerMock = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => undefined),
}));
const componentLibraryMock = vi.hoisted(() => ({
  confirmDanger: vi.fn(async () => true),
}));
const editServiceMock = vi.hoisted(() => ({
  describeUserMessageEditImpact: vi.fn(() => ({
    willStopRunningTask: false,
    willRestoreFiles: true,
    willDeleteTurns: true,
    willRerun: true,
  })),
  editAndRerunUserMessage: vi.fn(async () => undefined),
}));
/** Sessions are bound to a workspace by ID; its kind decides whether local-only actions are available. */
const workspaceRecords = vi.hoisted(() => ({
  local: { id: 'local-workspace', rootPath: '/project', workspaceKind: 'normal' as const },
  remote: { id: 'remote-workspace', rootPath: '/srv/project', workspaceKind: 'remote' as const, connectionId: 'ssh:user@example.com:22' },
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: {
    getState: () => ({
      currentWorkspace: workspaceRecords.local,
      openedWorkspaces: new Map([
        [workspaceRecords.local.id, workspaceRecords.local],
        [workspaceRecords.remote.id, workspaceRecords.remote],
      ]),
      recentWorkspaces: [],
    }),
  },
}));

function createPartialHistorySession(includeCatalog: boolean) {
  const session: any = {
    sessionId: 'partial-session',
    sessionKind: 'normal',
    workspaceId: workspaceRecords.local.id,
    isPartial: true,
    loadedTurnCount: 1,
    totalTurnCount: 20,
    dialogTurns: [{ id: 'turn-20', status: 'completed', backendTurnIndex: 19 }],
  };
  if (includeCatalog) {
    session.turnCatalog = {
      schemaVersion: 1,
      sessionId: 'partial-session',
      revision: 'catalog-1',
      totalTurnCount: 20,
      complete: true,
      entries: Array.from({ length: 20 }, (_, ordinal) => ({
        ordinal,
        storageTurnIndex: ordinal,
        turnId: `turn-${ordinal + 1}`,
        preview: `Prompt ${ordinal + 1}`,
        previewTruncated: false,
      })),
    };
  }
  return session;
}

function createHydratedHistoryState(partialSession: any) {
  return {
    sessions: new Map([[
      'partial-session',
      {
        ...partialSession,
        isPartial: false,
        loadedTurnCount: 20,
        dialogTurns: Array.from({ length: 20 }, (_, index) => ({
          id: `turn-${index + 1}`,
          status: 'completed',
        })),
      },
    ]]),
    activeSessionId: 'partial-session',
  };
}

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'steering.statusPending': '等待触发',
        'steering.statusInjected': '已触发',
        'message.copy': '复制',
        'message.copyFailed': '复制失败',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('../../store/modernFlowChatStore', () => ({
  useActiveSession: () => activeSessionRef.current,
}));

vi.mock('../../services/flow-chat-manager/PeerSessionRefreshModule', () => ({
  installPeerSessionRefresh: vi.fn(() => () => {}),
}));

vi.mock('../../services/sessionNavStatusService', () => ({
  installSessionNavStatusService: vi.fn(() => () => {}),
}));

const flowChatStoreMock = vi.hoisted(() => ({
  registerPersistUnreadCompletionCallback: vi.fn(),
  getState: vi.fn(() => ({
    sessions: new Map(),
    activeSessionId: null,
  })),
  loadSessionHistory: vi.fn(async () => undefined),
}));

vi.mock('../../store/FlowChatStore', () => ({
  FlowChatStore: {
    getInstance: () => flowChatStoreMock,
  },
  flowChatStore: flowChatStoreMock,
}));

vi.mock('../../services/SessionRollbackService', () => rollbackServiceMock);

vi.mock('../../utils/imagePayload', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/imagePayload')>(),
  buildImagePayload: imagePayloadMock.buildImagePayload,
}));

vi.mock('../../services/FlowChatManager', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/FlowChatManager')>(),
  flowChatManager: flowChatManagerMock,
}));

vi.mock('@/shared/notification-system', () => ({
  notificationService: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/infrastructure/event-bus', () => ({
  globalEventBus: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/confirm-dialog', async importOriginal => ({
  ...await importOriginal<typeof import('@/infrastructure/confirm-dialog')>(),
  confirmDanger: componentLibraryMock.confirmDanger,
}));

vi.mock('../../services/UserMessageEditService', () => ({
  describeUserMessageEditImpact: editServiceMock.describeUserMessageEditImpact,
  editAndRerunUserMessage: editServiceMock.editAndRerunUserMessage,
}));

vi.mock('./UserMessageEditComposer', () => ({
  UserMessageEditComposer: ({ onSubmit }: { onSubmit: () => void }) => (
    <button
      type="button"
      className="user-message-edit-composer__icon-button--confirm"
      onClick={() => onSubmit()}
    >
      Submit edit
    </button>
  ),
}));

describe('UserMessageItem steering tag', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  function openMessageActionMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('.user-message-item__edit-rollback-btn');
    act(() => { trigger?.click(); });
    return trigger;
  }

  function getMessageAction(action: 'edit' | 'rollback') {
    return document.querySelector<HTMLButtonElement>(`[role="menu"]:not([aria-hidden="true"]) [data-menu-id="${action}"]`);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    flowChatStoreMock.getState.mockReturnValue({
      sessions: new Map(),
      activeSessionId: null,
    });
    flowChatStoreMock.loadSessionHistory.mockResolvedValue(undefined);
    componentLibraryMock.confirmDanger.mockResolvedValue(true);
    rollbackServiceMock.rollbackSessionToTurn.mockResolvedValue({
      restoredFiles: [],
      fromTurnIndex: 0,
      composerText: 'restored prompt',
    });
    editServiceMock.editAndRerunUserMessage.mockResolvedValue(undefined);
    imagePayloadMock.buildImagePayload.mockResolvedValue(undefined);
    flowChatManagerMock.sendMessage.mockResolvedValue(undefined);
    stateMachineManager.clear();
    useMessageEditStore.getState().cancelEdit();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(),
      },
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    activeSessionRef.current = null;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useMessageEditStore.getState().cancelEdit();
    vi.unstubAllGlobals();
  });

  it('uses the shared image dialog without changing image or background click behavior', () => {
    act(() => root.render(
      <FlowChatContext.Provider value={{ sessionId: 'main-session' }}>
        <UserMessageItem message={{
          id: 'image-preview', content: 'Image', timestamp: 1000,
          images: [{ id: 'image-1', name: 'preview.png', dataUrl: 'data:image/png;base64,AA==', mimeType: 'image/png' }],
        }} turnId="turn-1" />
      </FlowChatContext.Provider>,
    ));
    const thumbnail = container.querySelector<HTMLElement>('.user-message-item__image-thumb')!;
    act(() => thumbnail.click());
    const dialog = document.querySelector<HTMLElement>('.user-message-item__lightbox-surface')!;
    expect(dialog.getAttribute('data-openbitfun-component')).toBe('dialog');
    expect(dialog.parentElement?.getAttribute('data-openbitfun-product-part')).toBe('lightbox');
    expect(dialog.parentElement?.getAttribute('data-openbitfun-native-webview-occlusion')).toBe('true');
    act(() => dialog.querySelector('img')!.click());
    expect(dialog.isConnected).toBe(true);
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog.isConnected).toBe(true);
    act(() => dialog.click());
    expect(dialog.isConnected).toBe(false);
    act(() => thumbnail.click());
    act(() => document.querySelector<HTMLButtonElement>('.user-message-item__lightbox-close')!.click());
    expect(document.querySelector('.user-message-item__lightbox')).toBeNull();
  });

  it('keeps image attachments outside the compact editor while editing', async () => {
    activeSessionRef.current = {
      sessionId: 'main-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      dialogTurns: [{ id: 'turn-1', status: 'completed' }],
    };

    act(() => root.render(
      <FlowChatContext.Provider
        value={{
          sessionId: 'main-session',
          allowUserMessageEdit: true,
          allowUserMessageRollback: true,
        }}
      >
        <UserMessageItem
          message={{
            id: 'image-edit',
            content: 'Describe this image',
            timestamp: 1000,
            images: [{
              id: 'image-1',
              name: 'preview.png',
              dataUrl: 'data:image/png;base64,AA==',
              mimeType: 'image/png',
            }],
          }}
          turnId="turn-1"
        />
      </FlowChatContext.Provider>,
    ));

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('edit')?.click();
    });

    const shell = container.querySelector('.user-message-item-shell');
    const imageGallery = shell?.querySelector('.user-message-item__images');
    const bubble = shell?.querySelector('.user-message-item--editing');
    const editLayout = bubble?.querySelector('.user-message-item__edit-layout');
    const editComposer = editLayout?.querySelector('.user-message-edit-composer__icon-button--confirm');

    expect(shell?.firstElementChild).toBe(imageGallery);
    expect(imageGallery?.nextElementSibling).toBe(bubble);
    expect(editLayout?.contains(imageGallery ?? null)).toBe(false);
    expect(editLayout?.firstElementChild).toBe(editComposer);
    expect(container.querySelectorAll('.user-message-item__images')).toHaveLength(1);
    expect(container.querySelector('[data-testid="chat-user-message-timestamp"]')).toBeNull();
  });

  it('places sent image attachments above the right-aligned text bubble', () => {
    act(() => root.render(
      <FlowChatContext.Provider value={{ allowUserMessageEdit: false, allowUserMessageRollback: false }}>
        <UserMessageItem
          message={{
            id: 'sent-image',
            content: 'Describe this image',
            timestamp: 1000,
            images: [{
              id: 'image-1',
              name: 'preview.png',
              dataUrl: 'data:image/png;base64,AA==',
              mimeType: 'image/png',
            }],
          }}
          turnId="turn-1"
        />
      </FlowChatContext.Provider>,
    ));

    const shell = container.querySelector('.user-message-item-shell');
    const imageGallery = shell?.querySelector('.user-message-item__images');
    const bubble = shell?.querySelector('.user-message-item');

    expect(shell?.firstElementChild).toBe(imageGallery);
    expect(imageGallery?.nextElementSibling).toBe(bubble);
    expect(bubble?.classList.contains('user-message-item--editing')).toBe(false);
  });

  it('renders pending steering tag on the right side of the message row', () => {
    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{
              id: 'user-steering-1',
              content: 'Please adjust this now',
              timestamp: 1000,
            }}
            turnId="turn-1"
            steeringStatus="pending"
          />
        </FlowChatContext.Provider>,
      );
    });

    const main = container.querySelector('.user-message-item__main');
    const tag = main?.querySelector('.user-message-item__steering-tag');

    expect(tag?.textContent).toBe('等待触发');
  });

  it('renders a localized send time outside the user message bubble', () => {
    const timestamp = Date.UTC(2026, 8, 3, 6, 32, 8);

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{ id: 'user-time-1', content: 'Timestamped message', timestamp }}
            turnId="turn-time-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    const bubble = container.querySelector('[data-testid="chat-user-message"]');
    const shell = bubble?.parentElement;
    const meta = container.querySelector('.user-message-item__meta');
    const time = container.querySelector<HTMLTimeElement>('[data-testid="chat-user-message-timestamp"]');

    expect(shell?.classList.contains('user-message-item-shell')).toBe(true);
    expect(meta?.parentElement).toBe(shell);
    expect(time?.parentElement).toBe(meta);
    expect(container.querySelector('.user-message-item__actions')?.parentElement).toBe(meta);
    expect(time?.parentElement).not.toBe(bubble);
    expect(time?.dateTime).toBe('2026-09-03T06:32:08.000Z');
    expect(time?.textContent?.trim()).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('does not invent a send time when the persisted timestamp is invalid', () => {
    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{ id: 'user-time-invalid', content: 'Legacy message', timestamp: 0 }}
            turnId="turn-time-invalid"
          />
        </FlowChatContext.Provider>,
      );
    });

    expect(container.querySelector('[data-testid="chat-user-message-timestamp"]')).toBeNull();
    const meta = container.querySelector('.user-message-item__meta');
    expect(meta?.parentElement).toBe(container.querySelector('.user-message-item-shell'));
    expect(container.querySelector('.user-message-item__actions')?.parentElement).toBe(meta);
  });

  it.each(['pending', 'failed'] as const)('shows host queue %s feedback without edit or rollback actions', status => {
    act(() => root.render(
      <FlowChatContext.Provider value={{ allowUserMessageRollback: true, allowUserMessageEdit: true }}>
        <UserMessageItem message={{ id: 'preview', content: 'Accepted instruction', timestamp: 1000 }}
          turnId="queued-turn" hostQueueStatus={status} hostQueueAttachmentCount={2} />
      </FlowChatContext.Provider>,
    ));
    if (status === 'failed') expect(container.querySelector('.user-message-item__steering-tag')?.textContent)
      .toContain('steering.statusNotApplied');
    expect(container.querySelector('.user-message-item__steering-tag')?.textContent).toContain('hostQueue.attachments');
    expect(container.querySelector('.user-message-item__edit-rollback-btn')).toBeNull();
    expect(container.querySelector('.user-message-item__copy-btn')).not.toBeNull();
  });

  it('renders an accepted text message without a pending status label', () => {
    act(() => root.render(
      <FlowChatContext.Provider value={{ allowUserMessageRollback: true, allowUserMessageEdit: true }}>
        <UserMessageItem message={{ id: 'preview-text', content: 'Accepted instruction', timestamp: 1000 }}
          turnId="queued-turn" hostQueueStatus="pending" />
      </FlowChatContext.Provider>,
    ));
    expect(container.querySelector('.user-message-item__steering-tag')).toBeNull();
    expect(container.textContent).toContain('Accepted instruction');
    expect(container.querySelector('.user-message-item__edit-rollback-btn')).toBeNull();
  });

  it('does not render a steering tag after steering is triggered', () => {
    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{
              id: 'user-steering-1',
              content: 'Please adjust this now',
              timestamp: 1000,
            }}
            turnId="turn-1"
            steeringStatus="completed"
          />
        </FlowChatContext.Provider>,
      );
    });

    expect(container.querySelector('.user-message-item__steering-tag')).toBeNull();
  });

  it.each(['legacy', 'text-metadata', 'mixed-metadata', 'failed'])('renders sent MCP references as capsules after reloading %s messages', variant => {
    const reference = createMcpPromptReference({ serverName: 'Docs', serverId: 'internal-docs-id' });
    const text = `Before ${reference} after`;
    const mixed = variant === 'mixed-metadata';
    const message = JSON.parse(JSON.stringify({
      id: 'user-mcp',
      content: mixed ? `[$pdf] ${text}` : text,
      timestamp: 1000,
      ...(variant.includes('metadata') ? {
        metadata: { composerPresentation: {
          version: 1,
          segments: [
            ...(mixed ? [{ kind: 'inline-token', token: '[$pdf]', tokenType: 'skill', label: 'pdf' }, { kind: 'text', text: ' ' }] : []),
            { kind: 'text', text },
          ],
        } },
      } : {}),
    }));
    const persisted = JSON.stringify(message);
    activeSessionRef.current = {
      sessionId: 'mcp-session',
      sessionKind: 'normal',
      dialogTurns: [{ id: 'turn-mcp', status: variant === 'failed' ? 'error' : 'completed' }],
    };
    const render = () => act(() => root.render(
      <FlowChatContext.Provider value={{ sessionId: 'mcp-session', allowUserMessageRollback: false }}>
        <UserMessageItem message={message} turnId="turn-mcp" />
      </FlowChatContext.Provider>,
    ));
    const verify = () => {
      const content = container.querySelector('[data-testid="chat-user-message-content"]')!;
      const capsule = content.querySelector('.message-reference-capsule--mcp');
      expect(capsule?.textContent).toBe('Docs');
      expect(capsule?.querySelector('svg')).not.toBeNull();
      expect(capsule?.getAttribute('title')).toBe('MCP: Docs');
      expect(content.textContent).toContain('Before Docs after');
      expect(content.textContent).not.toContain('server:');
      expect(content.textContent).not.toContain('internal-docs-id');
      if (mixed) expect(content.querySelector('.message-reference-capsule--skill')?.textContent).toBe('pdf');
      expect(JSON.stringify(message)).toBe(persisted);
    };
    render();
    verify();
    act(() => root.render(null));
    render();
    verify();
  });

  it('keeps malformed MCP references visible as text', () => {
    const content = 'MCP "Docs" (server: "")';
    act(() => root.render(
      <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
        <UserMessageItem message={{ id: 'invalid-mcp', content, timestamp: 1000 }} turnId="invalid-mcp-turn" />
      </FlowChatContext.Provider>,
    ));
    expect(container.querySelector('.message-reference-capsule--mcp')).toBeNull();
    expect(container.querySelector('[data-testid="chat-user-message-content"]')?.textContent).toBe(content);
  });

  it('renders persisted reference metadata as capsules instead of raw prompt tags', () => {
    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{
              id: 'user-reference-1',
              content: '[session: Delete all files] review this',
              timestamp: 1000,
              metadata: {
                composerPresentation: {
                  version: 1,
                  segments: [
                    {
                      kind: 'context',
                      context: {
                        id: 'session-reference-1',
                        type: 'session-reference',
                        sessionId: 'session-1',
                        sessionName: 'Delete all files',
                        workspacePath: '/workspace',
                        workspaceLabel: 'Workspace',
                        timestamp: 1,
                      },
                      tag: '[session: Delete all files]',
                      label: 'Delete all files',
                      title: 'Workspace · /workspace',
                    },
                    { kind: 'text', text: ' review this with ' },
                    {
                      kind: 'inline-token',
                      token: '[$pdf]',
                      tokenType: 'skill',
                      label: 'pdf',
                    },
                  ],
                },
              },
            }}
            turnId="turn-reference-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    const content = container.querySelector('[data-testid="chat-user-message-content"]');
    expect(content?.textContent).toContain('Delete all files');
    expect(content?.textContent).toContain('review this with');
    expect(content?.textContent).toContain('pdf');
    expect(content?.textContent).not.toContain('[session:');
    expect(content?.querySelectorAll('.user-message-item__reference')).toHaveLength(2);
  });

  it('copies a message with the readable text and a restorable token payload', async () => {
    const writeText = vi.fn(async () => {});
    const write = vi.fn(async (_items: unknown[]) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText, write } });
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly items: Record<string, Blob>) {}
    });

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ allowUserMessageRollback: false }}>
          <UserMessageItem
            message={{
              id: 'user-copy-1',
              content: '[$pdf] summarize it',
              timestamp: 1000,
              metadata: {
                composerPresentation: {
                  version: 1,
                  segments: [
                    { kind: 'inline-token', token: '[$pdf]', tokenType: 'skill', label: 'pdf' },
                    { kind: 'text', text: ' summarize it' },
                  ],
                },
              },
            }}
            turnId="turn-copy-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    const copyButton = container.querySelector<HTMLButtonElement>('.user-message-item__copy-btn')!;
    await act(async () => {
      copyButton.click();
    });

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0][0][0] as { items: Record<string, Blob> };
    expect(await item.items['text/plain'].text()).toBe('[Skill: pdf] summarize it');
    const html = await item.items['text/html'].text();
    expect(html).toContain('data-openbitfun-composer-clipboard-tokens="[$pdf] summarize it"');
  });

  it('restores persisted references and images from a failed message to the input', () => {
    const composerPresentation = {
      version: 1,
      segments: [
        {
          kind: 'context',
          context: {
            id: 'session-reference-1',
            type: 'session-reference',
            sessionId: 'session-1',
            sessionName: 'Delete all files',
            workspacePath: '/workspace',
            workspaceLabel: 'Workspace',
            timestamp: 1,
          },
          tag: '[session: Delete all files]',
          label: 'Delete all files',
          title: 'Workspace · /workspace',
        },
      ],
    };
    activeSessionRef.current = {
      sessionId: 'failed-session',
      sessionKind: 'normal',
      dialogTurns: [{ id: 'turn-failed-1', status: 'error' }],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ sessionId: 'failed-session', allowUserMessageRollback: true }}>
          <UserMessageItem
            message={{
              id: 'user-failed-1',
              content: '[session: Delete all files]',
              timestamp: 1000,
              metadata: { composerPresentation },
              images: [{
                id: 'image-failed-1',
                name: 'failure.png',
                dataUrl: 'data:image/png;base64,failed',
                imagePath: 'E:/uploads/failure.png',
                mimeType: 'image/png',
              }],
            }}
            turnId="turn-failed-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    const fillButton = container.querySelectorAll<HTMLButtonElement>('.user-message-item__copy-btn')[1];
    expect(fillButton).not.toBeNull();
    act(() => {
      fillButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(globalEventBus.emit).toHaveBeenCalledWith('fill-chat-input', {
      content: '[session: Delete all files]',
      contexts: [
        expect.objectContaining({
          id: 'session-reference-1',
          type: 'session-reference',
          sessionId: 'session-1',
        }),
        expect.objectContaining({
          id: 'image-failed-1',
          type: 'image',
          imagePath: 'E:/uploads/failure.png',
          imageName: 'failure.png',
          dataUrl: 'data:image/png;base64,failed',
          isLocal: true,
        }),
      ],
      composerPresentation,
    });
  });

  it('hides the rollback button for subagent sessions', () => {
    activeSessionRef.current = {
      sessionId: 'subagent-session',
      sessionKind: 'subagent',
      dialogTurns: [
        {
          id: 'turn-1',
          status: 'completed',
        },
      ],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ sessionId: 'subagent-session', allowUserMessageRollback: true }}>
          <UserMessageItem
            message={{
              id: 'user-subagent-1',
              content: 'subagent question',
              timestamp: 1000,
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    expect(getMessageAction('rollback')).toBeNull();
  });

  it('combines edit and rollback behind the edit icon for normal sessions', () => {
    activeSessionRef.current = {
      sessionId: 'main-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      dialogTurns: [
        {
          id: 'turn-1',
          status: 'completed',
        },
      ],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ sessionId: 'main-session', allowUserMessageRollback: true }}>
          <UserMessageItem
            message={{
              id: 'user-main-1',
              content: 'main session question',
              timestamp: 1000,
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    expect(container.querySelectorAll('.user-message-item__actions button')).toHaveLength(2);
    const trigger = openMessageActionMenu();
    expect(trigger?.getAttribute('aria-label')).toBe('message.editAndRollback');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(trigger?.querySelector('[data-openbitfun-component="icon"][data-openbitfun-name="edit"]')).not.toBeNull();
    expect(getMessageAction('edit')).not.toBeNull();
    expect(getMessageAction('rollback')).not.toBeNull();
    expect(rollbackServiceMock.rollbackSessionToTurn).not.toHaveBeenCalled();
    expect(useMessageEditStore.getState().editingTurnId).toBeNull();

    act(() => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(getMessageAction('edit')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('restores image attachments to the composer after rollback', async () => {
    activeSessionRef.current = {
      sessionId: 'main-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      dialogTurns: [{ id: 'turn-1', status: 'completed' }],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider value={{ sessionId: 'main-session', allowUserMessageRollback: true }}>
          <UserMessageItem
            message={{
              id: 'user-main-1',
              content: 'inspect this image',
              timestamp: 1000,
              images: [{
                id: 'image-1',
                name: 'screenshot.png',
                imagePath: 'E:/uploads/screenshot.png',
                mimeType: 'image/png',
              }],
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('rollback')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(globalEventBus.emit).toHaveBeenCalledWith('fill-chat-input', {
      content: 'restored prompt',
      contexts: [expect.objectContaining({
        id: 'image-1',
        type: 'image',
        imagePath: 'E:/uploads/screenshot.png',
        imageName: 'screenshot.png',
        mimeType: 'image/png',
        isLocal: true,
      })],
    });
  });

  it.each([
    { binding: { workspaceId: workspaceRecords.local.id, externalHistory: { mode: 'follow' }, config: {} }, reason: 'Source' },
    { binding: { workspaceId: workspaceRecords.remote.id, config: {} }, reason: 'Remote' },
    { binding: { workspaceId: workspaceRecords.local.id, config: { dispatchJobId: 'job-a100' } }, reason: 'Dispatch' },
    { binding: { workspaceId: workspaceRecords.local.id, config: { dispatchTarget: { kind: 'device', deviceId: 'target', workspacePath: '/w', displayName: 'Target' } } }, reason: 'Dispatch' },
  ])('disables file-consistent rollback and message editing for $reason sessions', ({ binding, reason }) => {
    activeSessionRef.current = {
      sessionId: 'remote-session',
      sessionKind: 'normal',
      ...binding,
      dialogTurns: [
        {
          id: 'turn-1',
          status: 'completed',
        },
      ],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'remote-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-remote-1',
              content: 'remote session question',
              timestamp: 1000,
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    const rollbackButton = getMessageAction('rollback');
    const editButton = getMessageAction('edit');

    expect(rollbackButton?.disabled).toBe(true);
    expect(rollbackButton?.getAttribute('aria-label')).toContain(reason === 'Source' ? 'externalHistory.forkBeforeEdit' : `message.rollbackDisabled${reason}`);
    expect(rollbackButton?.hasAttribute('title')).toBe(false);
    expect(editButton?.disabled).toBe(true);
    expect(editButton?.getAttribute('aria-label')).toContain(reason === 'Source' ? 'externalHistory.forkBeforeEdit' : `message.editDisabled${reason}`);
    expect(editButton?.hasAttribute('title')).toBe(false);
  });

  it('hides the edit button when the panel context disables user message editing', () => {
    activeSessionRef.current = {
      sessionId: 'btw-session',
      sessionKind: 'btw',
      dialogTurns: [
        {
          id: 'turn-1',
          status: 'completed',
        },
      ],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'btw-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: false,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-btw-1',
              content: 'btw session question',
              timestamp: 1000,
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    expect(getMessageAction('edit')).toBeNull();
    expect(getMessageAction('rollback')).not.toBeNull();
  });

  it('keeps edit and rollback available for on-demand hydration in a partial history tail', () => {
    activeSessionRef.current = {
      sessionId: 'partial-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 20,
      dialogTurns: [
        {
          id: 'turn-20',
          status: 'completed',
          backendTurnIndex: 19,
        },
      ],
    };

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-partial-20',
              content: 'latest partial prompt',
              timestamp: 1000,
            }}
            turnId="turn-20"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    expect(getMessageAction('edit')?.disabled).toBe(false);
    expect(getMessageAction('rollback')?.disabled).toBe(false);
  });

  it('rolls back partial history by stable Turn identity without full hydration', async () => {
    activeSessionRef.current = {
      sessionId: 'partial-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      isPartial: true,
      loadedTurnCount: 1,
      totalTurnCount: 20,
      dialogTurns: [
        {
          id: 'turn-20',
          status: 'completed',
          backendTurnIndex: 19,
        },
      ],
    };
    flowChatStoreMock.getState.mockReturnValue({
      sessions: new Map([[
        'partial-session',
        {
          ...activeSessionRef.current,
          isPartial: false,
          loadedTurnCount: 20,
          dialogTurns: Array.from({ length: 20 }, (_, index) => ({
            id: `turn-${index + 1}`,
            status: 'completed',
          })),
        },
      ]]),
      activeSessionId: 'partial-session',
    });

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-partial-20',
              content: 'latest partial prompt',
              timestamp: 1000,
            }}
            turnId="turn-20"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('rollback')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rollbackServiceMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'partial-session', targetTurnId: 'turn-20', kind: 'rollback' }));
    expect(flowChatStoreMock.loadSessionHistory).not.toHaveBeenCalled();
  });

  it('keeps edit and rollback available for a rendered Turn outside the canonical tail', () => {
    activeSessionRef.current = createPartialHistorySession(false);

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-partial-5',
              content: 'older window prompt',
              timestamp: 1000,
            }}
            turnId="turn-5"
            absoluteTurnIndex={5}
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    expect(getMessageAction('edit')?.disabled).toBe(false);
    expect(getMessageAction('rollback')?.disabled).toBe(false);
  });

  it('disables edit and rollback while the Session is not idle', async () => {
    activeSessionRef.current = createPartialHistorySession(false);
    await stateMachineManager.transition('partial-session', SessionExecutionEvent.START);

    await act(async () => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{ id: 'user-partial-5', content: 'older window prompt', timestamp: 1000 }}
            turnId="turn-5"
            absoluteTurnIndex={5}
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    expect(getMessageAction('edit')?.disabled).toBe(true);
    expect(getMessageAction('rollback')?.disabled).toBe(true);
  });

  it('rolls back a cataloged history-window Turn by stable identity', async () => {
    activeSessionRef.current = createPartialHistorySession(true);
    flowChatStoreMock.getState.mockReturnValue(
      createHydratedHistoryState(activeSessionRef.current),
    );

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{ id: 'user-partial-5', content: 'older window prompt', timestamp: 1000 }}
            turnId="turn-5"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('rollback')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rollbackServiceMock.rollbackSessionToTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'partial-session', targetTurnId: 'turn-5', kind: 'rollback' }));
  });

  it('edits and reruns a cataloged history-window Turn without pre-hydration', async () => {
    activeSessionRef.current = createPartialHistorySession(true);
    flowChatStoreMock.getState.mockReturnValue(
      createHydratedHistoryState(activeSessionRef.current),
    );

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'partial-session',
            allowUserMessageRollback: true,
            allowUserMessageEdit: true,
          }}
        >
          <UserMessageItem
            message={{ id: 'user-partial-5', content: 'older window prompt', timestamp: 1000 }}
            turnId="turn-5"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('edit')?.click();
    });
    await act(async () => {
      useMessageEditStore.getState().setDraft('edited older window prompt');
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.user-message-edit-composer__icon-button--confirm')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editServiceMock.editAndRerunUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'partial-session',
      turnId: 'turn-5',
      originalContent: 'older window prompt',
      editedContent: 'edited older window prompt',
    }));
    expect(flowChatStoreMock.loadSessionHistory).not.toHaveBeenCalled();
  });

  it('resubmits the original image attachments when editing a message', async () => {
    activeSessionRef.current = {
      sessionId: 'main-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      dialogTurns: [{ id: 'turn-1', status: 'completed' }],
    };
    imagePayloadMock.buildImagePayload.mockResolvedValueOnce({
      imageContexts: [{ id: 'image-1', image_path: 'E:/uploads/preview.png', mime_type: 'image/png' }],
      imageDisplayData: [{ id: 'image-1', name: 'preview.png', imagePath: 'E:/uploads/preview.png' }],
    });
    editServiceMock.editAndRerunUserMessage.mockImplementationOnce(async (request: any) => {
      await request.rerun(request.editedContent, request.agentType, 'lease-1');
      return undefined;
    });

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'main-session',
            allowUserMessageEdit: true,
            allowUserMessageRollback: true,
          }}
        >
          <UserMessageItem
            message={{
              id: 'user-image-1',
              content: 'Describe this image',
              timestamp: 1000,
              images: [{
                id: 'image-1',
                name: 'preview.png',
                imagePath: 'E:/uploads/preview.png',
                mimeType: 'image/png',
              }],
            }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('edit')?.click();
    });
    await act(async () => {
      useMessageEditStore.getState().setDraft('Describe this image in detail');
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.user-message-edit-composer__icon-button--confirm')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(imagePayloadMock.buildImagePayload).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'image-1',
        type: 'image',
        imageName: 'preview.png',
        imagePath: 'E:/uploads/preview.png',
        mimeType: 'image/png',
        isLocal: true,
      }),
    ]);
    expect(flowChatManagerMock.sendMessage).toHaveBeenCalledWith(
      'Describe this image in detail',
      'main-session',
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        imageContexts: [{ id: 'image-1', image_path: 'E:/uploads/preview.png', mime_type: 'image/png' }],
        imageDisplayData: [{ id: 'image-1', name: 'preview.png', imagePath: 'E:/uploads/preview.png' }],
        sessionMutationLeaseId: 'lease-1',
      }),
    );
  });

  it('reruns an edit without attachments when the message has no images', async () => {
    activeSessionRef.current = {
      sessionId: 'main-session',
      sessionKind: 'normal',
      workspaceId: workspaceRecords.local.id,
      dialogTurns: [{ id: 'turn-1', status: 'completed' }],
    };
    editServiceMock.editAndRerunUserMessage.mockImplementationOnce(async (request: any) => {
      await request.rerun(request.editedContent, request.agentType, 'lease-2');
      return undefined;
    });

    act(() => {
      root.render(
        <FlowChatContext.Provider
          value={{
            sessionId: 'main-session',
            allowUserMessageEdit: true,
            allowUserMessageRollback: true,
          }}
        >
          <UserMessageItem
            message={{ id: 'user-text-1', content: 'Describe this', timestamp: 1000 }}
            turnId="turn-1"
          />
        </FlowChatContext.Provider>,
      );
    });

    openMessageActionMenu();
    await act(async () => {
      getMessageAction('edit')?.click();
    });
    await act(async () => {
      useMessageEditStore.getState().setDraft('Describe this more precisely');
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.user-message-edit-composer__icon-button--confirm')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(imagePayloadMock.buildImagePayload).toHaveBeenCalledWith([]);
    expect(flowChatManagerMock.sendMessage).toHaveBeenCalledWith(
      'Describe this more precisely',
      'main-session',
      undefined,
      undefined,
      undefined,
      { sessionMutationLeaseId: 'lease-2' },
    );
  });
});
