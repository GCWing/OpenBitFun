import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { configAPI } from '@/infrastructure/api';
import { isSkillMarketItemInstalled } from '@/infrastructure/config/skillMarketInstallation';
import type { SkillLevel, SkillMarketItem } from '@/infrastructure/config/types';
import { useWorkspaceManagerSync } from '@/infrastructure/hooks/useWorkspaceManagerSync';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('SkillsScene:useSkillMarket');

const DEFAULT_PAGE_SIZE = 10;
const MAX_TOTAL_SKILLS = 500;

interface UseSkillMarketOptions {
  searchQuery: string;
  installedMarketIds: Set<string>;
  onInstalledChanged?: () => Promise<void> | void;
  pageSize?: number;
  enabled?: boolean;
}

export function useSkillMarket({
  searchQuery,
  installedMarketIds,
  onInstalledChanged,
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true,
}: UseSkillMarketOptions) {
  const { t } = useTranslation('scenes/skills');
  const notification = useNotification();
  const { workspace, hasWorkspace, isRemoteWorkspace } = useWorkspaceManagerSync();

  const [marketSkills, setMarketSkills] = useState<SkillMarketItem[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [downloadingPackage, setDownloadingPackage] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const marketRequestIdRef = useRef(0);
  const capabilityKey = `${enabled}\u0000${workspace?.id ?? ''}\u0000${isRemoteWorkspace}`;
  const capabilityRef = useRef({ key: capabilityKey, epoch: 0, enabled });
  useLayoutEffect(() => {
    if (capabilityRef.current.key !== capabilityKey) {
      capabilityRef.current = {
        key: capabilityKey,
        epoch: capabilityRef.current.epoch + 1,
        enabled,
      };
    } else {
      capabilityRef.current.enabled = enabled;
    }
  }, [capabilityKey, enabled]);

  const currentCapabilityEpoch = useCallback((): number | null => (
    capabilityRef.current.enabled ? capabilityRef.current.epoch : null
  ), []);
  const capabilityIsCurrent = useCallback((epoch: number): boolean => (
    capabilityRef.current.enabled && capabilityRef.current.epoch === epoch
  ), []);

  const fetchSkills = useCallback(async (query: string | undefined, limit: number) => {
    const normalized = query?.trim();
    return normalized
      ? await configAPI.searchSkillMarket(normalized, limit)
      : await configAPI.listSkillMarket(undefined, limit);
  }, []);

  const loadFirstPage = useCallback(async (query?: string) => {
    const capabilityEpoch = currentCapabilityEpoch();
    if (capabilityEpoch === null) {
      return;
    }
    const requestId = ++marketRequestIdRef.current;

    setMarketLoading(true);
    setMarketError(null);
    setCurrentPage(0);
    try {
      const skillList = await fetchSkills(query, pageSize);
      if (requestId !== marketRequestIdRef.current || !capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      setMarketSkills(skillList);
      setHasMore(skillList.length >= pageSize);
    } catch (err) {
      if (requestId !== marketRequestIdRef.current || !capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      log.error('Failed to load skill market', err);
      setMarketError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === marketRequestIdRef.current && capabilityIsCurrent(capabilityEpoch)) {
        setMarketLoading(false);
      }
    }
  }, [capabilityIsCurrent, currentCapabilityEpoch, fetchSkills, pageSize]);

  useEffect(() => {
    marketRequestIdRef.current += 1;
    if (!enabled) {
      setMarketSkills([]);
      setMarketLoading(false);
      setLoadingMore(false);
      setMarketError(null);
      setDownloadingPackage(null);
      setCurrentPage(0);
      setHasMore(false);
      return;
    }
    loadFirstPage(searchQuery || undefined);
  }, [capabilityKey, enabled, loadFirstPage, searchQuery]);

  const refresh = useCallback(async () => {
    await loadFirstPage(searchQuery || undefined);
  }, [loadFirstPage, searchQuery]);

  const displayMarketSkills = useMemo(() => {
    const entries = marketSkills.map((skill, index) => ({
      skill,
      index,
      installed: isSkillMarketItemInstalled(skill, installedMarketIds),
    }));

    entries.sort((a, b) => {
      if (a.installed !== b.installed) {
        return a.installed ? -1 : 1;
      }
      const installDelta = (b.skill.installs ?? 0) - (a.skill.installs ?? 0);
      if (installDelta !== 0) {
        return installDelta;
      }
      return a.index - b.index;
    });

    return entries.map((entry) => entry.skill);
  }, [installedMarketIds, marketSkills]);

  const loadedPages = Math.ceil(displayMarketSkills.length / pageSize);
  const totalPages = hasMore ? loadedPages + 1 : Math.max(1, loadedPages);

  const paginatedSkills = useMemo(() => displayMarketSkills.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  ), [currentPage, displayMarketSkills, pageSize]);

  const goToPrevPage = useCallback(() => {
    if (currentCapabilityEpoch() === null) {
      return;
    }
    setCurrentPage((page) => Math.max(0, page - 1));
  }, [currentCapabilityEpoch]);

  const goToNextPage = useCallback(async () => {
    const capabilityEpoch = currentCapabilityEpoch();
    if (capabilityEpoch === null) {
      return;
    }
    const requestId = ++marketRequestIdRef.current;

    const nextPage = currentPage + 1;
    const neededCount = Math.min((nextPage + 1) * pageSize, MAX_TOTAL_SKILLS);

    if (displayMarketSkills.length >= neededCount) {
      setCurrentPage(nextPage);
      return;
    }

    if (!hasMore) {
      return;
    }

    setCurrentPage(nextPage);

    try {
      setLoadingMore(true);
      const skillList = await fetchSkills(searchQuery || undefined, neededCount);
      if (requestId !== marketRequestIdRef.current || !capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      setMarketSkills(skillList);
      const hitCap = neededCount >= MAX_TOTAL_SKILLS;
      setHasMore(!hitCap && skillList.length >= neededCount);
    } catch (err) {
      if (requestId !== marketRequestIdRef.current || !capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      log.error('Failed to load more skills', err);
      setCurrentPage(currentPage);
    } finally {
      if (requestId === marketRequestIdRef.current && capabilityIsCurrent(capabilityEpoch)) {
        setLoadingMore(false);
      }
    }
  }, [capabilityIsCurrent, currentCapabilityEpoch, currentPage, displayMarketSkills.length, fetchSkills, hasMore, pageSize, searchQuery]);

  const handleDownload = useCallback(async (skill: SkillMarketItem, targetLevel: SkillLevel = 'project') => {
    const capabilityEpoch = currentCapabilityEpoch();
    if (capabilityEpoch === null) {
      return;
    }

    const resolvedLevel: SkillLevel = isRemoteWorkspace ? 'user' : targetLevel;
    if (resolvedLevel === 'project' && !hasWorkspace) {
      notification.warning(t('messages.noWorkspace'));
      return;
    }
    try {
      setDownloadingPackage(skill.installId);
      const result = await configAPI.downloadSkillMarket({
        packageId: skill.installId,
        level: resolvedLevel,
        workspaceId: resolvedLevel === 'project' ? workspace?.id : undefined,
      });
      if (!capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      const installedName = result.installedSkills[0] ?? skill.name;
      notification.success(t('messages.marketDownloadSuccess', { name: installedName }));
      await onInstalledChanged?.();
    } catch (err) {
      if (!capabilityIsCurrent(capabilityEpoch)) {
        return;
      }
      notification.error(
        t('messages.marketDownloadFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      if (capabilityIsCurrent(capabilityEpoch)) {
        setDownloadingPackage(null);
      }
    }
  }, [capabilityIsCurrent, currentCapabilityEpoch, hasWorkspace, isRemoteWorkspace, notification, onInstalledChanged, t, workspace?.id]);

  return {
    marketSkills: paginatedSkills,
    marketLoading,
    loadingMore,
    marketError,
    downloadingPackage,
    hasMore,
    currentPage,
    totalPages,
    refresh,
    goToPrevPage,
    goToNextPage,
    handleDownload,
    hasWorkspace,
    isRemoteWorkspace,
    totalLoaded: displayMarketSkills.length,
  };
}
