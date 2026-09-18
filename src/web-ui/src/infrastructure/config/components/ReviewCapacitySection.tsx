import { Button, NumberInput } from '@openbitfun/ui';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { ConfigLoadingState, ConfigPageRow, ConfigPageSection } from './common';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { useNotification } from '@/shared/notification-system';
import {
  loadDefaultReviewTeam,
  saveDefaultReviewTeamConcurrencyPolicy,
  type ReviewTeam,
  type ReviewTeamConcurrencyPolicy,
} from '@/shared/services/reviewTeamService';

const ReviewCapacitySection: React.FC = () => {
  const { t } = useTranslation('settings/review-capacity');
  const { workspace } = useCurrentWorkspace();
  const { error: notifyError, success: notifySuccess } = useNotification();
  const desktopRuntime = isTauriRuntime();
  const [loading, setLoading] = useState(desktopRuntime);
  const [team, setTeam] = useState<ReviewTeam | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<keyof ReviewTeamConcurrencyPolicy | null>(null);

  const loadData = useCallback(async () => {
    if (!desktopRuntime) return;
    setLoading(true);
    setLoadError(null);
    try {
      setTeam(await loadDefaultReviewTeam(workspace?.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('messages.loadFailed');
      setLoadError(message);
      notifyError(message);
    } finally {
      setLoading(false);
    }
  }, [desktopRuntime, notifyError, t, workspace?.id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const updatePolicy = useCallback(async (
    key: keyof ReviewTeamConcurrencyPolicy,
    value: ReviewTeamConcurrencyPolicy[keyof ReviewTeamConcurrencyPolicy],
  ) => {
    if (!team || savingKey !== null) return;
    const previous = team;
    const concurrencyPolicy = { ...team.concurrencyPolicy, [key]: value } as ReviewTeamConcurrencyPolicy;
    setSavingKey(key);
    setTeam({ ...team, concurrencyPolicy });
    try {
      await saveDefaultReviewTeamConcurrencyPolicy(concurrencyPolicy);
      notifySuccess(t('messages.saved'));
    } catch (error) {
      setTeam(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [notifyError, notifySuccess, savingKey, t, team]);

  if (!desktopRuntime) {
    return (
      <ConfigPageSection title={t('desktopOnly.title')} description={t('desktopOnly.description')}>
        {null}
      </ConfigPageSection>
    );
  }

  if (loading) return <ConfigLoadingState label={t('loading')} />;

  if (!team) {
    return (
      <ConfigPageSection title={t('error.title')} description={loadError ?? t('messages.loadFailed')}>
        <Button variant="outline" size="sm" onClick={() => void loadData()} leadingIcon={<RotateCcw size={14} />}>

          {t('error.retry')}
        </Button>
      </ConfigPageSection>
    );
  }

  return (
    <ConfigPageSection title={t('capacity.title')} description={t('capacity.description')}>
      <ConfigPageRow
        label={t('capacity.maxParallelReviewers.label')}
        description={t('capacity.maxParallelReviewers.description')}
        align="center"
      >
        <NumberInput
          value={team.concurrencyPolicy.maxParallelInstances}
          onValueChange={(value) => void updatePolicy('maxParallelInstances', value)}
          min={1}
          max={2}
          step={1}
          size="sm"
          disabled={savingKey !== null}
        />
      </ConfigPageRow>
      <ConfigPageRow
        label={t('capacity.maxQueueWaitSeconds.label')}
        description={t('capacity.maxQueueWaitSeconds.description')}
        align="center"
      >
        <NumberInput
          value={team.concurrencyPolicy.maxQueueWaitSeconds}
          onValueChange={(value) => void updatePolicy('maxQueueWaitSeconds', value)}
          min={0}
          max={3600}
          step={60}
          unit="s"
          size="sm"
          disabled={savingKey !== null}
        />
      </ConfigPageRow>
    </ConfigPageSection>
  );
};

export default ReviewCapacitySection;
