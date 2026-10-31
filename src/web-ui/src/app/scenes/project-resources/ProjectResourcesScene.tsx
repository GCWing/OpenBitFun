import React, { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Card, Dialog, DialogBody, DialogClose, DialogHeader, DialogHeading, DialogTitle,
  Icon, IconButton, ScrollArea, Spinner, Tooltip } from '@openbitfun/ui';
import { Bot, FolderOpen, Settings2 } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope, onSurfaceActivated, type SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { getSkillSourceLabel } from '@/infrastructure/config/skillSourcePresentation';
import { fileTabManager } from '@/shared/services/FileTabManager';
import { isRemoteWorkspace, type WorkspaceInfo } from '@/shared/types';
import { useNavSceneStore } from '@/app/stores/navSceneStore';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { WorkspaceIcon } from '@/app/components/WorkspaceIcon/WorkspaceIcon';
import { parseProjectResourceTarget } from './projectResourceTarget';
import { useProjectResources, type ProjectLoad } from './useProjectResources';
import { ProjectResourceMetrics, type ProjectResourceMetricTarget } from './ProjectResourceMetrics';
import { ProjectDirectoriesSection } from './ProjectDirectoriesSection';
import { ProjectResourceSummary } from './ProjectResourceSummary';
import { ProjectScheduledJobList } from './ProjectScheduledJobList';
import { ProjectResourceList, type ProjectResourceListAction } from './ProjectResourceList';
import { useProjectDirectoryActions } from './useProjectDirectoryActions';
import './ProjectResourcesScene.scss';

const RelatedPathsDialog = lazyWithRecovery(() => import('@/app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog'));
const WorkspaceIconDialog = lazyWithRecovery(() => import('@/app/components/WorkspaceIcon/WorkspaceIconDialog'));
const PermissionsPanel = lazyWithRecovery(() => import('@/app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsDialog')
  .then(module => ({ default: module.WorkspaceProjectPermissionsPanel })));
const ScheduledJobsModal = lazyWithRecovery(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'));
const CreateAgentDialog = lazyWithRecovery(() => import('../agents/components/CreateAgentDialog'));
const AddSkillDialog = lazyWithRecovery(() => import('../skills/components/AddSkillDialog').then(module => ({ default: module.StandaloneAddSkillDialog })));

export default function ProjectResourcesScene({ sceneId, isActive }: { sceneId: string; isActive: boolean }) {
  const { t } = useI18n('scenes/project-resources');
  const { openedWorkspaces } = useWorkspaceContext();
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const target = parseProjectResourceTarget(sceneId);
  const workspace = target?.surfaceId === scope.surfaceId ? openedWorkspaces.get(target.workspaceId) : undefined;
  if (!workspace || workspace.workspaceKind === 'assistant') {
    return <div className="project-resources" data-openbitfun-scene="project-resources" data-openbitfun-part="root">
      <div className="project-resources__unavailable" role="status"><Icon glyph={FolderOpen} size="lg" /><p>{t('unavailable')}</p></div>
    </div>;
  }
  return <ProjectResourcesContent key={scope.key(scope.epoch, workspace.id, workspace.connectionId, workspace.rootPath)}
    workspace={workspace} scope={scope} isActive={isActive} />;
}

interface ResourceDetail { name: string; description: string; source: string; path?: string }

function ProjectResourcesContent({ workspace, scope, isActive }: { workspace: WorkspaceInfo; scope: SurfaceScope; isActive: boolean }) {
  const { t, formatNumber } = useI18n('scenes/project-resources');
  const { t: commonT } = useI18n('common');
  const data = useProjectResources(workspace, scope, isActive);
  const directoryActions = useProjectDirectoryActions(workspace, scope, isActive);
  const remote = isRemoteWorkspace(workspace);
  const fileAccess = !remote || Boolean(workspace.connectionId);
  const [dialog, setDialog] = useState<'icon' | 'directories' | 'addDirectory' | 'jobs' | 'addJob' | 'agent' | 'skill' | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [capabilityList, setCapabilityList] = useState<'agents' | 'skills' | null>(null);
  const jobsSectionRef = useRef<HTMLElement>(null);
  const agentsSectionRef = useRef<HTMLDivElement>(null);
  const skillsSectionRef = useRef<HTMLDivElement>(null);
  const navigateToResource = (target: ProjectResourceMetricTarget) => {
    const section = { jobs: jobsSectionRef, agents: agentsSectionRef, skills: skillsSectionRef }[target].current;
    section?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    section?.focus({ preventScroll: true });
  };
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!isActive) { setDialog(null); setDetail(null); setCapabilityList(null); } }, [isActive]);
  const current = () => alive.current && scope.isCurrent();
  const closeDialog = () => { setDialog(null); data.refresh(); };
  const browseFiles = () => {
    if (current() && fileAccess) useNavSceneStore.getState().openWorkspaceResources(workspace.id);
  };
  const openFile = (path: string) => {
    if (!current() || !fileAccess) return;
    try {
      fileTabManager.openFile({ filePath: path, scope: { surfaceId: scope.surfaceId, workspaceId: workspace.id,
        workspacePath: workspace.rootPath, remoteConnectionId: workspace.connectionId } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('actionFailed')); }
  };
  const projectAgents = data.agents.status === 'ready'
    ? data.agents.data.filter(agent => agent.source === 'project') : [];
  const projectSkills = data.skills.status === 'ready'
    ? data.skills.data.skills.filter(skill => !skill.isBuiltin && skill.level === 'project') : [];
  const jobs = data.jobs.status === 'ready' ? [...data.jobs.data].sort((a, b) =>
    Number(b.state.lastRunStatus === 'error') - Number(a.state.lastRunStatus === 'error')
    || (a.state.nextRunAtMs ?? Infinity) - (b.state.nextRunAtMs ?? Infinity)) : [];
  const skillInstallSupported = !remote && scope.surfaceId === 'local' && isTauriRuntime();
  const agentsEmpty = data.agents.status === 'ready' && projectAgents.length === 0;
  const skillsEmpty = data.skills.status === 'ready' && projectSkills.length === 0;
  const jobsEmpty = data.jobs.status === 'ready' && jobs.length === 0;
  const showDetail = (resource: ResourceDetail) => { setCapabilityList(null); setDetail(resource); };
  const agentItems = projectAgents.map(agent => ({ id: agent.key, name: agent.name, icon: <Icon glyph={Bot} size="sm" />,
    title: agent.description, onClick: () => showDetail({ name: agent.name, description: agent.description, source: t('sources.project'), path: agent.path }) }));
  const skillItems = projectSkills.map(skill => ({ id: skill.key, name: skill.name, icon: <Icon name="extension" size="sm" />,
    title: skill.description, meta: skill.isShadowed ? t('capabilities.shadowed') : undefined,
    onClick: () => showDetail({ name: skill.name, description: skill.description,
      source: `${t('sources.project')} · ${getSkillSourceLabel(skill, t('sources.other'))}`,
      path: `${skill.path.replace(/\/$/, '')}/${skill.entryFile || 'SKILL.md'}` }) }));
  const agentAddAction: ProjectResourceListAction = { label: t('capabilities.createAgent'), disabled: remote,
    disabledReason: t('capabilities.remoteCreateUnavailable'), onClick: () => { setCapabilityList(null); setDialog('agent'); } };
  const skillAddAction: ProjectResourceListAction = { label: t('capabilities.addSkill'), disabled: !skillInstallSupported,
    disabledReason: t('capabilities.skillInstallUnavailable'), onClick: () => { setCapabilityList(null); setDialog('skill'); } };

  return <div className="project-resources" data-openbitfun-scene="project-resources" data-openbitfun-part="root">
    <ScrollArea className="project-resources__scroll">
      <div className="project-resources__content">
        <header className="project-resources__identity" data-openbitfun-scene="project-resources" data-openbitfun-part="identity">
          <IconButton className="project-resources__avatar" size="lg"
            aria-label={commonT('nav.workspaces.icon.title')} title={commonT('nav.workspaces.icon.title')}
            aria-haspopup="dialog" disabled={!isActive}
            icon={<>
              <WorkspaceIcon workspace={workspace} size={128} />
              <span className="project-resources__icon-edit-indicator" data-openbitfun-scene="project-resources" data-openbitfun-part="iconEditIndicator">
                <Icon name="edit" size="sm" />
              </span>
            </>}
            onClick={() => { if (current() && isActive) setDialog('icon'); }} />
          <h1>{workspace.name}</h1>
          {workspace.description && <p className="project-resources__description">{workspace.description}</p>}
        </header>
        <ProjectResourceMetrics data={data} onNavigate={navigateToResource} />
        {error && <p className="project-resources__error" role="alert">{error}</p>}
        {!fileAccess && <p className="project-resources__error" role="status">{t('connectionUnavailable')}</p>}

        <ProjectDirectoriesSection workspace={workspace} fileAccess={fileAccess} onBrowse={browseFiles} onManage={() => setDialog('directories')}
          onAdd={() => setDialog('addDirectory')} onRemove={path => void directoryActions.remove(path)}
          canReveal={isActive && directoryActions.canReveal} onReveal={path => void directoryActions.reveal(path)} revealingPath={directoryActions.revealingPath}
          removingPath={directoryActions.removingPath} error={directoryActions.error} />

        <section ref={jobsSectionRef} tabIndex={-1} className="project-resources__section" aria-label={t('automation.title')} data-openbitfun-scene="project-resources" data-openbitfun-part="automation">
          <ResourceSectionHeader title={t('automation.title')} actions={<>
            {!jobsEmpty && <>
              <Button className="project-resources__section-action" variant="text" size="sm" leadingIcon={<Icon name="plus" size="sm" />} onClick={() => setDialog('addJob')}>{t('automation.add')}</Button>
              <span className="project-resources__action-divider" aria-hidden="true" />
            </>}
            <Button className="project-resources__section-action" variant="text" size="sm" leadingIcon={<Icon glyph={Settings2} size="sm" />}
              onClick={() => setDialog('jobs')}>{t('automation.manage')}</Button>
          </>} />
          <ProjectResourceSummary title={t('automation.countLabel')} value={data.jobs.status === 'ready' ? formatNumber(jobs.length) : '—'}
            description={data.jobs.status === 'ready' ? t('automation.summary', {
              enabled: formatNumber(jobs.filter(job => job.enabled).length), paused: formatNumber(jobs.filter(job => !job.enabled).length),
            }) : undefined} listTitle={jobsEmpty ? undefined : t('automation.listTitle')} boundedList={jobs.length > 0} onOpen={() => setDialog('jobs')}>
            <LoadFeedback state={data.jobs} retry={data.refresh} />
            {jobs.length > 0 && <ProjectScheduledJobList jobs={jobs} onOpen={() => setDialog('jobs')} />}
            {jobsEmpty && <div className="project-resource-summary__empty">
              <Button variant="quiet" size="sm" leadingIcon={<Icon name="plus" size="sm" />} onClick={() => setDialog('addJob')}>{t('automation.add')}</Button>
            </div>}
          </ProjectResourceSummary>
        </section>

        <section className="project-resources__section" aria-label={t('permissions')} data-openbitfun-scene="project-resources" data-openbitfun-part="permissions">
          <Suspense fallback={<Spinner size="sm" />}>
            <PermissionsPanel workspace={workspace} isActive={isActive} />
          </Suspense>
        </section>

        <section className="project-resources__section" aria-label={t('capabilities.title')} data-openbitfun-scene="project-resources" data-openbitfun-part="capabilities">
          <ResourceSectionHeader title={t('capabilities.title')} />
          <div className="project-resources__split">
            <Card ref={agentsSectionRef} tabIndex={-1} aria-label={t('capabilities.agents')} appearance="subtle" radius="lg" className="project-resources__pane">
              {!agentsEmpty && <h3>{t('capabilities.agents')}</h3>}
              <LoadFeedback state={data.agents} retry={data.refresh} />
              {projectAgents.length > 0 && <div className="project-resources__capability-list">
                <ProjectResourceList items={agentItems} label={t('capabilities.agents')} addAction={agentAddAction}
                  moreLabel={t('showAll', { count: formatNumber(projectAgents.length) })} onShowAll={() => setCapabilityList('agents')} />
              </div>}
              {projectAgents.length === 0 && <div className={agentsEmpty ? 'project-resources__capability-empty' : undefined}>
                <Tooltip content={remote ? t('capabilities.remoteCreateUnavailable') : undefined}>
                  <span tabIndex={remote ? 0 : undefined}>
                    <Button variant={agentsEmpty ? 'quiet' : 'text'} size="sm" leadingIcon={<Icon name="plus" size="sm" />} disabled={remote}
                      onClick={() => setDialog('agent')}>{t('capabilities.createAgent')}</Button>
                  </span>
                </Tooltip>
              </div>}
            </Card>
            <Card ref={skillsSectionRef} tabIndex={-1} aria-label={t('capabilities.skills')} appearance="subtle" radius="lg" className="project-resources__pane">
              {!skillsEmpty && <h3>{t('capabilities.skills')}</h3>}
              <LoadFeedback state={data.skills} retry={data.refresh} />
              {projectSkills.length > 0 && <div className="project-resources__capability-list">
                <ProjectResourceList items={skillItems} label={t('capabilities.skills')} addAction={skillAddAction}
                  moreLabel={t('showAll', { count: formatNumber(projectSkills.length) })} onShowAll={() => setCapabilityList('skills')} />
              </div>}
              {data.skills.status === 'ready' && (data.skills.data.diagnostics.length > 0 || !data.skills.data.diagnosticsAvailable) &&
                <p className="project-resources__hint" role="status">{t('capabilities.incomplete')}</p>}
              {projectSkills.length === 0 && <div className={skillsEmpty ? 'project-resources__capability-empty' : undefined}>
                <Tooltip content={!skillInstallSupported ? t('capabilities.skillInstallUnavailable') : undefined}>
                  <span tabIndex={!skillInstallSupported ? 0 : undefined}>
                    <Button variant={skillsEmpty ? 'quiet' : 'text'} size="sm" leadingIcon={<Icon name="plus" size="sm" />} disabled={!skillInstallSupported}
                      onClick={() => setDialog('skill')}>{t('capabilities.addSkill')}</Button>
                  </span>
                </Tooltip>
              </div>}
            </Card>
          </div>
        </section>

      </div>
    </ScrollArea>
    <Suspense fallback={<Spinner size="sm" />}>
      {isActive && dialog === 'icon' && <WorkspaceIconDialog workspace={workspace} onClose={() => setDialog(null)} />}
      {isActive && (dialog === 'directories' || dialog === 'addDirectory') && <RelatedPathsDialog workspace={workspace} isOpen
        initialAdd={dialog === 'addDirectory'} onClose={closeDialog} />}
      {isActive && (dialog === 'jobs' || dialog === 'addJob') && <ScheduledJobsModal isOpen onClose={closeDialog} workspaceId={workspace.id}
        workspaceKind={workspace.workspaceKind} targetKind="workspace" targetLabel={workspace.name} title={t('automation.title')}
        listPresentation="table" listTargetKind="workspace" initialCreate={dialog === 'addJob'} />}
      {isActive && dialog === 'agent' && <CreateAgentDialog workspace={workspace} initialLevel="project" onClose={closeDialog} onCreated={data.refresh} />}
      {isActive && dialog === 'skill' && <AddSkillDialog workspace={workspace} initialLevel="project" open onOpenChange={open => { if (!open) closeDialog(); }} onAdded={data.refresh} />}
    </Suspense>
    {isActive && capabilityList && <Dialog open onOpenChange={open => { if (!open) setCapabilityList(null); }} size="md">
      <DialogHeader><DialogHeading><DialogTitle>{t(capabilityList === 'agents' ? 'capabilities.agents' : 'capabilities.skills')}</DialogTitle></DialogHeading><DialogClose /></DialogHeader>
      <DialogBody>
        <ProjectResourceList bounded={false} items={capabilityList === 'agents' ? agentItems : skillItems}
          label={t(capabilityList === 'agents' ? 'capabilities.agents' : 'capabilities.skills')}
          addAction={capabilityList === 'agents' ? agentAddAction : skillAddAction} />
      </DialogBody>
    </Dialog>}
    {isActive && detail && <Dialog open onOpenChange={() => setDetail(null)} size="md">
      <DialogHeader><DialogHeading><DialogTitle>{detail.name}</DialogTitle></DialogHeading><DialogClose /></DialogHeader>
      <DialogBody><div className="project-resources__detail">
        <p>{detail.description}</p><p className="project-resources__hint">{detail.source}</p>
        {detail.path && <><p className="project-resources__detail-path">{detail.path}</p>
          <Button variant="secondary" size="sm" disabled={!fileAccess} onClick={() => { setDetail(null); openFile(detail.path!); }}>{t('capabilities.openDefinition')}</Button></>}
      </div></DialogBody>
    </Dialog>}
  </div>;
}

function ResourceSectionHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return <div className="project-resources__section-header"><h2>{title}</h2>{actions && <div className="project-resources__section-actions">{actions}</div>}</div>;
}

function LoadFeedback({ state, retry }: { state: ProjectLoad<unknown>; retry: () => void }) {
  const { t } = useI18n('scenes/project-resources');
  if (state.status === 'ready') return null;
  return <div className="project-resources__load" role="status">
    {state.status === 'loading' ? <><Spinner size="sm" /><span>{t('loading')}</span></>
      : <><span>{t('loadFailed')}</span><Button variant="text" size="sm" onClick={retry}>{t('retry')}</Button>
        <details className="project-resources__failure-details"><summary>{t('failureDetails')}</summary>{state.error}</details></>}
  </div>;
}
