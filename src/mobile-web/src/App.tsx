import React, { Suspense, lazy, useState, useCallback, useRef, useEffect } from 'react';
import { MobileBanner, MobileButton, MobileScrim, MobileStatus } from '@openbitfun/ui/mobile';
import PairingPage, { type BrowserAccountBinding } from './pages/PairingPage';
import WorkspacePage from './pages/WorkspacePage';
import DeviceToolsPage from './pages/DeviceToolsPage';
import SessionListPage from './pages/SessionListPage';
import DevicesPage from './pages/DevicesPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider, useI18n } from './i18n';
import { RelayHttpClient } from './services/RelayHttpClient';
import {
  RemoteSessionManager,
} from './services/RemoteSessionManager';
import { reconcileAccountOwner } from './services/accountOwner';
import { BrowserAccountStorageError, releaseBrowserAccount } from './services/BrowserAccountStore';
import { CloudAccountClient } from './services/CloudAccountClient';
import {
  clearMobileNavigation,
  saveMobileNavigation,
  type PairedNavigation,
} from './services/MobileNavigationStore';
import { ThemeProvider } from './theme';
import { useConnectionHealth } from './hooks/useConnectionHealth';
import { useMobileViewport } from './hooks/useMobileViewport';
import { useWideLayout } from './hooks/useWideLayout';
import { useMobileStore } from './services/store';
import RemoteHomePanel from './components/RemoteHomePanel';
import './styles/index.scss';

type Page = 'pairing' | 'workspace' | 'sessions' | 'chat' | 'devices';
type NavDirection = 'push' | 'pop' | null;

const NAV_DURATION = 300;
const ChatPage = lazy(() => import('./pages/ChatPage'));

function getNavClass(
  targetPage: Page,
  currentPage: Page,
  navDir: NavDirection,
  isAnimating: boolean,
): string {
  if (!isAnimating) return '';
  const isEntering = currentPage === targetPage;
  if (isEntering) {
    return navDir === 'push' ? 'nav-push-enter' : 'nav-pop-enter';
  }
  return navDir === 'push' ? 'nav-push-exit' : 'nav-pop-exit';
}

const AppContent: React.FC = () => {
  useMobileViewport();
  const { t } = useI18n();
  const [page, setPage] = useState<Page>('pairing');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSessionName, setActiveSessionName] = useState<string>('Session');
  const [activeSessionAgentType, setActiveSessionAgentType] = useState('Standard');
  const [chatAutoFocus, setChatAutoFocus] = useState(false);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const isWideLayout = useWideLayout();
  const connectionHealth = useMobileStore((state) => state.connectionHealth);
  const clientRef = useRef<RelayHttpClient | null>(null);
  const accountOwnerUnlistenRef = useRef<(() => void) | null>(null);
  const sessionMgrRef = useRef<RemoteSessionManager | null>(null);
  const [sessionMgr, setSessionMgr] = useState<RemoteSessionManager | null>(null);
  const [accountDirectoryOpen, setAccountDirectoryOpen] = useState(false);
  const [preferredDeviceId, setPreferredDeviceId] = useState<string | undefined>();
  const navigationRef = useRef<PairedNavigation | null>(null);
  const accountBindingRef = useRef<BrowserAccountBinding | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [automaticDeviceSelection, setAutomaticDeviceSelection] = useState(true);
  const controlTarget = useMobileStore((state) => state.controlTarget);

  // An authenticated account without a selected desktop has nothing to ping.
  useConnectionHealth(accountDirectoryOpen ? null : sessionMgr);

  const [navDir, setNavDir] = useState<NavDirection>(null);
  const [prevPage, setPrevPage] = useState<Page | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Track the page stack for browser history integration.
  // When user triggers browser back (phone back button / edge swipe),
  // we intercept popstate and perform in-app navigation instead.
  const pageStackRef = useRef<Page[]>(['pairing']);
  const isPopstateNavRef = useRef(false);

  const navigateTo = useCallback((target: Page, direction: NavDirection) => {
    setPage(prev => {
      setPrevPage(prev);
      return target;
    });
    setNavDir(direction);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setPrevPage(null);
      setNavDir(null);
    }, NAV_DURATION);

    if (direction === 'push') {
      pageStackRef.current = [...pageStackRef.current, target];
      if (!isPopstateNavRef.current) {
        history.pushState({ page: target }, '');
      }
    } else if (direction === 'pop') {
      pageStackRef.current = pageStackRef.current.slice(0, -1);
      if (!isPopstateNavRef.current) {
        history.back();
      }
    }
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Open external links in a new tab from anywhere in the app.
  useEffect(() => {
    const handleLinkClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a') as HTMLAnchorElement | null;
      
      if (link && link.href) {
        const href = link.href;
        // Treat all http(s) links as external for the mobile web shell.
        if (href.startsWith('http://') || href.startsWith('https://')) {
          e.preventDefault();
          e.stopPropagation();
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      }
    };
    
    // Capture link clicks before nested content handles them.
    document.addEventListener('click', handleLinkClick, true);
    
    return () => {
      document.removeEventListener('click', handleLinkClick, true);
    };
  }, []);

  const handlePaired = useCallback(
    (
      client: RelayHttpClient,
      sessionMgr: RemoteSessionManager,
      preferredDeviceId?: string,
      navigation?: PairedNavigation,
      account?: BrowserAccountBinding,
    ) => {
      accountBindingRef.current = account ?? null;
      setAccountError(null);
      setAutomaticDeviceSelection(!navigation?.restored?.disconnected);
      navigationRef.current = navigation ?? null;
      const needsDevice = client.hasAccountIdentity && !client.targetDeviceId;
      setAccountDirectoryOpen(needsDevice);
      setPreferredDeviceId(preferredDeviceId);
      accountOwnerUnlistenRef.current?.();
      clientRef.current = client;
      accountOwnerUnlistenRef.current = client.onAccountOwnerChange((change) => {
        if (clientRef.current !== client) return;
        const ownerScopedStateWasReset = reconcileAccountOwner(change);
        if (!ownerScopedStateWasReset) return;
        navigationRef.current = null;

        // A detail page can retain local IDs in addition to Zustand state.
        // Return to the session root before any stale completion can render
        // data from the replacement account.
        clearTimeout(timerRef.current);
        setActiveSessionId(null);
        setActiveSessionName('Session');
        setActiveSessionAgentType('Standard');
        setChatAutoFocus(false);
        setPrevPage(null);
        setNavDir(null);
        pageStackRef.current = ['pairing', 'sessions'];
        history.replaceState({ page: 'sessions' }, '');
        setPage('sessions');
      }, { emitCurrent: true });
      sessionMgrRef.current = sessionMgr;
      setSessionMgr(sessionMgr);
      const landingPage = needsDevice ? 'devices' : 'sessions';
      pageStackRef.current = ['pairing', landingPage];
      history.pushState({ page: landingPage }, '');
      setPage(landingPage);
      setCompactSidebarOpen(false);
    },
    [],
  );

  // Pop navigation handlers that can be called from both UI buttons and popstate
  const doPopFromChat = useCallback(() => {
    navigateTo('sessions', 'pop');
    setTimeout(() => setActiveSessionId(null), NAV_DURATION);
  }, [navigateTo]);

  const doPopFromWorkspace = useCallback(() => {
    navigateTo('sessions', 'pop');
  }, [navigateTo]);

  const doPopFromDevices = useCallback(() => {
    navigateTo('sessions', 'pop');
  }, [navigateTo]);

  useEffect(() => {
    const onPopState = () => {
      const stack = pageStackRef.current;
      const currentPage = stack[stack.length - 1];

      if (accountDirectoryOpen || currentPage === 'pairing' || currentPage === 'sessions') {
        // At the root-level pages: re-push a history entry so the user
        // can't accidentally close the app with another back gesture.
        history.pushState({ page: currentPage }, '');
        return;
      }

      isPopstateNavRef.current = true;
      try {
        if (currentPage === 'chat') {
          doPopFromChat();
        } else if (currentPage === 'workspace') {
          doPopFromWorkspace();
        } else if (currentPage === 'devices') {
          doPopFromDevices();
        }
      } finally {
        isPopstateNavRef.current = false;
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [accountDirectoryOpen, doPopFromChat, doPopFromWorkspace, doPopFromDevices]);

  const [deviceToolsOpen, setDeviceToolsOpen] = useState(false);
  const handleOpenDeviceTools = useCallback(() => {
    setDeviceToolsOpen(true);
    setCompactSidebarOpen(false);
    navigateTo('workspace', 'push');
  }, [navigateTo]);

  const handleOpenWorkspace = useCallback(() => {
    setDeviceToolsOpen(false);
    setCompactSidebarOpen(false);
    navigateTo('workspace', 'push');
  }, [navigateTo]);

  const handleWorkspaceReady = useCallback(() => {
    navigateTo('sessions', 'pop');
  }, [navigateTo]);

  const handleSelectSession = useCallback((
    sessionId: string,
    sessionName?: string,
    isNew?: boolean,
    agentType = 'Standard',
  ) => {
    useMobileStore.getState().setError(null);
    setActiveSessionId(sessionId);
    setActiveSessionName(sessionName || 'Session');
    setActiveSessionAgentType(agentType);
    setChatAutoFocus(!!isNew);
    setCompactSidebarOpen(false);
    if (isWideLayout) {
      clearTimeout(timerRef.current);
      setPrevPage(null);
      setNavDir(null);
      if (page !== 'chat') {
        pageStackRef.current = [...pageStackRef.current.filter((entry) => entry !== 'chat'), 'chat'];
        history.pushState({ page: 'chat' }, '');
      }
      setPage('chat');
      return;
    }
    navigateTo('chat', 'push');
  }, [isWideLayout, navigateTo, page]);

  const handleBackToSessions = useCallback(() => {
    navigateTo('sessions', 'pop');
    setTimeout(() => setActiveSessionId(null), NAV_DURATION);
  }, [navigateTo]);

  const handleControlTargetChanged = useCallback(() => {
    setDeviceToolsOpen(false);
    setAccountDirectoryOpen(false);
    clearTimeout(timerRef.current);
    const restored = navigationRef.current?.restored;
    if (navigationRef.current) navigationRef.current.restored = null;
    if (restored && restored.deviceId === clientRef.current?.targetDeviceId && restored.session) {
      setActiveSessionId(restored.session.id);
      setActiveSessionName(restored.session.name);
      setActiveSessionAgentType(restored.session.agentType);
      setChatAutoFocus(false);
      setPrevPage(null);
      setNavDir(null);
      pageStackRef.current = ['pairing', 'sessions', 'chat'];
      history.replaceState({ page: 'chat' }, '');
      setPage('chat');
      setCompactSidebarOpen(false);
      return;
    }
    setActiveSessionId(null);
    setActiveSessionName('Session');
    setActiveSessionAgentType('Standard');
    setChatAutoFocus(false);
    setPrevPage(null);
    setNavDir(null);
    pageStackRef.current = ['pairing', 'sessions'];
    history.replaceState({ page: 'sessions' }, '');
    setPage('sessions');
    setCompactSidebarOpen(true);
  }, []);

  const resetAccount = useCallback((clearNavigation = false) => {
    navigationRef.current = null;
    accountBindingRef.current = null;
    if (clearNavigation) clearMobileNavigation();
    setAccountError(null);
    setAccountDirectoryOpen(false);
    setPreferredDeviceId(undefined);
    accountOwnerUnlistenRef.current?.();
    accountOwnerUnlistenRef.current = null;
    clientRef.current?.resetConnectionIdentity();
    clientRef.current = null;
    sessionMgrRef.current = null;
    setSessionMgr(null);
    setActiveSessionId(null);
    setActiveSessionName('Session');
    setActiveSessionAgentType('Standard');
    setChatAutoFocus(false);
    setCompactSidebarOpen(false);
    setPrevPage(null);
    setNavDir(null);
    clearTimeout(timerRef.current);
    useMobileStore.getState().resetConnectionState();
    pageStackRef.current = ['pairing'];
    history.replaceState({ page: 'pairing' }, '');
    setPage('pairing');
  }, []);

  const handleAccountStorageError = useCallback((error: unknown) => {
    setAccountError(t(error instanceof BrowserAccountStorageError && error.reason === 'invalid'
      ? 'pairing.browserStorageInvalid' : 'pairing.browserStorageUnavailable'));
  }, [t]);

  useEffect(() => {
    const binding = accountBindingRef.current;
    const client = clientRef.current;
    if (!sessionMgr || !binding || !client) return;
    let disposed = false;
    let generation = 0;
    const synchronize = async () => {
      const request = ++generation;
      try {
        const saved = await binding.store.read();
        try {
          if (disposed || request !== generation || clientRef.current !== client) return;
          if (saved.session?.token !== binding.token || saved.controllerDeviceId !== client.controllerDeviceId) {
            const clearNavigation = saved.lastChange !== 'expired' && saved.session?.userId !== client.accountUserId;
            resetAccount(clearNavigation);
          } else setAccountError(null);
        } finally { releaseBrowserAccount(saved); }
      } catch (error) {
        if (!disposed && request === generation) handleAccountStorageError(error);
      }
    };
    const unsubscribe = binding.store.subscribe(() => { void synchronize(); });
    const unlistenExpired = client.onAuthorizationExpired(token => {
      void binding.store.clearSession(token, 'expired').then(synchronize).catch(error => {
        if (!disposed) handleAccountStorageError(error);
      });
    });
    // Also close the gap between initial restoration and mounting this observer.
    void synchronize();
    return () => { disposed = true; unsubscribe(); unlistenExpired(); };
  }, [sessionMgr, resetAccount, handleAccountStorageError]);

  const handleSignOut = useCallback(async () => {
    const binding = accountBindingRef.current;
    if (!binding) { resetAccount(true); return; }
    try {
      await binding.store.clearSession(binding.token, 'signed-out');
      if (accountBindingRef.current === binding) resetAccount(true);
      void new CloudAccountClient(binding.store.relayUrl).logout(binding.token).catch(() => {
        console.warn('Could not revoke the signed-out browser token');
      });
    } catch (error) { handleAccountStorageError(error); }
  }, [resetAccount, handleAccountStorageError]);

  const handleDisconnect = useCallback(() => {
    // Disconnect this tab's target, retaining the browser account and other
    // tabs' connections. The directory must wait for explicit selection here.
    const deviceId = clientRef.current?.targetDeviceId;
    if (navigationRef.current && deviceId) {
      saveMobileNavigation(navigationRef.current.scope, { deviceId, disconnected: true });
    }
    if (navigationRef.current) navigationRef.current.restored = null;
    clientRef.current?.setTargetDeviceId(null);
    useMobileStore.getState().resetForDeviceSwitch();
    useMobileStore.getState().setControlTarget(null);
    setAutomaticDeviceSelection(false);
    setPreferredDeviceId(undefined);
    setAccountDirectoryOpen(true);
    setActiveSessionId(null);
    setActiveSessionName('Session');
    setActiveSessionAgentType('Standard');
    setChatAutoFocus(false);
    setCompactSidebarOpen(false);
    setPrevPage(null);
    setNavDir(null);
    clearTimeout(timerRef.current);
    pageStackRef.current = ['pairing', 'devices'];
    history.replaceState({ page: 'devices' }, '');
    setPage('devices');
  }, []);

  useEffect(() => () => {
    accountOwnerUnlistenRef.current?.();
    accountOwnerUnlistenRef.current = null;
  }, []);

  useEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation || accountDirectoryOpen || page === 'pairing' || !controlTarget
      || controlTarget.deviceId !== clientRef.current?.targetDeviceId) return;
    saveMobileNavigation(navigation.scope, {
      deviceId: controlTarget.deviceId,
      session: page === 'chat' && activeSessionId ? {
        id: activeSessionId,
        name: activeSessionName,
        agentType: activeSessionAgentType,
      } : undefined,
    });
  }, [accountDirectoryOpen, activeSessionAgentType, activeSessionId, activeSessionName, controlTarget, page]);

  const isAnimating = navDir !== null;
  const currentPage: Page = page;


  const renderSessionList = () => sessionMgrRef.current && (
    <SessionListPage
      sessionMgr={sessionMgrRef.current}
      client={clientRef.current ?? undefined}
      compact
      activeSessionId={activeSessionId}
      onSelectSession={handleSelectSession}
      onOpenWorkspace={handleOpenWorkspace}
      onOpenDeviceTools={handleOpenDeviceTools}
      onDisconnect={handleDisconnect}
      onOpenDevices={() => navigateTo('devices', 'push')}
      onControlTargetChanged={handleControlTargetChanged}
    />
  );

  const renderDetailPage = () => {
    if (currentPage === 'workspace' && sessionMgrRef.current) {
      if (deviceToolsOpen) return <DeviceToolsPage manager={sessionMgrRef.current} onBack={doPopFromWorkspace}/>;
      return (
        <WorkspacePage
          sessionMgr={sessionMgrRef.current}
          onReady={handleWorkspaceReady}
          onBack={doPopFromWorkspace}
        />
      );
    }
    if (currentPage === 'devices' && clientRef.current) {
      return <DevicesPage client={clientRef.current} onBack={doPopFromDevices} onSignOut={() => void handleSignOut()} />;
    }
    if (currentPage === 'chat' && sessionMgrRef.current && activeSessionId) {
      return (
        <Suspense fallback={<div className="chat-page"><MobileStatus className="chat-page__hydrate" loading title={t('chat.loadingSession')} /></div>}>
          <ChatPage
            sessionMgr={sessionMgrRef.current}
            key={activeSessionId}
            sessionId={activeSessionId}
            sessionName={activeSessionName}
            agentType={activeSessionAgentType}
            onBack={isWideLayout ? handleBackToSessions : () => setCompactSidebarOpen(true)}
            autoFocus={chatAutoFocus}
            wideLayout={isWideLayout}
          />
        </Suspense>
      );
    }
    return (
      <RemoteHomePanel
        onOpenSidebar={isWideLayout ? undefined : () => setCompactSidebarOpen(true)}
      />
    );
  };

  return (
    <div className="mobile-app" data-layout={isWideLayout ? 'wide' : 'compact'}>
      {accountError && <MobileBanner tone="danger">{accountError}</MobileBanner>}
      {connectionHealth === 'unreachable' && page !== 'pairing' && (
        <MobileBanner
          action={<MobileButton appearance="plain" onClick={handleDisconnect} size="sm">{t('sessions.repair')}</MobileButton>}
          className="mobile-reconnect-banner"
          tone="danger"
        >
          <span className="mobile-reconnect-spinner" />
          <span>{t('sessions.reconnecting')}</span>
        </MobileBanner>
      )}
      {page === 'pairing' && <PairingPage onPaired={handlePaired} />}
      {accountDirectoryOpen && clientRef.current && (
        <DevicesPage
          client={clientRef.current}
          accountLanding
          autoSelect={automaticDeviceSelection}
          preferredDeviceId={preferredDeviceId}
          onBack={() => void handleSignOut()}
          onDeviceSelected={handleControlTargetChanged}
        />
      )}
      {!accountDirectoryOpen && page !== 'pairing' && sessionMgrRef.current && (
        <div className={isWideLayout ? 'remote-shell remote-shell--wide' : `nav-page compact-remote-shell${compactSidebarOpen ? ' is-sidebar-open' : ''}`}>
          <aside
            className={isWideLayout ? 'remote-shell__master' : 'compact-remote-shell__sidebar'}
            aria-label={t('sessions.sessionHistory')}
            aria-hidden={!isWideLayout && !compactSidebarOpen || undefined}
            ref={(node) => { if (node) node.inert = !isWideLayout && !compactSidebarOpen; }}
          >
            {renderSessionList()}
          </aside>
          <MobileScrim
            className="compact-remote-shell__scrim"
            hidden={isWideLayout || !compactSidebarOpen}
            aria-label={t('common.close')}
            onClick={() => setCompactSidebarOpen(false)}
          />
          <section className={isWideLayout ? 'remote-shell__detail' : `compact-remote-shell__main ${getNavClass(currentPage, currentPage, navDir, isAnimating && currentPage !== prevPage)}`}>
            {renderDetailPage()}
          </section>
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => (
  <ThemeProvider>
    <ErrorBoundary>
      <I18nProvider>
        <AppContent />
      </I18nProvider>
    </ErrorBoundary>
  </ThemeProvider>
);

export default App;
