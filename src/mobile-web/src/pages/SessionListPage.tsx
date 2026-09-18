import { subscribeHostCatalog } from '../services/HostCatalogSubscription';
import {
  AppWindow as LucideAppWindow,
  Check as LucideCheck,
  ChevronRight as LucideChevronRight,
  ChevronsUpDown as LucideChevronsUpDown,
  Ellipsis as LucideEllipsis,
  Folder as LucideFolder,
  FolderOpen as LucideFolderOpen,
  Laptop as LucideLaptop,
  LoaderCircle as LucideLoaderCircle,
  LogOut as LucideLogOut,
  MessageSquare as LucideMessageSquare,
  MessageCircle as LucideMessageCircle,
  Monitor as LucideMonitor,
  Moon as LucideMoon,
  Plus as LucidePlus,
  RefreshCw as LucideRefreshCw,
  Search as LucideSearch,
  Server as LucideServer,
  Settings as LucideSettings,
  Sun as LucideSun,
  Terminal as LucideTerminal,
  User as LucideUser,
  Users as LucideUsers,
  Wrench as LucideWrench,
  X as LucideX,
} from 'lucide-react';
import { useGitHubAccountProfile } from '../hooks/useGitHubAccountProfile';
import AccountAvatar from '../components/AccountAvatar';
import React, { useEffect, useLayoutEffect, useRef, useCallback, useMemo, useState } from 'react';
import {
  MobileButton,
  MobileBanner,
  MobileChoiceSheet,
  MobileFloatingActions,
  MobileIconButton,
  MobileSection,
  MobileSegmentedControl,
  MobileStatus,
  MobileTextField,
} from '@openbitfun/ui/mobile';
import LanguageToggleButton from '../components/LanguageToggleButton';
import SessionOverlays from '../components/SessionOverlays';
import CompactSettingsSheet from '../components/CompactSettingsSheet';
import { SessionHistoryPanel, SessionLaunchPanel } from '../components/SessionDashboardSections';
import { useControlTargetEpoch } from '../hooks/useControlTargetEpoch';
import { useI18n } from '../i18n';
import {
  isRemoteControlTargetChangedError,
  isWorkspaceIdReferencesUnsupportedError,
  REMOTE_CAPABILITY_HARNESS_PROFILES_V1,
  RemoteSessionManager,
  type AssistantEntry,
  type RecentWorkspaceEntry,
  type RemoteWorkspaceIdentity,
  type SessionInfo,
} from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';
import { createRemoteCacheScope, remoteCache } from '../services/RemoteCache';
import { describeRemoteError } from '../services/remoteErrorPresentation';
import {
  sameWorkspace,
  sessionMatchesWorkspace,
  workspaceIdentityKey,
  type WorkspaceReference,
} from '../services/workspaceIdentity';
import { useTheme } from '../theme';
import logoMarkDark from '../assets/openbitfun-mark-dark.png';
import logoMarkLight from '../assets/openbitfun-mark-light.png';
import {
  isAccountIdentityChangedError,
  type RelayHttpClient,
} from '../services/RelayHttpClient';

const PAGE_SIZE = 30;

type DisplayMode = 'pro' | 'assistant';

interface SessionListPageProps {
  sessionMgr: RemoteSessionManager;
  client?: RelayHttpClient;
  compact?: boolean;
  activeSessionId?: string | null;
  onSelectSession: (
    sessionId: string,
    sessionName?: string,
    isNew?: boolean,
    agentType?: string,
  ) => void;
  onOpenWorkspace: () => void;
  onOpenDeviceTools: () => void;
  onDisconnect: () => void;
  onOpenDevices?: () => void;
  onControlTargetChanged?: () => void;
}

type CompactDevice = {
  device_id: string;
  device_name: string;
  online: boolean;
};


function compactSelectedDeviceIdForClient(client?: RelayHttpClient): string | null {
  if (!client) return null;
  return client.targetDeviceId
    ?? null;
}

type CompactWorkspaceLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

function compactWorkspaceKey(workspace: RecentWorkspaceEntry): string {
  return workspaceIdentityKey(workspace);
}

/**
 * Key of one initial session load: the owning control target plus the
 * workspace identity (ID when known, legacy triple only for ID-less rows).
 */
export function initialLoadKey(
  deviceId: string | null | undefined,
  workspace: WorkspaceReference | null | undefined,
): string | undefined {
  if (!workspace || (!workspace.workspace_id && !workspace.path)) return undefined;
  return JSON.stringify([deviceId ?? null, workspaceIdentityKey(workspace)]);
}

/** Command identity for a workspace row; paths remain the legacy projection. */
function commandIdentity(
  workspace: Pick<RecentWorkspaceEntry, 'workspace_id' | 'remote_connection_id' | 'remote_ssh_host'> | null | undefined,
): RemoteWorkspaceIdentity {
  return {
    workspaceId: workspace?.workspace_id,
    remoteConnectionId: workspace?.remote_connection_id,
    remoteSshHost: workspace?.remote_ssh_host,
  };
}

function assistantIdentity(assistant: AssistantEntry | null | undefined): RemoteWorkspaceIdentity {
  return { workspaceId: assistant?.workspace_id };
}

type SessionListTargetOwner = {
  sessionMgr: RemoteSessionManager;
  epoch: number;
  active: boolean;
};

/**
 * Resolve the epoch owned by one render. The explicit renderedEpoch check is
 * what prevents an old timer/poll closure from borrowing a newer mutable ref
 * owner during the render-to-passive-cleanup window.
 */
export function captureSessionListOwnerEpoch(
  owner: SessionListTargetOwner,
  sessionMgr: RemoteSessionManager,
  renderedEpoch: number,
): number | null {
  if (
    !owner.active
    || owner.sessionMgr !== sessionMgr
    || owner.epoch !== renderedEpoch
    || sessionMgr.controlTargetEpoch !== renderedEpoch
  ) return null;
  return renderedEpoch;
}

function formatTime(
  unixStr: string,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const ts = parseInt(unixStr, 10);
  if (!ts || isNaN(ts)) return '';
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('common.justNow');
  if (diffMin < 60) return t('common.minutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('common.hoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t('common.daysAgo', { count: diffDay });
  return formatDate(date);
}

function agentLabel(agentType: string, t: (key: string) => string): string {
  switch (agentType) {
    case 'Minimal':
      return t('sessions.harnessMinimal');
    case 'Ultimate':
      return t('sessions.harnessUltimate');
    case 'code':
      return t('sessions.agentCode');
    case 'Standard':
      return t('sessions.harnessStandard');
    case 'cowork':
    case 'Cowork':
      return t('sessions.agentCowork');
    case 'claw':
    case 'Claw':
      return t('shared.agents.Claw');
    default:
      return agentType || t('sessions.agentDefault');
  }
}

function isCoworkAgent(agentType: string): boolean {
  return agentType === 'cowork' || agentType === 'Cowork';
}

function isClawAgent(agentType: string): boolean {
  return agentType === 'claw' || agentType === 'Claw';
}

/** Pick first workspace suitable for Expert mode (exclude Claw assistant roots when kind is known). */
function pickFirstProWorkspace(list: RecentWorkspaceEntry[]): RecentWorkspaceEntry | undefined {
  if (list.length === 0) return undefined;
  const anyKind = list.some((w) => w.workspace_kind != null);
  if (anyKind) {
    return list.find((w) => w.workspace_kind !== 'assistant');
  }
  return list[0];
}

function truncateMiddle(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str;
  const keep = maxLen - 3;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return str.slice(0, head) + '...' + str.slice(-tail);
}

function SessionTypeIcon({ agentType }: { agentType: string }) {
  if (isCoworkAgent(agentType)) {
    return (
      <LucideUsers width="18" height="18" stroke="currentColor" aria-hidden="true" />
    );
  }

  if (isClawAgent(agentType)) {
    return (
      <LucideAppWindow width="18" height="18" stroke="currentColor" aria-hidden="true" />
    );
  }

  return (
    <LucideMessageSquare width="18" height="18" stroke="currentColor" aria-hidden="true" />
  );
}

function CompactDeviceIcon({ name }: { name: string }) {
  const normalized = name.toLocaleLowerCase();
  if (/(macbook|laptop|notebook)/.test(normalized)) {
    return (
      <LucideLaptop width="22" height="22" stroke="currentColor" aria-hidden="true" />
    );
  }
  if (/(server|ecs|cloud|host)/.test(normalized)) {
    return (
      <LucideServer width="22" height="22" stroke="currentColor" aria-hidden="true" />
    );
  }
  return (
    <LucideMonitor width="22" height="22" stroke="currentColor" aria-hidden="true" />
  );
}

/* Mode Selection Icons */
const ProModeIcon = () => (
  <LucideTerminal width="32" height="32" stroke="currentColor" aria-hidden="true" />
);

const AssistantModeIcon = () => (
  <LucideUser width="32" height="32" stroke="currentColor" aria-hidden="true" />
);

const WorkspaceIcon = () => (
  <LucideFolderOpen width="18" height="18" stroke="currentColor" aria-hidden="true" />
);

const ThemeToggleIcon: React.FC<{ isDark: boolean }> = ({ isDark }) => (
  <>{isDark ? <LucideMoon width="16" height="16" aria-hidden="true" /> : <LucideSun width="16" height="16" aria-hidden="true" />}</>
);

const SessionListPage: React.FC<SessionListPageProps> = ({
  sessionMgr,
  client,
  compact = false,
  activeSessionId,
  onSelectSession,
  onOpenWorkspace,
  onOpenDeviceTools,
  onDisconnect,
  onOpenDevices,
  onControlTargetChanged,
}) => {
  const { t, formatDate } = useI18n();
  const {
    sessions,
    setSessions,
    appendSessions,
    setError,
    currentWorkspace,
    setCurrentWorkspace,
    currentAssistant,
    setCurrentAssistant,
    setPairedDisplayMode,
    authenticatedUserId,
    connectionHealth,
    controlTarget,
    setControlTarget,
    resetForDeviceSwitch,
  } = useMobileStore();
  const githubProfile = useGitHubAccountProfile(authenticatedUserId);
  const authenticatedUserLabel = authenticatedUserId
    ? githubProfile ? `@${githubProfile.login}` : t('settings.githubAccount') : null;
  const { isDark, toggleTheme } = useTheme();
  const logoMark = isDark ? logoMarkLight : logoMarkDark;
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [targetInitializing, setTargetInitializing] = useState(true);
  const targetInitializingRef = useRef(true);
  const [hasMore, setHasMore] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    const hint = useMobileStore.getState().pairedDisplayMode;
    if (hint === 'assistant' || hint === 'pro') return hint;
    return 'pro';
  });

  const [assistantList, setAssistantList] = useState<AssistantEntry[]>([]);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [workspaceList, setWorkspaceList] = useState<RecentWorkspaceEntry[]>([]);
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [workspaceCatalogSource, setWorkspaceCatalogSource] = useState<'opened' | 'recent' | null>(null);

  // Search, rename & delete state
  const [searchQuery, setSearchQuery] = useState('');
  const [menuSession, setMenuSession] = useState<SessionInfo | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<SessionInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [actionToast, setActionToast] = useState<string | null>(null);

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [compactSearchOpen, setCompactSearchOpen] = useState(false);
  const [compactDevices, setCompactDevices] = useState<CompactDevice[]>([]);
  const [compactDirectoryLoading, setCompactDirectoryLoading] = useState(false);
  const [compactSelectedDeviceId, setCompactSelectedDeviceId] = useState<string | null>(
    () => compactSelectedDeviceIdForClient(client),
  );
  const [compactSwitchingDeviceId, setCompactSwitchingDeviceId] = useState<string | null>(null);
  const [compactExpandedWorkspaces, setCompactExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [compactWorkspaceSessions, setCompactWorkspaceSessions] = useState<Record<string, SessionInfo[]>>({});
  const [compactWorkspaceStatuses, setCompactWorkspaceStatuses] = useState<Record<string, CompactWorkspaceLoadStatus>>({});
  const [compactWorkspaceHasMore, setCompactWorkspaceHasMore] = useState<Record<string, boolean>>({});
  const [compactWorkspaceLoadingMore, setCompactWorkspaceLoadingMore] = useState<Set<string>>(() => new Set());
  const [compactVisibleSessionCounts, setCompactVisibleSessionCounts] = useState<Record<string, number>>({});
  const [compactVisibleDeviceCount, setCompactVisibleDeviceCount] = useState(3);
  const [compactVisibleWorkspaceCount, setCompactVisibleWorkspaceCount] = useState(3);
  const [compactSettingsOpen, setCompactSettingsOpen] = useState(false);
  const [harnessCreateRequest, setHarnessCreateRequest] = useState<{
    workspace?: RecentWorkspaceEntry;
  } | null>(null);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const longPressPosRef = useRef({ x: 0, y: 0 });
  const longPressTriggeredRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const controlTargetEpoch = useControlTargetEpoch(sessionMgr);
  const cacheScope = useMemo(() => createRemoteCacheScope(
    authenticatedUserId,
    controlTarget?.deviceId ?? client?.targetDeviceId,
  ), [authenticatedUserId, client?.targetDeviceId, controlTarget?.deviceId]);
  const liveDataSeqRef = useRef(0);
  const sessionListOwnerRef = useRef({
    sessionMgr,
    epoch: controlTargetEpoch,
    active: true,
  });
  if (
    sessionListOwnerRef.current.sessionMgr !== sessionMgr
    || sessionListOwnerRef.current.epoch !== controlTargetEpoch
  ) {
    sessionListOwnerRef.current = {
      sessionMgr,
      epoch: controlTargetEpoch,
      active: true,
    };
  }

  const captureSessionListEpoch = useCallback((): number | null => {
    return captureSessionListOwnerEpoch(
      sessionListOwnerRef.current,
      sessionMgr,
      controlTargetEpoch,
    );
  }, [controlTargetEpoch, sessionMgr]);

  const isSessionListCurrent = useCallback((epoch: number | null): boolean => {
    const owner = sessionListOwnerRef.current;
    return epoch !== null
      && owner.active
      && owner.sessionMgr === sessionMgr
      && owner.epoch === epoch
      && sessionMgr.controlTargetEpoch === epoch;
  }, [controlTargetEpoch, sessionMgr]);

  const hasSearchQuery = searchQuery.trim().length > 0;
  // Show the resume card as soon as session data is available — don't gate it
  // behind `loading`, otherwise a background refresh hides the card and makes it
  // pop back in after the network round-trip, lagging behind the rest of the UI.
  const showResumeCard = sessions.length > 0 && !hasSearchQuery;

  // ── Long-press context menu ─────────────────────────────────────
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
  };

  const handleSessionTouchStart = useCallback((s: SessionInfo, e: React.TouchEvent) => {
    if (deleting || renaming) return;
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setMenuSession(s);
      longPressTimerRef.current = undefined;
    }, 500);
  }, [deleting, renaming]);

  const handleSessionTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = Math.abs(e.touches[0].clientX - longPressPosRef.current.x);
    const dy = Math.abs(e.touches[0].clientY - longPressPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearLongPressTimer();
    }
  }, []);

  const handleSessionTouchEnd = useCallback(() => {
    clearLongPressTimer();
  }, []);

  const handleSessionClick = useCallback((s: SessionInfo, e: React.MouseEvent) => {
    if (longPressTriggeredRef.current) {
      e.preventDefault();
      e.stopPropagation();
      longPressTriggeredRef.current = false;
      return;
    }
    onSelectSession(s.session_id, s.name, false, s.agent_type);
  }, [onSelectSession]);

  // ── Session actions ─────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setActionToast(msg);
    toastTimerRef.current = setTimeout(() => setActionToast(null), 2500);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      clearLongPressTimer();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setRenaming(true);
    try {
      await sessionMgr.renameSession(renameTarget.session_id, renameValue.trim());
      if (!isSessionListCurrent(targetEpoch)) return;
      const nextName = renameValue.trim();
      useMobileStore.getState().updateSessionName(renameTarget.session_id, nextName);
      setCompactWorkspaceSessions((current) => Object.fromEntries(
        Object.entries(current).map(([key, workspaceSessions]) => [
          key,
          workspaceSessions.map((session) => (
            session.session_id === renameTarget.session_id
              ? { ...session, name: nextName }
              : session
          )),
        ]),
      ));
      remoteCache.renameSession(cacheScope, renameTarget.session_id, nextName);
      setRenameTarget(null);
      setMenuSession(null);
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        showToast(e.message || t('sessions.renameFailed'));
      }
    } finally {
      if (isSessionListCurrent(targetEpoch)) setRenaming(false);
    }
  }, [cacheScope, captureSessionListEpoch, isSessionListCurrent, renameTarget, renameValue, sessionMgr, showToast, t]);

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmTarget) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setDeleting(true);
    try {
      await sessionMgr.deleteSession(deleteConfirmTarget.session_id);
      if (!isSessionListCurrent(targetEpoch)) return;
      useMobileStore.getState().removeSession(deleteConfirmTarget.session_id);
      setCompactWorkspaceSessions((current) => Object.fromEntries(
        Object.entries(current).map(([key, workspaceSessions]) => [
          key,
          workspaceSessions.filter((session) => (
            session.session_id !== deleteConfirmTarget.session_id
          )),
        ]),
      ));
      remoteCache.deleteSession(cacheScope, deleteConfirmTarget.session_id);
      setDeleteConfirmTarget(null);
      setMenuSession(null);
      showToast(t('sessions.deleted'));
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        showToast(e.message || t('sessions.deleteFailed'));
      }
    } finally {
      if (isSessionListCurrent(targetEpoch)) setDeleting(false);
    }
  }, [cacheScope, captureSessionListEpoch, deleteConfirmTarget, isSessionListCurrent, sessionMgr, showToast, t]);

  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const offsetRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listRequestSeqRef = useRef(0);
  const workspaceCatalogRequestSeqRef = useRef(0);
  // Keyed by (control target, workspace identity); see initialLoadKey.
  const initLoadedWorkspaceRef = useRef<string | undefined>(undefined);
  const touchStartY = useRef(0);
  const isPulling = useRef(false);

  const committedSessionListTargetRef = useRef({ sessionMgr, epoch: controlTargetEpoch });
  useLayoutEffect(() => {
    const previous = committedSessionListTargetRef.current;
    const targetChanged = previous.sessionMgr !== sessionMgr
      || previous.epoch !== controlTargetEpoch;
    const owner = sessionListOwnerRef.current;
    owner.active = owner.sessionMgr === sessionMgr
      && owner.epoch === controlTargetEpoch
      && sessionMgr.controlTargetEpoch === controlTargetEpoch;
    if (targetChanged) {
      targetInitializingRef.current = true;
      setTargetInitializing(true);
      listRequestSeqRef.current += 1;
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      clearLongPressTimer();
      longPressTriggeredRef.current = false;
      isPulling.current = false;
      setPullDistance(0);
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = undefined;
      }
      setCreating(false);
      setRenaming(false);
      setDeleting(false);
      setAssistantList([]);
      setWorkspaceList([]);
      setWorkspaceCatalogSource(null);
      workspaceCatalogRequestSeqRef.current += 1;
      setShowAssistantPicker(false);
      setShowWorkspacePicker(false);
      setMenuSession(null);
      setRenameTarget(null);
      setRenameValue('');
      setDeleteConfirmTarget(null);
      setActionToast(null);
      setShowDisconnectConfirm(false);
      setSearchQuery('');
      setCompactSelectedDeviceId(compactSelectedDeviceIdForClient(client));
      setCompactSwitchingDeviceId(null);
      setCompactExpandedWorkspaces(new Set());
      setCompactWorkspaceSessions({});
      setCompactWorkspaceStatuses({});
      setCompactWorkspaceHasMore({});
      setCompactWorkspaceLoadingMore(new Set());
      setCompactVisibleSessionCounts({});
      setCompactVisibleDeviceCount(3);
      setCompactVisibleWorkspaceCount(3);
      setCompactSettingsOpen(false);
      setDisplayMode('pro');
      setHasMore(false);
      setSessions([]);
      setCurrentWorkspace(null);
      setCurrentAssistant(null);
      setPairedDisplayMode(null);
      setError(null);
      offsetRef.current = 0;
      initLoadedWorkspaceRef.current = undefined;
    }
    committedSessionListTargetRef.current = { sessionMgr, epoch: controlTargetEpoch };
    return () => {
      owner.active = false;
      listRequestSeqRef.current += 1;
    };
  }, [
    controlTargetEpoch,
    client,
    sessionMgr,
    setCurrentAssistant,
    setCurrentWorkspace,
    setError,
    setPairedDisplayMode,
    setSessions,
  ]);

  useEffect(() => {
    if (!compact || !cacheScope) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const liveDataSeq = liveDataSeqRef.current;
    let cancelled = false;
    void remoteCache.loadSessionState(cacheScope).then((cached) => {
      if (
        cancelled
        || !cached
        || liveDataSeqRef.current !== liveDataSeq
        || !isSessionListCurrent(targetEpoch)
      ) return;
      if (useMobileStore.getState().sessions.length === 0) {
        setSessions(cached.sessions);
        offsetRef.current = cached.sessions.length;
      }
      setWorkspaceList(cached.workspaces);
      setWorkspaceCatalogSource(cached.workspaceCatalogSource ?? 'recent');

      const cachedByWorkspace: Record<string, SessionInfo[]> = {};
      const cachedStatuses: Record<string, CompactWorkspaceLoadStatus> = {};
      cached.workspaces.forEach((workspace) => {
        const key = compactWorkspaceKey(workspace);
        const workspaceSessions = cached.sessions.filter((session) => (
          sessionMatchesWorkspace(session, workspace, cached.workspaces)
        ));
        if (workspaceSessions.length > 0) {
          cachedByWorkspace[key] = workspaceSessions;
          cachedStatuses[key] = 'idle';
        }
      });
      setCompactWorkspaceSessions(cachedByWorkspace);
      setCompactWorkspaceStatuses(cachedStatuses);
    });
    return () => { cancelled = true; };
  }, [cacheScope, captureSessionListEpoch, compact, controlTargetEpoch, isSessionListCurrent, setSessions]);

  // Load assistant list when entering assistant mode
  const loadAssistantList = useCallback(async () => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return undefined;
    try {
      const assistants = await sessionMgr.listAssistants();
      if (!isSessionListCurrent(targetEpoch)) return undefined;
      setAssistantList(assistants);
      // Set default assistant if none selected
      if (!currentAssistant && assistants.length > 0) {
        const defaultAssistant = assistants.find(a => !a.assistant_id) || assistants[0];
        setCurrentAssistant(defaultAssistant);
        return defaultAssistant;
      }
      return currentAssistant ?? undefined;
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
      return undefined;
    }
  }, [captureSessionListEpoch, currentAssistant, isSessionListCurrent, sessionMgr, setCurrentAssistant, setError, t]);

  const loadFirstPage = useCallback(async (
    workspacePath: string | undefined,
    query = '',
    identity?: { workspaceId?: string; remoteConnectionId?: string; remoteSshHost?: string },
  ) => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const requestSeq = ++listRequestSeqRef.current;
    // A new first page owns the complete list and supersedes pagination.
    setLoadingMore(false);
    setLoading(true);
    offsetRef.current = 0;
    try {
      const resp = await sessionMgr.listSessions(
        workspacePath,
        PAGE_SIZE,
        0,
        query,
        identity,
      );
      if (
        requestSeq !== listRequestSeqRef.current
        || !isSessionListCurrent(targetEpoch)
      ) return;
      liveDataSeqRef.current += 1;
      setSessions(resp.sessions);
      setHasMore(resp.has_more);
      offsetRef.current = resp.sessions.length;
      remoteCache.saveSessionPage(cacheScope, resp.sessions, {
        workspacePath,
        workspaceIdentity: identity,
        replaceWorkspace: query.trim().length === 0,
      });
    } catch (e: any) {
      if (
        requestSeq !== listRequestSeqRef.current
        || !isSessionListCurrent(targetEpoch)
      ) return;
      if (!isRemoteControlTargetChangedError(e)) setError(describeRemoteError(e, t));
    } finally {
      if (
        requestSeq === listRequestSeqRef.current
        && isSessionListCurrent(targetEpoch)
      ) {
        setLoading(false);
      }
    }
  }, [cacheScope, captureSessionListEpoch, isSessionListCurrent, sessionMgr, setError, setSessions, t]);

  // Load workspace list for Pro mode picker
  const loadWorkspaceList = useCallback(async () => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const requestSeq = ++workspaceCatalogRequestSeqRef.current;
    try {
      const catalog = compact
        ? await sessionMgr.listWorkspaceCatalog()
        : { workspaces: await sessionMgr.listRecentWorkspaces(), source: 'recent' as const };
      if (!isSessionListCurrent(targetEpoch) || requestSeq !== workspaceCatalogRequestSeqRef.current) return;
      liveDataSeqRef.current += 1;
      setWorkspaceList(catalog.workspaces);
      setWorkspaceCatalogSource(catalog.source);
      remoteCache.saveWorkspaceCatalog(cacheScope, catalog.workspaces, catalog.source);
    } catch (e: any) {
      if (requestSeq === workspaceCatalogRequestSeqRef.current
        && isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
    }
  }, [cacheScope, captureSessionListEpoch, compact, isSessionListCurrent, sessionMgr, setError, t]);

  const loadCompactDirectory = useCallback(async () => {
    if (!compact) return;
    setCompactDirectoryLoading(true);
    try {
      const tasks: Promise<unknown>[] = [loadWorkspaceList()];
      if (client?.hasAccountIdentity) {
        tasks.push(client.listDevices().then((list) => {
          setCompactDevices(list.filter((device) => (
            device.device_id !== client.controllerDeviceId
          )));
        }));
      }
      await Promise.all(tasks);
    } catch (e: any) {
      setError(e?.message || t('devices.loadFailed'));
    } finally {
      setCompactDirectoryLoading(false);
    }
  }, [client, compact, loadWorkspaceList, setError, t]);

  const loadCompactWorkspaceCatalog = useCallback(async (expectedTargetEpoch: number) => {
    if (!compact || !client) return;
    setCompactDirectoryLoading(true);
    const requestSeq = ++workspaceCatalogRequestSeqRef.current;
    try {
      const catalog = await sessionMgr.listWorkspaceCatalog();
      if (client.controlTargetEpoch !== expectedTargetEpoch || requestSeq !== workspaceCatalogRequestSeqRef.current) return;
      liveDataSeqRef.current += 1;
      setWorkspaceList(catalog.workspaces);
      setWorkspaceCatalogSource(catalog.source);
      remoteCache.saveWorkspaceCatalog(cacheScope, catalog.workspaces, catalog.source);
    } catch (error: unknown) {
      if (
        client.controlTargetEpoch === expectedTargetEpoch
        && requestSeq === workspaceCatalogRequestSeqRef.current
        && !isRemoteControlTargetChangedError(error)
      ) {
        setError(String((error as { message?: string })?.message || error));
      }
    } finally {
      if (client.controlTargetEpoch === expectedTargetEpoch) {
        setCompactDirectoryLoading(false);
      }
    }
  }, [cacheScope, client, compact, sessionMgr, setError]);

  useEffect(() => {
    if (!compact) return;
    void loadCompactDirectory();
  }, [compact, loadCompactDirectory]);

  const handleSelectCompactDevice = useCallback(async (device: CompactDevice) => {
    if (!client || !device.online || compactSwitchingDeviceId) return;
    setCompactSelectedDeviceId(device.device_id);

    if (client.targetDeviceId === device.device_id) {
      await loadCompactWorkspaceCatalog(client.controlTargetEpoch);
      return;
    }
    const accountEpoch = client.accountEpoch;
    const targetEpoch = client.controlTargetEpoch;
    setCompactSwitchingDeviceId(device.device_id);
    setError(null);
    try {
      const ping = await client.sendDeviceRpc<{ resp?: string; ok?: boolean; error?: string }>(
        device.device_id,
        {
          cmd: 'host_invoke',
          command: 'peer_mode_ping',
          args: {},
        },
        { retryable: true },
      );
      if (
        client.accountEpoch !== accountEpoch
        || client.controlTargetEpoch !== targetEpoch
      ) return;
      if (ping.resp === 'host_invoke_result' && ping.ok === false) {
        throw new Error(ping.error || t('devices.switchFailed'));
      }
      client.setTargetDeviceId(device.device_id);
      const switchedTargetEpoch = client.controlTargetEpoch;
      resetForDeviceSwitch();
      setControlTarget({
        deviceId: device.device_id,
        deviceName: device.device_name || null,
      });
      onControlTargetChanged?.();
      await loadCompactWorkspaceCatalog(switchedTargetEpoch);
    } catch (error: unknown) {
      if (isAccountIdentityChangedError(error)) return;
      const message = String((error as { message?: string })?.message || error);
      setError(message || t('devices.switchFailed'));
    } finally {
      setCompactSwitchingDeviceId((current) => (
        current === device.device_id ? null : current
      ));
    }
  }, [
    client,
    compactSwitchingDeviceId,
    loadCompactWorkspaceCatalog,
    onControlTargetChanged,
    resetForDeviceSwitch,
    setControlTarget,
    setError,
    t,
  ]);

  const handleToggleCompactWorkspace = useCallback(async (workspace: RecentWorkspaceEntry) => {
    const key = compactWorkspaceKey(workspace);
    if (compactExpandedWorkspaces.has(key)) {
      setCompactExpandedWorkspaces((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }

    setCompactExpandedWorkspaces((current) => new Set(current).add(key));
    if (compactWorkspaceStatuses[key] === 'ready' || compactWorkspaceStatuses[key] === 'loading') {
      return;
    }

    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'loading' }));
    try {
      const identity = commandIdentity(workspace);
      const response = await sessionMgr.listSessions(workspace.path, PAGE_SIZE, 0, '', identity);
      if (!isSessionListCurrent(targetEpoch)) return;
      liveDataSeqRef.current += 1;
      setCompactWorkspaceSessions((current) => ({ ...current, [key]: response.sessions }));
      setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'ready' }));
      setCompactWorkspaceHasMore((current) => ({ ...current, [key]: response.has_more }));
      setCompactVisibleSessionCounts((current) => ({ ...current, [key]: 3 }));
      remoteCache.saveSessionPage(cacheScope, response.sessions, {
        workspacePath: workspace.path,
        workspaceIdentity: identity,
        replaceWorkspace: true,
      });
    } catch (error: unknown) {
      if (!isSessionListCurrent(targetEpoch) || isRemoteControlTargetChangedError(error)) return;
      setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'failed' }));
      if (isWorkspaceIdReferencesUnsupportedError(error)) setError(describeRemoteError(error, t));
    }
  }, [
    captureSessionListEpoch,
    compactExpandedWorkspaces,
    compactWorkspaceStatuses,
    cacheScope,
    isSessionListCurrent,
    sessionMgr,
    setError,
    t,
  ]);

  const handleRetryCompactWorkspace = useCallback(async (workspace: RecentWorkspaceEntry) => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const key = compactWorkspaceKey(workspace);
    setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'loading' }));
    try {
      const identity = commandIdentity(workspace);
      const response = await sessionMgr.listSessions(workspace.path, PAGE_SIZE, 0, '', identity);
      if (!isSessionListCurrent(targetEpoch)) return;
      liveDataSeqRef.current += 1;
      setCompactWorkspaceSessions((current) => ({ ...current, [key]: response.sessions }));
      setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'ready' }));
      setCompactWorkspaceHasMore((current) => ({ ...current, [key]: response.has_more }));
      setCompactVisibleSessionCounts((current) => ({ ...current, [key]: 3 }));
      remoteCache.saveSessionPage(cacheScope, response.sessions, {
        workspacePath: workspace.path,
        workspaceIdentity: identity,
        replaceWorkspace: true,
      });
    } catch (error: unknown) {
      if (!isSessionListCurrent(targetEpoch) || isRemoteControlTargetChangedError(error)) return;
      setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'failed' }));
      if (isWorkspaceIdReferencesUnsupportedError(error)) setError(describeRemoteError(error, t));
    }
  }, [cacheScope, captureSessionListEpoch, isSessionListCurrent, sessionMgr, setError, t]);

  const handleLoadMoreCompactWorkspace = useCallback(async (workspace: RecentWorkspaceEntry) => {
    const key = compactWorkspaceKey(workspace);
    const visibleCount = compactVisibleSessionCounts[key] ?? 3;
    const loadedSessions = compactWorkspaceSessions[key] ?? [];
    if (visibleCount < loadedSessions.length) {
      setCompactVisibleSessionCounts((current) => ({
        ...current,
        [key]: Math.min(visibleCount + 3, loadedSessions.length),
      }));
      return;
    }
    if (!compactWorkspaceHasMore[key] || compactWorkspaceLoadingMore.has(key)) return;

    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setCompactWorkspaceLoadingMore((current) => new Set(current).add(key));
    try {
      const identity = commandIdentity(workspace);
      const response = await sessionMgr.listSessions(
        workspace.path,
        PAGE_SIZE,
        loadedSessions.length,
        '',
        identity,
      );
      if (!isSessionListCurrent(targetEpoch)) return;
      liveDataSeqRef.current += 1;
      const merged = [...loadedSessions];
      const existingIds = new Set(merged.map((session) => session.session_id));
      response.sessions.forEach((session) => {
        if (!existingIds.has(session.session_id)) merged.push(session);
      });
      setCompactWorkspaceSessions((current) => ({ ...current, [key]: merged }));
      setCompactWorkspaceHasMore((current) => ({ ...current, [key]: response.has_more }));
      setCompactVisibleSessionCounts((current) => ({
        ...current,
        [key]: Math.min(visibleCount + 3, merged.length),
      }));
      remoteCache.saveSessionPage(cacheScope, response.sessions, {
        workspacePath: workspace.path,
        workspaceIdentity: identity,
      });
    } catch (error: unknown) {
      if (!isSessionListCurrent(targetEpoch) || isRemoteControlTargetChangedError(error)) return;
      setError(describeRemoteError(error, t));
    } finally {
      if (isSessionListCurrent(targetEpoch)) {
        setCompactWorkspaceLoadingMore((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  }, [
    cacheScope,
    captureSessionListEpoch,
    compactVisibleSessionCounts,
    compactWorkspaceHasMore,
    compactWorkspaceLoadingMore,
    compactWorkspaceSessions,
    isSessionListCurrent,
    sessionMgr,
    setError,
    t,
  ]);

  const handleCreateInCompactWorkspace = useCallback(async (
    workspace: RecentWorkspaceEntry,
    agentType = 'code',
  ) => {
    if (creating || targetInitializingRef.current) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setCreating(true);
    try {
      const identity = commandIdentity(workspace);
      const created = await sessionMgr.createSession(agentType, undefined, workspace.path, identity);
      if (!isSessionListCurrent(targetEpoch)) return;
      // The host pins the new session to a workspace record; that identity
      // owns the follow-up listing and cache page.
      const createdIdentity: RemoteWorkspaceIdentity = {
        workspaceId: created.workspace_id ?? identity.workspaceId,
        remoteConnectionId: created.remote_connection_id ?? identity.remoteConnectionId,
        remoteSshHost: created.remote_ssh_host ?? identity.remoteSshHost,
      };
      const createdPath = created.workspace_path ?? workspace.path;
      const response = await sessionMgr.listSessions(createdPath, PAGE_SIZE, 0, '', createdIdentity);
      if (!isSessionListCurrent(targetEpoch)) return;
      const key = compactWorkspaceKey(workspace);
      liveDataSeqRef.current += 1;
      setCompactExpandedWorkspaces((current) => new Set(current).add(key));
      setCompactWorkspaceSessions((current) => ({ ...current, [key]: response.sessions }));
      setCompactWorkspaceStatuses((current) => ({ ...current, [key]: 'ready' }));
      setCompactWorkspaceHasMore((current) => ({ ...current, [key]: response.has_more }));
      setCompactVisibleSessionCounts((current) => ({ ...current, [key]: 3 }));
      remoteCache.saveSessionPage(cacheScope, response.sessions, {
        workspacePath: createdPath,
        workspaceIdentity: createdIdentity,
        replaceWorkspace: true,
      });
      onSelectSession(created.session_id, t(isClawAgent(agentType) ? 'sessions.remoteClawSession' : isCoworkAgent(agentType) ? 'sessions.remoteCoworkSession' : 'sessions.remoteCodeSession'), true, agentType);
    } catch (error: unknown) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(error)) {
        setError(describeRemoteError(error, t));
      }
    } finally {
      if (isSessionListCurrent(targetEpoch)) setCreating(false);
    }
  }, [
    captureSessionListEpoch,
    cacheScope,
    creating,
    isSessionListCurrent,
    onSelectSession,
    sessionMgr,
    setError,
    t,
  ]);

  const handleSelectWorkspace = useCallback(async (workspace: RecentWorkspaceEntry) => {
    if (targetInitializingRef.current) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    try {
      const result = await sessionMgr.setWorkspace(workspace);
      if (!isSessionListCurrent(targetEpoch)) return;
      if (result.success) {
        const path = result.path || workspace.path;
        const remoteConnectionId =
          result.remote_connection_id ?? workspace.remote_connection_id;
        const remoteSshHost = result.remote_ssh_host ?? workspace.remote_ssh_host;
        const workspaceId = result.workspace_id ?? workspace.workspace_id;
        const identity = { workspaceId, remoteConnectionId, remoteSshHost };
        setCurrentWorkspace({
          workspace_id: workspaceId,
          has_workspace: true,
          path,
          project_name: result.project_name || workspace.name,
          workspace_kind: workspace.workspace_kind,
          remote_connection_id: remoteConnectionId,
          remote_ssh_host: remoteSshHost,
        });
        setShowWorkspacePicker(false);
        loadFirstPage(path, searchQuery, identity);
      } else {
        setError(result.error || t('workspace.failedToSetWorkspace'));
      }
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
    }
  }, [captureSessionListEpoch, isSessionListCurrent, loadFirstPage, searchQuery, sessionMgr, setCurrentWorkspace, setError, t]);

  const trySelectFirstProWorkspace = useCallback(async (): Promise<boolean> => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return false;
    try {
      const list = await sessionMgr.listRecentWorkspaces();
      if (!isSessionListCurrent(targetEpoch)) return false;
      const candidate = pickFirstProWorkspace(list);
      if (!candidate) return false;
      const result = await sessionMgr.setWorkspace(candidate);
      if (!isSessionListCurrent(targetEpoch)) return false;
      if (result.success) {
        const path = result.path || candidate.path;
        const remoteConnectionId =
          result.remote_connection_id ?? candidate.remote_connection_id;
        const remoteSshHost = result.remote_ssh_host ?? candidate.remote_ssh_host;
        const workspaceId = result.workspace_id ?? candidate.workspace_id;
        const identity = { workspaceId, remoteConnectionId, remoteSshHost };
        setCurrentWorkspace({
          workspace_id: workspaceId,
          has_workspace: true,
          path,
          project_name: result.project_name || candidate.name,
          workspace_kind: candidate.workspace_kind,
          remote_connection_id: remoteConnectionId,
          remote_ssh_host: remoteSshHost,
        });
        await loadFirstPage(path, searchQuery, identity);
        return isSessionListCurrent(targetEpoch);
      }
      setError(result.error || t('workspace.failedToSetWorkspace'));
      return false;
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
      return false;
    }
  }, [captureSessionListEpoch, isSessionListCurrent, loadFirstPage, searchQuery, sessionMgr, setCurrentWorkspace, setError, t]);

  const loadNextPage = useCallback(async (
    workspacePath: string | undefined,
    query = '',
    identity?: { workspaceId?: string; remoteConnectionId?: string; remoteSshHost?: string },
  ) => {
    if (loading || loadingMore || !hasMore) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const requestSeq = listRequestSeqRef.current;
    setLoadingMore(true);
    try {
      const resp = await sessionMgr.listSessions(
        workspacePath,
        PAGE_SIZE,
        offsetRef.current,
        query,
        identity,
      );
      if (
        requestSeq !== listRequestSeqRef.current
        || !isSessionListCurrent(targetEpoch)
      ) return;
      appendSessions(resp.sessions);
      setHasMore(resp.has_more);
      offsetRef.current += resp.sessions.length;
      liveDataSeqRef.current += 1;
      remoteCache.saveSessionPage(cacheScope, resp.sessions, { workspacePath, workspaceIdentity: identity });
    } catch (e: any) {
      if (
        requestSeq !== listRequestSeqRef.current
        || !isSessionListCurrent(targetEpoch)
      ) return;
      if (!isRemoteControlTargetChangedError(e)) setError(describeRemoteError(e, t));
    } finally {
      if (
        requestSeq === listRequestSeqRef.current
        && isSessionListCurrent(targetEpoch)
      ) setLoadingMore(false);
    }
  }, [appendSessions, cacheScope, captureSessionListEpoch, hasMore, isSessionListCurrent, loading, loadingMore, sessionMgr, setError, t]);

  useEffect(() => {
    let cancelled = false;
    setHarnessCreateRequest(null);
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const isInitCurrent = () => (
      !cancelled && isSessionListCurrent(targetEpoch)
    );
    const init = async () => {
      try {
        const info = await sessionMgr.getWorkspaceInfo();
        if (!isInitCurrent()) return;
        const deviceId = sessionMgr.controlTargetDeviceId;
        if (info.workspace_kind === 'assistant' && info.path) {
          const assistant: AssistantEntry = {
            workspace_id: info.workspace_id,
            path: info.path,
            name: info.project_name ?? 'Claw',
            assistant_id: info.assistant_id,
          };
          setCurrentAssistant(assistant);
          setCurrentWorkspace(null);
          setDisplayMode('assistant');
          initLoadedWorkspaceRef.current = initialLoadKey(deviceId, assistant);
          await loadFirstPage(info.path, '', assistantIdentity(assistant));
        } else {
          setDisplayMode('pro');
          const ws = info.has_workspace ? info : null;
          setCurrentWorkspace(ws);
          if (ws?.path) {
            initLoadedWorkspaceRef.current = initialLoadKey(deviceId, ws);
            await loadFirstPage(ws.path, '', commandIdentity(ws));
          } else {
            await trySelectFirstProWorkspace();
          }
        }
      } catch (e: any) {
        if (isInitCurrent() && !isRemoteControlTargetChangedError(e)) setError(describeRemoteError(e, t));
      } finally {
        if (isInitCurrent()) {
          setPairedDisplayMode(null);
          setLoading(false);
          targetInitializingRef.current = false;
          setTargetInitializing(false);
        }
      }
    };
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlTargetEpoch]);

  const refreshData = useCallback(async () => {
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const requestSeq = ++listRequestSeqRef.current;
    // Refresh replaces both a first-page request and pagination. Their stale
    // finally blocks intentionally cannot publish, so this owner must also
    // settle the flags it superseded.
    setLoadingMore(false);
    try {
      if (displayMode === 'pro') {
        const info = await sessionMgr.getWorkspaceInfo();
        if (
          requestSeq !== listRequestSeqRef.current
          || !isSessionListCurrent(targetEpoch)
        ) return;
        if (info.workspace_kind === 'assistant') {
          setCurrentWorkspace(null);
          setSessions([]);
          setHasMore(false);
          offsetRef.current = 0;
          return;
        }
        const ws = info.has_workspace ? info : null;
        setCurrentWorkspace(ws);
        const identity = commandIdentity(ws);
        const resp = await sessionMgr.listSessions(ws?.path, PAGE_SIZE, 0, searchQuery, identity);
        if (
          requestSeq !== listRequestSeqRef.current
          || !isSessionListCurrent(targetEpoch)
        ) return;
        liveDataSeqRef.current += 1;
        setSessions(resp.sessions);
        setHasMore(resp.has_more);
        offsetRef.current = resp.sessions.length;
        remoteCache.saveSessionPage(cacheScope, resp.sessions, {
          workspacePath: ws?.path,
          workspaceIdentity: identity,
          replaceWorkspace: searchQuery.trim().length === 0,
        });
      } else {
        // Assistant mode: the assistant workspace ID scopes the listing; its
        // path is the legacy projection for pre-ID hosts.
        const identity = assistantIdentity(currentAssistant);
        const resp = await sessionMgr.listSessions(currentAssistant?.path, PAGE_SIZE, 0, searchQuery, identity);
        if (
          requestSeq !== listRequestSeqRef.current
          || !isSessionListCurrent(targetEpoch)
        ) return;
        liveDataSeqRef.current += 1;
        setSessions(resp.sessions);
        setHasMore(resp.has_more);
        offsetRef.current = resp.sessions.length;
        remoteCache.saveSessionPage(cacheScope, resp.sessions, {
          workspacePath: currentAssistant?.path,
          workspaceIdentity: identity,
          replaceWorkspace: searchQuery.trim().length === 0,
        });
      }
    } catch (error) {
      if (requestSeq === listRequestSeqRef.current && isSessionListCurrent(targetEpoch)
        && !isRemoteControlTargetChangedError(error)) {
        setError(describeRemoteError(error, t));
      }
    }
    finally {
      if (
        requestSeq === listRequestSeqRef.current
        && isSessionListCurrent(targetEpoch)
      ) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [cacheScope, captureSessionListEpoch, currentAssistant, displayMode, isSessionListCurrent, searchQuery, sessionMgr, setCurrentWorkspace, setError, setSessions, t]);

  const catalogReadRef = useRef<() => Promise<void>>(async () => {});
  catalogReadRef.current = async () => {
    await Promise.all([refreshData(), loadWorkspaceList()]);
  };
  const catalogSubscriptionRef = useRef<ReturnType<typeof subscribeHostCatalog> | null>(null);
  useEffect(() => {
    if (targetInitializing) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    const subscription = subscribeHostCatalog(sessionMgr, async () => {
      if (isSessionListCurrent(targetEpoch)) await catalogReadRef.current();
    }, (error) => {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(error)) {
        setError(error instanceof Error ? error.message : String(error));
      }
    });
    catalogSubscriptionRef.current = subscription;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void subscription.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      subscription.close();
      if (catalogSubscriptionRef.current === subscription) catalogSubscriptionRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [captureSessionListEpoch, controlTargetEpoch, isSessionListCurrent, sessionMgr, setError, targetInitializing]);

  useEffect(() => {
    const workspacePath = displayMode === 'assistant' ? currentAssistant?.path : currentWorkspace?.path;
    if (!workspacePath) return;
    // Skip the redundant first load when init() already loaded this workspace
    // on this control target. Otherwise the state change from init() triggers
    // a second loadFirstPage 250 ms later, causing an extra network round-trip
    // and a loading flicker. The key is the workspace identity, not its path.
    const loadKey = initialLoadKey(
      sessionMgr.controlTargetDeviceId,
      displayMode === 'assistant' ? currentAssistant : currentWorkspace,
    );
    if (loadKey !== undefined && initLoadedWorkspaceRef.current === loadKey) {
      initLoadedWorkspaceRef.current = undefined;
      return;
    }
    const identity = displayMode === 'assistant'
      ? assistantIdentity(currentAssistant)
      : commandIdentity(currentWorkspace);
    const timer = setTimeout(() => {
      loadFirstPage(workspacePath, searchQuery, identity);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    currentAssistant?.workspace_id,
    currentAssistant?.path,
    currentWorkspace?.workspace_id,
    currentWorkspace?.path,
    currentWorkspace?.remote_connection_id,
    currentWorkspace?.remote_ssh_host,
    displayMode,
    loadFirstPage,
    searchQuery,
    sessionMgr,
  ]);

  const PULL_THRESHOLD = 60;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const el = listRef.current;
    if (!el || el.scrollTop > 0 || refreshing) return;
    touchStartY.current = e.touches[0].clientY;
    isPulling.current = true;
  }, [refreshing]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPulling.current) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    if (delta > 0) {
      setPullDistance(Math.min(delta * 0.5, 80));
    } else {
      isPulling.current = false;
      setPullDistance(0);
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;
    isPulling.current = false;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    if (pullDistance >= PULL_THRESHOLD) {
      setRefreshing(true);
      setPullDistance(PULL_THRESHOLD);
      await (catalogSubscriptionRef.current?.refresh() ?? refreshData());
      if (isSessionListCurrent(targetEpoch)) setRefreshing(false);
    }
    if (isSessionListCurrent(targetEpoch)) setPullDistance(0);
  }, [captureSessionListEpoch, isSessionListCurrent, pullDistance, refreshData]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      const workspacePath = displayMode === 'assistant' ? currentAssistant?.path : currentWorkspace?.path;
      const identity = displayMode === 'assistant'
        ? assistantIdentity(currentAssistant)
        : commandIdentity(currentWorkspace);
      loadNextPage(workspacePath, searchQuery, identity);
    }
  }, [
    displayMode,
    currentAssistant,
    currentWorkspace,
    loadNextPage,
    searchQuery,
  ]);

  const handleCreate = useCallback(async (agentType: string) => {
    if (creating || targetInitializingRef.current) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setCreating(true);
    try {
      // Assistant mode (Claw) is scoped by the assistant workspace; Pro mode
      // (Code/Cowork) by the current workspace. IDs scope the command; paths
      // are the legacy projection for pre-ID hosts.
      const workspacePath = displayMode === 'assistant' ? currentAssistant?.path : currentWorkspace?.path;
      const identity = displayMode === 'assistant'
        ? assistantIdentity(currentAssistant)
        : commandIdentity(currentWorkspace);
      if (!workspacePath?.trim()) {
        onOpenWorkspace();
        return;
      }
      const created = await sessionMgr.createSession(agentType, undefined, workspacePath, identity);
      if (!isSessionListCurrent(targetEpoch)) return;
      const createdIdentity: RemoteWorkspaceIdentity = {
        workspaceId: created.workspace_id ?? identity.workspaceId,
        remoteConnectionId: created.remote_connection_id ?? identity.remoteConnectionId,
        remoteSshHost: created.remote_ssh_host ?? identity.remoteSshHost,
      };
      await loadFirstPage(created.workspace_path ?? workspacePath, searchQuery, createdIdentity);
      if (!isSessionListCurrent(targetEpoch)) return;
      const label = isClawAgent(agentType)
        ? t('sessions.remoteClawSession')
        : isCoworkAgent(agentType)
          ? t('sessions.remoteCoworkSession')
          : t('sessions.remoteCodeSession');
      onSelectSession(created.session_id, label, true, agentType);
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
    } finally {
      if (isSessionListCurrent(targetEpoch)) setCreating(false);
    }
  }, [
    creating,
    captureSessionListEpoch,
    currentWorkspace,
    currentAssistant,
    displayMode,
    isSessionListCurrent,
    loadFirstPage,
    onSelectSession,
    searchQuery,
    sessionMgr,
    setError,
    onOpenWorkspace,
    t,
  ]);

  const requestHarnessCreate = useCallback((workspace?: RecentWorkspaceEntry) => {
    if (creating || targetInitializingRef.current) return;
    if (sessionMgr.supportsHostCapability(REMOTE_CAPABILITY_HARNESS_PROFILES_V1)) {
      setHarnessCreateRequest({ workspace });
      return;
    }
    if (workspace) {
      void handleCreateInCompactWorkspace(workspace, 'code');
    } else {
      void handleCreate('code');
    }
  }, [creating, handleCreate, handleCreateInCompactWorkspace, sessionMgr]);

  const handleHarnessSelect = useCallback((agentType: string) => {
    const request = harnessCreateRequest;
    setHarnessCreateRequest(null);
    if (!request) return;
    if (request.workspace) {
      void handleCreateInCompactWorkspace(request.workspace, agentType);
    } else {
      void handleCreate(agentType);
    }
  }, [handleCreate, handleCreateInCompactWorkspace, harnessCreateRequest]);

  const handleSelectMode = useCallback(async (mode: DisplayMode) => {
    if (targetInitializingRef.current) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    setDisplayMode(mode);
    setShowAssistantPicker(false);
    if (mode === 'assistant') {
      const assistant = await loadAssistantList();
      if (!isSessionListCurrent(targetEpoch)) return;
      loadFirstPage(assistant?.path, searchQuery, assistantIdentity(assistant));
    } else {
      if (currentWorkspace?.path) {
        await loadFirstPage(currentWorkspace.path, searchQuery, commandIdentity(currentWorkspace));
      } else {
        await trySelectFirstProWorkspace();
      }
    }
  }, [captureSessionListEpoch, currentWorkspace, isSessionListCurrent, loadAssistantList, loadFirstPage, searchQuery, trySelectFirstProWorkspace]);

  const handleSelectAssistant = useCallback(async (assistant: AssistantEntry) => {
    if (targetInitializingRef.current) return;
    const targetEpoch = captureSessionListEpoch();
    if (targetEpoch === null) return;
    try {
      const result = await sessionMgr.setAssistant(assistant);
      if (!isSessionListCurrent(targetEpoch)) return;
      if (!result.success) {
        setError(result.error || t('workspace.failedToSetWorkspace'));
        return;
      }
      const selected: AssistantEntry = {
        ...assistant,
        workspace_id: result.workspace_id ?? assistant.workspace_id,
        path: result.path || assistant.path,
        name: result.name || assistant.name,
      };
      setCurrentAssistant(selected);
      setShowAssistantPicker(false);
      loadFirstPage(selected.path, searchQuery, assistantIdentity(selected));
    } catch (e: any) {
      if (isSessionListCurrent(targetEpoch) && !isRemoteControlTargetChangedError(e)) {
        setError(describeRemoteError(e, t));
      }
    }
  }, [captureSessionListEpoch, isSessionListCurrent, loadFirstPage, searchQuery, sessionMgr, setCurrentAssistant, setError, t]);

  const workspaceDisplayName = currentWorkspace?.project_name || t('sessions.noWorkspaceSelected');
  const assistantDisplayName = currentAssistant?.name || t('shared.agents.default');
  const isProMode = displayMode === 'pro';

  if (compact) {
    const query = searchQuery.trim().toLocaleLowerCase();
    const compactWorkspaces = workspaceList;
    const activeDeviceId = client?.targetDeviceId
      ?? null;
    const projectedCompactDevices = !activeDeviceId || compactDevices.some((device) => (
      device.device_id === activeDeviceId
    ))
      ? compactDevices
      : [{
          device_id: activeDeviceId,
          device_name: client?.targetDeviceId
            ? controlTarget?.deviceName || client.targetDeviceId
            : t('devices.pairedDesktopName'),
          online: connectionHealth !== 'unreachable',
        }, ...compactDevices];

    return (
      <div className="harmony-sidebar">
        <header className="harmony-sidebar__header">
          <h1>OpenBitFun</h1>
          <MobileIconButton
            appearance="floating"
            className="harmony-sidebar__round-action"
            aria-label={t('shared.tools.search')}
            icon={(
              <LucideSearch stroke="currentColor" aria-hidden="true" />
            )}
            onClick={() => {
              setCompactSearchOpen((open) => !open);
              if (compactSearchOpen) setSearchQuery('');
            }}
            selected={compactSearchOpen}
          />
        </header>

        {compactSearchOpen && (
          <MobileTextField
            className="harmony-sidebar__search"
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('sessions.searchSessions')}
            autoFocus
          />
        )}

        <div className="harmony-sidebar__scroll">
          <MobileSection className="harmony-sidebar__section">
            <div className="harmony-sidebar__section-heading">
              <h2>{t('devices.title')}</h2>
              <span className="harmony-sidebar__heading-actions">
                <MobileIconButton appearance="plain" size="sm" aria-label={t('devices.refresh')} loading={compactDirectoryLoading} onClick={() => void loadCompactDirectory()} icon={<LucideRefreshCw className={compactDirectoryLoading ? 'is-spinning' : ''} width="20" height="20" stroke="currentColor" aria-hidden="true" />} />
              </span>
            </div>
            <div className="harmony-sidebar__rows">
              {projectedCompactDevices.slice(0, compactVisibleDeviceCount).map((device) => {
                const isCurrent = device.device_id === compactSelectedDeviceId;
                const isSwitching = device.device_id === compactSwitchingDeviceId;
                return (
                  <MobileButton
                    appearance="plain"
                    block
                    className={`harmony-sidebar__device-row${isCurrent ? ' is-current' : ''}`}
                    key={device.device_id}
                    disabled={!device.online || (!!compactSwitchingDeviceId && !isSwitching)}
                    onClick={() => void handleSelectCompactDevice(device)}
                  >
                    <span className="harmony-sidebar__device-icon" aria-hidden="true">
                      <CompactDeviceIcon name={device.device_name || device.device_id}/>
                    </span>
                    <span className="harmony-sidebar__row-label">{device.device_name || device.device_id}</span>
                    {isSwitching
                      ? <span className="spinner harmony-sidebar__row-spinner"/>
                      : <span className={`harmony-sidebar__status${device.online ? ' is-online' : ''}`}/>}
                  </MobileButton>
                );
              })}
              {projectedCompactDevices.length > compactVisibleDeviceCount && (
                <MobileButton appearance="plain" block className="harmony-sidebar__more-row" onClick={() => setCompactVisibleDeviceCount((count) => count + 3)}>
                  <span>···</span>{t('shell.moreDevices', { count: projectedCompactDevices.length - compactVisibleDeviceCount })}
                </MobileButton>
              )}
            </div>
          </MobileSection>

          {compactSelectedDeviceId && (
            <MobileSection className="harmony-sidebar__section harmony-sidebar__section--workspaces">
              <div className="harmony-sidebar__section-heading">
                <h2>{t('shared.features.workspace')}</h2>
                <MobileIconButton appearance="plain" size="sm" aria-label={t('workspace.selectWorkspace')} onClick={onOpenWorkspace} icon={<LucidePlus width="20" height="20" stroke="currentColor" aria-hidden="true" />} />
              </div>
              <div className="harmony-sidebar__rows">
                {workspaceCatalogSource === 'recent' && (
                  <MobileBanner tone="info">{t('sessions.legacyWorkspaceCatalog')}</MobileBanner>
                )}
                {compactDirectoryLoading && compactWorkspaces.length === 0 && (
                  <MobileStatus className="harmony-sidebar__empty" loading title={t('common.loading')} />
                )}
                {!compactDirectoryLoading && compactWorkspaces.length === 0 && (
                  <MobileStatus className="harmony-sidebar__empty" description={connectionHealth === 'unreachable' ? t('sessions.connectionUnreachable') : t('sessions.noWorkspaces')} />
                )}
                {compactWorkspaces.slice(0, compactVisibleWorkspaceCount).map((workspace) => {
                  const key = compactWorkspaceKey(workspace);
                  const expanded = query.length > 0 || compactExpandedWorkspaces.has(key);
                  const projectedSessions = sessions.filter((session) => (
                    sessionMatchesWorkspace(session, workspace, compactWorkspaces)
                  ));
                  const workspaceSessions = (compactWorkspaceSessions[key] ?? projectedSessions).filter(session => !query || (session.name || '').toLocaleLowerCase().includes(query));
                  const status = compactWorkspaceStatuses[key]
                    ?? (projectedSessions.length > 0 ? 'ready' : 'idle');
                  const visibleCount = compactVisibleSessionCounts[key] ?? 3;
                  const current = sameWorkspace(currentWorkspace, workspace);
                  return (
                    <div className="harmony-sidebar__workspace-group" key={key}>
                      <div className={`harmony-sidebar__workspace-row${current ? ' is-current' : ''}`}>
                        <MobileButton appearance="plain" block className="harmony-sidebar__workspace-main" onClick={() => void handleToggleCompactWorkspace(workspace)}>
                          <span className="harmony-sidebar__folder-icon" aria-hidden="true">
                            <LucideFolder width="21" height="21" stroke="currentColor" aria-hidden="true" />
                          </span>
                          <span className="harmony-sidebar__workspace-copy">
                            <span className="harmony-sidebar__row-label">{workspace.name || workspace.path}</span>
                            {workspace.remote_ssh_host && (
                              <span className="harmony-sidebar__workspace-host" title={workspace.remote_ssh_host}>
                                {workspace.remote_ssh_host}
                              </span>
                            )}
                          </span>
                        </MobileButton>
                        <MobileIconButton appearance="plain" size="sm" className={`harmony-sidebar__workspace-disclosure${expanded ? ' is-expanded' : ''}`} onClick={() => void handleToggleCompactWorkspace(workspace)} aria-label={expanded ? t('common.close') : t('sessions.sessionHistory')} icon={<LucideChevronRight width="14" height="14" stroke="currentColor" aria-hidden="true" />} />
                        <MobileIconButton appearance="plain" size="sm" className="harmony-sidebar__row-plus" onClick={() => requestHarnessCreate(workspace)} aria-label={`${workspace.name} · ${t('common.more')}`} disabled={creating} icon={<LucidePlus width="20" height="20" stroke="currentColor" aria-hidden="true" />} />
                      </div>
                      {expanded && (
                        <div className="harmony-sidebar__workspace-sessions">
                          {status === 'loading' && <MobileStatus className="harmony-sidebar__workspace-message" loading title={t('sessions.loadingSessions')} />}
                          {status === 'failed' && <MobileButton appearance="plain" block className="harmony-sidebar__workspace-message" onClick={() => void handleRetryCompactWorkspace(workspace)}>{t('devices.retry')}</MobileButton>}
                          {status === 'ready' && workspaceSessions.length === 0 && <MobileStatus className="harmony-sidebar__workspace-message" description={t('sessions.noSessions')} />}
                          {workspaceSessions.slice(0, visibleCount).map((session) => (
                            <div
                              className={`harmony-sidebar__workspace-session${activeSessionId === session.session_id ? ' is-current' : ''}`}
                              key={session.session_id}
                              onContextMenu={(event) => { event.preventDefault(); setMenuSession(session); }}
                            >
                              <MobileButton appearance="plain" block className="harmony-sidebar__session-main" onClick={(event) => handleSessionClick(session, event)}>
                                <span className="harmony-sidebar__session-icon" aria-hidden="true"><LucideMessageCircle width="18" height="18" stroke="currentColor" /></span>
                                <span className="harmony-sidebar__row-label">{session.name || t('sessions.untitledSession')}</span>
                              </MobileButton>
                              <MobileIconButton
                                appearance="plain"
                                size="sm"
                                className="harmony-sidebar__session-more"
                                aria-label={t('sessions.sessionActions')}
                                onClick={(event) => { event.stopPropagation(); setMenuSession(session); }}
                                icon={<LucideEllipsis width="18" height="18" aria-hidden="true" />}
                              />
                            </div>
                          ))}
                          {(workspaceSessions.length > visibleCount || compactWorkspaceHasMore[key]) && (
                            <MobileButton
                              appearance="plain"
                              block
                              className="harmony-sidebar__session-main harmony-sidebar__load-more"
                              onClick={() => void handleLoadMoreCompactWorkspace(workspace)}
                              disabled={compactWorkspaceLoadingMore.has(key)}
                            >
                              {compactWorkspaceLoadingMore.has(key)
                                ? <><span className="spinner"/>{t('sessions.loadingMore')}</>
                                : <><span className="harmony-sidebar__session-icon" aria-hidden="true"><LucideChevronRight className="harmony-sidebar__more-chevron" width="14" height="14" /></span><span className="harmony-sidebar__row-label">{t('shell.expandMore')}</span></>}
                            </MobileButton>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {compactWorkspaces.length > compactVisibleWorkspaceCount && (
                  <MobileButton appearance="plain" block className="harmony-sidebar__more-row" onClick={() => setCompactVisibleWorkspaceCount((count) => count + 3)}>
                    <span>···</span>{t('shell.moreWorkspaces', { count: compactWorkspaces.length - compactVisibleWorkspaceCount })}
                  </MobileButton>
                )}
              </div>
            </MobileSection>
          )}


        </div>

        <MobileFloatingActions
          className="harmony-sidebar__footer"
          leading={(
            <MobileButton appearance="secondary" className="harmony-sidebar__workspace-tools" onClick={onOpenDeviceTools} disabled={creating || targetInitializing} leading={<LucideWrench width="20" height="20" stroke="currentColor" aria-hidden="true" />}>
              <span>{t('workspace.tools')}</span>
            </MobileButton>
          )}
          trailing={(
            <MobileIconButton
              appearance="floating"
              className="harmony-sidebar__settings"
              onClick={() => setCompactSettingsOpen(true)}
              aria-label={t('shared.features.settings')}
              icon={<LucideSettings stroke="currentColor" aria-hidden="true" />}
            />
          )}
        />

        <CompactSettingsSheet
          accountLabel={authenticatedUserLabel}
          accountUserId={authenticatedUserId}
          accountAvatarUrl={githubProfile?.avatarUrl}
          devices={projectedCompactDevices}
          isDark={isDark}
          onClose={() => setCompactSettingsOpen(false)}
          onDisconnectRequest={() => { setCompactSettingsOpen(false); setShowDisconnectConfirm(true); }}
          onOpenDevices={onOpenDevices ? () => { setCompactSettingsOpen(false); onOpenDevices(); } : undefined}
          onSelectDevice={(device) => void handleSelectCompactDevice(device)}
          onToggleTheme={toggleTheme}
          open={compactSettingsOpen}
          renderDeviceIcon={(name) => <CompactDeviceIcon name={name} />}
          selectedDeviceId={compactSelectedDeviceId}
        />

        <SessionOverlays
          compact
          deleteTarget={deleteConfirmTarget}
          deleting={deleting}
          harnessOpen={harnessCreateRequest !== null}
          menuSession={menuSession}
          onCloseDelete={() => !deleting && setDeleteConfirmTarget(null)}
          onCloseDisconnect={() => setShowDisconnectConfirm(false)}
          onCloseHarness={() => setHarnessCreateRequest(null)}
          onCloseMenu={() => setMenuSession(null)}
          onCloseRename={() => !renaming && setRenameTarget(null)}
          onConfirmDelete={() => void handleDelete()}
          onConfirmDisconnect={() => { setShowDisconnectConfirm(false); onDisconnect(); }}
          onConfirmRename={() => void handleRename()}
          onDeleteRequest={setDeleteConfirmTarget}
          onHarnessSelect={handleHarnessSelect}
          onRenameRequest={(session) => { setRenameTarget(session); setRenameValue(session.name || ''); }}
          onRenameValueChange={setRenameValue}
          renameTarget={renameTarget}
          renameValue={renameValue}
          renaming={renaming}
          showDisconnectConfirm={showDisconnectConfirm}
        />
      </div>
    );
  }

  return (
    <div className="session-list">
      <div className="session-list__header">
        <div className="session-list__header-brand">
          <img src={logoMark} alt="OpenBitFun" className="session-list__logo" />
          <div className="session-list__header-copy">
            <h1>OpenBitFun</h1>
            {authenticatedUserLabel && (
              <span className="session-list__header-account-name">
                <span className={`session-list__health-dot session-list__health-dot--${connectionHealth}`} title={(() => { switch (connectionHealth) { case 'connected': return t('sessions.connectionConnected'); case 'checking': return t('sessions.connectionChecking'); case 'unreachable': return t('sessions.connectionUnreachable'); default: return t('sessions.connectionUnpaired'); } })()} />
                <AccountAvatar url={githubProfile?.avatarUrl} />
                <span title={t('settings.githubId', { id: authenticatedUserId || '' })}>{authenticatedUserLabel}</span>
                {controlTarget && controlTarget.deviceName && (
                  <span className="session-list__header-target" title={t('devices.controllingDevice', { name: controlTarget.deviceName })}>
                    {controlTarget.deviceName}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="session-list__header-actions">
          {onOpenDevices && (
            <MobileIconButton
              appearance="plain"
              className={`session-list__devices-btn ${controlTarget ? 'is-remote' : ''}`}
              onClick={onOpenDevices}
              title={t('devices.title')} aria-label={t('devices.title')} icon={<LucideMonitor width="16" height="16" stroke="currentColor" aria-hidden="true" />} />
          )}
          <LanguageToggleButton className="session-list__language-btn" />
          <MobileIconButton appearance="plain" className="session-list__theme-btn" onClick={toggleTheme} aria-label={t('common.toggleTheme')} icon={<ThemeToggleIcon isDark={isDark} />} />
          <MobileIconButton appearance="plain" className="session-list__disconnect-btn" onClick={() => setShowDisconnectConfirm(true)} aria-label={t('sessions.disconnect')} title={t('sessions.disconnect')} icon={<LucideLogOut width="16" height="16" stroke="currentColor" aria-hidden="true" />} />
        </div>
      </div>

      <div
        className="session-list__items"
        ref={listRef}
        onScroll={handleScroll}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {(pullDistance > 0 || refreshing) && (
          <div
            className="session-list__pull-indicator"
            style={{ height: refreshing ? PULL_THRESHOLD : pullDistance }}
          >
            <div className={`session-list__pull-spinner${refreshing || pullDistance >= PULL_THRESHOLD ? ' is-active' : ''}`}>
              <LucideLoaderCircle width="18" height="18" style={{ transform: `rotate(${pullDistance * 4}deg)`, transition: refreshing ? 'transform 0s' : undefined }} aria-hidden="true" />
            </div>
          </div>
        )}

        {/* Resume Card — quick continue for the most recent session */}
        {showResumeCard && (
          <MobileButton
            appearance="secondary"
            block
            className={`session-list__resume-card${activeSessionId === sessions[0].session_id ? ' is-selected' : ''}`}
            onClick={(e) => handleSessionClick(sessions[0], e)}
            onTouchStart={(e) => handleSessionTouchStart(sessions[0], e)}
            onTouchMove={handleSessionTouchMove}
            onTouchEnd={handleSessionTouchEnd}
            onTouchCancel={handleSessionTouchEnd}
            onContextMenu={(e) => { e.preventDefault(); setMenuSession(sessions[0]); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectSession(sessions[0].session_id, sessions[0].name, false, sessions[0].agent_type);
              }
            }}
          >
            <div className={`session-list__item-icon session-list__resume-icon session-list__item-icon--${sessions[0].agent_type}`}>
              <SessionTypeIcon agentType={sessions[0].agent_type} />
            </div>
            <div className="session-list__resume-body">
              <div className="session-list__resume-label">{t('sessions.continueSession')}</div>
              <div className="session-list__resume-name">{sessions[0].name || t('sessions.untitledSession')}</div>
              <div className="session-list__resume-meta">
                <span className={`session-list__agent-badge session-list__agent-badge--${sessions[0].agent_type}`}>
                  {agentLabel(sessions[0].agent_type, t)}
                </span>
                <span className="session-list__resume-time">{formatTime(sessions[0].updated_at, formatDate, t)}</span>
              </div>
            </div>
            <span className="session-list__resume-arrow">
              <LucideChevronRight width="18" height="18" stroke="currentColor" aria-hidden="true" />
            </span>
          </MobileButton>
        )}

        {/* Mode Toggle - Inline */}
        <MobileSegmentedControl
          aria-label={t('shared.modes.expert')}
          className="session-list__mode-toggle"
          onChange={handleSelectMode}
          options={[
            { disabled: targetInitializing, label: <><ProModeIcon /><span>{t('shared.modes.expert')}</span></>, value: 'pro' },
            { disabled: targetInitializing, label: <><AssistantModeIcon /><span>{t('shared.modes.assistant')}</span></>, value: 'assistant' },
          ]}
          value={displayMode}
        />

        {/* Pro Mode: Workspace Selection Required */}
        {isProMode && (
          <>
            <MobileButton
              appearance="plain"
              block
              className="session-list__workspace-bar"
              onClick={() => {
                if (targetInitializingRef.current) return;
                loadWorkspaceList();
                setShowWorkspacePicker(true);
              }}
            >
              <span className="session-list__workspace-icon">
                <WorkspaceIcon />
              </span>
              <div className="session-list__workspace-copy">
                <span className="session-list__workspace-label">{t('shared.features.workspace')}</span>
                <span className="session-list__workspace-name" title={workspaceDisplayName}>{truncateMiddle(workspaceDisplayName, 24)}</span>
              </div>
              {currentWorkspace?.git_branch && (
                <span className="session-list__workspace-branch">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                  {truncateMiddle(currentWorkspace.git_branch, 20)}
                </span>
              )}
              <span className="session-list__workspace-switch" aria-label={t('sessions.switchWorkspace')}>
                <LucideChevronsUpDown width="16" height="16" stroke="currentColor" aria-hidden="true" />
              </span>
            </MobileButton>

            <MobileChoiceSheet
              className="session-list__picker-modal session-list__picker-modal--workspace"
              emptyContent={<MobileStatus title={t('sessions.noWorkspaces')} />}
              headerAction={<MobileIconButton appearance="plain" className="session-list__picker-close" onClick={() => setShowWorkspacePicker(false)} aria-label={t('common.close')} icon={<LucideX width="20" height="20" stroke="currentColor" aria-hidden="true" />} />}
              onOpenChange={() => setShowWorkspacePicker(false)}
              onSelect={(value) => {
                const workspace = workspaceList[Number(value)];
                if (workspace) void handleSelectWorkspace(workspace);
              }}
              open={showWorkspacePicker}
              optionAppearance="plain"
              options={workspaceList.map((workspace, index) => {
                // Option values are row positions; the selected row is found by
                // workspace identity (ID first, legacy triple for ID-less rows).
                const selected = sameWorkspace(currentWorkspace, workspace);
                return {
                  className: `session-list__picker-item session-list__picker-item--workspace ${selected ? 'is-selected' : ''}`,
                  label: workspace.remote_ssh_host
                    ? `${workspace.name} · ${workspace.remote_ssh_host}`
                    : workspace.name,
                  leading: <span className="session-list__picker-item-icon"><WorkspaceIcon /></span>,
                  trailing: selected ? <LucideCheck width="16" height="16" stroke="currentColor" aria-hidden="true" /> : undefined,
                  value: String(index),
                };
              })}
              selectedValue={(() => {
                const index = workspaceList.findIndex((workspace) => sameWorkspace(currentWorkspace, workspace));
                return index >= 0 ? String(index) : undefined;
              })()}
              showHandle={false}
              title={t('sessions.selectWorkspace')}
            />
          </>
        )}

        {/* Assistant Mode: Assistant Selection */}
        {!isProMode && (
          <>
            <MobileButton
              appearance="plain"
              block
              className="session-list__assistant-bar"
              onClick={() => {
                if (targetInitializingRef.current) return;
                loadAssistantList();
                setShowAssistantPicker(true);
              }}
            >
              <span className="session-list__assistant-icon">
                <AssistantModeIcon />
              </span>
              <div className="session-list__assistant-copy">
                <span className="session-list__assistant-label">{t('sessions.assistant')}</span>
                <span className="session-list__assistant-name">{assistantDisplayName}</span>
              </div>
              <span className="session-list__assistant-switch" aria-label={t('sessions.switchAssistant')}>
                <LucideChevronsUpDown width="16" height="16" stroke="currentColor" aria-hidden="true" />
              </span>
            </MobileButton>

            <MobileChoiceSheet
              className="session-list__picker-modal"
              headerAction={<MobileIconButton appearance="plain" className="session-list__picker-close" onClick={() => setShowAssistantPicker(false)} aria-label={t('common.close')} icon={<LucideX width="20" height="20" stroke="currentColor" aria-hidden="true" />} />}
              onOpenChange={() => setShowAssistantPicker(false)}
              onSelect={(value) => {
                const assistant = assistantList[Number(value)];
                if (assistant) void handleSelectAssistant(assistant);
              }}
              open={showAssistantPicker}
              optionAppearance="plain"
              options={assistantList.map((assistant, index) => {
                const selected = sameWorkspace(currentAssistant, assistant);
                return {
                  className: `session-list__picker-item ${selected ? 'is-selected' : ''}`,
                  label: assistant.name,
                  leading: <span className="session-list__picker-item-icon"><AssistantModeIcon /></span>,
                  trailing: selected ? <LucideCheck width="16" height="16" stroke="currentColor" aria-hidden="true" /> : undefined,
                  value: String(index),
                };
              })}
              selectedValue={(() => {
                const index = assistantList.findIndex((assistant) => sameWorkspace(currentAssistant, assistant));
                return index >= 0 ? String(index) : undefined;
              })()}
              showHandle={false}
              title={t('sessions.selectAssistant')}
            />
          </>
        )}

        <SessionLaunchPanel
          creating={creating}
          hasWorkspace={!!currentWorkspace}
          isProMode={isProMode}
          targetInitializing={targetInitializing}
          onCreateClaw={() => void handleCreate('claw')}
          onCreateCowork={() => void handleCreate('cowork')}
          onRequestCodeHarness={() => requestHarnessCreate()}
          renderSessionIcon={(agentType) => <SessionTypeIcon agentType={agentType} />}
        />

        <SessionHistoryPanel
          activeSessionId={activeSessionId}
          hasSearchQuery={hasSearchQuery}
          isProMode={isProMode}
          loading={loading}
          loadingMore={loadingMore}
          menuSessionId={menuSession?.session_id}
          searchQuery={searchQuery}
          sessions={sessions.slice(showResumeCard ? 1 : 0)}
          totalSessionCount={sessions.length}
          targetInitializing={targetInitializing}
          onOpenMenu={setMenuSession}
          onSearchQueryChange={setSearchQuery}
          onSessionClick={handleSessionClick}
          onSessionTouchEnd={handleSessionTouchEnd}
          onSessionTouchMove={handleSessionTouchMove}
          onSessionTouchStart={handleSessionTouchStart}
          renderAgentLabel={(agentType) => agentLabel(agentType, t)}
          renderSessionIcon={(agentType) => <SessionTypeIcon agentType={agentType} />}
          renderSessionTime={(updatedAt) => formatTime(updatedAt, formatDate, t)}
        />
      </div>

      <SessionOverlays
        compact={false}
        deleteTarget={deleteConfirmTarget}
        deleting={deleting}
        harnessOpen={harnessCreateRequest !== null}
        menuSession={menuSession}
        onCloseDelete={() => !deleting && setDeleteConfirmTarget(null)}
        onCloseDisconnect={() => setShowDisconnectConfirm(false)}
        onCloseHarness={() => setHarnessCreateRequest(null)}
        onCloseMenu={() => setMenuSession(null)}
        onCloseRename={() => !renaming && setRenameTarget(null)}
        onConfirmDelete={() => void handleDelete()}
        onConfirmDisconnect={() => { setShowDisconnectConfirm(false); onDisconnect(); }}
        onConfirmRename={() => void handleRename()}
        onDeleteRequest={setDeleteConfirmTarget}
        onHarnessSelect={handleHarnessSelect}
        onRenameRequest={(session) => { setRenameTarget(session); setRenameValue(session.name || ''); }}
        onRenameValueChange={setRenameValue}
        renameTarget={renameTarget}
        renameValue={renameValue}
        renaming={renaming}
        showDisconnectConfirm={showDisconnectConfirm}
      />

      {/* Action Toast */}
      {actionToast && <MobileBanner className="session-list__toast" role="alert" aria-live="assertive">{actionToast}</MobileBanner>}
    </div>
  );
};

export default SessionListPage;
