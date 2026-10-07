import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmWarning } from '@/infrastructure/confirm-dialog';
import { notificationService } from '@/shared/notification-system';
import type { Session } from '../types/flow-chat';
import { flowChatStore } from '../store/FlowChatStore';
import {
  dismissResumePrompt,
  resumePromptKey,
  shouldOpenResumePrompt,
  threadGoalActionsForStatus,
  type ThreadGoalUiAction,
} from '../services/threadGoalActions';
import { parseGoalCommand } from '../services/goalCommandParser';
import {
  fetchSessionThreadGoal,
  runGoalCommandSafely,
  runThreadGoalUiAction,
  saveThreadGoalObjective,
  type ThreadGoalSnapshot,
} from '../services/goalService';

const HISTORICAL_THREAD_GOAL_REFRESH_DELAY_MS = 350;

export interface ThreadGoalController {
  goal: ThreadGoalSnapshot | null;
  menuOpen: boolean;
  editOpen: boolean;
  editMode: 'create' | 'update';
  editInitialObjective: string;
  resumeOpen: boolean;
  availableActions: ThreadGoalUiAction[];
  openMenu: () => void;
  openEdit: (mode?: 'create' | 'update') => void;
  closeMenu: () => void;
  closeEdit: () => void;
  closeResume: () => void;
  refreshGoal: () => Promise<void>;
  /** Fetch latest goal from backend, then open menu or create dialog. */
  openGoalEntry: () => Promise<void>;
  runSlashAction: (message: string) => Promise<ThreadGoalSnapshot | null>;
  runUiAction: (action: 'clear' | 'pause' | 'resume') => Promise<void>;
  saveEdit: (objective: string) => Promise<void>;
  confirmResume: () => Promise<void>;
  dismissResume: () => void;
}

function readStoreGoal(sessionId: string | undefined): ThreadGoalSnapshot | null {
  if (!sessionId) return null;
  const raw = flowChatStore.getState().sessions.get(sessionId)?.threadGoal;
  if (!raw) return null;
  return {
    goalId: raw.goalId,
    objective: raw.objective,
    status: raw.status,
    tokensUsed: raw.tokensUsed,
    tokenBudget: raw.tokenBudget,
    timeUsedSeconds: raw.timeUsedSeconds,
    updatedAt: raw.updatedAt,
  };
}

function threadGoalSnapshotCacheKey(
  sessionId: string | undefined,
  goal: ThreadGoalSnapshot | null
): string {
  if (!sessionId) return '';
  if (!goal) return `${sessionId}:null`;
  return [
    sessionId,
    goal.goalId ?? '',
    goal.status,
    goal.objective,
    goal.updatedAt ?? '',
    goal.tokensUsed ?? '',
    goal.tokenBudget ?? '',
    goal.timeUsedSeconds ?? '',
  ].join('|');
}

/** useSyncExternalStore requires a stable snapshot reference when store data is unchanged. */
function useStableThreadGoalSnapshot(sessionId: string | undefined): ThreadGoalSnapshot | null {
  const cacheRef = useRef<{ key: string; snapshot: ThreadGoalSnapshot | null }>({
    key: '',
    snapshot: null,
  });

  const subscribe = useCallback(
    (onStoreChange: () => void) => flowChatStore.subscribe(() => onStoreChange()),
    []
  );

  const getSnapshot = useCallback(() => {
    const next = readStoreGoal(sessionId);
    const key = threadGoalSnapshotCacheKey(sessionId, next);
    if (cacheRef.current.key === key) {
      return cacheRef.current.snapshot;
    }
    cacheRef.current = { key, snapshot: next };
    return next;
  }, [sessionId]);

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function useThreadGoalController(
  session: Session | undefined,
  options?: { isBtwSession?: boolean; disabled?: boolean; sceneActive?: boolean }
): ThreadGoalController {
  const { t } = useTranslation('flow-chat');
  const sessionId = session?.sessionId;
  const isBtwSession = Boolean(options?.isBtwSession);
  const disabled = isBtwSession || Boolean(options?.disabled);
  const sceneActive = options?.sceneActive ?? true;

  const storeGoal = useStableThreadGoalSnapshot(sessionId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState<'create' | 'update'>('update');
  const [editInitialObjective, setEditInitialObjective] = useState('');
  const [resumeOpen, setResumeOpen] = useState(false);
  const lastResumePromptKey = useRef<string | null>(null);
  /**
   * Goal the user paused on purpose. A pause the user asked for is not an
   * interruption to report back, so it must not raise the resume prompt; a pause
   * that happened for another reason (a stopped turn, a usage limit) still does.
   */
  const userPausedGoalId = useRef<string | null>(null);

  const goal = storeGoal;

  const titles = useMemo(
    () => ({
      usageMessage: t('chatInput.goalUsage'),
      failedTitle: t('chatInput.goalFailed'),
      unknownErrorMessage: t('error.unknown'),
      activatedTitle: t('chatInput.goalActivated'),
      clearedTitle: t('chatInput.goalCleared'),
      pausedTitle: t('chatInput.goalPaused'),
      resumedTitle: t('chatInput.goalResumed'),
      editedTitle: t('chatInput.goalEdited'),
      replaceConfirmTitle: t('threadGoal.replaceConfirmTitle'),
      replaceConfirmMessage: t('threadGoal.replaceConfirmMessage'),
    }),
    [t]
  );

  const refreshGoal = useCallback(async () => {
    if (!sessionId || disabled) return;
    const current = flowChatStore.getState().sessions.get(sessionId);
    if (!current?.workspacePath) return;
    try {
      await fetchSessionThreadGoal(current);
    } catch {
      // best-effort; UI still works from events
    }
  }, [disabled, sessionId]);

  useEffect(() => {
    if (!sessionId || disabled) return;
    if (session?.isHistorical) {
      const timeoutId = globalThis.setTimeout(() => {
        void refreshGoal();
      }, HISTORICAL_THREAD_GOAL_REFRESH_DELAY_MS);
      return () => globalThis.clearTimeout(timeoutId);
    }
    void refreshGoal();
  }, [session?.isHistorical, sessionId, disabled, refreshGoal]);

  /** Which session the user is actually looking at through this controller. */
  const visitKey = sceneActive && sessionId ? sessionId : null;

  /**
   * Every scene stays mounted, so a paused goal must not raise its modal over
   * whatever scene is in front. Leaving this session — or opening another one —
   * retracts the prompt and re-arms the gate, which brings the prompt back when
   * the user opens the paused session again. Declared before the effect below
   * so a new visit re-arms first and can then re-open in the same commit.
   */
  useEffect(() => {
    lastResumePromptKey.current = null;
    setResumeOpen(false);
  }, [visitKey]);

  useEffect(() => {
    if (
      !shouldOpenResumePrompt({
        sessionId,
        goal,
        sceneActive,
        disabled,
        lastPromptedKey: lastResumePromptKey.current,
      })
    ) {
      return;
    }
    lastResumePromptKey.current = resumePromptKey(goal);
    // The user paused this goal from the track or the menu, so the paused state
    // they are looking at is the one they asked for.
    if (userPausedGoalId.current && goal?.goalId === userPausedGoalId.current) {
      return;
    }
    setResumeOpen(true);
  }, [disabled, goal, sceneActive, sessionId]);

  const openMenu = useCallback(() => {
    setMenuOpen(true);
  }, []);

  const confirmReplaceGoal = useCallback(
    async ({ existingObjective, newObjective }: { existingObjective: string; newObjective: string }) =>
      confirmWarning(
        titles.replaceConfirmTitle,
        t('threadGoal.replaceConfirmMessage', {
          existing: existingObjective,
          next: newObjective,
        })
      ),
    [t, titles.replaceConfirmTitle]
  );

  const openEdit = useCallback(
    (mode: 'create' | 'update' = 'update') => {
      setEditMode(mode);
      setEditInitialObjective(mode === 'update' ? (goal?.objective ?? '') : '');
      setEditOpen(true);
      setMenuOpen(false);
    },
    [goal?.objective]
  );

  const openGoalEntry = useCallback(async () => {
    if (!session?.workspacePath || disabled) return;
    const latest = await fetchSessionThreadGoal(session);
    if (latest) {
      setMenuOpen(true);
    } else {
      openEdit('create');
    }
  }, [disabled, openEdit, session]);

  const runSlashAction = useCallback(
    async (message: string) => {
      if (!session || disabled) return null;
      const parsed = parseGoalCommand(message);
      if (!parsed) return null;
      // `/goal pause` is the same deliberate pause as the track's control, while
      // any other goal command leaves the goal free to report an interruption.
      userPausedGoalId.current = parsed.kind === 'pause' ? (goal?.goalId ?? null) : null;

      return runGoalCommandSafely({
        session,
        action: parsed,
        ...titles,
        confirmReplaceGoal,
        onOpenMenu: g => {
          if (!g) {
            openEdit('create');
            return;
          }
          setMenuOpen(true);
        },
        onOpenEdit: (initial, mode) => {
          setEditInitialObjective(initial);
          setEditMode(mode);
          setEditOpen(true);
        },
      });
    },
    [confirmReplaceGoal, disabled, goal?.goalId, openEdit, session, titles]
  );

  const runUiAction = useCallback(
    async (action: 'clear' | 'pause' | 'resume') => {
      if (!session || disabled) return;
      // Clearing drops the objective together with the time and tokens spent on
      // it, and none of that can be recovered, so every entry point asks first.
      if (action === 'clear') {
        const confirmed = await confirmWarning(
          t('threadGoal.clearConfirmTitle'),
          t('threadGoal.clearConfirmMessage', { objective: goal?.objective ?? '' })
        );
        if (!confirmed) return;
      }
      userPausedGoalId.current = action === 'pause' ? (goal?.goalId ?? null) : null;
      try {
        await runThreadGoalUiAction(session, action, titles);
        if (action === 'clear') {
          setMenuOpen(false);
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : titles.unknownErrorMessage;
        notificationService.error(message, { title: titles.failedTitle, duration: 5000 });
      }
    },
    [disabled, goal?.goalId, goal?.objective, session, t, titles]
  );

  const saveEdit = useCallback(
    async (objective: string) => {
      if (!session || disabled) return;
      try {
        const saved = await saveThreadGoalObjective(session, objective, editMode, titles, {
          confirmReplaceGoal: editMode === 'create' ? confirmReplaceGoal : undefined,
        });
        if (!saved) {
          return;
        }
        // Saving an objective puts the goal back to work, so the pause the user
        // asked for before the edit no longer describes the goal in front of them.
        userPausedGoalId.current = null;
        setEditOpen(false);
        setMenuOpen(false);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : titles.unknownErrorMessage;
        notificationService.error(message, { title: titles.failedTitle, duration: 5000 });
      }
    },
    [confirmReplaceGoal, disabled, editMode, session, titles]
  );

  const confirmResume = useCallback(async () => {
    if (!session) return;
    await runUiAction('resume');
    setResumeOpen(false);
  }, [runUiAction, session]);

  const dismissResume = useCallback(() => {
    if (sessionId && goal) {
      dismissResumePrompt(sessionId, goal);
    }
    setResumeOpen(false);
  }, [goal, sessionId]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);
  const closeResume = useCallback(() => setResumeOpen(false), []);

  const availableActions = useMemo(
    () => (goal ? threadGoalActionsForStatus(goal.status) : []),
    [goal]
  );

  return useMemo(
    () => ({
      goal,
      menuOpen,
      editOpen,
      editMode,
      editInitialObjective,
      resumeOpen,
      availableActions,
      openMenu,
      openGoalEntry,
      openEdit,
      closeMenu,
      closeEdit,
      closeResume,
      refreshGoal,
      runSlashAction,
      runUiAction,
      saveEdit,
      confirmResume,
      dismissResume,
    }),
    [
      availableActions,
      closeEdit,
      closeMenu,
      closeResume,
      confirmResume,
      dismissResume,
      editInitialObjective,
      editMode,
      editOpen,
      goal,
      menuOpen,
      openEdit,
      openGoalEntry,
      openMenu,
      refreshGoal,
      resumeOpen,
      runSlashAction,
      runUiAction,
      saveEdit,
    ]
  );
}
