import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Icon, ScrollArea, Spinner } from '@openbitfun/ui';
import { useSubagentAvatarMotion } from '@openbitfun/ui/brand';
import { useAccountIdentity } from '@/infrastructure/account-identity/useAccountIdentity';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useAgentsStore } from '../agents/agentsStore';
import { useNurseryStore } from '../profile/nurseryStore';
import { projectMiniAppActivity } from '../miniapps/miniAppActivity';
import { useMiniAppCreation } from '../miniapps/hooks/useMiniAppCreation';
import { useSkillsSceneStore, type SkillTab } from '../skills/skillsSceneStore';
import { summarizeOverviewUsage } from './overviewData';
import { UsageActivityGrid } from '@/infrastructure/config/components/UsageActivityGrid';
import { usePersonalOverview } from './usePersonalOverview';
import { getOverviewIdentity } from './overviewIdentity';
import { OverviewAccountButton } from './OverviewAccountButton';
import { OverviewDevicesSection } from './OverviewDevicesSection';
import { OverviewSplitCard, OverviewSplitCardAction, OverviewSplitCardSection } from './OverviewSplitCard';
import { OverviewMiniAppLogos } from './OverviewMiniAppLogos';
import joystickArtwork from '@/flow_chat/assets/subagent-avatars/robot-04.svg?raw';
import './PersonalOverviewScene.scss';

const log = createLogger('PersonalOverviewScene');
const StandaloneAddSkillDialog = React.lazy(() => import('../skills/components/AddSkillDialog').then(module => ({ default: module.StandaloneAddSkillDialog })));
const CreateAgentDialog = React.lazy(() => import('../agents/components/CreateAgentDialog'));
const MiniAppGalleryScene = React.lazy(() => import('../miniapps/MiniAppGalleryScene'));

// Reuse the authored IP and its existing motion rig; no account data enters SVG markup.
const overviewArtwork = joystickArtwork
  .replace(/<title\b[^>]*>[\s\S]*?<\/title>/, '')
  .replace(/\s(?:aria-labelledby|role)="[^"]*"/g, '');

const PersonalOverviewScene: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const { t, formatNumber, resolvedTimeZone } = useI18n('scenes/personal-overview');
  const identity = useAccountIdentity();
  const { usage, agents, miniApps, skills, refresh } = usePersonalOverview(resolvedTimeZone, isActive);
  const { creating: creatingMiniApp, createMiniApp } = useMiniAppCreation();
  const surfaceScope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope);
  const openTabs = useSceneStore(state => state.openTabs);
  const miniAppActivities = useMemo(() => miniApps.status === 'ready'
    ? projectMiniAppActivity(miniApps.data.apps, openTabs, miniApps.data.runningWorkerIds)
    : [], [miniApps, openTabs]);
  const miniAppItems = miniApps.status === 'ready' ? miniApps.data.apps : [];
  const catalogCount = (status: string, value: number) => status === 'ready'
    ? formatNumber(value)
    : t(status === 'loading' ? 'loadingValue' : 'unavailableValue');
  const { assistantWorkspaces, loading: workspacesLoading, createAssistantWorkspace } = useWorkspaceContext();
  const notification = useNotification();
  const [creatingAssistant, setCreatingAssistant] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const surfaceEpoch = surfaceScope.epoch;
  const [miniAppDetail, setMiniAppDetail] = useState<{ app: MiniAppMeta; epoch: number } | null>(null);
  const showingMiniAppDetail = miniAppDetail?.epoch === surfaceEpoch;
  const overviewScrollRef = useRef<HTMLDivElement>(null);
  const overviewReturnPosition = useRef<{ scrollTop: number; focus: HTMLElement | null } | null>(null);

  useLayoutEffect(() => {
    if (showingMiniAppDetail || !overviewReturnPosition.current) return;
    const { scrollTop, focus } = overviewReturnPosition.current;
    if (overviewScrollRef.current) overviewScrollRef.current.scrollTop = scrollTop;
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }, [showingMiniAppDetail]);

  const openMiniAppDetails = (app: MiniAppMeta) => {
    overviewReturnPosition.current = {
      scrollTop: overviewScrollRef.current?.scrollTop ?? 0,
      focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    setMiniAppDetail({ app, epoch: surfaceEpoch });
  };
  useEffect(() => {
    if (!isActive) {
      setAddingSkill(false);
      setCreatingAgent(false);
      setMiniAppDetail(null);
    }
  }, [isActive]);
  const assistantCreationPending = useRef(false);
  const displayedIdentity = getOverviewIdentity(identity);
  const [greetingSeed] = useState(Math.random);
  const guestGreetings = [
    t('greetings.spotted'),
    t('greetings.mystery'),
    t('greetings.ideas'),
    t('greetings.create'),
    t('greetings.energy'),
    t('greetings.ready'),
  ];
  const displayName = displayedIdentity?.name ?? (
    identity.resolved && (identity.status === 'signed-out' || identity.status === 'authorizing')
      ? guestGreetings[Math.floor(greetingSeed * guestGreetings.length)]
      : null
  );
  const avatarRef = useRef<HTMLSpanElement>(null);
  useSubagentAvatarMotion(avatarRef, 'running', isActive, 'personal-overview');
  const summary = useMemo(() => usage.status === 'ready'
    ? summarizeOverviewUsage(usage.data.stats, resolvedTimeZone, usage.data.now)
    : null, [usage, resolvedTimeZone]);
  const tokens = (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  const unavailable = usage.status === 'loading' ? t('loadingValue') : t('unavailableValue');
  const metrics = [
    { label: t('metrics.totalTokens'), value: usage.status === 'ready' ? tokens(usage.data.stats.totalTokens) : unavailable },
    { label: t('metrics.peakTokens'), value: summary ? tokens(summary.peakTokens) : unavailable, hint: summary?.partial ? t('metrics.partial') : undefined },
    { label: t('metrics.longestTask'), value: t('unavailableValue') },
    { label: t('metrics.longestStreak'), value: summary ? t('metrics.days', { count: formatNumber(summary.longestStreak) }) : unavailable, hint: summary?.partial ? t('metrics.partial') : undefined },
    { label: t('metrics.currentStreak'), value: summary ? t('metrics.days', { count: formatNumber(summary.currentStreak) }) : unavailable, hint: summary?.partial ? t('metrics.partial') : undefined },
  ];

  const openAgents = () => {
    const store = useAgentsStore.getState();
    store.openHome();
    store.setSearchQuery('');
    store.setAgentFilterLevel('all');
    store.setAgentFilterType('all');
    useSceneStore.getState().openScene('agents');
  };
  const createAgent = () => {
    setCreatingAgent(true);
  };
  const createAssistant = async () => {
    if (assistantCreationPending.current) return;
    const scope = getActiveSurfaceScope();
    assistantCreationPending.current = true;
    try {
      const confirmed = await confirmDialog({
        title: t('agents.createAssistant'),
        message: t('agents.createAssistantConfirmMessage'),
        confirmText: t('agents.createAssistant'),
        type: 'info',
      });
      if (!confirmed || !scope.isCurrent()) return;

      setCreatingAssistant(true);
      const workspace = await createAssistantWorkspace();
      scope.assertCurrent('open newly created assistant');
      useNurseryStore.getState().openAssistant(workspace.id);
      useSceneStore.getState().openScene('assistant');
    } catch (error) {
      if (scope.isCurrent()) {
        log.error('Failed to create assistant workspace', error);
        notification.error(t('agents.createAssistantFailed'));
      }
    } finally {
      assistantCreationPending.current = false;
      setCreatingAssistant(false);
    }
  };
  const openSkills = (target: SkillTab) => {
    useSkillsSceneStore.getState().openNativeSkills(target);
    useSceneStore.getState().openScene('skills');
  };
  const addSkill = () => {
    setAddingSkill(true);
  };
  const agentCards = [
    {
      id: 'agents',
      title: t('agents.title'),
      description: t('agents.description'),
      count: catalogCount(agents.status, agents.status === 'ready' ? agents.data.length : 0),
      onClick: openAgents,
    },
    {
      id: 'assistants',
      title: t('shared:agents.Claw'),
      description: t('agents.assistants.description'),
      count: assistantWorkspaces !== null
        ? formatNumber(assistantWorkspaces.length)
        : t(workspacesLoading ? 'loadingValue' : 'unavailableValue'),
      onClick: () => {
        useNurseryStore.getState().openGallery();
        useSceneStore.getState().openScene('assistant');
      },
    },
  ];

  return (
    <>
      {showingMiniAppDetail && miniAppDetail && (
        <React.Suspense fallback={<div className="personal-overview__placeholder" role="status"><Spinner size="md" /></div>}>
          <MiniAppGalleryScene key={`${surfaceEpoch}:${miniAppDetail.app.id}`} initialDetailApp={miniAppDetail.app}
            detailBackLabel={t('miniApps.backToOverview')} onDetailBack={() => { setMiniAppDetail(null); refresh(); }} />
        </React.Suspense>
      )}
      <div className="personal-overview" hidden={showingMiniAppDetail} data-openbitfun-scene="personal-overview" data-openbitfun-part="root">
        {identity.resolved && identity.status === 'signed-in' && identity.me && (
          <div className="personal-overview__account-actions">
            <OverviewAccountButton identity={identity} />
          </div>
        )}
        <ScrollArea ref={overviewScrollRef} className="personal-overview__scroll">
          <div className="personal-overview__content">
            <header className="personal-overview__identity" data-openbitfun-scene="personal-overview" data-openbitfun-part="identity">
              <span
                ref={avatarRef}
                className="personal-overview__avatar"
                data-openbitfun-scene="personal-overview"
                data-openbitfun-part="avatar"
                aria-hidden="true"
              >
                <span className="personal-overview__avatar-art" data-subagent-motion-art="true" dangerouslySetInnerHTML={{ __html: overviewArtwork }} />
              </span>
              {displayName && <h1 className="personal-overview__name">{displayName}</h1>}
              {displayedIdentity?.handle && <p className="personal-overview__handle">{displayedIdentity.handle}</p>}
            </header>

            <section aria-label={t('metrics.title')}>
              <dl className="personal-overview__metrics" aria-busy={usage.status === 'loading'} data-openbitfun-scene="personal-overview" data-openbitfun-part="metrics">
                {metrics.map(metric => (
                  <div className="personal-overview__metric" key={metric.label} title={metric.hint}>
                    <dt className="personal-overview__metric-label">{metric.label}</dt>
                    <dd className="personal-overview__metric-value">{metric.value}</dd>
                  </div>
                ))}
              </dl>
              {(usage.status === 'failed' || usage.status === 'unsupported') && (
                <div className="personal-overview__message" role="status">
                  <span>{t(usage.status === 'unsupported' ? 'usage.unsupported' : 'usage.failed')}</span>
                  <Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>
                </div>
              )}
            </section>

            <section className="personal-overview__section" aria-labelledby="overview-agents-title" data-openbitfun-scene="personal-overview" data-openbitfun-part="agents">
              <div className="personal-overview__section-header">
                <h2 id="overview-agents-title" className="personal-overview__section-title">{t('agents.title')}</h2>
                <div className="personal-overview__section-actions">
                  <Button className="personal-overview__section-action" variant="text" size="sm" leadingIcon={<Icon name="plus" size="sm" />} onClick={createAgent} data-testid="personal-overview-create-agent">
                    {t('agents.create')}
                  </Button>
                  <span className="personal-overview__action-divider" aria-hidden="true" />
                  <Button className="personal-overview__section-action" variant="text" size="sm" leadingIcon={<Icon name="plus" size="sm" />} loading={creatingAssistant} onClick={() => void createAssistant()} data-testid="personal-overview-create-assistant">
                    {t('agents.createAssistant')}
                  </Button>
                </div>
              </div>
              <OverviewSplitCard>
                {agentCards.map(card => (
                  <OverviewSplitCardAction key={card.id} title={card.title} value={card.count}
                    description={card.description} onClick={card.onClick} data-testid={`personal-overview-${card.id}`} />
                ))}
              </OverviewSplitCard>
              {agents.status !== 'ready' && (
                <div className="personal-overview__message" role="status">
                  <span>{t(agents.status === 'loading' ? 'agents.loading' : 'agents.failed')}</span>
                  {agents.status !== 'loading' && <Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>}
                </div>
              )}
            </section>

            <OverviewDevicesSection identity={identity} />

            <section className="personal-overview__section" aria-labelledby="overview-miniapps-title" aria-busy={miniApps.status === 'loading'} data-openbitfun-scene="personal-overview" data-openbitfun-part="miniApps" data-catalog-status={miniApps.status}>
              <div className="personal-overview__section-header">
                <h2 id="overview-miniapps-title" className="personal-overview__section-title">{t('common:scenes.miniApps')}</h2>
                <Button
                  className="personal-overview__section-action"
                  variant="text"
                  size="sm"
                  leadingIcon={<Icon name="plus" size="sm" />}
                  loading={creatingMiniApp}
                  onClick={() => void createMiniApp()}
                  data-testid="personal-overview-create-miniapp"
                >
                  {t('miniApps.create')}
                </Button>
              </div>
              <div className="personal-overview__catalog">
                <OverviewSplitCard>
                  <OverviewSplitCardAction
                    title={t('common:scenes.miniApps')}
                    value={<span data-testid="personal-overview-miniapp-count">{catalogCount(miniApps.status, miniAppItems.length)}</span>}
                    description={t('miniApps.runningCount', { count: catalogCount(miniApps.status, miniAppActivities.length) })}
                    onClick={() => useSceneStore.getState().openScene('miniapps')}
                    data-testid="personal-overview-miniapp-summary"
                  />
                  <OverviewSplitCardSection title={t('miniApps.installed')}>
                    {miniApps.status === 'ready' ? miniAppItems.length > 0 ? (
                      <OverviewMiniAppLogos apps={miniAppItems} onDetails={openMiniAppDetails}
                        onLaunch={appId => useSceneStore.getState().openScene(`miniapp:${appId}`)}
                        onViewAll={() => useSceneStore.getState().openScene('miniapps')} />
                    ) : <p className="personal-overview__catalog-empty">{t('miniApps.empty')}</p> : (
                      <div className="personal-overview__catalog-status" role="status">
                        <span>{t(miniApps.status === 'loading' ? 'miniApps.loading' : 'miniApps.failed')}</span>
                        {miniApps.status !== 'loading' && <Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>}
                      </div>
                    )}
                  </OverviewSplitCardSection>
                </OverviewSplitCard>
              </div>
            </section>

            <section className="personal-overview__section" aria-labelledby="overview-skills-title" aria-busy={skills.status === 'loading'} data-openbitfun-scene="personal-overview" data-openbitfun-part="skills">
              <div className="personal-overview__section-header">
                <h2 id="overview-skills-title" className="personal-overview__section-title">{t('common:scenes.skills')}</h2>
                <Button
                  className="personal-overview__section-action"
                  variant="text"
                  size="sm"
                  leadingIcon={<Icon name="plus" size="sm" />}
                  onClick={addSkill}
                  data-testid="personal-overview-add-skill"
                >
                  {t('skills.add')}
                </Button>
              </div>
              <div className="personal-overview__catalog">
                <OverviewSplitCard>
                  <OverviewSplitCardAction
                    title={t('skills.installed')}
                    value={catalogCount(skills.status, skills.status === 'ready' ? skills.data.skills.length : 0)}
                    description={t('skills.installedDescription')}
                    onClick={() => openSkills('installed')}
                    data-testid="personal-overview-skills"
                  />
                  <OverviewSplitCardAction
                    title={t('skills.discover')}
                    value={<Icon name="search" size="lg" />}
                    description={t('skills.discoverDescription')}
                    onClick={() => openSkills('discover')}
                    data-testid="personal-overview-discover-skills"
                  />
                </OverviewSplitCard>
                {skills.status !== 'ready' ? (
                  <div className="personal-overview__catalog-status" role="status">
                    <span>{t(skills.status === 'loading' ? 'skills.loading' : 'skills.failed')}</span>
                    {skills.status !== 'loading' && <Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>}
                  </div>
                ) : (skills.data.diagnostics.length > 0 || !skills.data.diagnosticsAvailable) && (
                  <div className="personal-overview__catalog-status" role="status">
                    <span>{t(skills.data.diagnosticsAvailable ? 'skills.incomplete' : 'skills.diagnosticsUnavailable')}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="personal-overview__section" aria-labelledby="overview-activity-title" data-openbitfun-scene="personal-overview" data-openbitfun-part="activity">
              <div className="personal-overview__section-header">
                <h2 id="overview-activity-title" className="personal-overview__section-title">{t('activity.title')}</h2>
              </div>
              {usage.status === 'loading' ? (
                <div className="personal-overview__placeholder" role="status"><Spinner size="md" /><span>{t('usage.loading')}</span></div>
              ) : usage.status !== 'ready' ? (
                <div className="personal-overview__placeholder"><p>{t(usage.status === 'unsupported' ? 'usage.unsupported' : 'usage.failed')}</p></div>
              ) : (
                <div className="personal-overview__heatmap">
                  <UsageActivityGrid points={usage.data.stats.trend} timeZone={resolvedTimeZone} now={usage.data.now} />
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
        {addingSkill && isActive && (
          <React.Suspense fallback={null}>
            <StandaloneAddSkillDialog open onOpenChange={setAddingSkill} onAdded={refresh} />
          </React.Suspense>
        )}
        {creatingAgent && isActive && (
          <React.Suspense fallback={null}>
            <CreateAgentDialog onClose={() => setCreatingAgent(false)} onCreated={refresh} />
          </React.Suspense>
        )}
      </div>
    </>
  );
};

export default PersonalOverviewScene;
