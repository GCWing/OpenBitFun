// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillMarketItem } from '@/infrastructure/config/types';
import { useSkillMarket } from './useSkillMarket';

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

function Harness({ enabled, installedMarketIds = new Set<string>() }: { enabled: boolean; installedMarketIds?: Set<string> }) {
  const market = useSkillMarket({
    searchQuery: '',
    installedMarketIds,
    enabled,
    onInstalledChanged: installedChangedMock,
  });
  currentMarket = market;
  return <span>{market.marketLoading ? 'loading' : 'idle'}</span>;
}

describe('useSkillMarket', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
