import { useCallback, useEffect, useRef, useState } from 'react';
import { Select } from '@openbitfun/ui';
import {
  ConfigLoadingState, ConfigMessage, ConfigPageRow, ConfigPageSection, ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { useConfigSeed } from '@/infrastructure/config/hooks/useConfigSeed';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { RemoteUserSkillsMode, WorkspaceConfig } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';

const log = createLogger('RemoteUserSkillsSection');

function supportedMode(value: unknown): RemoteUserSkillsMode | undefined {
  return value === 'skill_md_only' || value === 'disabled' || value === 'full' ? value : undefined;
}

export default function RemoteUserSkillsSection() {
  const { t } = useI18n('settings/runtime');
  const seed = useConfigSeed(['workspace']);
  const [mode, setMode] = useState(() => supportedMode(seed.get<Partial<WorkspaceConfig>>('workspace', {}).remote_user_skills));
  const [loading, setLoading] = useState(!seed.loaded);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const sectionAnchor = useSettingsSectionAnchor('remote-user-skills', !loading);

  const load = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    setLoading(true);
    setLoadFailed(false);
    try {
      const workspace = await configManager.getConfig<WorkspaceConfig>('workspace');
      if (scope.isCurrent()) setMode(supportedMode(workspace.remote_user_skills));
    } catch (reason) {
      if (scope.isCurrent()) {
        log.error('Failed to load remote user Skill settings', reason);
        setLoadFailed(true);
      }
    } finally {
      if (scope.isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => { if (!seed.loaded) void load(); }, [load, seed.loaded]);

  const save = async (next: RemoteUserSkillsMode) => {
    if (saveInFlight.current || mode === undefined || next === mode) return;
    const scope = getActiveSurfaceScope();
    saveInFlight.current = true;
    setSaving(true);
    try {
      await configManager.setConfig('workspace.remote_user_skills', next);
      if (scope.isCurrent()) setMode(next);
    } catch (reason) {
      if (scope.isCurrent()) {
        log.error('Failed to save remote user Skill settings', reason);
        notificationService.error(t('remoteUserSkills.saveFailed'));
      }
    } finally {
      saveInFlight.current = false;
      if (scope.isCurrent()) setSaving(false);
    }
  };

  const description = mode === 'disabled' ? t('remoteUserSkills.disabledDescription')
    : mode === 'full' ? t('remoteUserSkills.fullDescription')
      : mode === 'skill_md_only' ? t('remoteUserSkills.skillMdOnlyDescription')
        : t('remoteUserSkills.unsupported');

  return (
    <ConfigPageSection id={sectionAnchor}
      title={t('remoteUserSkills.title')} description={t('remoteUserSkills.scope')}>
      {loading ? <ConfigLoadingState label={t('loading.text')} />
        : loadFailed ? <ConfigRetryState message={t('remoteUserSkills.loadFailed')}
          retryLabel={t('loading.retry')} onRetry={() => void load()} />
          : <>
            <ConfigPageRow label={t('remoteUserSkills.label')} description={description} align="center">
              <Select size="sm" value={mode ?? 'skill_md_only'} disabled={saving || mode === undefined}
                aria-label={t('remoteUserSkills.label')}
                options={[
                  { value: 'skill_md_only', label: t('remoteUserSkills.skillMdOnly') },
                  { value: 'disabled', label: t('remoteUserSkills.disabled') },
                  { value: 'full', label: t('remoteUserSkills.full') },
                ]}
                onValueChange={value => {
                  const next = supportedMode(value);
                  if (next) void save(next);
                }} />
            </ConfigPageRow>
            {mode === 'full' && <ConfigMessage message={{ type: 'info', text: t('remoteUserSkills.syncHint') }} />}
          </>}
    </ConfigPageSection>
  );
}
