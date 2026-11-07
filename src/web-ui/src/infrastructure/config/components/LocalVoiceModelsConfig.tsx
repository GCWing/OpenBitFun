import { captureConfirmationAnchor, OverflowText,
  Button,
  Icon,
  IconButton,
  StatusPill,
  type StatusPillTone,
  Tooltip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, ShieldCheck } from 'lucide-react';

import { confirmDanger } from '@/infrastructure/confirm-dialog';
import {
  speechAPI,
  workspaceAPI,
  type SpeechModelInstallState,
  type SpeechModelStatus,
} from '@/infrastructure/api';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useContextMenuStore } from '@/shared/context-menu-system/store/ContextMenuStore';
import { ContextType } from '@/shared/context-menu-system/types/context.types';
import type { MenuItem } from '@/shared/context-menu-system/types/menu.types';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useAIExperienceSettings } from '../hooks';
import { aiExperienceConfigService } from '../services/AIExperienceConfigService';
import type { VoiceInputSettings } from '../types';
import { ConfigLoadingState, ConfigMessage } from './common';
import './VoiceInputConfig.scss';

const log = createLogger('LocalVoiceModelsConfig');

const MODEL_RESOURCE_HINT_KEYS: Record<string, string> = {
  'sensevoice-small-int8': 'model.resourceHints.sensevoice',
  'qwen3-asr-0.6b-int8': 'model.resourceHints.qwen3',
};

interface LocalVoiceModelsConfigProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function statusBadgeVariant(state: SpeechModelInstallState): StatusPillTone {
  switch (state) {
    case 'installed':
      return 'success';
    case 'downloading':
    case 'verifying':
      return 'info';
    case 'corrupt':
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

const LocalVoiceModelsConfig: React.FC<LocalVoiceModelsConfigProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation('settings/voice-input');
  const speechRuntimeSupported = isTauriRuntime();
  const {
    settings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useAIExperienceSettings();
  const showMenu = useContextMenuStore(state => state.showMenu);
  const hideMenu = useContextMenuStore(state => state.hideMenu);
  const [models, setModels] = useState<SpeechModelStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const cancelDownloadRequestedRef = useRef<Set<string>>(new Set());

  const voiceInput = settings?.voice_input;
  const selectedModelId = voiceInput?.provider === 'local' ? voiceInput.model_id : '';
  const anyDownloading = models.some(model => model.state === 'downloading');

  const loadModels = useCallback(async () => {
    if (!speechRuntimeSupported) return;
    try {
      setLoading(true);
      setLoadError(false);
      const response = await speechAPI.listModels();
      setModels(response.models);
    } catch (error) {
      setLoadError(true);
      log.error('Failed to load local speech models', { error });
      notificationService.error(t('messages.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [speechRuntimeSupported, t]);

  useEffect(() => {
    if (!isOpen || !speechRuntimeSupported) return undefined;
    void loadModels();
    const unsubscribeProgress = speechAPI.onModelProgress(event => {
      setModels(previous => previous.map(model =>
        model.modelId === event.status.modelId ? event.status : model
      ));
    });
    const unsubscribeStatus = speechAPI.onModelStatusChanged(status => {
      setModels(previous => previous.map(model =>
        model.modelId === status.modelId ? status : model
      ));
    });
    return () => {
      unsubscribeProgress();
      unsubscribeStatus();
    };
  }, [isOpen, loadModels, speechRuntimeSupported]);

  const updateVoiceInput = useCallback(async (patch: Partial<VoiceInputSettings>) => {
    if (!settings) {
      notificationService.error(t('messages.loadFailed'));
      return;
    }
    try {
      await aiExperienceConfigService.saveSettings({ voice_input: patch });
    } catch (error) {
      log.error('Failed to select local speech model', { error });
      notificationService.error(t('messages.saveFailed'));
    }
  }, [settings, t]);

  const updateModelStatus = useCallback((status: SpeechModelStatus) => {
    setModels(previous => previous.map(model =>
      model.modelId === status.modelId ? status : model
    ));
  }, []);

  const handleDownload = useCallback((model: SpeechModelStatus) => {
    if (model.state === 'downloading') return;
    cancelDownloadRequestedRef.current.delete(model.modelId);
    updateModelStatus({
      ...model,
      state: 'downloading',
      installedBytes: 0,
      progress: {
        modelId: model.modelId,
        downloadedBytes: 0,
        totalBytes: model.expectedBytes,
        percent: 0,
      },
      error: null,
    });
    void speechAPI.downloadModel(model.modelId).then(status => {
      updateModelStatus(status);
      notificationService.success(t('messages.downloadSuccess'));
    }).catch(error => {
      if (cancelDownloadRequestedRef.current.has(model.modelId)) return;
      log.error('Failed to download local speech model', { modelId: model.modelId, error });
      notificationService.error(t('messages.downloadFailed'));
      void loadModels();
    }).finally(() => {
      cancelDownloadRequestedRef.current.delete(model.modelId);
    });
  }, [loadModels, t, updateModelStatus]);

  const handleCancelDownload = useCallback(async (model: SpeechModelStatus) => {
    cancelDownloadRequestedRef.current.add(model.modelId);
    setBusyAction(`cancel:${model.modelId}`);
    try {
      const status = await speechAPI.cancelModelDownload(model.modelId);
      updateModelStatus(status);
      notificationService.info(t('messages.downloadCancelled'));
    } catch (error) {
      log.error('Failed to cancel local speech model download', { modelId: model.modelId, error });
      notificationService.error(t('messages.cancelFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [t, updateModelStatus]);

  const handleVerify = useCallback(async (model: SpeechModelStatus) => {
    setBusyAction(`verify:${model.modelId}`);
    try {
      const status = await speechAPI.verifyModel(model.modelId);
      updateModelStatus(status);
      notificationService.success(t('messages.verifySuccess'));
    } catch (error) {
      log.error('Failed to verify local speech model', { modelId: model.modelId, error });
      notificationService.error(t('messages.verifyFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [t, updateModelStatus]);

  const handleOpenFolder = useCallback(async (model: SpeechModelStatus) => {
    if (!model.installedPath) return;
    try {
      await workspaceAPI.revealInExplorer(model.installedPath);
    } catch (error) {
      log.error('Failed to reveal local speech model path', { modelId: model.modelId, error });
      notificationService.error(t('messages.openFolderFailed'));
    }
  }, [t]);

  const handleDelete = useCallback(async (model: SpeechModelStatus, trigger?: HTMLElement) => {
    const confirmed = await confirmDanger(
      t('model.deleteConfirmTitle'),
      t('model.deleteConfirmMessage', { name: model.displayName }),
      {
        anchor: captureConfirmationAnchor(trigger),
        confirmText: t('model.delete'),
        cancelText: t('model.keep'),
      },
    );
    if (!confirmed) return;
    setBusyAction(`delete:${model.modelId}`);
    try {
      const status = await speechAPI.deleteModel(model.modelId);
      updateModelStatus(status);
      notificationService.success(t('messages.deleteSuccess'));
    } catch (error) {
      log.error('Failed to delete local speech model', { modelId: model.modelId, error });
      notificationService.error(t('messages.deleteFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [t, updateModelStatus]);

  const openMaintenanceMenu = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    model: SpeechModelStatus,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const items: MenuItem[] = [
      {
        id: `voice-model-open:${model.modelId}`,
        label: t('model.openFolder'),
        icon: <FolderOpen size={14} />,
        disabled: !model.installedPath || busyAction !== null,
        onClick: () => handleOpenFolder(model),
      },
      {
        id: `voice-model-verify:${model.modelId}`,
        label: t('model.verify'),
        icon: <ShieldCheck size={14} />,
        disabled: busyAction !== null,
        onClick: () => handleVerify(model),
      },
      {
        id: `voice-model-delete:${model.modelId}`,
        label: t('model.delete'),
        icon: <Icon name="delete" size="sm" />,
        className: 'context-menu-item--danger',
        disabled: busyAction !== null,
        onClick: () => handleDelete(model, target),
      },
    ];
    showMenu(
      { x: rect.right, y: rect.bottom + 4 },
      items,
      {
        type: ContextType.CUSTOM,
        customType: 'voice-model-maintenance',
        data: { modelId: model.modelId },
        event,
        targetElement: target,
        position: { x: rect.right, y: rect.bottom + 4 },
        timestamp: Date.now(),
      },
    );
  }, [busyAction, handleDelete, handleOpenFolder, handleVerify, showMenu, t]);

  const closeDialog = useCallback(() => {
    hideMenu();
    onClose();
  }, [hideMenu, onClose]);

  let content: React.ReactNode;
  if (!speechRuntimeSupported) {
    content = <ConfigMessage message={{ type: 'info', text: t('messages.unsupported') }} />;
  } else if ((loading || settingsLoading) && models.length === 0) {
    content = <ConfigLoadingState label={t('localModels.loading')} />;
  } else if (loadError || settingsError || !settings || !voiceInput) {
    content = <ConfigMessage message={{ type: 'error', text: t('messages.loadFailed') }} />;
  } else if (models.length === 0) {
    content = <div className="voice-input-config__model-empty">{t('model.empty')}</div>;
  } else {
    content = (
      <div
        className="voice-input-config__model-list"
        data-openbitfun-component="voice-input-config"
        data-openbitfun-part="modelList"
      >
        {models.map(model => {
          const isUsable = model.state === 'installed';
          const isSelected = model.modelId === selectedModelId && isUsable;
          const isDownloading = model.state === 'downloading';
          const canInstall = model.state === 'not_installed'
            || model.state === 'corrupt'
            || model.state === 'error';
          const needsRepair = model.state === 'corrupt' || model.state === 'error';
          const progressPercent = Math.min(100, Math.max(0, model.progress?.percent ?? 0));
          const busyKey = busyAction?.endsWith(`:${model.modelId}`)
            ? busyAction.split(':')[0]
            : null;
          const resourceHintKey = MODEL_RESOURCE_HINT_KEYS[model.modelId]
            ?? 'model.resourceHints.default';

          return (
            <div
              className={`voice-input-config__model-card${isSelected ? ' voice-input-config__model-card--selected' : ''}`}
              data-openbitfun-component="voice-input-config"
              data-openbitfun-part="modelCard"
              key={model.modelId}
            >
              <div className="voice-input-config__model-copy">
                <div className="voice-input-config__model-title-row">
                  <div className="voice-input-config__model-name">{model.displayName}</div>
                  <StatusPill tone={isSelected ? 'info' : statusBadgeVariant(model.state)}>
                    {isSelected ? t('model.selected') : t(`states.${model.state}`)}
                  </StatusPill>
                </div>
                <div className="voice-input-config__model-meta">
                  <span>{formatBytes(model.expectedBytes || model.installedBytes)}</span>
                  <span>{t(resourceHintKey)}</span>
                </div>
                {model.error ? (
                  <div className="voice-input-config__model-error"><OverflowText>{model.error}</OverflowText></div>
                ) : null}
                {isDownloading ? (
                  <div className="voice-input-config__progress">
                    <div className="voice-input-config__progress-track" aria-hidden="true">
                      <div
                        className="voice-input-config__progress-value"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <span className="voice-input-config__progress-text">
                      {t('model.progressCompact', { percent: Math.round(progressPercent) })}
                    </span>
                  </div>
                ) : null}
              </div>

              <div
                className="voice-input-config__model-actions"
                data-openbitfun-component="voice-input-config"
                data-openbitfun-part="modelActions"
              >
                {isUsable && !isSelected ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void updateVoiceInput({
                      provider: 'local',
                      model_id: model.modelId,
                    })}
                    disabled={busyAction !== null || anyDownloading}
                  >
                    {t('model.select')}
                  </Button>
                ) : null}

                {isDownloading ? (
                  <Button
                    variant="fill"
                    size="sm"
                    onClick={() => void handleCancelDownload(model)}
                    loading={busyKey === 'cancel'}
                    disabled={busyAction !== null && busyKey !== 'cancel'}
                  >
                    {t('model.cancel')}
                  </Button>
                ) : canInstall ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleDownload(model)}
                    disabled={busyAction !== null || anyDownloading}
                    leadingIcon={<Icon name="arrow-down" size="sm" />}
                  >

                    {needsRepair ? t('model.repair') : t('model.download')}
                  </Button>
                ) : null}

                {isUsable ? (
                  <Tooltip content={t('model.more')}>
                    <IconButton
                      aria-label={t('model.more')}
                      size="sm"
                      data-openbitfun-component="voice-input-config"
                      data-openbitfun-part="modelMore"
                      onClick={event => openMaintenanceMenu(event, model)}
                      icon={<Icon name="more" size="sm" />}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => { if (!nextOpen) closeDialog(); }}
      size="md"
      data-testid="local-voice-models-dialog"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{t('localModels.title')}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody inset="none">
        <div className="voice-input-config__model-dialog-content">
      <div
        className="voice-input-config__model-dialog"
        data-openbitfun-component="voice-input-config"
        data-openbitfun-part="modelDialog"
      >
        <div className="voice-input-config__model-dialog-intro">
          <span>{t('localModels.description')}</span>
          <Tooltip content={t('model.refresh')}>
            <IconButton
              aria-label={t('model.refresh')}
              size="sm"
              onClick={() => void loadModels()}
              disabled={loading || busyAction !== null || anyDownloading}
              icon={<Icon name="refresh" size="sm" />}
            />
          </Tooltip>
        </div>
        {content}
      </div>
            </div>
            </DialogBody>
    </Dialog>
  );
};

export default LocalVoiceModelsConfig;
