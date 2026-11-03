import { useEffect, useRef, useState } from 'react';
import { Button, Combobox, FieldGroup, Select, Spinner } from '@openbitfun/ui';
import { agentAPI, type ModeInfo } from '@/infrastructure/api/service-api/AgentAPI';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { useModelSelectPresentation } from '@/infrastructure/config/components/ModelSelectPresentation';
import { filterSelectableTextChatModels } from '@/infrastructure/config/services/modelCategory';
import { readProjectDefaults, saveProjectDefault } from '@/infrastructure/config/services/ProjectDefaultsService';
import type { AIModelConfig, ProjectDefaultsConfig } from '@/infrastructure/config/types';
import { useI18n } from '@/infrastructure/i18n';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { normalizeUserDefaultChatInputModeId } from '@/flow_chat/utils/chatInputMode';
import type { WorkspaceInfo } from '@/shared/types';
import { agentName } from '@/shared/agents/identity';

interface Snapshot { defaults: ProjectDefaultsConfig; models: AIModelConfig[]; modes: ModeInfo[]; supported: boolean }

export function ProjectDefaultsSection({ workspace, scope, isActive }: {
  workspace: WorkspaceInfo; scope: SurfaceScope; isActive: boolean;
}) {
  const { t } = useI18n('scenes/project-resources');
  const { buildModelOption } = useModelSelectPresentation();
  const projectId = workspace.worktree && !workspace.worktree.isMain && workspace.workspaceKind !== 'remote'
    ? workspace.worktree.mainWorkspaceId : workspace.id;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const generation = useRef(0);
  const copy = useRef(t); copy.current = t;

  useEffect(() => {
    const order = ++generation.current;
    if (!isActive) return;
    setLoading(true); setError(undefined); setSaved(false);
    void (async () => {
      try {
        if (!projectId) throw new Error('Project workspace ID is unavailable');
        const [settings, models, modes] = await Promise.all([
          readProjectDefaults(projectId), configAPI.getConfig('ai.models'), agentAPI.getAvailableModes({ workspaceId: workspace.id }),
        ]);
        if (order !== generation.current || !scope.isCurrent()) return;
        if (!Array.isArray(models)) throw new Error('Model catalog is unavailable');
        setSnapshot({ ...settings, models: filterSelectableTextChatModels(models), modes: modes.filter(mode =>
          normalizeUserDefaultChatInputModeId(mode.id) && !['claw', 'plan', 'multitask'].includes(mode.id.toLowerCase())) });
      } catch {
        if (order === generation.current && scope.isCurrent()) { setSnapshot(undefined); setError(copy.current('defaults.loadFailed')); }
      } finally {
        if (order === generation.current && scope.isCurrent()) setLoading(false);
      }
    })();
    return () => { ++generation.current; };
  }, [isActive, projectId, workspace.id, scope, revision]);

  const save = async (field: 'primary_model' | 'fast_model' | 'mode', value: string) => {
    if (!snapshot?.supported || !projectId || !isActive || !scope.isCurrent() || busy.current || loading) return;
    const order = generation.current;
    busy.current = true; setSaving(true); setError(undefined); setSaved(false);
    try {
      const defaults = await saveProjectDefault(projectId, field, value);
      if (order !== generation.current || !scope.isCurrent()) return;
      setSnapshot(current => current && { ...current, defaults }); setSaved(true);
    } catch {
      if (order === generation.current && scope.isCurrent()) setError(t('defaults.saveFailed'));
    } finally {
      busy.current = false;
      if (scope.isCurrent()) setSaving(false);
    }
  };
  const disabled = !isActive || loading || saving || !snapshot?.supported;
  const inherit = { label: t('defaults.inherit'), value: '' };
  const modelOptions = (field: 'primary_model' | 'fast_model') => {
    const selected = snapshot?.defaults[field];
    return [inherit, ...(selected && !snapshot?.models.some(model => model.id === selected)
      ? [{ label: t('defaults.unavailableValue', { value: selected }), value: selected, disabled: true }] : []),
    ...(snapshot?.models.map(buildModelOption) ?? [])];
  };
  const selectedMode = snapshot?.defaults.mode;
  const modeOptions = [inherit, ...(selectedMode && !snapshot?.modes.some(mode => mode.id === selectedMode)
    ? [{ label: t('defaults.unavailableValue', { value: selectedMode }), value: selectedMode, disabled: true }] : []),
  ...(snapshot?.modes.map(mode => ({ value: mode.id, label: agentName(mode, t) })) ?? [])];
  const fields = [{ field: 'primary_model', label: t('defaults.primary_model') }, { field: 'fast_model', label: t('defaults.fast_model') }] as const;
  return <section className="project-resources__default-settings" aria-label={t('defaults.title')}
    data-openbitfun-scene="project-resources" data-openbitfun-part="defaults" aria-busy={loading || saving}>
    <FieldGroup appearance="plain" fieldSurface="ambient" dividers={false} className="project-resources__default-fields">
      {fields.map(({ field, label }) => <Combobox key={field} className="project-resources__default-field"
          size="sm" variant="pill" bordered="hover" hitArea="expanded" showIndicator={false} aria-label={label} value={snapshot?.defaults[field] ?? ''}
          valuePrefix={t('defaults.labelPrefix', { label })}
          placeholder={inherit.label} popupWidth="content"
          options={modelOptions(field)} disabled={disabled} onValueChange={value => void save(field, String(Array.isArray(value) ? value[0] ?? '' : value))} />
      )}
      <Select className="project-resources__default-field" size="sm" variant="pill" bordered="hover" hitArea="expanded" showIndicator={false}
          aria-label={t('defaults.mode')} value={selectedMode ?? ''} options={modeOptions} popupWidth="trigger"
          valuePrefix={t('defaults.labelPrefix', { label: t('defaults.mode') })}
          disabled={disabled} onValueChange={value => void save('mode', String(value))} />
    </FieldGroup>
    {loading && <div className="project-resources__load" role="status"><Spinner size="sm" />{t('loading')}</div>}
    {snapshot && !snapshot.supported && <p className="project-resources__hint" role="status">{t('defaults.unsupported')}</p>}
    {error && <div className="project-resources__metrics-feedback" role="alert"><span>{error}</span>
      {!snapshot && <Button variant="text" size="sm" onClick={() => setRevision(value => value + 1)}>{t('retry')}</Button>}</div>}
    {saved && <p className="project-resources__hint" role="status">{t('defaults.saved')}</p>}
  </section>;
}
