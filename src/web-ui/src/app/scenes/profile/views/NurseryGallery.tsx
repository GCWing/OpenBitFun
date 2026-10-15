import { resolveAssistantName } from '@/shared/utils/assistantName';
import { Button, Icon, NumberBadge, PageHeader } from '@openbitfun/ui';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import {
  GalleryEmpty,
  GalleryLayout,
  GalleryZone,
  GalleryGrid,
  GallerySkeleton,
} from '@/app/components/GalleryLayout';
import { confirmDanger, confirmDialog } from '@/infrastructure/confirm-dialog';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import type { WorkspaceInfo } from '@/shared/types';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import AssistantCard from './AssistantCard';
import { useNurseryStore } from '../nurseryStore';
import './NurseryView.scss';

const log = createLogger('NurseryGallery');

const NurseryGallery: React.FC = () => {
  const { t } = useI18n('scenes/profile');
  const {
    allAssistantWorkspacesList: assistantWorkspacesList,
    openedWorkspaces,
    assistantWorkspaces,
    closeWorkspaceById,
    createAssistantWorkspace,
    deleteAssistantWorkspace,
    primaryAssistantWorkspaceId,
    error: workspaceError,
    loading: workspaceLoading,
    setActiveWorkspace,
    setPrimaryAssistantWorkspace,
  } = useWorkspaceContext();
  const { openAssistant } = useNurseryStore();
  const notification = useNotification();
  const [creating, setCreating] = useState(false);
  const assistantCreationPending = useRef(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [settingPrimaryWorkspaceId, setSettingPrimaryWorkspaceId] = useState<string | null>(null);
  const [openingWorkspaceId, setOpeningWorkspaceId] = useState<string | null>(null);
  const [closingWorkspaceId, setClosingWorkspaceId] = useState<string | null>(null);

  const handleCreateAssistant = useCallback(async () => {
    if (assistantCreationPending.current) return;
    const scope = getActiveSurfaceScope();
    assistantCreationPending.current = true;
    try {
      const confirmed = await confirmDialog({
        title: t('nursery.gallery.newAssistant'),
        message: t('nursery.gallery.createConfirmMessage'),
        confirmText: t('nursery.gallery.newAssistant'),
        type: 'info',
      });
      if (!confirmed || !scope.isCurrent()) return;

      setCreating(true);
      const newWorkspace = await createAssistantWorkspace();
      scope.assertCurrent('open newly created assistant');
      openAssistant(newWorkspace.id);
    } catch (e) {
      if (scope.isCurrent()) {
        log.error('Failed to create assistant workspace', e);
        notification.error(t('nursery.gallery.createFailed'));
      }
    } finally {
      assistantCreationPending.current = false;
      setCreating(false);
    }
  }, [createAssistantWorkspace, notification, openAssistant, t]);

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
    const name = resolveAssistantName(workspace, t('shared:agents.Claw'));
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

  const handleOpenAssistant = useCallback(async (workspace: WorkspaceInfo) => {
    if (openingWorkspaceId) return;
    setOpeningWorkspaceId(workspace.id);
    try {
      await setActiveWorkspace(workspace.id);
    } catch (error) {
      log.error('Failed to open assistant workspace', error);
      notification.error(t('nursery.card.openFailed'));
    } finally {
      setOpeningWorkspaceId(null);
    }
  }, [notification, openingWorkspaceId, setActiveWorkspace, t]);

  const handleCloseAssistant = useCallback(async (workspace: WorkspaceInfo) => {
    if (closingWorkspaceId) return;
    setClosingWorkspaceId(workspace.id);
    try {
      await closeWorkspaceById(workspace.id);
    } catch (error) {
      log.error('Failed to close assistant workspace', error);
      notification.error(t('nursery.card.closeFailed'));
    } finally {
      setClosingWorkspaceId(null);
    }
  }, [closeWorkspaceById, closingWorkspaceId, notification, t]);

  return (
    <GalleryLayout
      className="nursery-gallery"
      data-openbitfun-component="nursery-gallery"
      data-openbitfun-part="root"
    >
      <PageHeader
        className="nursery-gallery__header"
        level={2}
        size="display"
        align="center"
        title={t('nursery.gallery.title')}
        description={t('nursery.gallery.subtitle')}
      />

      <div className="gallery-zones" data-openbitfun-component="nursery-gallery" data-openbitfun-part="content">
        <GalleryZone
          id="nursery-assistants-zone"
          className="nursery-gallery__assistant-zone"
          title={t('nursery.gallery.assistantsTitle')}
          titleAdornment={<NumberBadge value={sortedAssistantWorkspacesList.length} />}
          tools={(
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
        >
          {workspaceLoading && sortedAssistantWorkspacesList.length === 0 ? (
            <GallerySkeleton
              count={3}
              cardHeight={152}
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
              className="nursery-gallery__assistant-grid"
              role="list"
            >
              {sortedAssistantWorkspacesList.map((workspace, i) => {
                const isPrimary = workspace.id === primaryAssistantWorkspaceId;
                const isOpened = openedWorkspaces.has(workspace.id);
                return (
                  <AssistantCard
                    key={workspace.id}
                    workspace={workspace}
                    isPrimary={isPrimary}
                    isDeleting={deletingWorkspaceId === workspace.id}
                    isSettingPrimary={settingPrimaryWorkspaceId === workspace.id}
                    isOpening={openingWorkspaceId === workspace.id}
                    isClosing={closingWorkspaceId === workspace.id}
                    onOpen={isOpened ? undefined : () => { void handleOpenAssistant(workspace); }}
                    onClose={isOpened ? () => { void handleCloseAssistant(workspace); } : undefined}
                    closeDisabledReason={assistantWorkspaces === null ? t('common:nav.workspaces.closeAssistantUnsupported') : undefined}
                    onClick={() => openAssistant(workspace.id)}
                    onDelete={isPrimary ? undefined : () => { void handleDeleteRequest(workspace); }}
                    onSetPrimary={isPrimary ? undefined : () => { void handleSetPrimary(workspace); }}
                    style={{ '--surface-stagger-index': i } as React.CSSProperties}
                  />
                );
              })}
              {sortedAssistantWorkspacesList.length < 3 ? (
                <div
                  className={[
                    'nursery-gallery__create-card',
                    sortedAssistantWorkspacesList.length === 1
                      && sortedAssistantWorkspacesList[0].id === primaryAssistantWorkspaceId
                      && 'nursery-gallery__create-card--tall',
                  ].filter(Boolean).join(' ')}
                  role="listitem"
                  data-openbitfun-component="nursery-gallery"
                  data-openbitfun-part="createCard"
                >
                  <Button
                    className="nursery-gallery__create-button"
                    variant="fill"
                    labelBehavior="static"
                    leadingIcon={<Icon name="plus" size="lg" aria-hidden="true" />}
                    onClick={handleCreateAssistant}
                    loading={creating}
                    disabled={creating}
                  >
                    {t(creating ? 'nursery.gallery.creating' : 'nursery.gallery.newAssistant')}
                  </Button>
                </div>
              ) : null}
            </GalleryGrid>
          )}
        </GalleryZone>
      </div>
    </GalleryLayout>
  );
};

export default NurseryGallery;
