import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActionCard, Button, Card, Icon, OverflowText, ScrollArea, Spinner } from '@openbitfun/ui';
import { useSubagentAvatarMotion } from '@openbitfun/ui/brand';
import { Ellipsis } from 'lucide-react';
import { useAccountIdentity } from '@/infrastructure/account-identity/useAccountIdentity';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { confirmDialog } from '@/infrastructure/confirm-dialog';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useSceneStore } from '@/app/stores/sceneStore';
import { useAgentsStore } from '../agents/agentsStore';
import { useNurseryStore } from '../profile/nurseryStore';
import { projectMiniAppActivity } from '../miniapps/miniAppActivity';
import { useMiniAppCreation } from '../miniapps/hooks/useMiniAppCreation';
import { pickLocalizedString } from '../miniapps/utils/pickLocalizedString';
import { renderMiniAppIcon } from '../miniapps/utils/miniAppIcons';
import { useSkillsSceneStore, type SkillTab } from '../skills/skillsSceneStore';
import { summarizeOverviewUsage } from './overviewData';
import { recentMiniApps } from './overviewCatalog';
import { UsageActivityGrid } from '@/infrastructure/config/components/UsageActivityGrid';
import { usePersonalOverview } from './usePersonalOverview';
import { getOverviewIdentity } from './overviewIdentity';
import { OverviewAccountButton } from './OverviewAccountButton';
import { OverviewDevicesSection } from './OverviewDevicesSection';
import joystickArtwork from '@/flow_chat/assets/subagent-avatars/robot-04.svg?raw';
import './PersonalOverviewScene.scss';

const log = createLogger('PersonalOverviewScene');
const StandaloneAddSkillDialog = React.lazy(() => import('../skills/components/AddSkillDialog').then(module => ({ default: module.StandaloneAddSkillDialog })));
const CreateAgentDialog = React.lazy(() => import('../agents/components/CreateAgentDialog'));

// Reuse the authored IP and its existing motion rig; no account data enters SVG markup.
const overviewArtwork = joystickArtwork
  .replace(/<title\b[^>]*>[\s\S]*?<\/title>/, '')
  .replace(/\s(?:aria-labelledby|role)="[^"]*"/g, '');

const PersonalOverviewScene: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const { t, formatNumber, resolvedTimeZone, currentLanguage } = useI18n('scenes/personal-overview');
  const identity = useAccountIdentity();
  const { usage, agents, miniApps, skills, refresh } = usePersonalOverview(resolvedTimeZone, isActive);
  const { creating: creatingMiniApp, createMiniApp } = useMiniAppCreation();
  const openTabs = useSceneStore(state => state.openTabs);
  const miniAppActivities = useMemo(() => miniApps.status === 'ready'
    ? projectMiniAppActivity(miniApps.data.apps, openTabs, miniApps.data.runningWorkerIds)
    : [], [miniApps, openTabs]);
  const miniAppPreview = useMemo(() => miniApps.status === 'ready'
    ? recentMiniApps(miniApps.data.apps)
    : null, [miniApps]);
  const miniAppItems = useMemo(() => {
    // Keep active apps reachable, then fill the remaining preview slots by recency.
    const apps = new Map(miniAppActivities.map(({ app }) => [app.id, app]));
    miniAppPreview?.items.forEach(({ item }) => apps.set(item.id, item));
    if (miniApps.status === 'ready') {
      miniApps.data.apps.forEach(app => apps.set(app.id, app));
    }
    return [...apps.values()].slice(0, 3);
  }, [miniAppPreview, miniAppActivities, miniApps]);
  const remainingMiniAppCount = miniApps.status === 'ready'
    ? Math.max(0, miniApps.data.apps.length - miniAppItems.length)
    : 0;
  const catalogCount = (status: string, value: number) => status === 'ready'
    ? formatNumber(value)
    : t(status === 'loading' ? 'loadingValue' : 'unavailableValue');
  const { assistantWorkspaces, loading: workspacesLoading, createAssistantWorkspace } = useWorkspaceContext();
  const notification = useNotification();
  const [creatingAssistant, setCreatingAssistant] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  useEffect(() => {
    if (!isActive) {
      setAddingSkill(false);
      setCreatingAgent(false);
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
    <div className="personal-overview" data-openbitfun-scene="personal-overview" data-openbitfun-part="root">
      <div className="personal-overview__account-actions">
        <OverviewAccountButton identity={identity} />
      </div>
      <ScrollArea className="personal-overview__scroll">
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
            <Card appearance="subtle" radius="lg" clip>
              <div className="personal-overview__agent-grid">
                {agentCards.map(card => (
                  <button className="personal-overview__agent" type="button" key={card.id} onClick={card.onClick} data-testid={`personal-overview-${card.id}`} data-overflow-trigger>
                    <OverflowText className="personal-overview__agent-name">{card.title}</OverflowText>
                    <span className="personal-overview__agent-count">{card.count}</span>
                    <span className="personal-overview__agent-description">{card.description}</span>
                  </button>
                ))}
              </div>
            </Card>
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
              <ul className="personal-overview__catalog-grid personal-overview__catalog-grid--miniapps">
                {miniAppItems.map(app => {
                  const active = miniAppActivities.some(activity => activity.app.id === app.id);
                  return (
                    <li key={app.id} className="personal-overview__catalog-cell">
                      <ActionCard
                        className="personal-overview__catalog-action"
                        leading={renderMiniAppIcon(app.icon || 'box', 'lg')}
                        body={(
                          <span className="personal-overview__catalog-copy">
                            <OverflowText className="personal-overview__catalog-item-name">{pickLocalizedString(app, currentLanguage, 'name')}</OverflowText>
                            <OverflowText className="personal-overview__catalog-item-description">{pickLocalizedString(app, currentLanguage, 'description')}</OverflowText>
                          </span>
                        )}
                        onClick={() => useSceneStore.getState().openScene(`miniapp:${app.id}`)}
                        data-testid={active ? 'personal-overview-miniapp-activity' : 'personal-overview-recent-miniapp'}
                        data-miniapp-id={app.id}
                      />
                    </li>
                  );
                })}
                <li className="personal-overview__catalog-cell">
                  <ActionCard
                    className="personal-overview__catalog-action"
                    leading={<Icon glyph={Ellipsis} size="lg" />}
                    body={<OverflowText className="personal-overview__catalog-item-name">{remainingMiniAppCount > 0 ? t('miniApps.more', { count: formatNumber(remainingMiniAppCount) }) : t('miniApps.manage')}</OverflowText>}
                    onClick={() => useSceneStore.getState().openScene('miniapps')}
                    data-testid="personal-overview-more-miniapps"
                  />
                </li>
              </ul>
              {miniApps.status === 'ready' && miniAppItems.length === 0 && <p className="personal-overview__catalog-empty">{t('miniApps.empty')}</p>}
              {miniAppPreview?.incomplete && <p className="personal-overview__catalog-empty" role="status">{t('catalog.datesIncomplete')}</p>}
              {miniApps.status !== 'ready' && (
                <div className="personal-overview__catalog-status" role="status">
                  <span>{t(miniApps.status === 'loading' ? 'miniApps.loading' : 'miniApps.failed')}</span>
                  {miniApps.status !== 'loading' && <Button variant="secondary" size="sm" onClick={refresh}>{t('retry')}</Button>}
                </div>
              )}
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
              <ul className="personal-overview__catalog-grid personal-overview__catalog-grid--skills">
                <li className="personal-overview__catalog-cell">
                  <ActionCard
                    className="personal-overview__catalog-action"
                    leading={<Icon name="book-open" size="lg" />}
                    body={(
                      <span className="personal-overview__catalog-copy">
                        <OverflowText className="personal-overview__catalog-item-name">{t('skills.installed')}</OverflowText>
                        <OverflowText className="personal-overview__catalog-item-description">{t('skills.installedCount', { count: catalogCount(skills.status, skills.status === 'ready' ? skills.data.skills.length : 0) })}</OverflowText>
                      </span>
                    )}
                    onClick={() => openSkills('installed')}
                    data-testid="personal-overview-skills"
                  />
                </li>
                <li className="personal-overview__catalog-cell">
                  <ActionCard
                    className="personal-overview__catalog-action"
                    leading={<Icon name="search" size="lg" />}
                    body={(
                      <span className="personal-overview__catalog-copy">
                        <OverflowText className="personal-overview__catalog-item-name">{t('skills.discover')}</OverflowText>
                        <OverflowText className="personal-overview__catalog-item-description">{t('skills.discoverDescription')}</OverflowText>
                      </span>
                    )}
                    onClick={() => openSkills('discover')}
                    data-testid="personal-overview-discover-skills"
                  />
                </li>
              </ul>
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
  );
};

export default PersonalOverviewScene;
