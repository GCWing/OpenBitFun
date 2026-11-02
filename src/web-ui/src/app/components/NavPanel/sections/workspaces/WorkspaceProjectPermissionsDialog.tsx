import { Alert, OverflowText,
  Button,
  Icon,
  IconButton,
  Input,
  Select,
  type SelectOption,
  Field,
  StatusPill,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Save } from 'lucide-react';

import { confirmDanger } from '@/infrastructure/confirm-dialog';
import {
  permissionAPI,
  type PermissionGrant,
  type ProjectPermissionEffect,
  type ProjectPermissionRule,
} from '@/infrastructure/api/service-api/PermissionAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { notificationService } from '@/shared/notification-system';
import type { WorkspaceInfo } from '@/shared/types';
import { createLogger } from '@/shared/utils/logger';
import { ProjectResourceSummary } from '@/app/scenes/project-resources/ProjectResourceSummary';
import { ProjectResourceList } from '@/app/scenes/project-resources/ProjectResourceList';
import './WorkspaceProjectPermissionsDialog.scss';

const log = createLogger('WorkspaceProjectPermissionsDialog');

const PROJECT_PERMISSION_ACTION_OPTIONS: SelectOption[] = [
  { value: '*', label: '*' },
  { value: 'read', label: 'read' },
  { value: 'edit', label: 'edit' },
  { value: 'bash', label: 'bash' },
  { value: 'git', label: 'git' },
  { value: 'websearch', label: 'websearch' },
  { value: 'webfetch', label: 'webfetch' },
  { value: 'task', label: 'task' },
  { value: 'skill', label: 'skill' },
  { value: 'mcp', label: 'mcp' },
  { value: 'computer_use', label: 'computer_use' },
  { value: 'custom_tool', label: 'custom_tool' },
  { value: 'external_directory', label: 'external_directory' },
];
const EFFECTS: ProjectPermissionEffect[] = ['allow', 'ask', 'deny'];

let draftRuleSequence = 0;

interface DraftRule extends ProjectPermissionRule {
  localId: string;
}

interface WorkspaceProjectPermissionsDialogProps {
  workspace: WorkspaceInfo;
  isOpen: boolean;
  onClose?: () => void;
  presentation?: 'dialog' | 'inline';
  refreshKey?: number;
}

function toDraftRule(rule: ProjectPermissionRule): DraftRule {
  draftRuleSequence += 1;
  return { ...rule, localId: `project-rule-${draftRuleSequence}` };
}

function toProjectRules(rules: DraftRule[]): ProjectPermissionRule[] {
  return rules.map(({ action, resource, effect }) => ({ action, resource, effect }));
}

function rulesEqual(left: ProjectPermissionRule[], right: ProjectPermissionRule[]): boolean {
  return left.length === right.length && left.every((rule, index) => {
    const other = right[index];
    return rule.action === other.action && rule.resource === other.resource && rule.effect === other.effect;
  });
}

export const WorkspaceProjectPermissionsDialog: React.FC<WorkspaceProjectPermissionsDialogProps> = (props) => {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  return <WorkspaceProjectPermissionsContent {...props} scope={scope}
    key={scope.key(scope.epoch, props.workspace.id, props.workspace.rootPath, props.workspace.connectionId)} />;
};

export function WorkspaceProjectPermissionsPanel({ workspace, isActive, refreshKey }: {
  workspace: WorkspaceInfo;
  isActive: boolean;
  refreshKey?: number;
}) {
  return <WorkspaceProjectPermissionsDialog workspace={workspace} isOpen={isActive} refreshKey={refreshKey} presentation="inline" />;
}

function WorkspaceProjectPermissionsContent({
  workspace,
  isOpen,
  onClose,
  presentation = 'dialog',
  refreshKey,
  scope,
}: WorkspaceProjectPermissionsDialogProps & { scope: SurfaceScope }) {
  const { t, formatDate, formatNumber } = useI18n('settings/runtime');
  const [listOpen, setListOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [addition, setAddition] = useState<{ rule: ProjectPermissionRule; stage: boolean } | null>(null);
  const [additionError, setAdditionError] = useState<string | null>(null);
  const additionEpoch = useRef(0);
  const additionFormId = useId();
  const dialogVisible = isOpen && (presentation === 'dialog' || listOpen);
  const dialogEpoch = useRef(0);
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [mutationKey, setMutationKey] = useState<string | null>(null);
  const [savedRules, setSavedRules] = useState<ProjectPermissionRule[]>([]);
  const [draftRules, setDraftRules] = useState<DraftRule[]>([]);
  const [rulesRevision, setRulesRevision] = useState<string | null>(null);
  const mounted = useRef(true);
  const active = useRef(dialogVisible);
  const grantsRequest = useRef(0);
  const rulesRequest = useRef(0);
  const mutationRunning = useRef(false);
  const dirty = useRef(false);
  useLayoutEffect(() => { active.current = dialogVisible; dialogEpoch.current += 1; }, [dialogVisible]);
  useEffect(() => {
    if (!isOpen) { setListOpen(false); setAddition(null); setAdditionError(null); additionEpoch.current += 1; }
  }, [isOpen]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => mounted.current && scope.isCurrent(), [scope]);
  const effectOptions = useMemo<SelectOption[]>(
    () => EFFECTS.map((effect) => ({
      value: effect,
      label: t(`projectPermissions.effects.${effect}`),
    })),
    [t],
  );

  const loadGrants = useCallback(async () => {
    if (!current()) return;
    const request = ++grantsRequest.current;
    setGrantsLoading(true);
    setGrantsError(null);
    try {
      const grants = await permissionAPI.listProjectGrants(workspace.id);
      if (current() && request === grantsRequest.current) setPermissionGrants(grants);
    } catch (error) {
      if (!current() || request !== grantsRequest.current) return;
      log.error('Failed to load project permission grants', { workspaceId: workspace.id, error });
      setGrantsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current() && request === grantsRequest.current) setGrantsLoading(false);
    }
  }, [current, workspace.id]);

  const loadRules = useCallback(async () => {
    if (!current() || dirty.current || mutationRunning.current) return;
    const request = ++rulesRequest.current;
    setRulesLoading(true);
    setRulesError(null);
    try {
      const response = await permissionAPI.getProjectRules(workspace.id);
      if (!current() || request !== rulesRequest.current) return;
      setSavedRules(response.rules);
      setDraftRules(response.rules.map(toDraftRule));
      setRulesRevision(response.revision);
    } catch (error) {
      if (!current() || request !== rulesRequest.current) return;
      log.error('Failed to load project permission rules', { workspaceId: workspace.id, error });
      setRulesRevision(null);
      setRulesError(error instanceof Error ? error.message : String(error));
    } finally {
      if (current() && request === rulesRequest.current) setRulesLoading(false);
    }
  }, [current, workspace.id]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void Promise.all([loadGrants(), loadRules()]);
  }, [isOpen, loadGrants, loadRules, refreshKey]);

  const handleRemovePermissionGrant = async (grant: PermissionGrant) => {
    if (!current() || !active.current || mutationRunning.current) return;
    const confirmationEpoch = dialogEpoch.current;
    const confirmed = await confirmDanger(
      t('projectPermissions.removeGrantTitle'),
      t('projectPermissions.removeGrantMessage', { action: grant.action, resource: grant.resource }),
      { confirmText: t('projectPermissions.removeGrantConfirm') },
    );
    if (!confirmed || !current() || !active.current || confirmationEpoch !== dialogEpoch.current || mutationRunning.current) {
      return;
    }

    const key = `${grant.action}\n${grant.resource}`;
    mutationRunning.current = true;
    setMutationKey(key);
    try {
      await permissionAPI.removeProjectGrant(workspace.id, grant);
      if (!current()) return;
      await loadGrants();
      if (!current()) return;
      notificationService.success(t('projectPermissions.removeGrantSuccess'));
    } catch (error) {
      if (!current()) return;
      log.error('Failed to remove project permission grant', {
        workspaceId: workspace.id,
        action: grant.action,
        resource: grant.resource,
        error,
      });
      notificationService.error(t('projectPermissions.removeGrantFailed'));
    } finally {
      mutationRunning.current = false;
      if (current()) setMutationKey(null);
    }
  };

  const handleClearPermissionGrants = async () => {
    if (!current() || !active.current || mutationRunning.current || permissionGrants.length === 0) {
      return;
    }

    const confirmationEpoch = dialogEpoch.current;
    const confirmed = await confirmDanger(
      t('projectPermissions.clearGrantsTitle'),
      t('projectPermissions.clearGrantsMessage'),
      { confirmText: t('projectPermissions.clearGrantsConfirm') },
    );
    if (!confirmed || !current() || !active.current || confirmationEpoch !== dialogEpoch.current || mutationRunning.current) {
      return;
    }

    mutationRunning.current = true;
    setMutationKey('*');
    try {
      await permissionAPI.clearProjectGrants(workspace.id);
      if (!current()) return;
      await loadGrants();
      if (!current()) return;
      notificationService.success(t('projectPermissions.clearGrantsSuccess'));
    } catch (error) {
      if (!current()) return;
      log.error('Failed to clear project permission grants', { workspaceId: workspace.id, error });
      notificationService.error(t('projectPermissions.clearGrantsFailed'));
    } finally {
      mutationRunning.current = false;
      if (current()) setMutationKey(null);
    }
  };

  const updateDraftRule = (localId: string, update: Partial<ProjectPermissionRule>) => {
    setDraftRules((rules) => rules.map((rule) => (rule.localId === localId ? { ...rule, ...update } : rule)));
  };

  const moveDraftRule = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= draftRules.length) {
      return;
    }
    setDraftRules((rules) => {
      const nextRules = [...rules];
      [nextRules[index], nextRules[nextIndex]] = [nextRules[nextIndex], nextRules[index]];
      return nextRules;
    });
  };

  const isMutationRunning = mutationKey !== null;
  const projectRules = useMemo(() => toProjectRules(draftRules), [draftRules]);
  const rulesDirty = !rulesEqual(projectRules, savedRules);
  useLayoutEffect(() => { dirty.current = rulesDirty || addition !== null; }, [rulesDirty, addition]);
  const rulesValid = projectRules.every((rule) => rule.action.trim() && rule.resource.trim());
  const isBusy = !isOpen || grantsLoading || rulesLoading || rulesSaving || isMutationRunning;

  const handleSaveRules = async () => {
    if (!current() || !active.current || mutationRunning.current || isBusy || !rulesDirty || !rulesValid || rulesRevision === null) {
      return;
    }

    mutationRunning.current = true;
    setRulesSaving(true);
    try {
      const response = await permissionAPI.saveProjectRules(workspace.id, projectRules, rulesRevision);
      if (!current()) return;
      setSavedRules(response.rules);
      setDraftRules(response.rules.map(toDraftRule));
      setRulesRevision(response.revision);
      setEditingRuleId(null);
      notificationService.success(t('projectPermissions.rulesSaveSuccess'));
    } catch (error) {
      if (!current()) return;
      log.error('Failed to save project permission rules', { workspaceId: workspace.id, error });
      notificationService.error(
        error instanceof Error && error.message.includes('changed outside OpenBitFun')
          ? t('projectPermissions.rulesConflict')
          : t('projectPermissions.rulesSaveFailed'),
      );
    } finally {
      mutationRunning.current = false;
      if (current()) setRulesSaving(false);
    }
  };

  const handleDiscardRules = () => {
    setDraftRules(savedRules.map(toDraftRule));
    setEditingRuleId(null);
  };

  const addAuthorization = () => {
    if (!current() || !isOpen || isBusy || rulesRevision === null) return;
    additionEpoch.current += 1;
    setAddition({ rule: { action: '', resource: '', effect: 'allow' }, stage: dialogVisible || rulesDirty });
    setAdditionError(null);
  };
  const closeAddition = () => {
    if (rulesSaving || isMutationRunning) return;
    additionEpoch.current += 1;
    setAddition(null);
    setAdditionError(null);
  };
  const submitAddition = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current() || !isOpen || !addition || isBusy || mutationRunning.current || rulesRevision === null) return;
    const rule = { ...addition.rule, action: addition.rule.action.trim(), resource: addition.rule.resource.trim() };
    if (!rule.action || !rule.resource) return;
    if (addition.stage) {
      setDraftRules(rules => [...rules, toDraftRule(rule)]);
      closeAddition();
      setListOpen(true);
      return;
    }
    const epoch = additionEpoch.current;
    mutationRunning.current = true;
    setRulesSaving(true);
    setAdditionError(null);
    try {
      const response = await permissionAPI.saveProjectRules(workspace.id, [...savedRules, rule], rulesRevision);
      if (!current()) return;
      setSavedRules(response.rules);
      setDraftRules(response.rules.map(toDraftRule));
      setRulesRevision(response.revision);
      if (epoch === additionEpoch.current) setAddition(null);
      notificationService.success(t('projectPermissions.rulesSaveSuccess'));
    } catch (error) {
      if (!current() || epoch !== additionEpoch.current) return;
      log.error('Failed to add project permission rule', { workspaceId: workspace.id, error });
      setAdditionError(t(error instanceof Error && error.message.includes('changed outside OpenBitFun')
        ? 'projectPermissions.rulesConflict' : 'projectPermissions.rulesSaveFailed'));
    } finally {
      mutationRunning.current = false;
      if (current()) setRulesSaving(false);
    }
  };
  const closeList = () => {
    if (rulesSaving || isMutationRunning) return;
    if (presentation === 'dialog') onClose?.();
    else setListOpen(false);
  };
  const entries = [
    ...savedRules.map((rule, index) => ({ ...rule, key: `rule:${index}`, source: t('projectPermissions.rulesTitle') })),
    ...permissionGrants.map(grant => ({ ...grant, key: `grant:${grant.action}:${grant.resource}`, effect: 'allow' as const, source: t('projectPermissions.grantsTitle') })),
  ];
  const complete = !grantsLoading && !rulesLoading && !grantsError && !rulesError;
  const permissionsEmpty = complete && entries.length === 0;
  const effectPill = (effect: ProjectPermissionEffect) => <StatusPill tone={effect === 'allow' ? 'success' : effect === 'deny' ? 'danger' : 'neutral'}>
    {t(`projectPermissions.effects.${effect}`)}
  </StatusPill>;
  const feedback = <>
    {(grantsLoading || rulesLoading) && <p className="workspace-project-permissions-dialog__empty" role="status">{t('loading.text')}</p>}
    {grantsError && <div className="workspace-project-permissions-dialog__error" role="status">
      <span>{t('projectPermissions.grantsLoadFailed')}</span>
      <Button variant="text" size="sm" disabled={grantsLoading} onClick={() => void loadGrants()}>{t('common:retry')}</Button><p>{grantsError}</p>
    </div>}
    {rulesError && <div className="workspace-project-permissions-dialog__error" role="status">
      <span>{t('projectPermissions.rulesLoadFailed')}</span>
      <Button variant="text" size="sm" disabled={rulesLoading} onClick={() => void loadRules()}>{t('common:retry')}</Button><p>{rulesError}</p>
    </div>}
  </>;
  const ruleFields = (rule: ProjectPermissionRule, onChange: (update: Partial<ProjectPermissionRule>) => void) => <>
    <Field label={t('projectPermissions.action')} controlWidth="fill">
      <Select size="sm" value={rule.action} options={PROJECT_PERMISSION_ACTION_OPTIONS}
        placeholder={t('projectPermissions.action')} aria-label={t('projectPermissions.action')} disabled={isBusy} invalid={!rule.action.trim()}
        onValueChange={value => onChange({ action: value as string })} />
    </Field>
    <Field label={t('projectPermissions.resource')} controlWidth="fill">
      <Input value={rule.resource} placeholder={t('projectPermissions.resourcePlaceholder')} aria-label={t('projectPermissions.resource')}
        disabled={isBusy} invalid={!rule.resource.trim()} onChange={event => onChange({ resource: event.target.value })} size="sm" autoFocus />
    </Field>
    <Field label={t('projectPermissions.effect')} controlWidth="fill">
      <Select size="sm" value={rule.effect} options={effectOptions} aria-label={t('projectPermissions.effect')} disabled={isBusy}
        onValueChange={value => onChange({ effect: value as ProjectPermissionEffect })} />
    </Field>
  </>;
  const editor = (rule: DraftRule) => <div className="workspace-project-permissions-dialog__editor" id={`permission-editor-${rule.localId}`}>
    {ruleFields(rule, update => updateDraftRule(rule.localId, update))}
  </div>;
  const additionDialog = addition && <Dialog open={isOpen} onOpenChange={open => { if (!open) closeAddition(); }} size="md">
    <DialogHeader>
      <DialogHeading><DialogTitle>{t('projectPermissions.addAuthorization')}</DialogTitle></DialogHeading>
      <DialogClose disabled={rulesSaving || isMutationRunning} />
    </DialogHeader>
    <DialogBody>
      <form id={additionFormId} className="workspace-project-permissions-dialog__add-form" onSubmit={event => void submitAddition(event)}
        data-openbitfun-component="workspace-project-permissions-dialog" data-openbitfun-part="addForm">
        {ruleFields(addition.rule, update => {
          setAddition(value => value ? { ...value, rule: { ...value.rule, ...update } } : null);
          setAdditionError(null);
        })}
        {additionError && <Alert tone="error" message={additionError} />}
      </form>
    </DialogBody>
    <DialogFooter>
      <Button size="sm" variant="fill" disabled={rulesSaving || isMutationRunning} onClick={closeAddition}>{t('projectPermissions.cancel')}</Button>
      <Button type="submit" form={additionFormId} size="sm" variant="primary" loading={rulesSaving}
        disabled={isBusy || !addition.rule.action.trim() || !addition.rule.resource.trim()}>{t('projectPermissions.addAuthorization')}</Button>
    </DialogFooter>
  </Dialog>;

  return <div className="workspace-project-permissions-dialog" data-openbitfun-component="workspace-project-permissions-dialog" data-openbitfun-part="root">
    {presentation === 'inline' && <>
      <div className="workspace-project-permissions-dialog__heading">
        <h2>{t('projectPermissions.title')}</h2>
        {!permissionsEmpty && <Button className="workspace-project-permissions-dialog__section-action" variant="text" size="sm" leadingIcon={<Icon name="plus" size="sm" />}
          disabled={isBusy || rulesRevision === null} onClick={addAuthorization}>{t('projectPermissions.addAuthorization')}</Button>}
      </div>
      <ProjectResourceSummary title={t('projectPermissions.entryCount')} value={complete ? formatNumber(entries.length) : '—'}
        description={complete ? t('projectPermissions.summary', {
          allow: formatNumber(entries.filter(entry => entry.effect === 'allow').length),
          ask: formatNumber(entries.filter(entry => entry.effect === 'ask').length),
          deny: formatNumber(entries.filter(entry => entry.effect === 'deny').length),
        }) : t('projectPermissions.incomplete')}
        listTitle={permissionsEmpty ? undefined : t('projectPermissions.listTitle')} boundedList={entries.length > 0} onOpen={() => setListOpen(true)}>
        {entries.length > 0 && <ProjectResourceList label={t('projectPermissions.listTitle')}
          moreLabel={t('projectPermissions.listTitle')} onShowAll={() => setListOpen(true)}
          items={entries.map(entry => ({ id: entry.key, name: `${entry.action} · ${entry.resource}`,
            title: `${entry.source} · ${entry.action} · ${entry.resource}`, meta: effectPill(entry.effect), onClick: () => setListOpen(true) }))} />}
        {permissionsEmpty && <div className="project-resource-summary__empty">
          <Button variant="quiet" size="sm" leadingIcon={<Icon name="plus" size="sm" />} onClick={addAuthorization}
            disabled={isBusy || rulesRevision === null}>{t('projectPermissions.addAuthorization')}</Button>
        </div>}
      </ProjectResourceSummary>
      {rulesDirty && <StatusPill tone="info">{t('projectPermissions.unsaved')}</StatusPill>}
      {feedback}
    </>}
    <Dialog open={dialogVisible} onOpenChange={nextOpen => { if (!nextOpen) closeList(); }} size="xl"
      className="workspace-project-permissions-dialog__modal">
      <DialogHeader>
        <DialogHeading><DialogTitle>{t('projectPermissions.title')}</DialogTitle><DialogDescription>{workspace.name}</DialogDescription></DialogHeading>
        <DialogClose disabled={rulesSaving || isMutationRunning} />
      </DialogHeader>
      <div className="workspace-project-permissions-dialog__toolbar">
        <Button size="sm" variant="outline" disabled={isBusy || rulesRevision === null} leadingIcon={<Icon name="plus" size="sm" />}
          onClick={addAuthorization}>{t('projectPermissions.addAuthorization')}</Button>
        {permissionGrants.length > 0 && <Button size="sm" variant="text" disabled={isBusy || !!grantsError}
          onClick={() => void handleClearPermissionGrants()}>{t('projectPermissions.clearRemembered')}</Button>}
      </div>
      <DialogBody className="workspace-project-permissions-dialog__body">
        {feedback}
        <div className="workspace-project-permissions-dialog__table-wrap">
          <div role="table" className="workspace-project-permissions-dialog__table" aria-label={t('projectPermissions.listTitle')}>
            <div role="row" className="resource-table__row resource-table__header">
              <div role="columnheader">{t('projectPermissions.action')}</div><div role="columnheader">{t('projectPermissions.resource')}</div>
              <div role="columnheader">{t('projectPermissions.effect')}</div><div role="columnheader">{t('projectPermissions.source')}</div>
              <div role="columnheader">{t('projectPermissions.actions')}</div>
            </div>

            {draftRules.map((rule, index) => <React.Fragment key={rule.localId}>
              <div role="row" className="resource-table__row workspace-project-permissions-dialog__row" data-openbitfun-component="workspace-project-permissions-dialog" data-openbitfun-part="rule">
                <div role="cell"><OverflowText>{rule.action || t('projectPermissions.action')}</OverflowText></div>
                <div role="cell"><OverflowText title={rule.resource}>{rule.resource || t('projectPermissions.resource')}</OverflowText></div>
                <div role="cell">{effectPill(rule.effect)}</div><div role="cell">{t('projectPermissions.rulesTitle')}</div>
                <div role="cell"><div className="workspace-project-permissions-dialog__row-actions">
                  <IconButton size="sm" aria-label={t('projectPermissions.editAuthorization')} disabled={isBusy}
                    aria-expanded={editingRuleId === rule.localId} aria-controls={`permission-editor-${rule.localId}`}
                    onClick={() => setEditingRuleId(current => current === rule.localId ? null : rule.localId)} icon={<Icon name="edit" size="sm" />} />
                  <IconButton size="sm" aria-label={t('projectPermissions.moveRuleUp')} disabled={isBusy || index === 0}
                    onClick={() => moveDraftRule(index, -1)} icon={<Icon name="arrow-up" size="sm" />} />
                  <IconButton size="sm" aria-label={t('projectPermissions.moveRuleDown')} disabled={isBusy || index === draftRules.length - 1}
                    onClick={() => moveDraftRule(index, 1)} icon={<Icon name="arrow-down" size="sm" />} />
                  <IconButton size="sm" tone="danger" aria-label={t('projectPermissions.removeRule')} disabled={isBusy}
                    onClick={() => { setDraftRules(rules => rules.filter(({ localId }) => localId !== rule.localId)); if (editingRuleId === rule.localId) setEditingRuleId(null); }}
                    icon={<Icon name="delete" size="sm" />} />
                </div></div>
              </div>
              {editingRuleId === rule.localId && <div role="row" className="resource-table__row resource-table__details workspace-project-permissions-dialog__editor-row"><div role="cell" aria-colspan={5}>{editor(rule)}</div></div>}
            </React.Fragment>)}
            {permissionGrants.map(grant => <div role="row" key={`grant:${grant.action}:${grant.resource}`} className="resource-table__row workspace-project-permissions-dialog__row"
              data-openbitfun-component="workspace-project-permissions-dialog" data-openbitfun-part="grant">
              <div role="cell"><OverflowText>{grant.action}</OverflowText></div><div role="cell"><OverflowText title={grant.resource}>{grant.resource}</OverflowText></div>
              <div role="cell">{effectPill('allow')}</div><div role="cell" title={formatDate(grant.createdAtMs, { dateStyle: 'medium', timeStyle: 'short' })}>{t('projectPermissions.grantsTitle')}</div>
              <div role="cell"><div className="workspace-project-permissions-dialog__row-actions">
                <IconButton size="sm" tone="danger" aria-label={t('projectPermissions.removeGrant')} disabled={isBusy}
                  onClick={() => void handleRemovePermissionGrant(grant)} icon={<Icon name="delete" size="sm" />} />
              </div></div>
            </div>)}
            {complete && draftRules.length + permissionGrants.length === 0 && <div role="row" className="resource-table__row resource-table__details"><div role="cell" aria-colspan={5} className="workspace-project-permissions-dialog__empty">{t('projectPermissions.empty')}</div></div>}

          </div>
        </div>
      </DialogBody>
      <DialogFooter separator data-openbitfun-component="workspace-project-permissions-dialog"
        data-openbitfun-part="footer" className="workspace-project-permissions-dialog__footer">
        {rulesDirty ? <>
          <span className="workspace-project-permissions-dialog__pending">{t('projectPermissions.unsaved')}</span>
          <Button type="button" size="sm" variant="fill" onClick={handleDiscardRules} disabled={isBusy}>{t('projectPermissions.cancel')}</Button>
          <Button type="button" size="sm" variant="primary" loading={rulesSaving} disabled={!rulesValid || rulesRevision === null || isBusy}
            onClick={() => void handleSaveRules()} leadingIcon={<Icon glyph={Save} size="sm" />}>{t('projectPermissions.saveRules')}</Button>
        </> : <Button size="sm" variant="fill" onClick={closeList} disabled={rulesSaving || isMutationRunning}>{t('common:actions.close')}</Button>}
      </DialogFooter>
      {dialogVisible && additionDialog}
    </Dialog>
    {!dialogVisible && additionDialog}
  </div>;
}

export default WorkspaceProjectPermissionsDialog;
