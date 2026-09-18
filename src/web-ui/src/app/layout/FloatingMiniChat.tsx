/** Modeless host of references to Runtime-owned conversations. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUpRight, Minus, Phone, PhoneOff, X } from 'lucide-react';
import { IconButton, LauncherButton, OverflowText, TabGroup, Button } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceId, getActiveSurfaceScope, onSurfaceActivated, isSurfaceChangedError } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import { FLOWCHAT_FOCUS_ITEM_EVENT, type FlowChatFocusItemRequest } from '@/flow_chat/events/flowchatNavigation';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { createControlConversation, ensureControlConversation, replayVoiceExchanges } from '@/flow_chat/services/controlConversation';
import ChatPane from '@/app/scenes/session/ChatPane';
import type { ChatInputRegistration } from '@/flow_chat/components/chatInputRegistration';
import { ConversationModeSurface } from '@/flow_chat/components/voice/ConversationModeSurface';
import { ControlConversation } from '@/flow_chat/components/voice/ControlConversation';
import { ConversationViewProvider } from '@/flow_chat/contexts/ConversationViewProvider';
import { useRealtimeVoiceCall } from '@/flow_chat/components/voice/RealtimeVoiceCallContext';
import type { VoiceCallTarget } from '@/flow_chat/components/voice/voiceClientContext';
import { useConversationDockStore, dockConversationKey, type DockConversation } from '../stores/conversationDockStore';
import { beginConversationTransfer, endConversationTransfer, isConversationTransfer, dropConversationInDock, returnConversationToWorkbench } from '../services/conversationDockTransfer';
import { sessionSceneWorkspaceKey } from '../services/sessionSceneTarget';
import { useMiniAppStore, MINIAPP_COMPOSER_DRAFT_EVENT, MINIAPP_COMPOSER_FOCUS_EVENT, type MiniAppDraftEventDetail, type MiniAppFocusEventDetail } from '../scenes/miniapps/miniAppStore';
import { useSceneStore } from '../stores/sceneStore';
import { getMiniAppIdFromSceneId, getMiniAppSceneId } from '../scenes/miniapps/miniAppActivity';
import { followMiniAppConversation, openMiniAppConversation, openMiniAppFromConversation, resolveMiniAppConversation, syncMiniAppConversations } from '../scenes/miniapps/miniAppConversation';
import { postMiniAppComposerMessage } from '../scenes/miniapps/miniAppComposerMessages';
import { pickLocalizedString } from '../scenes/miniapps/utils/pickLocalizedString';
import { resolveDisplayTitle } from '@/flow_chat/components/session-menu/useFlowChatSessions';
import MiniAppBubbleWelcome from './MiniAppBubbleWelcome';
import { createLogger } from '@/shared/utils/logger';
import './FloatingMiniChat.scss';
const log = createLogger('ConversationDock');

const subscribeSurface = (listener: () => void) => onSurfaceActivated(listener);
const subscribeSessions = (listener: () => void) => flowChatStore.subscribe(listener);
const sessionSnapshot = () => flowChatStore.getState();

function DockConversationView({ entry, active, onCollapse, renderHeader, onVoiceViewChange }: { entry: DockConversation; active: boolean; onCollapse: () => void; renderHeader: (modeSwitch: ReactNode) => ReactNode; onVoiceViewChange: (key: string, visible: boolean) => void }) {
  const { t, i18n } = useI18n('flow-chat');
  const state = useSyncExternalStore(subscribeSessions, sessionSnapshot);
  const session = state.sessions.get(entry.sessionId);
  const claim = useMiniAppStore(s => entry.appId ? s.composerClaims[entry.appId] : undefined);
  const app = useMiniAppStore(s => s.apps.find(candidate => candidate.id === entry.appId));
  const claimValid = entry.kind !== 'miniapp' || claim?.surfaceId === entry.surfaceId && claim?.token === entry.claimToken && claim?.sessionId === entry.sessionId;
  const key = dockConversationKey(entry);
  const reportVoiceView = useCallback((visible: boolean) => onVoiceViewChange(key, visible), [key, onVoiceViewChange]);
  const newControlConversation = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    if (scope.surfaceId !== entry.surfaceId) return;
    const result = await createControlConversation(entry.sessionId);
    scope.assertCurrent('open new control conversation');
    useConversationDockStore.getState().add({ ...result, surfaceId: entry.surfaceId, workspaceKey: sessionSceneWorkspaceKey(result.workspaceId), kind: 'control' });
  }, [entry.surfaceId, entry.sessionId]);
  const draft = useConversationDockStore(state => state.drafts[key]);
  const setDraft = (text: string) => useConversationDockStore.getState().setDraft(key, text);
  const appName = app ? pickLocalizedString(app, i18n.language, 'name') || app.name : entry.appId ?? '';
  const registration = useMemo<ChatInputRegistration | undefined>(() => entry.kind !== 'miniapp' ? undefined : ({
    registrationId: entry.claimToken!,
    workspacePath: session?.workspacePath || '',
    remoteConnectionId: session?.remoteConnectionId || session?.config.remoteConnectionId,
    placeholder: claim?.customization?.composer?.placeholder || claim?.placeholder || t('miniAppComposer.placeholder', { app: appName }),
    draft,
    onDraftConsumed: id => useConversationDockStore.getState().consumeDraft(key, id),
    onSubmit: submission => {
      const live = useMiniAppStore.getState().composerClaims[entry.appId!];
      if (getActiveSurfaceId() !== entry.surfaceId || live?.surfaceId !== entry.surfaceId
        || live?.token !== entry.claimToken || live.sessionId !== entry.sessionId) throw new Error('The MiniApp no longer owns this conversation');
      postMiniAppComposerMessage({ ...submission, token: entry.claimToken!, sessionId: entry.sessionId });
    },
  }), [appName, claim, draft, entry, session, t, key]);
  const voiceTarget = useMemo<VoiceCallTarget | undefined>(() => !session ? undefined : entry.kind === 'miniapp' ? {
    kind: 'miniapp', appId: entry.appId!, appName, claimToken: entry.claimToken!, surfaceId: entry.surfaceId,
    sessionId: entry.sessionId, workspacePath: session.workspacePath,
  } : { kind: entry.kind, surfaceId: entry.surfaceId, sessionId: entry.sessionId,
    workspaceId: session.workspaceId ?? session.config.workspaceId, workspacePath: session.workspacePath || '' }, [entry, session, appName]);
  const unavailable = <div className="openbitfun-fmc__miniapp-session-pending" role="status"
    data-openbitfun-component="floating-mini-chat" data-openbitfun-part="pending">{t('dock.unavailable')}</div>;
  if (entry.kind === 'control' && session && voiceTarget) return <ConversationViewProvider
    scope={{ ...entry, viewId: key, presentation: 'compact' }}>
    <ControlConversation session={session} sessionRef={entry} voiceTarget={voiceTarget} active={active}
      renderHeader={renderHeader} onClose={onCollapse} onVoiceViewChange={reportVoiceView} onNewConversation={newControlConversation} />
  </ConversationViewProvider>;
  return <ConversationModeSurface voiceTarget={voiceTarget} voiceStartDisabled={!voiceTarget || !claimValid} onCloseVoice={onCollapse}
    renderHeader={renderHeader} onVoiceViewChange={reportVoiceView} switchTestId="hello-realtime-voice-mode-switch">
    {!session || !claimValid ? unavailable : <ChatPane sessionRef={entry} viewId={dockConversationKey(entry)} presentation="compact" width={0} isFullscreen={false}
      isSceneActive={active} workspacePath={session.workspacePath} showChatInput chatInputRegistration={registration}
      emptyState={<MiniAppBubbleWelcome
        appName={entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp' ? appName : resolveDisplayTitle(session)}
        appDescription={entry.kind === 'control' ? t('dock.welcome') : app ? pickLocalizedString(app, i18n.language, 'description') : undefined}
        appIcon={app?.icon} showIcon={entry.kind === 'miniapp'} customization={claim?.customization}
        onSuggestion={setDraft}
      />}
    />}
  </ConversationModeSurface>;
}

export function FloatingMiniChat() {
  const { t, i18n } = useI18n('flow-chat');
  const { t: tv } = useI18n('settings/voice-input');
  const surfaceId = useSyncExternalStore(subscribeSurface, getActiveSurfaceId);
  const dock = useConversationDockStore();
  const claims = useMiniAppStore(s => s.composerClaims);
  const apps = useMiniAppStore(s => s.apps);
  const activeSceneId = useSceneStore(s => s.activeTabId);
  const openScenes = useSceneStore(s => s.openTabs);
  const activeMiniAppId = activeSceneId ? getMiniAppIdFromSceneId(activeSceneId) : null;
  const activeMiniAppClaim = activeMiniAppId ? claims[activeMiniAppId] : undefined;
  const flow = useSyncExternalStore(subscribeSessions, sessionSnapshot);
  const voice = useRealtimeVoiceCall();
  const panelRef = useRef<HTMLDivElement>(null);
  const [voiceViews, setVoiceViews] = useState<Record<string, boolean>>({});
  const onVoiceViewChange = useCallback((key: string, visible: boolean) => {
    setVoiceViews(previous => previous[key] === visible ? previous : { ...previous, [key]: visible });
  }, []);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [drop, setDrop] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const dragging = useRef<string>();
  const entries = dock.entries.filter(entry => entry.surfaceId === surfaceId)
    .sort((a, b) => Number(b.kind === 'control') - Number(a.kind === 'control'));
  const active = entries.find(entry => dockConversationKey(entry) === dock.activeBySurface[surfaceId]) ?? entries[0];
  const activeKey = active ? dockConversationKey(active) : undefined;
  const recoveryRevision = [...flow.sessions.values()].map(session => `${session.sessionId}:${session.dialogTurns.at(-1)?.status}`).join('|');
  useEffect(() => { void replayVoiceExchanges().catch(reason => { if (!isSurfaceChangedError(reason)) log.warn('Voice history recovery is pending', { reason }); }); }, [surfaceId, recoveryRevision]);
  const live = voice.phase !== 'idle';
  const liveRef = useRef(live);
  liveRef.current = live;
  const immersiveVoice = Boolean(activeKey && live && voiceViews[activeKey]);
  const callKey = voice.target ? dockConversationKey({ surfaceId: voice.target.surfaceId ?? surfaceId, sessionId: voice.target.sessionId }) : undefined;

  useEffect(() => globalEventBus.on<FlowChatFocusItemRequest>(FLOWCHAT_FOCUS_ITEM_EVENT, request => {
    if (request.embedded || request.surfaceEpoch !== undefined && request.surfaceEpoch !== getActiveSurfaceScope().epoch) return;
    const state = useConversationDockStore.getState();
    const target = state.entries.find(entry => entry.surfaceId === surfaceId && entry.sessionId === request.sessionId);
    if (!target) return;
    const key = dockConversationKey(target);
    state.select(key);
    state.setOpen(true);
    state.requestFocus(key, request);
  }), [surfaceId]);

  useEffect(() => {
    if (!dock.open) return;
    let disposed = false;
    setError('');
    if (!useConversationDockStore.getState().entries.some(entry => entry.surfaceId === surfaceId && entry.kind === 'control')) {
      useConversationDockStore.getState().add({ surfaceId, sessionId: 'openbitfun-control', workspaceKey: '', kind: 'control' }, false);
    }
    void ensureControlConversation().then(result => {
      if (!disposed) useConversationDockStore.getState().add({ ...result, surfaceId, workspaceKey: sessionSceneWorkspaceKey(result.workspaceId), kind: 'control' }, false);
    }).catch(reason => { if (!disposed && !isSurfaceChangedError(reason)) setError(String(reason instanceof Error ? reason.message : reason)); });
    return () => { disposed = true; };
  }, [dock.open, surfaceId, retry]);

  useEffect(() => {
    syncMiniAppConversations(surfaceId);
  }, [claims, surfaceId]);

  useEffect(() => {
    if (activeMiniAppId) followMiniAppConversation(activeMiniAppId,
      liveRef.current || Boolean(panelRef.current?.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus')), surfaceId);
    // Selection inside the dock does not retrigger following the main scene.
  }, [activeMiniAppId, activeMiniAppClaim?.sessionId, activeMiniAppClaim?.token, surfaceId]);

  useEffect(() => {
    const target = voice.target;
    if (target?.kind === 'miniapp' && live && voice.phase !== 'ending'
      && !openScenes.some(tab => tab.id === getMiniAppSceneId(target.appId))) voice.end();
  }, [openScenes, voice, live]);

  useEffect(() => {
    if (dock.open && activeKey) setVisited(previous => previous.has(activeKey) ? previous : new Set([...previous, activeKey]));
  }, [dock.open, activeKey]);

  // Prepared MiniApp drafts also work before the first visit to that tab.
  useEffect(() => {
    const mayReveal = (appId: string) => {
      const state = useConversationDockStore.getState();
      const selected = state.entries.find(entry => dockConversationKey(entry) === state.activeBySurface[surfaceId]);
      const isSelected = selected?.kind === 'miniapp' && selected.appId === appId;
      if (live && !isSelected) return false;
      if (!isSelected && panelRef.current?.querySelector('[contenteditable="true"]:focus, textarea:focus, input:focus')) return false;
      return state.open && isSelected || useSceneStore.getState().activeTabId === getMiniAppSceneId(appId);
    };
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<MiniAppFocusEventDetail>).detail;
      if (!detail) return;
      const entry = resolveMiniAppConversation(detail.appId, detail.surfaceId);
      if (entry?.claimToken === detail.token && entry.sessionId === detail.sessionId && mayReveal(detail.appId)) {
        openMiniAppConversation(detail.appId, detail.surfaceId);
      }
    };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<MiniAppDraftEventDetail>).detail;
      const claim = Object.entries(useMiniAppStore.getState().composerClaims).find(([, value]) => value.token === detail?.token);
      if (!claim?.[1].sessionId || detail.sessionId && detail.sessionId !== claim[1].sessionId) return;
      const [appId, value] = claim;
      const entry = resolveMiniAppConversation(appId, surfaceId);
      if (!entry || entry.claimToken !== value.token) return;
      const state = useConversationDockStore.getState();
      state.setDraft(dockConversationKey(entry), detail.text);
      if (mayReveal(appId)) openMiniAppConversation(appId, surfaceId);
    };
    window.addEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, listener);
    window.addEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, focus);
    return () => {
      window.removeEventListener(MINIAPP_COMPOSER_DRAFT_EVENT, listener);
      window.removeEventListener(MINIAPP_COMPOSER_FOCUS_EVENT, focus);
    };
  }, [surfaceId, live]);
  const collapse = () => dock.setOpen(false);
  const label = (entry: DockConversation) => entry.kind === 'control' ? 'OpenBitFun' : entry.kind === 'miniapp'
    ? claims[entry.appId!]?.customization?.title || (() => { const app = apps.find(a => a.id === entry.appId); return app ? pickLocalizedString(app, i18n.language, 'name') : entry.appId; })() || entry.appId!
    : resolveDisplayTitle(flow.sessions.get(entry.sessionId));
  const acceptDrop = (event: React.DragEvent) => {
    if (!isConversationTransfer(event.dataTransfer)) return;
    event.preventDefault(); event.stopPropagation(); setDrop(false);
    void dropConversationInDock(event.dataTransfer);
  };
  const renderHeader = (modeSwitch: ReactNode) => <>
      <div className={['openbitfun-fmc__header', active?.kind === 'control' && entries.length === 1 && 'openbitfun-fmc__header--identity'].filter(Boolean).join(' ')} data-openbitfun-component="floating-mini-chat" data-openbitfun-part="header">
        <div className="openbitfun-fmc__mode-switch">{modeSwitch}</div>
        {entries.length > 1 ? <TabGroup className="openbitfun-fmc__tabs" size="sm" value={activeKey} onValueChange={dock.select}
          aria-label={t('dock.tabs')} items={entries.map(entry => ({ value: dockConversationKey(entry), label: label(entry),
            endAction: entry.kind !== 'control' && !(live && dockConversationKey(entry) === callKey) ? <button type="button" aria-label={t(entry.kind === 'miniapp' ? 'dock.hideConversation' : 'session.close')} title={t(entry.kind === 'miniapp' ? 'dock.hideConversation' : 'session.close')} tabIndex={-1}
              onClick={event => { event.stopPropagation(); dock.hide(dockConversationKey(entry)); }}><X size={12} /></button> : undefined,
          }))} renderItem={(item, node) => {
            const entry = entries.find(value => dockConversationKey(value) === item.value)!;
            return <div draggable={entry.kind !== 'control'} onDragStart={event => {
              dragging.current = item.value;
              if (entry.kind === 'session') beginConversationTransfer(event.dataTransfer, entry);
              else event.dataTransfer.setData('application/x-openbitfun-dock-tab', item.value);
            }} onDragEnd={() => { dragging.current = undefined; endConversationTransfer(); }}
              onDragOver={event => { if (dragging.current) event.preventDefault(); }}
              onDrop={event => { if (!dragging.current) return; event.preventDefault(); event.stopPropagation(); dock.reorder(dragging.current, item.value); }}
            >{node}</div>;
          }} /> : <OverflowText className="openbitfun-fmc__title-wrapper">{active ? label(active) : 'OpenBitFun'}</OverflowText>}
        {active?.kind === 'session' && <IconButton size="sm" icon={<ArrowUpRight size={15} />} aria-label={t('dock.moveToMain')}
          onClick={() => returnConversationToWorkbench(active)} />}
        {active?.kind === 'miniapp' && <IconButton size="sm" icon={<ArrowUpRight size={15} />} aria-label={t('dock.openApp')} title={t('dock.openApp')}
          onClick={() => openMiniAppFromConversation(active)} />}
        <IconButton size="sm" icon={<Minus size={15} />} aria-label={t('dock.collapse')} onClick={collapse} />
      </div>
      {live && !(active?.kind === 'control' && activeKey === callKey) && <div className="openbitfun-fmc__call-status" data-openbitfun-component="floating-mini-chat" data-openbitfun-part="callStatus">
        <button type="button" onClick={() => {
          const target = voice.target;
          if (!target) return;
          dock.add({ ...target, surfaceId: target.surfaceId ?? surfaceId,
            workspaceKey: target.kind !== 'miniapp' && target.workspaceId ? sessionSceneWorkspaceKey(target.workspaceId) : '' });
        }}>
          <Phone size={13} /><OverflowText>{tv('voiceCall.call.title')}</OverflowText>
        </button>
        <IconButton size="sm" icon={<PhoneOff size={14} />} aria-label={tv('voiceCall.call.hangUp')} onClick={voice.end} />
      </div>}
  </>;
  return <div className={['openbitfun-fmc', dock.open && 'openbitfun-fmc--open'].filter(Boolean).join(' ')}
    data-openbitfun-component="floating-mini-chat" data-openbitfun-part="root" data-openbitfun-mode="chat"
    data-openbitfun-state={dock.open ? 'open' : undefined}
    data-openbitfun-communication-mode={immersiveVoice ? 'voice' : 'chat'}
    onDragOver={event => { if (isConversationTransfer(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDrop(true); dock.setOpen(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDrop(false); }} onDrop={acceptDrop}>
    <LauncherButton className="openbitfun-fmc__button" aria-expanded={dock.open} aria-label={t('dock.open')}
      onClick={() => dock.setOpen(true)} onPointerDown={event => { if (event.button === 0) dock.setOpen(true); }}>
      {live ? <Phone size={16} /> : tv('voiceCall.call.launcherCompactLabel')}
    </LauncherButton>
    <div ref={panelRef} role="dialog" aria-modal="false" aria-label={t('dock.open')} aria-hidden={!dock.open} data-motion="presence"
      {...(!dock.open ? { inert: '' } : {})}
      className={['openbitfun-fmc__panel', dock.open && 'openbitfun-fmc__panel--open', drop && 'openbitfun-fmc__panel--drop'].filter(Boolean).join(' ')}
      data-openbitfun-component="floating-mini-chat" data-openbitfun-part="panel">
      <div className="openbitfun-fmc__body" data-openbitfun-component="floating-mini-chat" data-openbitfun-part="body">
        {(!active || active.kind === 'control' && !flow.sessions.has(active.sessionId)) && renderHeader(null)}
        {entries.filter(entry => (visited.has(dockConversationKey(entry)) || dockConversationKey(entry) === activeKey) && (entry.kind !== 'control' || flow.sessions.has(entry.sessionId))).map(entry => <div
          key={dockConversationKey(entry)} hidden={dockConversationKey(entry) !== activeKey}
          className="openbitfun-fmc__view">
          <DockConversationView entry={entry} active={dock.open && dockConversationKey(entry) === activeKey} onCollapse={collapse} renderHeader={renderHeader} onVoiceViewChange={onVoiceViewChange} />
        </div>)}
        {(!active || active.kind === 'control' && !flow.sessions.has(active.sessionId)) && <div className="openbitfun-fmc__miniapp-session-pending" role="status" data-openbitfun-component="floating-mini-chat" data-openbitfun-part="pending">
          {error ? <><span>{t('dock.loadFailed')}</span><span>{error}</span><Button onClick={() => setRetry(value => value + 1)}>{t('dock.retry')}</Button></> : t('dock.loading')}
        </div>}
      </div>
    </div>
  </div>;
}
export default FloatingMiniChat;
