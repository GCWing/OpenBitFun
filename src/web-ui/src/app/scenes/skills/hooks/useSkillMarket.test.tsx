// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMarketItem } from '@/infrastructure/config/types';
import { useSkillMarket } from './useSkillMarket';
import { activateSurface, resetDeviceSurfaceForTest } from '@/infrastructure/peer-device/deviceSurface';

const listSkillMarketMock = vi.hoisted(() => vi.fn());
const searchSkillMarketMock = vi.hoisted(() => vi.fn());
const downloadSkillMarketMock = vi.hoisted(() => vi.fn());
const installedChangedMock = vi.hoisted(() => vi.fn());
const notificationMocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

const configChange = vi.hoisted(() => ({ listener: null as ((path: string) => void) | null }));
vi.mock('@/infrastructure/config/services/ConfigManager', () => ({
  configManager: { onConfigChange: (listener: (path: string) => void) => {
    configChange.listener = listener;
    return () => { configChange.listener = null; };
  } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/infrastructure/api', () => ({
  configAPI: {
    querySkillMarkets: async (query?: string, limit?: number) => {
      const result = query ? await searchSkillMarketMock(query, limit) : await listSkillMarketMock(undefined, limit);
      return Array.isArray(result) ? { skills: result, sourceErrors: [] } : result;
    },
    listSkillMarket: listSkillMarketMock,
    searchSkillMarket: searchSkillMarketMock,
    downloadSkillMarket: downloadSkillMarketMock,
  },
}));
vi.mock('@/infrastructure/hooks/useWorkspaceManagerSync', () => ({
  useWorkspaceManagerSync: () => ({
    workspace: { id: 'project-workspace-id', rootPath: 'D:/workspace/project' },
    hasWorkspace: true,
    isRemoteWorkspace: false,
  }),
}));
vi.mock('@/shared/notification-system', () => ({
  useNotification: () => notificationMocks,
}));

let currentMarket: ReturnType<typeof useSkillMarket> | null = null;

function Harness({ enabled, installedMarketIds = new Set<string>(), pageSize = 10 }: { enabled: boolean; installedMarketIds?: Set<string>; pageSize?: number }) {
  const market = useSkillMarket({
    searchQuery: '',
    installedMarketIds,
    enabled,
    pageSize,
    onInstalledChanged: installedChangedMock,
  });
  currentMarket = market;
  return <span>{market.marketLoading ? 'loading' : 'idle'}</span>;
}

describe('useSkillMarket', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetDeviceSurfaceForTest();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    listSkillMarketMock.mockReset().mockResolvedValue([]);
    searchSkillMarketMock.mockReset().mockResolvedValue([]);
    downloadSkillMarketMock.mockReset();
    installedChangedMock.mockReset();
    notificationMocks.success.mockReset();
    notificationMocks.warning.mockReset();
    notificationMocks.error.mockReset();
    currentMarket = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDeviceSurfaceForTest();
  });

  it('refreshes when marketplace configuration changes and ignores the old response', async () => {
    let resolveOld: ((items: SkillMarketItem[]) => void) | undefined;
    listSkillMarketMock.mockReturnValueOnce(new Promise<SkillMarketItem[]>((resolve) => { resolveOld = resolve; }));
    await act(async () => { root.render(<Harness enabled />); });
    const item = { id: 'review', installId: 'skillhub:https://corp#review', source: 'https://corp', name: 'Review', installs: 0 } as SkillMarketItem;
    listSkillMarketMock.mockResolvedValueOnce([item]);
    await act(async () => { configChange.listener?.('app.skill_market'); });
    await act(async () => { resolveOld?.([{ ...item, installId: 'old@review' }]); });
    expect(currentMarket?.marketSkills).toEqual([item]);
    expect(listSkillMarketMock).toHaveBeenCalledTimes(2);
  });

  it('keeps successful sources visible when another source fails', async () => {
    const item = { id: 'corp', installId: 'skills-sh:https://corp#team/skills@review', name: 'review', source: 'team/skills' } as SkillMarketItem;
    listSkillMarketMock.mockResolvedValue({ skills: [item], sourceErrors: ['Private: SkillHub authentication failed'] });
    await act(async () => root.render(<Harness enabled />));
    expect(currentMarket?.marketSkills).toEqual([item]);
    expect(currentMarket?.sourceErrors).toEqual(['Private: SkillHub authentication failed']);
    expect(currentMarket?.marketError).toBeNull();
  });

  it('retains the current page and loaded range during a background refresh', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `skill-${index}`, installId: `source@skill-${index}`, name: `Skill ${index}`, source: 'source',
    })) as SkillMarketItem[];
    listSkillMarketMock.mockResolvedValueOnce(items.slice(0, 20)).mockResolvedValueOnce(items);
    await act(async () => root.render(<Harness enabled />));
    await act(async () => { await currentMarket!.goToPage(2); });
    expect(currentMarket?.currentPage).toBe(2);
    const previous = currentMarket!.marketSkills;
    let finish!: (skills: SkillMarketItem[]) => void;
    listSkillMarketMock.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let refresh!: Promise<void>;
    await act(async () => { refresh = currentMarket!.refresh({ background: true }); });
    expect(currentMarket?.marketLoading).toBe(false);
    expect(currentMarket?.currentPage).toBe(2);
    expect(currentMarket?.marketSkills).toEqual(previous);
    expect(listSkillMarketMock).toHaveBeenLastCalledWith(undefined, 40);
    await act(async () => { finish(items.map(item => ({ ...item, description: 'Updated' }))); await refresh; });
    expect(currentMarket?.currentPage).toBe(2);
    expect(currentMarket?.marketSkills[0].description).toBe('Updated');
  });

  it('retains a valid empty background snapshot and still reports refresh failures', async () => {
    await act(async () => root.render(<Harness enabled />));
    let fail!: (error: Error) => void;
    listSkillMarketMock.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    let refresh!: Promise<void>;
    await act(async () => { refresh = currentMarket!.refresh({ background: true }); });
    expect(currentMarket?.marketLoading).toBe(false);
    expect(currentMarket?.marketSkills).toEqual([]);
    await act(async () => { fail(new Error('Market offline')); await refresh; });
    expect(currentMarket?.marketError).toBe('Market offline');
  });

  it('does not reuse a background snapshot or late response on another peer with the same workspace ID', async () => {
    const item = { id: 'private', installId: 'source@private', name: 'Private', source: 'source' } as SkillMarketItem;
    listSkillMarketMock.mockResolvedValueOnce([item]);
    await act(async () => root.render(<Harness enabled />));
    let finishOld!: (skills: SkillMarketItem[]) => void;
    listSkillMarketMock.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    let oldRefresh!: Promise<void>;
    await act(async () => { oldRefresh = currentMarket!.refresh({ background: true }); });
    listSkillMarketMock.mockReturnValue(new Promise(() => {}));
    await act(async () => { activateSurface('peer-b'); });
    expect(currentMarket?.marketLoading).toBe(true);
    expect(currentMarket?.marketSkills).toEqual([]);
    await act(async () => { finishOld([item]); await oldRefresh; });
    expect(currentMarket?.marketSkills).toEqual([]);
    expect(currentMarket?.marketLoading).toBe(true);
  });

  it('prioritizes only the installed repository when market skills share a name', async () => {
    const first = {
      id: 'first/skills/eli5', name: 'eli5', source: 'first/skills',
      installId: 'first/skills@eli5', installs: 1, description: '', url: '',
    };
    const second = {
      ...first, id: 'second/skills/eli5', source: 'second/skills',
      installId: 'second/skills@eli5', installs: 100,
    };
    listSkillMarketMock.mockResolvedValue([second, first]);
    await act(async () => {
      root.render(<Harness enabled installedMarketIds={new Set(['first/skills@eli5'])} />);
    });
    expect(currentMarket?.marketSkills.map(skill => skill.id)).toEqual([first.id, second.id]);

    await act(async () => {
      root.render(<Harness enabled installedMarketIds={new Set(['second/skills@eli5'])} />);
    });
    expect(currentMarket?.marketSkills.map(skill => skill.id)).toEqual([second.id, first.id]);
    expect(listSkillMarketMock).toHaveBeenCalledTimes(1);
  });

  it('does not query the skill market outside the desktop app', async () => {
    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });

    expect(listSkillMarketMock).not.toHaveBeenCalled();
    expect(searchSkillMarketMock).not.toHaveBeenCalled();
    expect(downloadSkillMarketMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe('idle');

    await act(async () => {
      root.render(<Harness enabled />);
      await Promise.resolve();
    });

    expect(listSkillMarketMock).toHaveBeenCalledTimes(1);
  });

  it('reuses loaded results and keeps the current skill visible when capacity changes', async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `skill-${index}`, installId: `skill-${index}`, name: `Skill ${index + 1}`,
      source: 'test', description: '', url: '', installs: 100 - index,
    }));
    listSkillMarketMock.mockResolvedValue(items);
    await act(async () => root.render(<Harness enabled />));
    await act(async () => currentMarket?.goToPage(1));
    expect(currentMarket?.marketSkills[0].name).toBe('Skill 11');
    await act(async () => root.render(<Harness enabled pageSize={6} />));
    expect(currentMarket?.marketSkills).toHaveLength(6);
    expect(currentMarket?.marketSkills.map(skill => skill.name)).toContain('Skill 11');
    expect(listSkillMarketMock).toHaveBeenCalledTimes(1);
  });

  it('retains the current cards while loading and honors a resize during the request', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `skill-${index}`, installId: `skill-${index}`, name: `Skill ${index + 1}`,
      source: 'test', description: '', url: '', installs: 100 - index,
    }));
    listSkillMarketMock.mockResolvedValueOnce(items.slice(0, 20));
    await act(async () => root.render(<Harness enabled />));
    await act(async () => currentMarket?.goToPage(1));
    let resolveMore!: (skills: SkillMarketItem[]) => void;
    listSkillMarketMock.mockReturnValueOnce(new Promise<SkillMarketItem[]>(resolve => { resolveMore = resolve; }));
    let request: Promise<void> | undefined;
    await act(async () => { request = currentMarket?.goToNextPage(); });
    expect(currentMarket?.loadingMore).toBe(true);
    expect(currentMarket?.marketSkills[0].name).toBe('Skill 11');
    await act(async () => root.render(<Harness enabled pageSize={4} />));
    await act(async () => { resolveMore(items); await request; });
    expect(currentMarket?.loadingMore).toBe(false);
    expect(currentMarket?.marketSkills.map(skill => skill.name)).toEqual(['Skill 21', 'Skill 22', 'Skill 23', 'Skill 24']);
    expect(listSkillMarketMock).toHaveBeenCalledTimes(2);
  });

  it('stays on a populated page when the next request finds an exact end of results', async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `skill-${index}`, installId: `skill-${index}`, name: `Skill ${index + 1}`,
      source: 'test', description: '', url: '', installs: 100 - index,
    }));
    listSkillMarketMock.mockResolvedValue(items);
    await act(async () => root.render(<Harness enabled />));
    await act(async () => currentMarket?.goToPage(1));
    await act(async () => currentMarket?.goToNextPage());
    expect(currentMarket?.hasMore).toBe(false);
    expect(currentMarket?.currentPage).toBe(1);
    expect(currentMarket?.totalPages).toBe(2);
    expect(currentMarket?.marketSkills).toHaveLength(10);
  });

  it('ignores a market load that finishes after switching away', async () => {
    let resolveLoad: ((skills: SkillMarketItem[]) => void) | undefined;
    listSkillMarketMock.mockReturnValueOnce(new Promise<SkillMarketItem[]>((resolve) => {
      resolveLoad = resolve;
    }));

    await act(async () => {
      root.render(<Harness enabled />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveLoad?.([{
        id: 'test',
        name: 'test',
        description: '',
        source: 'test',
        installs: 0,
        url: 'https://example.com/test',
        installId: 'test',
      }]);
      await Promise.resolve();
    });

    expect(currentMarket?.marketSkills).toEqual([]);
    expect(container.textContent).toBe('idle');
  });

  it('passes the workspace id when installing a project skill', async () => {
    downloadSkillMarketMock.mockResolvedValue({ installedSkills: ['review'] });
    const skill = {
      id: 'review', name: 'review', installId: 'skillhub:https://corp#team/review',
      source: 'https://corp', installs: 0, description: '', url: '',
    } as SkillMarketItem;
    await act(async () => root.render(<Harness enabled />));
    await act(async () => currentMarket?.handleDownload(skill, 'project'));
    expect(downloadSkillMarketMock).toHaveBeenCalledWith({
      packageId: skill.installId,
      level: 'project',
      workspaceId: 'project-workspace-id',
    });
    expect(installedChangedMock).toHaveBeenCalledTimes(1);
  });

  it('does not notify or reload after a pending download loses desktop capability', async () => {
    let resolveDownload: ((result: { installedSkills: string[] }) => void) | undefined;
    downloadSkillMarketMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveDownload = resolve;
    }));
    const skill: SkillMarketItem = {
      id: 'test',
      name: 'test',
      description: '',
      source: 'test',
      installs: 0,
      url: 'https://example.com/test',
      installId: 'test',
    };

    await act(async () => {
      root.render(<Harness enabled />);
      await Promise.resolve();
    });
    let download: Promise<void> | undefined;
    await act(async () => {
      download = currentMarket?.handleDownload(skill, 'user');
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Harness enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveDownload?.({ installedSkills: ['test'] });
      await download;
    });

    expect(notificationMocks.success).not.toHaveBeenCalled();
    expect(notificationMocks.error).not.toHaveBeenCalled();
    expect(installedChangedMock).not.toHaveBeenCalled();
  });
});
