/**
 * SceneViewport — renders the active scene component.
 *
 * Open scene hosts stay mounted, but only the active host is visible. Workspace
 * session tabs share one Session host backed by the authoritative selection;
 * their resource identity is independent of the host's mounting lifetime.
 *
 * When no tabs are open, the viewport renders WelcomeScene as a shell-owned
 * landing surface rather than manufacturing a tab for it.
 */
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';

import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { SceneTabId } from '../components/SceneBar/types';
import { getSceneViewId } from '../components/SceneBar/types';
import { useSceneManager } from '../hooks/useSceneManager';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { useDialogCompletionNotify } from '../hooks/useDialogCompletionNotify';
import { Spinner, SplitViewSurface } from '@openbitfun/ui';
import { selectedScene, tabPane } from '../workbench/scenePaneModel';
import { useSceneStore } from '../stores/sceneStore';
import { useSessionPaneLayout } from './session/sessionPaneLayoutStore';
import SettingsScene from './settings/SettingsScene';
import AssistantScene from './assistant/AssistantScene';
import SessionScene from './session/SessionScene';
import WelcomeScene from './welcome/WelcomeScene';
import ContentResourceView from '../workbench/ContentResourceView';
import { useContentResourceStore } from '../workbench/contentResourceStore';
import './SceneViewport.scss';

// Session is the primary interaction path. Keep it in the main scene bundle so
// first open does not stall on a lazy chunk fetch/parse before FlowChat mounts.
const TerminalScene   = lazyWithRecovery(() => import('./terminal/TerminalScene'));
const GitScene        = lazyWithRecovery(() => import('./git/GitScene'));
const ProfileScene    = lazyWithRecovery(() => import('./profile/ProfileScene'));
const PersonalOverviewScene = lazyWithRecovery(() => import('./personal-overview/PersonalOverviewScene'));
const AgentsScene       = lazyWithRecovery(() => import('./agents/AgentsScene'));
const SkillsScene     = lazyWithRecovery(() => import('./skills/SkillsScene'));
const EcosystemCompatibilityScene = lazyWithRecovery(
  () => import('./ecosystem-compatibility/EcosystemCompatibilityScene'),
);
const MiniAppGalleryScene = lazyWithRecovery(() => import('./miniapps/MiniAppGalleryScene'));
const PagesScene      = lazyWithRecovery(() => import('./pages/PagesScene'));
const BrowserScene    = lazyWithRecovery(() => import('./browser/BrowserScene'));
const TodosScene      = lazyWithRecovery(() => import('./todos/TodosScene'));
const InsightsScene   = lazyWithRecovery(() => import('./my-agent/InsightsScene'));
const ShellScene      = lazyWithRecovery(() => import('./shell/ShellScene'));
const MiniAppScene    = lazyWithRecovery(() => import('./miniapps/MiniAppScene'));

const SCENE_ENTRY_DURATION_MS = 480;
const EMPTY_SCENE_ID = '__empty-scene__' as const;
type RenderedSceneId = SceneTabId | typeof EMPTY_SCENE_ID;

interface SceneTransition {
  outgoingTabId: RenderedSceneId | null;
  incomingTabId: RenderedSceneId | null;
  phase: 'holding' | 'preparing' | 'running';
}

interface SceneReadyBoundaryProps {
  sceneId: SceneTabId;
  onReady: (sceneId: SceneTabId) => void;
  children: React.ReactNode;
}

/**
 * This effect commits only after a lazy scene has resolved through Suspense.
 * It lets the viewport hold the outgoing pixels until the incoming tree is
 * actually paintable instead of exposing a fallback between the two scenes.
 */
const SceneReadyBoundary: React.FC<SceneReadyBoundaryProps> = ({
  sceneId,
  onReady,
  children,
}) => {
  useLayoutEffect(() => {
    onReady(sceneId);
  }, [onReady, sceneId]);

  return <>{children}</>;
};

interface SceneViewportProps {
  workspacePath?: string;
  isEntering?: boolean;
  paned?: boolean;
}

const SceneViewport: React.FC<SceneViewportProps> = ({ workspacePath, isEntering = false, paned = false }) => {
  const {
    openTabs,
    activeTabId,
    navigationMotion,
    navigationSequence,
    paneSelections,
  } = useSceneManager();
  const { t } = useI18n('common');
  const resources = useContentResourceStore(state => state.resources);
  const pane = useSessionPaneLayout();
  const primaryTabId = paned ? selectedScene(paneSelections.primary) : activeTabId;
  const secondaryTabId = paned ? selectedScene(paneSelections.secondary) : null;
  const activeRenderedSceneId: RenderedSceneId | null = primaryTabId ? getSceneViewId(primaryTabId)
    : paned && paneSelections.primary.kind === 'canvas' ? null : EMPTY_SCENE_ID;
  const secondarySceneId = secondaryTabId ? getSceneViewId(secondaryTabId) : null;
  const primaryTransition = useSceneTransition(activeRenderedSceneId, navigationMotion, navigationSequence);
  const secondaryTransition = useSceneTransition(secondarySceneId, navigationMotion, navigationSequence);
  const pendingTransition = primaryTransition.pendingTransition;
  useDialogCompletionNotify();
  const renderedTabIds: RenderedSceneId[] = [...new Set(openTabs.map(tab => getSceneViewId(tab.id)))];
  for (const resource of Object.values(resources)) {
    const id: SceneTabId = `content:${resource.id}`;
    if (resource.target.kind === 'file' && !renderedTabIds.includes(id)) renderedTabIds.push(id);
  }
  if (activeRenderedSceneId === EMPTY_SCENE_ID) renderedTabIds.push(EMPTY_SCENE_ID);
  for (const transition of [primaryTransition, secondaryTransition]) {
    if (transition.outgoingTabId && !renderedTabIds.includes(transition.outgoingTabId)) renderedTabIds.push(transition.outgoingTabId);
  }

  return (
    <div
      className={`openbitfun-scene-viewport${paned ? ' openbitfun-scene-viewport--paned' : ''}`}
      data-testid="scene-viewport"
      data-openbitfun-scene="workbench"
      data-openbitfun-part="viewport"
      data-openbitfun-state={activeRenderedSceneId === EMPTY_SCENE_ID ? 'empty' : undefined}
    >
      <div
        className="openbitfun-scene-viewport__clip"
        data-testid="scene-viewport-clip"
        data-scene-motion-phase={pendingTransition?.phase}
        data-openbitfun-scene="workbench"
        data-openbitfun-part="viewportClip"
      >
        {renderedTabIds.map(tabId => {
          const isEmpty = tabId === EMPTY_SCENE_ID;
          const isSecondary = tabId === secondarySceneId || (tabId !== activeRenderedSceneId && (
            tabId === secondaryTransition.outgoingTabId || openTabs.some(tab => getSceneViewId(tab.id) === tabId && tabPane(tab) === 'secondary')));
          const location = paned && isSecondary ? 'secondary' : 'primary';
          const selectedId = location === 'secondary' ? secondarySceneId : activeRenderedSceneId;
          const transition = location === 'secondary' ? secondaryTransition : primaryTransition;
          const paneVisible = !paned || (location === 'secondary' ? pane.mode !== 'chat-only' : pane.mode !== 'content-only');
          const isActive = tabId === selectedId && paneVisible;
          const isOutgoing = !isActive && tabId === transition.outgoingTabId;
          const isIncoming = isActive && transition.pendingTransition?.incomingTabId === tabId;
          const isVisible = paneVisible && (transition.pendingTransition?.phase === 'holding' && transition.outgoingTabId
            ? isOutgoing : isActive);
          const Host: React.ElementType = paned ? SplitViewSurface : 'div';
          const focusScene = () => {
            if (isActive) useSceneStore.getState().focusPane(location);
          };
          return (
            <Host
              key={tabId}
              {...(paned ? { pane: location, active: isVisible } : {})}
              onPointerDownCapture={paned ? focusScene : undefined}
              onFocusCapture={paned ? focusScene : undefined}
              className={[
                'openbitfun-scene-viewport__scene',
                isEmpty && 'openbitfun-scene-viewport__scene--empty',
                isActive && 'openbitfun-scene-viewport__scene--active',
                isVisible && 'openbitfun-scene-viewport__scene--visible',
                isIncoming && 'openbitfun-scene-viewport__scene--incoming',
                isOutgoing && 'openbitfun-scene-viewport__scene--outgoing',
              ].filter(Boolean).join(' ')}
              aria-hidden={!isActive || !isVisible}
              {...(!isActive || !isVisible ? { inert: '' } : {})}
              data-testid="scene-viewport-scene"
              data-scene-id={tabId}
              data-pane-motion-phase={transition.pendingTransition?.phase}
              data-shortcut-scope={String(tabId).startsWith('content:') ? 'workbench-content' : undefined}
              data-scene-active={isActive ? 'true' : 'false'}
              data-openbitfun-scene="workbench"
              data-openbitfun-part="scene"
              data-openbitfun-scene-id={isEmpty ? 'welcome' : tabId.startsWith('content:') ? 'content' : tabId.startsWith('miniapp:') ? 'miniapp' : tabId}
              data-openbitfun-state={[
                isActive && 'active',
                isEmpty && 'empty',
              ].filter(Boolean).join(' ') || undefined}
            >
              {isEmpty ? (
                <div
                  className="openbitfun-scene-viewport__empty"
                  data-testid="scene-viewport-empty"
                  data-openbitfun-scene="workbench"
                  data-openbitfun-part="empty"
                  data-openbitfun-state="empty"
                >
                  <WelcomeScene />
                </div>
              ) : (
                <Suspense
                  fallback={
                    isActive ? (
                      <div
                        className="openbitfun-scene-viewport__lazy-fallback"
                        role="status"
                        aria-busy="true"
                        aria-label={t('loading.scenes')}
                        data-openbitfun-scene="workbench"
                        data-openbitfun-part="loading"
                      >
                        <Spinner size="md" />
                      </div>
                    ) : null
                  }
                >
                  <SceneReadyBoundary sceneId={tabId} onReady={transition.markSceneReady}>
                    {renderScene(tabId, workspacePath, isEntering, isActive)}
                  </SceneReadyBoundary>
                </Suspense>
              )}
            </Host>
          );
        })}
      </div>
    </div>
  );
};

function useSceneTransition(activeRenderedSceneId: RenderedSceneId | null,
  navigationMotion: string, navigationSequence: number) {
  const [transition, setTransition] = useState<SceneTransition | null>(null);
  const [readyVersion, setReadyVersion] = useState(0);
  const readySceneIdsRef = useRef<Set<RenderedSceneId>>(new Set([EMPTY_SCENE_ID]));
  const previousActiveTabIdRef = useRef<RenderedSceneId | null>(activeRenderedSceneId);

  const markSceneReady = useCallback((sceneId: SceneTabId) => {
    if (readySceneIdsRef.current.has(sceneId)) return;
    readySceneIdsRef.current.add(sceneId);
    setReadyVersion(version => version + 1);
  }, []);

  // Derive the outgoing id during render as well as from state. Pointer
  // navigation keeps that scene as the only visible surface until the target
  // has resolved through Suspense, then swaps atomically to the incoming scene.
  const activeSceneChanged = previousActiveTabIdRef.current !== activeRenderedSceneId;
  const pendingTransition: SceneTransition | null = activeSceneChanged
    && navigationMotion === 'pointer'
    ? {
        outgoingTabId: previousActiveTabIdRef.current,
        incomingTabId: activeRenderedSceneId,
        phase: 'holding',
      }
    : activeSceneChanged
      ? null
      : transition;
  const outgoingTabId = pendingTransition?.outgoingTabId ?? null;
  useLayoutEffect(() => {
    const previousActiveTabId = previousActiveTabIdRef.current;
    previousActiveTabIdRef.current = activeRenderedSceneId;

    if (previousActiveTabId === activeRenderedSceneId) {
      return;
    }

    if (navigationMotion !== 'pointer') {
      setTransition(null);
      return;
    }

    setTransition({
      outgoingTabId: previousActiveTabId,
      incomingTabId: activeRenderedSceneId,
      phase: (!activeRenderedSceneId || readySceneIdsRef.current.has(activeRenderedSceneId)) ? 'preparing' : 'holding',
    });
  }, [activeRenderedSceneId, navigationMotion, navigationSequence]);

  useLayoutEffect(() => {
    if (
      transition?.phase !== 'holding'
      || transition.incomingTabId !== null && !readySceneIdsRef.current.has(transition.incomingTabId)
    ) {
      return;
    }

    setTransition(current => (
      current?.incomingTabId === transition.incomingTabId
        ? { ...current, phase: 'preparing' }
        : current
    ));
  }, [readyVersion, transition]);

  useEffect(() => {
    if (transition?.phase !== 'preparing') return;

    const preparedTransition = transition;
    let runningFrame: number | null = null;
    const preparationFrame = window.requestAnimationFrame(() => {
      runningFrame = window.requestAnimationFrame(() => {
        setTransition(current => (
          current === preparedTransition
            ? { ...current, phase: 'running' }
            : current
        ));
      });
    });

    return () => {
      window.cancelAnimationFrame(preparationFrame);
      if (runningFrame !== null) {
        window.cancelAnimationFrame(runningFrame);
      }
    };
  }, [transition]);

  useEffect(() => {
    if (transition?.phase !== 'running') return;

    const completedTransition = transition;
    const entryTimer = window.setTimeout(() => {
      setTransition(current => (
        current === completedTransition ? null : current
      ));
    }, SCENE_ENTRY_DURATION_MS);

    return () => window.clearTimeout(entryTimer);
  }, [transition]);

  return { pendingTransition, outgoingTabId, markSceneReady };
}

function renderScene(
  id: SceneTabId,
  workspacePath?: string,
  isEntering?: boolean,
  isActive: boolean = false
) {
  switch (id) {
    case 'session':
      return <SessionScene workspacePath={workspacePath} isEntering={isEntering} isActive={isActive} />;
    case 'terminal':
      return <TerminalScene isActive={isActive} />;
    case 'git':
      return <GitScene workspacePath={workspacePath} isActive={isActive} />;
    case 'settings':
      return <SettingsScene isActive={isActive} />;
    case 'profile':
      return <ProfileScene />;
    case 'personal-overview':
      return <PersonalOverviewScene isActive={isActive} />;
    case 'agents':
      return <AgentsScene />;
    case 'skills':
      return <SkillsScene />;
    case 'ecosystem-compatibility':
      return <EcosystemCompatibilityScene />;
    case 'miniapps':
      return <MiniAppGalleryScene />;
    case 'pages':
      return <PagesScene isActive={isActive} />;
    case 'browser':
      return <BrowserScene />;
    case 'assistant':
      return <AssistantScene />;
    case 'todos':
      return <TodosScene />;
    case 'insights':
      return <InsightsScene />;
    case 'shell':
      return <ShellScene isActive={isActive} />;
    default:
      if (id.startsWith('content:')) {
        return <ContentResourceView resourceId={id.slice('content:'.length)} isActive={isActive} />;
      }
      if (typeof id === 'string' && id.startsWith('miniapp:')) {
        return <MiniAppScene appId={id.slice('miniapp:'.length)} />;
      }
      return null;
  }
}

export default SceneViewport;
