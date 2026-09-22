// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MenuItem } from '@/shared/context-menu-system/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useAgentCanvasStore } from '@/app/components/panels/content-canvas/stores/canvasStore';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useContentResourceStore } from '@/app/workbench/contentResourceStore';
import { appManager } from '@/app/services/AppManager';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import type { Session } from '@/flow_chat/types/flow-chat';
import { activateSurface, getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';

/** The chat session's workspace record; content opened from chat links is routed by its ID. */
const SESSION_WORKSPACE = vi.hoisted(() => ({
  id: 'workspace-1',
  rootPath: '/srv/project',
  workspaceKind: 'remote' as const,
  connectionId: 'remote-connection-1',
}));

const mocks = vi.hoisted(() => ({
  getCurrentWorkspacePath: vi.fn(),
  revealInExplorer: vi.fn(),
  readFileContent: vi.fn(),
  openExternal: vi.fn(),
  openFileInBestTarget: vi.fn(),
  openHtmlFileInExternalBrowser: vi.fn(),
  renderMath: vi.fn(),
  showContextMenu: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  globalAPI: {
    getCurrentWorkspacePath: (...args: unknown[]) => mocks.getCurrentWorkspacePath(...args),
  },
  workspaceAPI: {
    revealInExplorer: (...args: unknown[]) => mocks.revealInExplorer(...args),
    readFileContent: (...args: unknown[]) => mocks.readFileContent(...args),
  },
  systemAPI: {
    openExternal: (...args: unknown[]) => mocks.openExternal(...args),
  },
}));

vi.mock('@/infrastructure/i18n', () => ({
  i18nService: {
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  },
}));

vi.mock('@/infrastructure/appearance', () => ({
  useAppearance: () => ({ current: { mode: 'dark' } }),
}));

vi.mock('./MermaidBlock', () => ({
  MermaidBlock: () => <div data-testid="mermaid-block" />,
}));

vi.mock('./MarkdownMathRenderer', () => ({
  default: ({ markdownContent }: { markdownContent: string }) => {
    mocks.renderMath(markdownContent);
    return <span data-testid="markdown-math-renderer">{markdownContent}</span>;
  },
}));

vi.mock('./AsyncPrismSyntaxHighlighter', () => ({
  AsyncPrismSyntaxHighlighter: ({ children }: { children: React.ReactNode }) => <pre>{children}</pre>,
}));

vi.mock('@/shared/context-menu-system/core/ContextMenuController', () => ({
  contextMenuController: {
    show: (...args: unknown[]) => mocks.showContextMenu(...args),
  },
}));

vi.mock('@/shared/utils/tabUtils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/utils/tabUtils')>(),
  openFileInBestTarget: (...args: unknown[]) => mocks.openFileInBestTarget(...args),
}));

vi.mock('@/shared/utils/htmlFilePreview', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/shared/utils/htmlFilePreview')>(),
  openHtmlFileInExternalBrowser: (...args: unknown[]) => mocks.openHtmlFileInExternalBrowser(...args),
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/shared/utils/startupTrace', () => ({
  isStartupRenderTraceEnabled: () => false,
  recordReactRenderProfile: vi.fn(),
  startupTrace: {},
}));

vi.mock('@/infrastructure/services/business/workspaceManager', () => ({
  workspaceManager: {
    getState: vi.fn(() => ({
      currentWorkspace: SESSION_WORKSPACE,
      openedWorkspaces: new Map([[SESSION_WORKSPACE.id, SESSION_WORKSPACE]]),
      recentWorkspaces: [],
    })),
  },
}));

const EXAMPLE_WORKSPACE = 'C:\\ExampleWorkspace';
const EXAMPLE_ABSOLUTE_README = 'D:\\SampleDocs\\Guides\\README.md';

describe('Markdown file links', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onFileViewRequest: ReturnType<typeof vi.fn>;

  function openSessionHost(overrides: Partial<Session> = {}) {
    const session: Session = {
      sessionId: 'session_1',
      title: 'Session',
      dialogTurns: [],
      status: 'idle',
      config: {},
      sessionKind: 'normal',
      workspaceId: SESSION_WORKSPACE.id,
      createdAt: 1,
      lastActiveAt: 1,
      error: null,
      ...overrides,
    };
    flowChatStore.setState(state => ({
      ...state,
      sessions: new Map([[session.sessionId, session]]),
      activeSessionId: session.sessionId,
    }));
    useSceneStore.getState().openSessionScene({
      surfaceId: getActiveSurfaceId(),
      workspaceKey: session.workspaceId ?? 'workspace-less',
      sessionId: session.sessionId,
    });
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    activateSurface('local');
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
    appManager.updateLayout({ chatCollapsed: false, rightPanelCollapsed: true });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useAgentCanvasStore.getState().reset();
    onFileViewRequest = vi.fn();
    mocks.getCurrentWorkspacePath.mockReset();
    mocks.revealInExplorer.mockReset();
    mocks.readFileContent.mockReset();
    mocks.openExternal.mockReset();
    mocks.openFileInBestTarget.mockReset();
    mocks.openHtmlFileInExternalBrowser.mockReset();
    mocks.renderMath.mockReset();
    mocks.showContextMenu.mockReset();
    mocks.getCurrentWorkspacePath.mockResolvedValue(EXAMPLE_WORKSPACE);
    mocks.readFileContent.mockResolvedValue('cmVsdS1wbmc=');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    activateSurface('local');
    container.remove();
    flowChatStore.setState(state => ({ ...state, sessions: new Map(), activeSessionId: null }));
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
    vi.clearAllMocks();
  });

  it('preserves same-tag sibling matches for generated and raw HTML content', async () => {
    const content = `First paragraph.

Second paragraph.

- First item
  - Nested item
  - Next nested item
- Second item

| A | B |
| - | - |
| C | D |

<div align="center"><p>One</p><!-- comment -->text<p>Two</p><hr><p>Three</p></div>
<table><tbody><tr><th>A</th><td>B</td><td>C</td><th>D</th><th>E</th></tr></tbody></table>`;
    await act(async () => root.render(<MarkdownRenderer content={content} />));
    for (const [tag, className] of [
      ['p', 'markdown-paragraph'], ['li', 'markdown-list-item'],
      ['th', 'markdown-header-cell'], ['td', 'markdown-data-cell'],
    ]) {
      const oldMatches = [...container.querySelectorAll(`${tag} + ${tag}`)];
      expect(oldMatches.length).toBeGreaterThan(0);
      expect([...container.querySelectorAll(`${tag}:where(.${className}) + ${tag}:where(.${className})`)])
        .toEqual(oldMatches);
      expect([...container.querySelectorAll(tag)].every(node => node.classList.contains(className))).toBe(true);
    }
    expect([...container.querySelectorAll('div[align="center"] > p:where(.markdown-paragraph) + p:where(.markdown-paragraph)')]
      .map(node => node.textContent)).toEqual(['Two']);
  });

  it.each([false, true])('keeps fullwidth parentheses outside bare web links (escaped=%s)', async escaped => {
    const url = 'http://127.0.0.1:8000';
    const bare = escaped ? url.replace(':', '\\:') : url;
    const content = `\uff08Link1 ${bare}\uff09\uff08Link2 [${url}](${url}) \uff09`;
    await act(async () => root.render(<MarkdownRenderer content={content} />));
    const links = [...container.querySelectorAll('a')];
    expect(links.map(link => link.getAttribute('href'))).toEqual([url, url]);
    expect(links.map(link => link.textContent)).toEqual([url, url]);
    expect(container.textContent).toContain(`\uff08Link1 ${url}\uff09\uff08Link2 ${url} \uff09`);
  });

  it('does not resolve workspace path for markdown without local file links', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'Plain answer without file links.\n\n```ts\nconst value = 1;\n```'}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getCurrentWorkspacePath).not.toHaveBeenCalled();
  });

  it('renders separate footnote regions and follows their shared anchors', async () => {
    const reference = 'Text[^a].';
    const definition = '[^a]: Definition';
    const content = `${reference}\n\n${definition}`;
    await act(async () => root.render(<>
      <MarkdownRenderer content={content} sourceRange={{ start: 0, end: reference.length, idPrefix: 'test-editor-' }} />
      <MarkdownRenderer content={content} sourceRange={{ start: reference.length + 2, end: content.length, idPrefix: 'test-editor-' }} />
    </>));
    const link = container.querySelector<HTMLAnchorElement>('[data-footnote-ref]')!;
    const target = document.getElementById(link.hash.slice(1))!;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    expect(container.querySelectorAll('section[data-footnotes] li')).toHaveLength(1);
    expect(target.textContent).toContain('Definition');
    act(() => link.click());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it.each([
    '[Open Canvas](openbitfun-canvas://session/session_1/canvas/canvas_1)',
    'openbitfun-canvas://session/session_1/canvas/canvas_1',
  ])('opens Canvas artifact links in the Canvas panel: %s', async (content) => {
    openSessionHost({
      workspaceId: SESSION_WORKSPACE.id,
      workspacePath: '/srv/project',
      remoteConnectionId: 'remote-connection-1',
      remoteSshHost: 'workspace.example',
    });

    try {
      await act(async () => {
        root.render(
          <MarkdownRenderer
            content={content}
            workspaceId={SESSION_WORKSPACE.id}
            basePath="/srv/project"
            remoteConnectionId="remote-connection-1"
            remoteSshHost="workspace.example"
          />,
        );
        await Promise.resolve();
      });

      const link = container.querySelector<HTMLButtonElement>('button.canvas-link');
      expect(link).not.toBeNull();

      act(() => link?.click());

      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content).toMatchObject({
        type: 'openbitfun-canvas',
        title: 'OpenBitFun Canvas',
        data: {
          artifactReference: 'openbitfun-canvas://session/session_1/canvas/canvas_1',
          workspaceId: SESSION_WORKSPACE.id,
          workspacePath: '/srv/project',
          remoteConnectionId: 'remote-connection-1',
          remoteSshHost: 'workspace.example',
          _source: { type: 'markdown-link' },
        },
        metadata: {
          artifactReference: 'openbitfun-canvas://session/session_1/canvas/canvas_1',
          fromMarkdown: true,
        },

      });
      expect(mocks.getCurrentWorkspacePath).not.toHaveBeenCalled();
    } finally {
      useAgentCanvasStore.getState().reset();
    }
  });

  it('opens chat http links in the built-in browser by default', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';
    openSessionHost();

    try {
      await act(async () => {
        root.render(<MarkdownRenderer content={'[Example](https://example.com/docs)'} />);
        await Promise.resolve();
      });

      const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
      expect(link).not.toBeNull();

      await act(async () => {
        link?.click();
        await Promise.resolve();
      });

      expect(mocks.openExternal).not.toHaveBeenCalled();
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content).toMatchObject({
        type: 'browser',
        data: { url: 'https://example.com/docs' },
        metadata: { duplicateCheckKey: 'browser-panel:https://example.com/docs' },
      });
    } finally {
      useAgentCanvasStore.getState().reset();
    }
  });

  it('commits a browser view and explicitly reveals its inline host', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';
    openSessionHost();
    const onExpandPanel = vi.fn();

    window.addEventListener('expand-right-panel-immediate', onExpandPanel);

    try {
      await act(async () => {
        root.render(<MarkdownRenderer content={'[Example](https://example.com/docs)'} />);
        await Promise.resolve();
      });

      const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
      expect(link).not.toBeNull();

      act(() => {
        link?.click();
      });

      expect(onExpandPanel).toHaveBeenCalledTimes(1);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(1);
      expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].content.data.url).toBe('https://example.com/docs');
    } finally {
      window.removeEventListener('expand-right-panel-immediate', onExpandPanel);
      vi.useRealTimers();
    }
  });

  it('opens modified chat link clicks in the external browser', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';


    try {
      await act(async () => {
        root.render(<MarkdownRenderer content={'[Example](https://example.com/docs)'} />);
        await Promise.resolve();
      });

      const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
      expect(link).not.toBeNull();

      await act(async () => {
        link?.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }));
        await Promise.resolve();
      });

      expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');
      expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    } finally {
      useAgentCanvasStore.getState().reset();
    }
  });

  it('adds source, integrated browser, and system browser actions to FlowChat HTML file links', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'[Preview](docs/index.html#L7)'}
          basePath={EXAMPLE_WORKSPACE}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    const link = container.querySelector<HTMLButtonElement>('button.file-link');
    expect(link).not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 24,
      }));
    });

    expect(mocks.showContextMenu).toHaveBeenCalledTimes(1);
    const [, items, context] = mocks.showContextMenu.mock.calls[0] as [
      unknown,
      MenuItem[],
      Parameters<NonNullable<MenuItem['onClick']>>[0],
    ];
    expect(items.slice(0, 3)).toMatchObject([
      {
        id: 'markdown-open-html-as-text',
        label: 'common:actions.open',
        icon: 'FileText',
      },
      {
        id: 'markdown-open-html-in-integrated-browser',
        label: 'common:file.openInIntegratedBrowser',
        icon: 'PanelRightOpen',
      },
      {
        id: 'markdown-open-html-in-system-browser',
        label: 'common:file.openInSystemBrowser',
        icon: 'ExternalLink',
        disabled: false,
      },
    ]);

    await items[0].onClick?.(context);
    expect(mocks.openFileInBestTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      fileName: 'index.html',
      workspacePath: EXAMPLE_WORKSPACE,
      editorType: 'code-editor',
      jumpToRange: { start: 7, end: undefined },
    }));

    await items[1].onClick?.(context);
    expect(mocks.openFileInBestTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      fileName: 'index.html',
      workspacePath: EXAMPLE_WORKSPACE,
      editorType: 'html-preview',
    }));

    await items[2].onClick?.(context);
    expect(mocks.openHtmlFileInExternalBrowser).toHaveBeenCalledWith(
      expect.stringMatching(/docs[\\/]index\.html$/),
    );
  });

  it('keeps system-browser opening disabled for remote FlowChat HTML links', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'[Preview](site/page.htm)'}
          basePath={'/srv/project'}
          remoteConnectionId={'remote-connection-1'}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('button.file-link')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });

    const items = mocks.showContextMenu.mock.calls[0]?.[1] as MenuItem[];
    const integrated = items.find(item => item.id === 'markdown-open-html-in-integrated-browser');
    const system = items.find(item => item.id === 'markdown-open-html-in-system-browser');

    expect(system?.disabled).toBe(true);
    await integrated?.onClick?.(mocks.showContextMenu.mock.calls[0][2]);
    expect(mocks.openFileInBestTarget).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/srv/project/site/page.htm',
      workspacePath: '/srv/project',
      remoteConnectionId: 'remote-connection-1',
      editorType: 'html-preview',
    }));
  });

  it('routes detached HTML and unknown file types through the target callback and disables host actions', async () => {
    container.className = 'openbitfun-session-scene modern-flowchat-container';
    await act(async () => {
      root.render(<MarkdownRenderer content={'[Preview](page.html) [Binary](result.bin)'} basePath="/target" fileActionsViaCallbackOnly onFileViewRequest={onFileViewRequest} />);
    });
    const links = container.querySelectorAll<HTMLButtonElement>('button.file-link');
    act(() => links[1].click());
    expect(onFileViewRequest).toHaveBeenCalledWith('result.bin', 'result.bin', undefined);
    act(() => links[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    const items = mocks.showContextMenu.mock.calls[0][1] as MenuItem[];
    expect(items.find(item => item.id === 'markdown-open-in-explorer')?.disabled).toBe(true);
    expect(items.some(item => item.id === 'markdown-open-html-in-system-browser')).toBe(false);
    await items.find(item => item.id === 'markdown-open-remote-file')?.onClick?.(mocks.showContextMenu.mock.calls[0][2]);
    expect(onFileViewRequest).toHaveBeenCalledWith('page.html', 'page.html', undefined);
    expect(mocks.openFileInBestTarget).not.toHaveBeenCalled();
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();
  });

  it.each(['computer://preview.png', 'openbitfun://current-session/artifacts/preview.png'])(
    'renders dispatched image %s through the session provider only', async source => {
      const read = vi.fn().mockResolvedValue('data:image/png;base64,YQ==');
      await act(async () => root.render(<MarkdownRenderer content={`![Preview](${source})`}
        basePath="/controller/baseline" fileActionsViaCallbackOnly onImageRead={read} />));
      expect(read).toHaveBeenCalledWith(source.startsWith('computer:') ? 'preview.png' : source);
      expect(container.querySelector('img')?.src).toBe('data:image/png;base64,YQ==');
      expect(mocks.readFileContent).not.toHaveBeenCalled();
    },
  );

  it('retries a failed dispatched preview and offers an explicit file download', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Target offline')).mockResolvedValue('data:image/png;base64,YQ==');
    const download = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<MarkdownRenderer content="![Preview](preview.png)" fileActionsViaCallbackOnly onImageRead={read} onFileDownload={download} />));
    expect(container.querySelector('img')).toBeNull();
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'common:retry');
    const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'common:actions.download');
    await act(async () => save!.click());
    expect(download).toHaveBeenCalledWith('preview.png');
    await act(async () => retry!.click());
    expect(read).toHaveBeenLastCalledWith('preview.png', true);
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,YQ==');
    expect(mocks.readFileContent).not.toHaveBeenCalled();
  });

  it('routes same-label relative, absolute, and computer links independently', async () => {
    const content = [
      '1. [README.md](.\\README.md)',
      `2. [README.md](${EXAMPLE_ABSOLUTE_README})`,
      '3. [README.md](computer://README.md)',
      `4. [README.md](computer://${EXAMPLE_ABSOLUTE_README})`,
      '5. [deck.pptx](computer://deck.pptx)',
    ].join('\n');

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={content}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button.file-link'));
    expect(buttons).toHaveLength(5);

    await act(async () => {
      buttons[0].click();
      await Promise.resolve();
    });

    expect(onFileViewRequest).toHaveBeenNthCalledWith(1, '.\\README.md', 'README.md', undefined);
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();

    await act(async () => {
      buttons[1].click();
      await Promise.resolve();
    });

    expect(onFileViewRequest).toHaveBeenNthCalledWith(2, EXAMPLE_ABSOLUTE_README, 'README.md', undefined);
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();

    await act(async () => {
      buttons[2].click();
      await Promise.resolve();
    });

    expect(onFileViewRequest).toHaveBeenNthCalledWith(3, 'README.md', 'README.md', undefined);
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();

    await act(async () => {
      buttons[3].click();
      await Promise.resolve();
    });

    expect(onFileViewRequest).toHaveBeenNthCalledWith(4, EXAMPLE_ABSOLUTE_README, 'README.md', undefined);
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();

    await act(async () => {
      buttons[4].click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.revealInExplorer).toHaveBeenNthCalledWith(1, `${EXAMPLE_WORKSPACE}\\deck.pptx`);
    expect(onFileViewRequest).toHaveBeenCalledTimes(4);
  });

  it('routes PDF links through the integrated file viewer instead of the file manager', async () => {
    const pdfPath = 'D:\\SampleDocs\\Report.PDF';

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={`[Report.pdf](${pdfPath})`}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    const link = container.querySelector<HTMLButtonElement>('button.file-link');
    expect(link).not.toBeNull();

    act(() => link?.click());

    expect(onFileViewRequest).toHaveBeenCalledWith(pdfPath, 'Report.PDF', undefined);
    expect(mocks.revealInExplorer).not.toHaveBeenCalled();
  });

  it('does not load the math renderer for ordinary markdown', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'Plain answer with **bold** text and a table-like sentence.'}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Plain answer with');
    expect(container.querySelector('[data-testid="markdown-math-renderer"]')).toBeNull();
    expect(mocks.renderMath).not.toHaveBeenCalled();
  });

  it('keeps math markdown visible while the math renderer loads', async () => {
    act(() => {
      root.render(
        <MarkdownRenderer
          content={'Formula: $x + y$'}
          onFileViewRequest={onFileViewRequest}
        />,
      );
    });

    expect(container.textContent).toContain('Formula:');

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="markdown-math-renderer"]')).not.toBeNull();
    expect(mocks.renderMath).toHaveBeenCalledWith('Formula: $x + y$');
  });

  it('loads relative markdown images from the provided base path', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![ReLU 图像](relu.png)'}
          basePath={EXAMPLE_WORKSPACE}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>('img[alt="ReLU 图像"]');
    expect(image).not.toBeNull();
    expect(mocks.readFileContent).toHaveBeenCalledWith(
      `${EXAMPLE_WORKSPACE}/relu.png`,
      'base64',
      undefined,
    );
    expect(image?.src).toBe('data:image/png;base64,cmVsdS1wbmc=');
    expect(mocks.getCurrentWorkspacePath).not.toHaveBeenCalled();
  });

  it.each([
    ['computer://output/preview%20%E5%9B%BE.png', '/srv/project/output/preview 图.png'],
    ['file:///srv/project/preview.png', '/srv/project/preview.png'],
    ['computer:///srv/project/preview.png', '/srv/project/preview.png'],
  ])('resolves output image references through the owning filesystem: %s', async (source, expectedPath) => {
    await act(async () => root.render(<MarkdownRenderer content={`![Preview](${source})`} basePath="/srv/project" remoteConnectionId={source} />));
    expect(mocks.readFileContent).toHaveBeenCalledWith(expectedPath, 'base64', source);
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,cmVsdS1wbmc=');
  });

  it('keeps inline image data while blocking executable data links', async () => {
    await act(async () => root.render(<MarkdownRenderer content="![Preview](data:image/png;base64,YQ==) [bad](data:text/html;base64,YQ==)" />));
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,YQ==');
    expect(container.querySelector('a[href^="data:"]')).toBeNull();
    expect(mocks.readFileContent).not.toHaveBeenCalled();
  });

  it('isolates same-path images across peer hosts and discards late reads', async () => {
    let finishOld!: (value: string) => void;
    mocks.readFileContent.mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve; }));
    await act(async () => {
      activateSurface('peer:output-first');
      root.render(<MarkdownRenderer content="![Preview](same-path.png)" basePath="/srv/project" />);
    });
    mocks.readFileContent.mockResolvedValueOnce('bmV3');
    await act(async () => activateSurface('peer:output-second'));
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,bmV3');
    await act(async () => finishOld('b2xk'));
    expect(container.querySelector('img')?.src).toBe('data:image/png;base64,bmV3');
    expect(mocks.readFileContent).toHaveBeenCalledTimes(2);
  });

  it.each(['dispatch-private.png', '/srv/private/dispatch-private.png'])(
    'does not read controller images or resolve its workspace for dispatch observers: %s',
    async (imagePath) => {
      await act(async () => {
        root.render(<MarkdownRenderer content={`![Target image](${imagePath})`} fileActionsViaCallbackOnly />);
      });

      expect(mocks.readFileContent).not.toHaveBeenCalled();
      expect(mocks.getCurrentWorkspacePath).not.toHaveBeenCalled();
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('Target image');
      expect(container.textContent).toContain('components:markdown.remoteImageUnavailable');
    },
  );

  it('does not reuse a cached controller image when switching to a dispatch observer', async () => {
    const content = '![Private controller image](cached-controller-image.png)';
    await act(async () => {
      root.render(<MarkdownRenderer content={content} basePath="/srv/project" />);
    });
    expect(mocks.readFileContent).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.src).toContain('data:image/png;base64,');

    await act(async () => {
      root.render(<MarkdownRenderer content={content} basePath="/srv/project" fileActionsViaCallbackOnly />);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(mocks.readFileContent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('components:markdown.remoteImageUnavailable');
  });

  it('keeps externally hosted images available to dispatch observers', async () => {
    await act(async () => {
      root.render(<MarkdownRenderer content="![Public image](https://example.com/image.png)" fileActionsViaCallbackOnly />);
    });
    expect(container.querySelector('img')?.src).toBe('https://example.com/image.png');
    expect(mocks.readFileContent).not.toHaveBeenCalled();
    expect(mocks.getCurrentWorkspacePath).not.toHaveBeenCalled();
  });

  it('preserves existing markdown nodes while streaming content is appended', async () => {
    const initialContent = [
      'Before image',
      '',
      '![Stable diagram](stream-stable.png)',
      '',
      'After image',
    ].join('\n');

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={initialContent}
          basePath={EXAMPLE_WORKSPACE}
          isStreaming
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const imageBefore = container.querySelector<HTMLImageElement>('img[alt="Stable diagram"]');
    const paragraphsBefore = Array.from(container.querySelectorAll('p'));
    expect(imageBefore).not.toBeNull();
    expect(paragraphsBefore).toHaveLength(3);
    expect(mocks.readFileContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={`${initialContent}\n\nNew streamed paragraph`}
          basePath={EXAMPLE_WORKSPACE}
          isStreaming
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    const imageAfter = container.querySelector<HTMLImageElement>('img[alt="Stable diagram"]');
    const paragraphsAfter = Array.from(container.querySelectorAll('p'));
    expect(imageAfter).toBe(imageBefore);
    expect(paragraphsAfter).toHaveLength(4);
    expect(paragraphsAfter.slice(0, 3)).toEqual(paragraphsBefore);
    expect(mocks.readFileContent).toHaveBeenCalledTimes(1);
  });

  it('renders alt text instead of a broken image when a local image read fails', async () => {
    mocks.readFileContent.mockRejectedValueOnce(new Error('missing image'));

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![Missing diagram](missing-stream-image.png)'}
          basePath={EXAMPLE_WORKSPACE}
          isStreaming
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('img[alt="Missing diagram"]')).toBeNull();
    const fallback = container.querySelector('[data-openbitfun-part="imageFallback"]');
    expect(fallback?.textContent).toBe('Missing diagram');

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![Missing diagram](missing-stream-image.png)\n\nLater streamed text'}
          basePath={EXAMPLE_WORKSPACE}
          isStreaming
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[data-openbitfun-part="imageFallback"]')).toBe(fallback);
    expect(mocks.readFileContent).toHaveBeenCalledTimes(1);
  });

  it('replaces an externally hosted image after the browser reports an error', async () => {
    await act(async () => {
      root.render(<MarkdownRenderer content={'![Unavailable chart](https://example.invalid/chart.png)'} />);
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>('img[alt="Unavailable chart"]');
    expect(image).not.toBeNull();

    act(() => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img[alt="Unavailable chart"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-part="imageFallback"]')?.textContent)
      .toBe('Unavailable chart');
  });

  it('uses the latest source text and callback without remounting a file link', async () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const firstPath = 'D:\\First\\README.md';
    const secondPath = 'E:\\Second\\README.md';

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={`[README.md](${firstPath})`}
          onFileViewRequest={firstHandler}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const linkBefore = container.querySelector<HTMLButtonElement>('button.file-link');
    expect(linkBefore).not.toBeNull();

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={`[README.md](${secondPath})`}
          onFileViewRequest={secondHandler}
        />,
      );
      await Promise.resolve();
    });

    const linkAfter = container.querySelector<HTMLButtonElement>('button.file-link');
    expect(linkAfter).toBe(linkBefore);
    act(() => linkAfter?.click());
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith(secondPath, 'README.md', undefined);
  });

  it('routes remote markdown image reads through the session connection', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![Remote chart](artifacts/chart.png)'}
          basePath={'/srv/project'}
          remoteConnectionId={'remote-connection-1'}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.readFileContent).toHaveBeenCalledWith(
      '/srv/project/artifacts/chart.png',
      'base64',
      'remote-connection-1',
    );
  });

  it('previews the resolved bytes of a markdown image and closes on the scrim or the close button', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![ReLU 图像](relu.png)'}
          basePath={EXAMPLE_WORKSPACE}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>('img[alt="ReLU 图像"]');
    expect(image?.classList.contains('markdown-image--previewable')).toBe(true);

    act(() => image?.click());

    const overlay = document.querySelector<HTMLElement>('.image-lightbox');
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute('data-openbitfun-native-webview-occlusion')).toBe('true');
    // The preview shows the bytes the inline image resolved, not the raw path.
    const preview = overlay?.querySelector<HTMLImageElement>('img');
    expect(preview?.getAttribute('src')).toBe('data:image/png;base64,cmVsdS1wbmc=');
    expect(preview?.getAttribute('data-openbitfun-part')).toBe('image');
    const surface = overlay?.querySelector<HTMLElement>('.image-lightbox-surface');
    expect(surface?.getAttribute('aria-label')).toBe('ReLU 图像');

    // Clicking the previewed image itself must not dismiss the overlay.
    act(() => preview?.click());
    expect(document.querySelector('.image-lightbox')).not.toBeNull();

    act(() => surface?.click());
    expect(document.querySelector('.image-lightbox')).toBeNull();

    act(() => image?.click());
    act(() => document.querySelector<HTMLButtonElement>('.image-lightbox-close')?.click());
    expect(document.querySelector('.image-lightbox')).toBeNull();
  });

  it('leaves images owned by a markdown link to that link', async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'[![Badge](data:image/png;base64,YQ==)](README.md)'}
          basePath={EXAMPLE_WORKSPACE}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>('img[alt="Badge"]');
    expect(image?.classList.contains('markdown-image--previewable')).toBe(true);

    act(() => image?.click());

    expect(document.querySelector('.image-lightbox')).toBeNull();
    // The file link still owns the click.
    expect(onFileViewRequest).toHaveBeenCalled();
  });

  it('does not offer a preview before an inline image resolves', async () => {
    mocks.readFileContent.mockImplementationOnce(() => new Promise<string>(() => {}));
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={'![Pending](pending.png)'}
          basePath={EXAMPLE_WORKSPACE}
          onFileViewRequest={onFileViewRequest}
        />,
      );
      await Promise.resolve();
    });

    const image = container.querySelector<HTMLImageElement>('img[alt="Pending"]');
    expect(image?.classList.contains('markdown-image--previewable')).toBe(false);
    act(() => image?.click());
    expect(document.querySelector('.image-lightbox')).toBeNull();
  });

  it('closes an open image preview when the surface switches hosts', async () => {
    await act(async () => {
      root.render(<MarkdownRenderer content={'![Preview](data:image/png;base64,YQ==)'} />);
    });

    act(() => container.querySelector<HTMLImageElement>('img')?.click());
    expect(document.querySelector('.image-lightbox')).not.toBeNull();

    await act(async () => activateSurface('peer:output-second'));

    // The previewed bytes belonged to the previous host.
    expect(document.querySelector('.image-lightbox')).toBeNull();
  });
});
