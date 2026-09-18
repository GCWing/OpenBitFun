import { Button, Card, Icon, NumberBadge, PageHeader, StatusPill } from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, LoaderCircle, Wrench } from 'lucide-react';
import {
  GalleryEmpty,
  GalleryLayout,
  GalleryZone,
  GalleryGrid,
  GallerySkeleton,
} from '@/app/components';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { flowChatManager } from '@/flow_chat/services/FlowChatManager';
import { flowChatSessionConfigForWorkspace } from '@/app/utils/projectSessionWorkspace';
import type { WorkspaceInfo } from '@/shared/types';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import AssistantCard from './AssistantCard';
import { useNurseryStore } from '../nurseryStore';
import './NurseryView.scss';

const log = createLogger('NurseryGallery');
const ASSISTANT_MODE_ID = 'Claw';

interface TemplateStats {
  enabledToolCount: number;
  enabledSkillCount: number;
}

type TemplateStatsStatus = 'loading' | 'ready' | 'error';

const NurseryGallery: React.FC = () => {
  const { t } = useTranslation('scenes/profile');
  const {
    assistantWorkspacesList,
    createAssistantWorkspace,
    deleteAssistantWorkspace,
    primaryAssistantWorkspaceId,
    error: workspaceError,
    loading: workspaceLoading,
    setActiveWorkspace,
    setPrimaryAssistantWorkspace,
  } = useWorkspaceContext();
  const { openDefaults, openAssistant } = useNurseryStore();
  const notification = useNotification();
  const [creating, setCreating] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [settingPrimaryWorkspaceId, setSettingPrimaryWorkspaceId] = useState<string | null>(null);
  const [startingSessionWorkspaceId, setStartingSessionWorkspaceId] = useState<string | null>(null);
  const [templateStats, setTemplateStats] = useState<TemplateStats | null>(null);
  const [templateStatsStatus, setTemplateStatsStatus] = useState<TemplateStatsStatus>('loading');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setTemplateStatsStatus('loading');
      try {
        const [modeConf, skills] = await Promise.all([
          configAPI.getAgentProfileConfig(ASSISTANT_MODE_ID),
          configAPI.getModeSkillConfigs({ modeId: ASSISTANT_MODE_ID }),
        ]);

        if (cancelled) return;
        setTemplateStats({
          enabledToolCount: modeConf?.enabled_tools?.length ?? 0,
          enabledSkillCount: skills.filter((skill) => skill.effectiveEnabled).length,
        });
        setTemplateStatsStatus('ready');
      } catch (e) {
        log.error('Failed to load template stats', e);
        if (!cancelled) {
          setTemplateStats(null);
          setTemplateStatsStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreateAssistant = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const newWorkspace = await createAssistantWorkspace();
      openAssistant(newWorkspace.id);
    } catch (e) {
      log.error('Failed to create assistant workspace', e);
      notification.error(t('nursery.gallery.createFailed'));
    } finally {
      setCreating(false);
    }
  }, [creating, createAssistantWorkspace, notification, openAssistant, t]);

  const sortedAssistantWorkspacesList = useMemo(
    () => {
      const primary = assistantWorkspacesList.filter(w => w.id === primaryAssistantWorkspaceId);
      const secondary = assistantWorkspacesList.filter(w => w.id !== primaryAssistantWorkspaceId);
      return [...primary, ...secondary];
    },
    [assistantWorkspacesList, primaryAssistantWorkspaceId]
  );

  const handleSetPrimary = useCallback(async (workspace: WorkspaceInfo) => {
    if (settingPrimaryWorkspaceId || workspace.id === primaryAssistantWorkspaceId) return;
    setSettingPrimaryWorkspaceId(workspace.id);
    try {
      await setPrimaryAssistantWorkspace(workspace.id);
      notification.success(t('nursery.card.setPrimarySuccess'));
    } catch (e) {
      log.error('Failed to set primary assistant workspace', e);
      notification.error(t('nursery.card.setPrimaryFailed'));
    } finally {
      setSettingPrimaryWorkspaceId(null);
    }
  }, [
    notification,
    primaryAssistantWorkspaceId,
    setPrimaryAssistantWorkspace,
    settingPrimaryWorkspaceId,
    t,
  ]);

  const handleDeleteRequest = useCallback(async (workspace: WorkspaceInfo) => {
    if (deletingWorkspaceId) return;
    const identity = workspace.identity;
    const name = identity?.name?.trim() || workspace.name || t('nursery.card.unnamed');
    const confirmed = await confirmDanger(
      t('nursery.card.deleteConfirmTitle'),
      t('nursery.card.deleteConfirmMessage', { name }),
      {
        confirmText: t('nursery.card.deleteConfirm'),
        cancelText: t('nursery.card.deleteCancel'),
      },
    );
    if (!confirmed) return;

    setDeletingWorkspaceId(workspace.id);
    try {
      await deleteAssistantWorkspace(workspace.id);
    } catch (e) {
      log.error('Failed to delete assistant workspace', e);
      notification.error(t('nursery.card.deleteFailed'));
    } finally {
      setDeletingWorkspaceId(null);
    }
  }, [deleteAssistantWorkspace, deletingWorkspaceId, notification, t]);

  const handleNewAssistantSession = useCallback(
    async (workspace: WorkspaceInfo) => {
      if (startingSessionWorkspaceId) return;
      setStartingSessionWorkspaceId(workspace.id);
      try {
        const sessionId = await flowChatManager.createChatSession(flowChatSessionConfigForWorkspace(workspace), 'Claw');
        await openMainSession(sessionId, {
          workspaceId: workspace.id,
          activateWorkspace: setActiveWorkspace,
        });
      } catch (e) {
        log.error('Failed to create assistant session from gallery', e);
        notification.error(t('nursery.card.newSessionFailed'));
      } finally {
        setStartingSessionWorkspaceId(null);
      }
    },
    [
      notification,
      setActiveWorkspace,
      startingSessionWorkspaceId,
      t,
    ],
  );

  return (
    <GalleryLayout
      className="nursery-gallery"
      data-openbitfun-component="nursery-gallery"
      data-openbitfun-part="root"
    >
      <PageHeader
        className="nursery-gallery__header"
        level={2}
        title={t('nursery.gallery.title')}
        description={t('nursery.gallery.subtitle')}
        action={(
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleCreateAssistant}
            disabled={creating}
            aria-busy={creating}
          >
            {creating ? (
              <LoaderCircle className="nursery-spinning" size={15} aria-hidden="true" />
            ) : (
              <Icon name="plus" size="sm" aria-hidden="true" />
            )}
            <span>
              {t(creating ? 'nursery.gallery.creating' : 'nursery.gallery.newAssistant')}
            </span>
          </Button>
        )}
      />

      <div className="gallery-zones" data-openbitfun-component="nursery-gallery" data-openbitfun-part="content">
        <section className="nursery-defaults" aria-labelledby="nursery-defaults-title" data-openbitfun-component="nursery-gallery" data-openbitfun-part="defaults">
          <Card className="nursery-defaults__surface" appearance="subtle" padding="md" radius="md" gap="md">
            <div className="nursery-defaults__content" data-openbitfun-component="nursery-gallery" data-openbitfun-part="defaultsContent">
              <div className="nursery-defaults__title-row">
                <h3 className="nursery-defaults__title" id="nursery-defaults-title">
                  {t('nursery.template.title')}
                </h3>
                <StatusPill tone="neutral">{t('nursery.template.defaultBadge')}</StatusPill>
              </div>
              <p className="nursery-defaults__subtitle">{t('nursery.template.subtitle')}</p>

              <div
                className="nursery-defaults__stats"
                data-openbitfun-component="nursery-gallery"
                data-openbitfun-part="stats"
                aria-live="polite"
                aria-busy={templateStatsStatus === 'loading'}
              >
                {templateStatsStatus === 'loading' ? (
                  <>
                    <span className="nursery-defaults__stat-skeleton" aria-hidden="true" />
                    <span className="nursery-defaults__stat-skeleton" aria-hidden="true" />
                  </>
                ) : templateStatsStatus === 'error' ? (
                  <span className="nursery-defaults__stat nursery-defaults__stat--error">
                    <Icon glyph={CircleAlert} size="xs" />
                    {t('nursery.template.statsUnavailable')}
                  </span>
                ) : templateStats ? (
                  <>
                    <span className="nursery-defaults__stat">
                      <Icon glyph={Wrench} size="xs" />
                      {t('nursery.template.stats.tools', { count: templateStats.enabledToolCount })}
                    </span>
                    <span className="nursery-defaults__stat">
                      <Icon name="extension" size="xs" aria-hidden="true" />
                      {t('nursery.template.stats.skills', { count: templateStats.enabledSkillCount })}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            <Button
              variant="secondary"
              size="sm"
              className="nursery-defaults__action"
              leadingIcon={<Icon name="settings" size="sm" />}
              trailingIcon={<Icon name="chevron-right" size="sm" />}
              onClick={openDefaults}
            >
              {t('nursery.template.configure')}
            </Button>
          </Card>
        </section>

        <GalleryZone
          id="nursery-assistants-zone"
          className="nursery-gallery__assistant-zone"
          title={t('nursery.gallery.assistantsTitle')}
          subtitle={t('nursery.gallery.assistantsSubtitle')}
          tools={(
            <NumberBadge value={sortedAssistantWorkspacesList.length} />
          )}
        >
          {workspaceLoading && sortedAssistantWorkspacesList.length === 0 ? (
            <GallerySkeleton
              count={3}
              cardHeight={168}
              minCardWidth={340}
              className="nursery-gallery__skeleton"
            />
          ) : workspaceError && sortedAssistantWorkspacesList.length === 0 ? (
            <GalleryEmpty
              icon={{ glyph: CircleAlert }}
              message={t('nursery.gallery.loadFailed')}
              isError
              className="nursery-gallery__empty"
              testId="nursery-gallery-error"
            />
          ) : sortedAssistantWorkspacesList.length === 0 ? (
            <GalleryEmpty
              icon={{ name: 'user' }}
              message={(
                <>
                  <strong>{t('nursery.gallery.emptyTitle')}</strong>
                  <small>{t('nursery.gallery.emptySubtitle')}</small>
                </>
              )}
              action={(
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleCreateAssistant}
                  disabled={creating}
                  leadingIcon={<Icon name="plus" size="sm" aria-hidden="true" />}
                >

                  {t('nursery.gallery.newAssistant')}
                </Button>
              )}
              className="nursery-gallery__empty"
              testId="nursery-gallery-empty"
            />
          ) : (
            <GalleryGrid
              minCardWidth={340}
              className="nursery-gallery__assistant-grid"
              role="list"
            >
              {sortedAssistantWorkspacesList.map((workspace, i) => {
                const isPrimary = workspace.id === primaryAssistantWorkspaceId;
                return (
                  <AssistantCard
                    key={workspace.id}
                    workspace={workspace}
                    isPrimary={isPrimary}
                    isDeleting={deletingWorkspaceId === workspace.id}
                    isStartingSession={startingSessionWorkspaceId === workspace.id}
                    isSettingPrimary={settingPrimaryWorkspaceId === workspace.id}
                    onClick={() => openAssistant(workspace.id)}
                    onNewSession={() => { void handleNewAssistantSession(workspace); }}
                    onDelete={isPrimary ? undefined : () => { void handleDeleteRequest(workspace); }}
                    onSetPrimary={isPrimary ? undefined : () => { void handleSetPrimary(workspace); }}
                    style={{ '--surface-stagger-index': i } as React.CSSProperties}
                  />
                );
              })}
            </GalleryGrid>
          )}
        </GalleryZone>
      </div>
    </GalleryLayout>
  );
};

export default NurseryGallery;
