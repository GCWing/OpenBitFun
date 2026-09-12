// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionAPI, workspaceAPI } from '@/infrastructure/api';
import {
  ChatContextPicker,
  type ChatContextPickerEntryView,
  type ChatContextPickerProps,
  type ContextPickerSkill,
} from './ChatContextPicker';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/infrastructure/api', () => ({
  sessionAPI: {
    searchReferenceableSessions: vi.fn().mockResolvedValue([]),
  },
  workspaceAPI: {
    getDirectoryChildren: vi.fn().mockResolvedValue([]),
    searchFilenamesOnlyStreamDetailed: vi.fn().mockResolvedValue({
      searchId: 'search-1',
      searchKind: 'filenames',
      limit: 30,
      truncated: false,
      totalResults: 0,
    }),
  },
}));

vi.mock('@/infrastructure/api/service-api/ExternalSourcesAPI', () => ({
  externalSourcesAPI: {
    getWorkspaceReferences: vi.fn().mockResolvedValue({ references: [] }),
  },
}));

interface HarnessProps {
  mcpCatalog?: ChatContextPickerProps['mcpCatalog'];
  mcpLoading?: boolean;
  mcpLoadFailed?: boolean;
  mcpUnavailable?: ChatContextPickerProps['mcpUnavailable'];
  onRefreshMcp?: ChatContextPickerProps['onRefreshMcp'];
  onSelectMcp?: ChatContextPickerProps['onSelectMcp'];
  isOpen?: boolean;
  searchQuery?: string;
  remoteConnectionId?: string;
  entryView?: ChatContextPickerEntryView;
  skills?: readonly ContextPickerSkill[];
  skillsLoading?: boolean;
  skillsLoadFailed?: boolean;
  onRetrySkills?: ChatContextPickerProps['onRetrySkills'];
  onSelectSkill?: ChatContextPickerProps['onSelectSkill'];
  onAddImage?: ChatContextPickerProps['onAddImage'];
  onSelectContext?: ChatContextPickerProps['onSelectContext'];
  onClose?: ChatContextPickerProps['onClose'];
}

const Harness: React.FC<HarnessProps> = ({
  mcpCatalog, mcpLoading, mcpLoadFailed, mcpUnavailable, onRefreshMcp, onSelectMcp,
  isOpen = true,
  searchQuery = '',
  remoteConnectionId = 'remote-connection-1',
  entryView = 'files',
  skills,
  skillsLoading,
  skillsLoadFailed,
  onRetrySkills,
  onSelectSkill,
  onAddImage,
  onSelectContext = vi.fn(),
  onClose = vi.fn(),
}) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={anchorRef} type="button">anchor</button>
      <ChatContextPicker
        mcpCatalog={mcpCatalog}
        mcpLoading={mcpLoading}
        mcpLoadFailed={mcpLoadFailed}
        mcpUnavailable={mcpUnavailable}
        onRefreshMcp={onRefreshMcp}
        onSelectMcp={onSelectMcp}
        isOpen={isOpen}
        searchQuery={searchQuery}
        workspacePath="/workspace"
        remoteConnectionId={remoteConnectionId}
        anchorRef={anchorRef}
        entryView={entryView}
        skills={skills}
        skillsLoading={skillsLoading}
        skillsLoadFailed={skillsLoadFailed}
        onRetrySkills={onRetrySkills}
        onSelectSkill={onSelectSkill}
        onAddImage={onAddImage}
        onSelectContext={onSelectContext}
        onClose={onClose}
      />
    </div>
  );
};

const option = (kind: string) => document.querySelector<HTMLElement>(
  `[data-openbitfun-context-kind="${kind}"]`,
);

describe('ChatContextPicker overlay', () => {
  const mcpCatalog = {
    modeRestricted: false,
    tools: [{ name: 'mcp__docs__search', serverId: 'docs', serverName: 'Docs', toolName: 'search', description: 'Find manuals' }],
  };

  it('opens MCP from sources with the keyboard and selects a server reference', async () => {
    const onSelectMcp = vi.fn();
    const onClose = vi.fn();
    await act(async () => root.render(<Harness entryView="sources" mcpCatalog={mcpCatalog} onSelectMcp={onSelectMcp} onClose={onClose} />));
    expect(option('mcp')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(option('mcp-server')?.textContent).toContain('Docs');
    expect(option('mcp-tool')).toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onSelectMcp).toHaveBeenCalledWith(expect.objectContaining({ reference: 'MCP "Docs" (server: "docs")' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('searches tool descriptions and selects only their owning MCP service', async () => {
    const onSelectMcp = vi.fn();
    await act(async () => root.render(<Harness searchQuery="manuals" mcpCatalog={mcpCatalog} onSelectMcp={onSelectMcp} />));
    expect(option('mcp-tool')).toBeNull();
    await act(async () => option('mcp-server')?.click());
    expect(onSelectMcp).toHaveBeenCalledWith(expect.objectContaining({ reference: 'MCP "Docs" (server: "docs")' }));
  });

  it('removes the MCP source and search results when switching to a mode without MCP', async () => {
    await act(async () => root.render(<Harness entryView="sources" mcpCatalog={mcpCatalog} onSelectMcp={vi.fn()} />));
    await act(async () => option('mcp')?.click());
    expect(option('mcp-server')).not.toBeNull();
    await act(async () => root.render(<Harness entryView="sources" mcpCatalog={mcpCatalog} />));
    expect(option('files')).not.toBeNull();
    expect(option('mcp')).toBeNull();
    expect(option('mcp-server')).toBeNull();
    await act(async () => root.render(<Harness searchQuery="MCP" mcpCatalog={mcpCatalog} />));
    expect(option('mcp-server')).toBeNull();
  });

  it('distinguishes loading, failure, mode restriction, and unsupported hosts with a retry action', async () => {
    const onRefreshMcp = vi.fn();
    const onSelectMcp = vi.fn();
    const render = (props: Partial<HarnessProps>) => act(async () => root.render(
      <Harness entryView="sources" onSelectMcp={onSelectMcp} onRefreshMcp={onRefreshMcp} {...props} />,
    ));
    await render({ mcpLoading: true });
    await act(async () => option('mcp')?.click());
    expect(document.body.textContent).toContain('contextPicker.loading');
    await render({ mcpLoadFailed: true });
    expect(document.body.textContent).toContain('contextPicker.mcp.loadFailed');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="contextPicker.mcp.refresh"]')?.click());
    expect(onRefreshMcp).toHaveBeenCalledOnce();
    await render({ mcpCatalog: { tools: [], modeRestricted: true } });
    expect(document.body.textContent).toContain('contextPicker.mcp.modeRestricted');
    expect(option('mcp-tool')).toBeNull();
    await render({ mcpUnavailable: 'unsupportedHost' });
    expect(document.body.textContent).toContain('contextPicker.mcp.unsupportedHost');
    expect(document.querySelector('[aria-label="contextPicker.mcp.refresh"]')).toBeNull();
    await render({ mcpUnavailable: 'remoteWorkspace' });
    expect(document.body.textContent).toContain('contextPicker.mcp.remoteWorkspace');
  });

  it('shows only the runtime winner for a name without exposing its key', async () => {
    const chosen = vi.fn();
    const skills = [{ name: 'pdf', key: 'user::codex::pdf', selectedForRuntime: false }, { name: 'pdf', key: 'project::codex::pdf', selectedForRuntime: true }];
    await act(async () => root.render(<Harness searchQuery="pdf" skills={skills} onSelectSkill={chosen} />));
    const options = document.querySelectorAll<HTMLElement>('[data-openbitfun-context-kind="skill"]');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe('pdf');
    await act(async () => options[0].click());
    expect(chosen).toHaveBeenCalledWith(skills[1]);
  });

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(workspaceAPI.getDirectoryChildren).mockResolvedValue([]);
    vi.mocked(workspaceAPI.searchFilenamesOnlyStreamDetailed).mockResolvedValue({
      searchId: 'search-1',
      searchKind: 'filenames',
      limit: 30,
      truncated: false,
      totalResults: 0,
    });
    vi.mocked(sessionAPI.searchReferenceableSessions).mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    container.remove();
    vi.clearAllMocks();
  });

  it('renders direct file browsing above clipped composers through the overlay host', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const picker = document.querySelector<HTMLElement>('.chat-context-picker--overlay');
    expect(picker?.parentElement?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(picker?.style.visibility).toBe('visible');
    expect(workspaceAPI.getDirectoryChildren).toHaveBeenCalledWith(
      '/workspace',
      'remote-connection-1',
    );
  });

  it('starts at context sources and loads files only after that source is entered', async () => {
    const onSelectSkill = vi.fn();
    const onAddImage = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          entryView="sources"
          onSelectSkill={onSelectSkill}
          onAddImage={onAddImage}
        />,
      );
      await Promise.resolve();
    });

    expect(option('files')).toBeTruthy();
    expect(option('skills')).toBeTruthy();
    expect(option('add-image')).toBeTruthy();
    expect(workspaceAPI.getDirectoryChildren).not.toHaveBeenCalled();
    expect(document.querySelector('[data-openbitfun-part="currentViewLabel"]')?.textContent)
      .toBe('contextPicker.menuTitle');

    await act(async () => {
      option('files')?.click();
      await Promise.resolve();
    });

    expect(workspaceAPI.getDirectoryChildren).toHaveBeenCalledWith(
      '/workspace',
      'remote-connection-1',
    );
  });

  it('returns to context sources without eagerly reloading the previous file view', async () => {
    const pickerProps = {
      entryView: 'sources' as const,
      onSelectSkill: vi.fn(),
      onAddImage: vi.fn(),
    };

    await act(async () => {
      root.render(<Harness {...pickerProps} />);
      await Promise.resolve();
    });
    await act(async () => {
      option('files')?.click();
      await Promise.resolve();
    });
    expect(workspaceAPI.getDirectoryChildren).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(<Harness {...pickerProps} isOpen={false} />);
      await Promise.resolve();
    });
    vi.mocked(workspaceAPI.getDirectoryChildren).mockClear();
    await act(async () => {
      root.render(<Harness {...pickerProps} />);
      await Promise.resolve();
    });

    expect(option('files')).toBeTruthy();
    expect(workspaceAPI.getDirectoryChildren).not.toHaveBeenCalled();
  });

  it('shows the current directory as one continuous workspace-relative path', async () => {
    vi.mocked(workspaceAPI.getDirectoryChildren).mockResolvedValueOnce([
      {
        path: '/workspace/src',
        name: 'src',
        isDirectory: true,
      },
    ]);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const item = document.querySelector<HTMLElement>('[data-openbitfun-part="option"]');
    expect(document.querySelector('[data-openbitfun-part="currentDirectoryPath"]')?.textContent)
      .toBe('workspace');
    expect(document.querySelector('.chat-context-picker__directory-label')?.getAttribute('title'))
      .toBe('workspace');
    expect(item?.querySelector('[data-openbitfun-part="label"]')?.textContent).toBe('src');
    expect(item?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();

    vi.mocked(workspaceAPI.getDirectoryChildren).mockResolvedValueOnce([
      {
        path: '/workspace/src/App.tsx',
        name: 'App.tsx',
        isDirectory: false,
      },
    ]);

    await act(async () => {
      item?.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[data-openbitfun-part="currentDirectoryPath"]')?.textContent)
      .toBe('workspace/src');
    expect(document.querySelector('.chat-context-picker__directory-label')?.getAttribute('title'))
      .toBe('workspace/src');
    const nestedItem = document.querySelector('[data-openbitfun-part="option"]');
    expect(nestedItem?.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe('App.tsx');
    expect(nestedItem?.querySelector('[data-openbitfun-part="metadata"]')).toBeNull();
  });

  it('enters the Skill source and returns the selected Skill', async () => {
    const skill = {
      key: 'pdf-skill',
      name: 'pdf-document-extraction-and-accessibility-review',
      description: 'Work with PDFs',
      argumentHint: '<file>',
    };
    const secondSkill = {
      key: 'slides-skill',
      name: 'slides',
      description: 'Build presentations',
    };
    const onSelectSkill = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          entryView="sources"
          skills={[skill, secondSkill]}
          onSelectSkill={onSelectSkill}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      option('skills')?.click();
    });

    const skillOptions = document.querySelectorAll<HTMLElement>(
      '[data-openbitfun-context-kind="skill"]',
    );
    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="label"]')?.textContent)
      .toBe(skill.name);
    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="label"]')
      ?.getAttribute('data-overflow-behavior')).toBe('fade');
    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="label"] [data-overflow-content]'))
      .toBeNull();
    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="metadata"]')?.textContent)
      .toBe('Work with PDFs');
    const description = skillOptions[0]?.querySelector('[data-openbitfun-part="skillDescription"]');
    expect(description?.getAttribute('data-marquee-active')).toBeNull();
    expect(description?.getAttribute('title')).toBe('');
    expect(skillOptions[0]?.getAttribute('title')).toBe('');
    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="label"]')?.getAttribute('title')).toBe('');
    expect(skillOptions[1]?.querySelector('[data-openbitfun-part="metadata"]')?.textContent)
      .toBe('Build presentations');
    expect(workspaceAPI.getDirectoryChildren).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(skillOptions[0]?.querySelector('[data-openbitfun-part="metadata"]')?.textContent).toBe('Work with PDFs');
    expect(skillOptions[1]?.querySelector('[data-openbitfun-part="metadata"]')?.textContent)
      .toBe('Build presentations');

    await act(async () => {
      skillOptions[1]?.click();
    });

    expect(onSelectSkill).toHaveBeenCalledWith(secondSkill);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('runs the add-image action from the source level', async () => {
    const onAddImage = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <Harness entryView="sources" onAddImage={onAddImage} onClose={onClose} />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      option('add-image')?.click();
    });

    expect(onAddImage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a failed Skill provider inside its child view and supports retry', async () => {
    const onRetrySkills = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          entryView="sources"
          skillsLoadFailed
          onRetrySkills={onRetrySkills}
          onSelectSkill={vi.fn()}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      option('skills')?.click();
    });
    expect(option('retry-skills')).toBeTruthy();
    await act(async () => {
      option('retry-skills')?.click();
    });

    expect(onRetrySkills).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('merges file, Skill, and session providers when text follows @', async () => {
    vi.useFakeTimers();
    vi.mocked(workspaceAPI.searchFilenamesOnlyStreamDetailed).mockImplementationOnce((
      _rootPath,
      _pattern,
      _caseSensitive,
      _useRegex,
      _wholeWord,
      _searchIdOrSignal,
      _maxResults,
      _includeDirectories,
      callbacks,
    ) => {
      callbacks.onProgress({
        searchId: 'search-merged-1',
        searchKind: 'filenames',
        results: [{
          path: '/workspace/docs',
          name: 'docs',
          isDirectory: true,
          fileNameMatch: {
            path: '/workspace/docs',
            name: 'docs',
            isDirectory: true,
            matchType: 'fileName',
          },
          contentMatches: [],
        }],
      });
      return Promise.resolve({
        searchId: 'search-merged-1',
        searchKind: 'filenames',
        limit: 30,
        truncated: false,
        totalResults: 1,
      });
    });
    vi.mocked(sessionAPI.searchReferenceableSessions).mockResolvedValueOnce([{
      sessionId: 'session-docs',
      sessionName: 'Docs migration',
      workspacePath: '/workspace',
      workspaceLabel: 'workspace',
      lastActivityAt: 1,
    }]);

    await act(async () => {
      root.render(
        <Harness
          entryView="sources"
          searchQuery="doc"
          skills={[{ key: 'docs-skill', name: 'docs-helper', description: 'Docs' }]}
          onSelectSkill={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(option('file')?.textContent).toContain('docs');
    expect(option('skill')?.textContent).toContain('docs-helper');
    expect(option('session')?.textContent).toContain('Docs migration');
    expect(document.querySelector('[data-openbitfun-part="currentDirectoryPath"]')).toBeNull();
  });

  it('does not present a remote browse failure as an empty directory', async () => {
    vi.mocked(workspaceAPI.getDirectoryChildren).mockRejectedValueOnce(
      new Error('remote connection unavailable'),
    );

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    expect(document.querySelector('[data-openbitfun-part="empty"][data-openbitfun-state~="error"]')?.textContent)
      .toBe('contextPicker.browseUnavailable');
    expect(document.querySelector('[data-openbitfun-part="empty"]:not([data-openbitfun-state~="error"])'))
      .toBeNull();
  });

  it('shows streamed remote matches before the recursive search completes', async () => {
    vi.useFakeTimers();
    let reportProgress: ((event: {
      searchId: string;
      searchKind: 'filenames';
      results: Array<{
        path: string;
        name: string;
        isDirectory: boolean;
        fileNameMatch: {
          path: string;
          name: string;
          isDirectory: boolean;
          matchType: 'fileName';
        };
        contentMatches: [];
      }>;
    }) => void) | undefined;
    let finishSearch: (() => void) | undefined;

    vi.mocked(workspaceAPI.searchFilenamesOnlyStreamDetailed).mockImplementationOnce((
      _rootPath,
      _pattern,
      _caseSensitive,
      _useRegex,
      _wholeWord,
      _searchIdOrSignal,
      _maxResults,
      _includeDirectories,
      callbacks,
    ) => {
      reportProgress = callbacks.onProgress;
      return new Promise(resolve => {
        finishSearch = () => resolve({
          searchId: 'search-remote-1',
          searchKind: 'filenames',
          limit: 30,
          truncated: false,
          totalResults: 1,
        });
      });
    });

    await act(async () => {
      root.render(<Harness searchQuery="手写" />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(workspaceAPI.searchFilenamesOnlyStreamDetailed).toHaveBeenCalled();
    expect(
      vi.mocked(workspaceAPI.searchFilenamesOnlyStreamDetailed).mock.calls[0]?.[10],
    ).toBe('remote-connection-1');

    await act(async () => {
      reportProgress?.({
        searchId: 'search-remote-1',
        searchKind: 'filenames',
        results: [{
          path: '/workspace/手写笔画标注项目',
          name: '手写笔画标注项目',
          isDirectory: true,
          fileNameMatch: {
            path: '/workspace/手写笔画标注项目',
            name: '手写笔画标注项目',
            isDirectory: true,
            matchType: 'fileName',
          },
          contentMatches: [],
        }],
      });
      await Promise.resolve();
    });

    expect(option('file')?.textContent).toContain('手写笔画标注项目');
    expect(document.querySelector('[data-openbitfun-part="root"]')?.getAttribute('data-openbitfun-state'))
      .toBe('loading');

    await act(async () => {
      finishSearch?.();
      await Promise.resolve();
    });
  });
});
