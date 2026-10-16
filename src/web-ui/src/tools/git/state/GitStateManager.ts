import { GitWorkspaceScope, gitWorkspaceKey } from '@/infrastructure/api/service-api/GitAPI';
/**
 * Git state manager - central state management for Git repositories
 * 
 * Single source of truth for all repository Git states
 * 
 * Design patterns:
 * - Singleton: global unique instance
 * - Observer: state change notifications
 * - Strategy: configurable refresh strategies
 * 
 * Features:
 * - Layered caching: basic/status/detailed three-tier data
 * - Visibility-aware: adjust refresh based on panel visibility
 * - Event-driven: auto refresh after Git operations
 * - Debounce/throttle: avoid frequent refreshes
 */

import { gitAPI } from '@/infrastructure/api';
import { gitRepositoryUntrustedPath } from '@/infrastructure/api/errors/TauriCommandError';
import { gitEventService } from '../services/GitEventService';
import { globalEventBus } from '@/infrastructure/event-bus';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { isRemoteWorkspace } from '@/shared/types/global-state';
import {
  GitState,
  GitStateLayer,
  GitStateSubscriber,
  RefreshOptions,
  RefreshReason,
  CacheConfig,
  SubscribeOptions,
  createInitialGitState,
  compareStates,
  DEFAULT_CACHE_CONFIG,
  GitStateChangedEventData,
} from './types';
import { createLogger } from '@/shared/utils/logger';
import { sendDebugProbe } from '@/shared/utils/debugProbe';
import { startupTrace } from '@/shared/utils/startupTrace';
import { elapsedMs, nowMs } from '@/shared/utils/timing';
import { i18nService } from '@/infrastructure/i18n';

const log = createLogger('GitStateManager');

interface SubscriberEntry {
  callback: GitStateSubscriber;
  options: SubscribeOptions;
}

/**
 * Git metadata changes (checkout, commit, rebase, etc.) often happen outside
 * the app — in an integrated terminal, an external Git client, a script, or
 * triggered by the agent itself. None of those emit our in-process
 * `branch:changed` / `operation:completed` events, so the UI can stay stale
 * indefinitely. Only active consumers request polling; passive subscriptions
 * still receive changes without causing IO. Remote reads open SSH exec channels,
 * so they use a slower cadence and never overlap on the same connection.
 */
const POLL_INTERVAL_MS = 2000;
const REMOTE_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_BACKOFF_MS = 300_000;

interface PollSchedule {
  failures: number;
  nextAttemptAt: number;
}

interface PendingRefresh {
  layers: Set<GitStateLayer>;
  force: boolean;
  reason: RefreshReason;
  source?: string;
  pollOnly: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

function pendingRefreshIncludesSource(pendingSource: string | undefined, source: string): boolean {
  return pendingSource?.split('|').includes(source) === true;
}

export class GitStateManager {
  private static instance: GitStateManager;

  private states = new Map<string, GitState>();
  private subscribers = new Map<string, Set<SubscriberEntry>>();
  private pollingCounts = new Map<string, number>();
  private pollSchedules = new Map<string, PollSchedule>();
  private pollingConnections = new Set<string>();
  private windowFocusRefreshCounts = new Map<string, number>();
  private refreshDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshLocks = new Map<string, Promise<void>>();
  private pendingRefreshes = new Map<string, PendingRefresh>();
  private cacheConfig: CacheConfig = { ...DEFAULT_CACHE_CONFIG };
  private readonly DEBOUNCE_DELAY = 100;
  private globalListenersInitialized = false;
  private globalListenerCleanups: Array<() => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollVisibilityCleanup: (() => void) | null = null;

  private constructor() {
    this.setupGlobalListeners();
  }

  static getInstance(): GitStateManager {
    if (!GitStateManager.instance) {
      GitStateManager.instance = new GitStateManager();
    }
    return GitStateManager.instance;
  }

  /**
   * Reset instance (for testing only)
   */
  static resetInstance(): void {
    if (GitStateManager.instance) {
      GitStateManager.instance.dispose();
      GitStateManager.instance = undefined as any;
    }
  }

  /**
   * Subscribe to repository state changes.
   * @returns Unsubscribe function.
   */
  subscribe(
    repositoryPath: GitWorkspaceScope,
    callback: GitStateSubscriber,
    options: SubscribeOptions = {}
  ): () => void {
    const normalizedPath = this.normalizePath(repositoryPath);

    if (!this.subscribers.has(normalizedPath)) {
      this.subscribers.set(normalizedPath, new Set());
    }

    const entry: SubscriberEntry = { callback, options };
    this.subscribers.get(normalizedPath)!.add(entry);

    if (options.immediate !== false) {
      const currentState = this.states.get(normalizedPath);
      if (currentState) {
        callback(currentState, null, ['basic', 'status', 'detailed']);
      }
    }

    return () => {
      const set = this.subscribers.get(normalizedPath);
      if (!set) return;
      set.delete(entry);
      if (set.size === 0) {
        this.subscribers.delete(normalizedPath);
      }
    };
  }

  /** Active consumers opt into IO separately from observing cached state. */
  registerPolling(scope: GitWorkspaceScope): () => void {
    const key = this.normalizePath(scope);
    this.pollingCounts.set(key, (this.pollingCounts.get(key) ?? 0) + 1);
    if (!this.pollSchedules.has(key)) {
      this.pollSchedules.set(key, {
        failures: 0,
        nextAttemptAt: Date.now() + this.pollPolicy(scope).intervalMs,
      });
    }
    // An activation refresh must not be swallowed by the basic layer's Infinity
    // TTL. Keep a recent read reusable when several consumers mount together.
    const lastRead = this.states.get(key)?.lastRefreshTime.basic ?? 0;
    if (Date.now() - lastRead >= this.pollPolicy(scope).intervalMs) {
      this.invalidateCache(scope, ['basic']);
    }
    this.ensurePollingStarted();
    return () => {
      const count = this.pollingCounts.get(key) ?? 0;
      if (count > 1) {
        this.pollingCounts.set(key, count - 1);
      } else {
        this.pollingCounts.delete(key);
        // Use the captured surface key; cleanup may run after a device switch.
        // A manual/operation refresh merged into this batch must still execute.
        const pending = this.pendingRefreshes.get(key);
        if (pending?.pollOnly) {
          clearTimeout(this.refreshDebounceTimers.get(key));
          this.refreshDebounceTimers.delete(key);
          this.pendingRefreshes.delete(key);
          pending.resolve();
        }
        if (this.pollingCounts.size === 0) this.stopPolling();
      }
    };
  }

  private pollPolicy(scope: GitWorkspaceScope): { intervalMs: number; connectionId?: string } {
    const workspace = workspaceManager.getState().openedWorkspaces.get(scope.workspaceId);
    if (!workspace || isRemoteWorkspace(workspace)) {
      // Missing catalog metadata must never select the aggressive local cadence.
      return {
        intervalMs: REMOTE_POLL_INTERVAL_MS,
        connectionId: workspace?.connectionId ?? scope.workspaceId,
      };
    }
    return { intervalMs: POLL_INTERVAL_MS };
  }

  private scheduleNextPoll(key: string, failed: boolean): void {
    const failures = failed ? Math.min((this.pollSchedules.get(key)?.failures ?? 0) + 1, 8) : 0;
    this.pollSchedules.set(key, {
      failures,
      nextAttemptAt: Date.now() + Math.min(
        this.pollPolicy(this.scopeForKey(key)).intervalMs * 2 ** failures,
        MAX_POLL_BACKOFF_MS,
      ),
    });
  }

  /**
   * Get current state synchronously (cached).
   */
  getState(repositoryPath: GitWorkspaceScope): GitState | null {
    const normalizedPath = this.normalizePath(repositoryPath);
    return this.states.get(normalizedPath) || null;
  }

  /**
   * Get state or create an initial one.
   */
  getOrCreateState(repositoryPath: GitWorkspaceScope): GitState {
    const normalizedPath = this.normalizePath(repositoryPath);
    let state = this.states.get(normalizedPath);

    if (!state) {
      state = createInitialGitState();
      this.states.set(normalizedPath, state);
    }

    return state;
  }

  /**
   * Request a refresh.
   */
  async refresh(
    repositoryPath: GitWorkspaceScope,
    options: RefreshOptions = {}
  ): Promise<void> {
    const normalizedPath = this.normalizePath(repositoryPath);
    const {
      force = false,
      layers = ['basic', 'status'],
      silent = false,
      reason = 'manual',
      source,
    } = options;

    return this.enqueueRefresh(normalizedPath, layers, force, reason, silent, source);
  }

  cancelPendingRefresh(
    repositoryPath: GitWorkspaceScope,
    options: {
      reason?: RefreshReason;
      source?: string;
      layers?: GitStateLayer[];
    } = {}
  ): boolean {
    const normalizedPath = this.normalizePath(repositoryPath);
    const pending = this.pendingRefreshes.get(normalizedPath);
    if (!pending) {
      return false;
    }

    if (options.reason && pending.reason !== options.reason) {
      return false;
    }
    if (options.source && !pendingRefreshIncludesSource(pending.source, options.source)) {
      return false;
    }
    if (options.layers?.some(layer => !pending.layers.has(layer))) {
      return false;
    }

    const timer = this.refreshDebounceTimers.get(normalizedPath);
    if (timer) {
      clearTimeout(timer);
      this.refreshDebounceTimers.delete(normalizedPath);
    }
    this.pendingRefreshes.delete(normalizedPath);
    pending.resolve();
    return true;
  }

  /**
   * Register a consumer that wants automatic refresh on window focus.
   * Multiple concurrent consumers for the same repository are reference-counted.
   */
  registerWindowFocusRefresh(repositoryPath: GitWorkspaceScope): () => void {
    const normalizedPath = this.normalizePath(repositoryPath);
    const nextCount = (this.windowFocusRefreshCounts.get(normalizedPath) ?? 0) + 1;
    this.windowFocusRefreshCounts.set(normalizedPath, nextCount);

    return () => {
      const currentCount = this.windowFocusRefreshCounts.get(normalizedPath) ?? 0;
      if (currentCount <= 1) {
        this.windowFocusRefreshCounts.delete(normalizedPath);
        return;
      }
      this.windowFocusRefreshCounts.set(normalizedPath, currentCount - 1);
    };
  }

  /**
   * Invalidate cache by resetting last refresh timestamps.
   */
  invalidateCache(
    repositoryPath: GitWorkspaceScope,
    layers: GitStateLayer[] = ['basic', 'status', 'detailed']
  ): void {
    const normalizedPath = this.normalizePath(repositoryPath);
    const state = this.states.get(normalizedPath);

    if (state) {
      const newState = { ...state };
      for (const layer of layers) {
        newState.lastRefreshTime = {
          ...newState.lastRefreshTime,
          [layer]: 0,
        };
      }
      this.states.set(normalizedPath, newState);
    }
  }

  /**
   * Override cache TTL configuration.
   */
  setCacheConfig(config: Partial<CacheConfig>): void {
    this.cacheConfig = { ...this.cacheConfig, ...config };
  }

  /**
   * Cleanup resources (testing / shutdown).
   */
  dispose(): void {

    for (const timer of this.refreshDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshDebounceTimers.clear();

    this.stopPolling();

    this.subscribers.clear();
    this.pollingCounts.clear();
    this.pollSchedules.clear();
    this.pollingConnections.clear();


    this.states.clear();
    this.workspaceScopes.clear();

    this.windowFocusRefreshCounts.clear();

    // Detach global listeners so resetInstance() does not leak a live set
    // of window focus / git event handlers per disposed instance.
    for (const cleanup of this.globalListenerCleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.globalListenerCleanups = [];
    this.globalListenersInitialized = false;
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------

  /**
   * Enqueue a refresh request (debounced and merged).
   */
  private async enqueueRefresh(
    repositoryPath: string,
    layers: GitStateLayer[],
    force: boolean,
    reason: RefreshReason,
    silent: boolean,
    source?: string
  ): Promise<void> {

    const existingTimer = this.refreshDebounceTimers.get(repositoryPath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }


    let pending = this.pendingRefreshes.get(repositoryPath);
    if (pending) {
      pending.pollOnly = pending.pollOnly && reason === 'interval';

      for (const layer of layers) {
        pending.layers.add(layer);
      }
      if (force) {
        pending.force = true;
      }
      if (source && pending.source !== source) {
        pending.source = pending.source ? `${pending.source}|${source}` : source;
      }
    } else {

      pending = {
        layers: new Set(layers),
        force,
        reason,
        source,
        pollOnly: reason === 'interval',
        resolve: () => {},
        reject: () => {},
      };
      this.pendingRefreshes.set(repositoryPath, pending);
    }


    return new Promise<void>((resolve, reject) => {
      const currentPending = this.pendingRefreshes.get(repositoryPath)!;
      const originalResolve = currentPending.resolve;
      const originalReject = currentPending.reject;

      currentPending.resolve = () => {
        originalResolve();
        resolve();
      };
      currentPending.reject = (error: Error) => {
        originalReject(error);
        reject(error);
      };


      const timer = setTimeout(() => {
        this.executePendingRefresh(repositoryPath, silent);
      }, this.DEBOUNCE_DELAY);

      this.refreshDebounceTimers.set(repositoryPath, timer);
    });
  }

  /**
   * Execute a pending refresh.
   */
  private async executePendingRefresh(
    repositoryPath: string,
    silent: boolean
  ): Promise<void> {
    const pending = this.pendingRefreshes.get(repositoryPath);
    if (!pending) return;

    this.pendingRefreshes.delete(repositoryPath);
    this.refreshDebounceTimers.delete(repositoryPath);

    if (pending.pollOnly && (
      !this.pollingCounts.has(repositoryPath) || document.hidden || isPeerDeviceModeActive() ||
      gitWorkspaceKey(this.scopeForKey(repositoryPath)) !== repositoryPath
    )) {
      pending.resolve();
      return;
    }

    const { layers, force, reason, source, resolve, reject } = pending;

    try {
      await this.doRefresh(
        repositoryPath,
        Array.from(layers),
        force,
        reason,
        silent,
        source
      );
      resolve();
    } catch (error) {
      reject(error as Error);
    }
  }

  /**
   * Execute an actual refresh.
   */
  private async doRefresh(
    repositoryPath: string,
    layers: GitStateLayer[],
    force: boolean,
    reason: RefreshReason,
    silent: boolean,
    source?: string
  ): Promise<void> {
    const existingLock = this.refreshLocks.get(repositoryPath);
    if (existingLock) {
      if (!force) {
        await existingLock;
        return;
      }
      try {
        await existingLock;
      } catch {
        // A force refresh after a failed in-flight refresh should still get a
        // chance to rebuild fresh state.
      }
    }

    const startedAt = nowMs();
    const shouldProbeReason =
      reason === 'window-focus' || reason === 'visibility' || reason === 'mount';
    let probeError: string | null = null;
    let probeOutcome = 'completed';

    let state = this.getOrCreateState(this.scopeForKey(repositoryPath));
    const prevState = { ...state };


    const now = Date.now();
    const layersToRefresh = force
      ? layers
      : layers.filter((layer) => this.isCacheExpired(state, layer, now));

    if (layersToRefresh.length === 0) {
      if (shouldProbeReason) {
        sendDebugProbe('GitStateManager.ts:doRefresh', 'Git refresh skipped by cache', {
          repositoryPath,
          reason,
          force,
          silent,
          requestedLayers: layers,
        });
      }
      return;
    }

    log.debug('Starting refresh', { repositoryPath, layersToRefresh, reason });

    const refreshPromise = (async () => {
      try {

        if (!silent) {
          state = this.updateState(repositoryPath, {
            isRefreshing: true,
            refreshingLayers: new Set(layersToRefresh),
            error: null,
          });
        }


        // Only basic/status reaches Git in a way that can observe the ownership
        // gate. A detailed-only refresh swallows its own failures (branches and
        // commits fall back to empty arrays), so treating its success as proof
        // that trust is no longer required would clear a wall nobody retested.
        const probedTrust =
          layersToRefresh.includes('basic') || layersToRefresh.includes('status');
        if (probedTrust) {
          await this.refreshBasicAndStatus(repositoryPath, layersToRefresh);
        }

        if (layersToRefresh.includes('detailed')) {
          await this.refreshDetailed(repositoryPath);
        }


        state = this.getOrCreateState(this.scopeForKey(repositoryPath));
        const newLastRefreshTime = { ...state.lastRefreshTime };
        for (const layer of layersToRefresh) {
          newLastRefreshTime[layer] = now;
        }

        this.updateState(repositoryPath, {
          lastRefreshTime: newLastRefreshTime,
          isRefreshing: false,
          refreshingLayers: new Set(),
          ...(probedTrust ? { repositoryTrustRequired: false, error: null } : {}),
        });
        if (probedTrust) this.scheduleNextPoll(repositoryPath, false);


        const finalState = this.getState(this.scopeForKey(repositoryPath))!;
        const comparison = compareStates(prevState, finalState);
        if (comparison.hasChanges) {
          this.notifySubscribers(repositoryPath, finalState, prevState, comparison.changedLayers);
          this.emitStateChanged(repositoryPath, finalState, comparison.changedLayers, reason);
        } else if (prevState.error !== finalState.error) {
          this.notifySubscribers(repositoryPath, finalState, prevState, layersToRefresh);
        }

      } catch (error) {
        probeOutcome = 'error';
        probeError = error instanceof Error ? error.message : String(error);
        this.scheduleNextPoll(repositoryPath, true);
        // The ownership wall reaches here as a stable code, not as prose. Say
        // what happened instead of showing the raw code to the user.
        //
        // The code is produced by whichever executor classified the rejection.
        // An execution domain that cannot classify still answers the read-only
        // trust probe, so ask it once before concluding that ownership has
        // nothing to do with this failure — see `probeRepositoryTrust`.
        const stablePath = gitRepositoryUntrustedPath(error);
        const probed = stablePath === undefined
          ? await this.probeRepositoryTrust(repositoryPath)
          : undefined;
        const untrustedPath = stablePath ?? probed?.path;
        const errorMessage = untrustedPath
          ? i18nService.t('panels/git:trust.required', { path: untrustedPath })
          : error instanceof Error
            ? error.message
            : i18nService.t('panels/git:errors.refreshFailed');
        log.error('Refresh failed', { repositoryPath, layersToRefresh, error });

        // The flag follows whoever actually reached Git's answer, in both
        // directions. A probe that answered raises the wall on `trust_required`
        // and lowers it on anything else: without the lowering half, an
        // execution domain whose status read can never succeed — the CLI peer
        // has no `git_get_status` — has no way back out. The user fixes
        // ownership on the peer, the probe starts reporting `trusted`, and the
        // panel stays on the Trust screen forever, because the only other thing
        // that clears the flag is a successful basic/status refresh that will
        // never come.
        //
        // A failure nobody could explain leaves the wall exactly as it was: the
        // probe threw (a host too old to answer, a dropped SSH connection) and
        // never reached Git, so it has nothing to say about trust. Clearing on
        // that would drop a blocked repository back to "not a repository" — the
        // status read throws before `isRepository` is ever set — and send the
        // user to initialize one over a repository that is already there.
        const failedState = this.updateState(repositoryPath, {
          isRefreshing: false,
          refreshingLayers: new Set(),
          error: errorMessage,
          ...(untrustedPath !== undefined
            ? { repositoryTrustRequired: true }
            : probed
              ? { repositoryTrustRequired: false }
              : {}),
        });
        if (prevState.error !== failedState.error ||
            prevState.repositoryTrustRequired !== failedState.repositoryTrustRequired) {
          this.notifySubscribers(repositoryPath, failedState, prevState, layersToRefresh);
        }

        throw error;
      } finally {
        const durationMs = elapsedMs(startedAt);
        if (probeError || shouldProbeReason || durationMs >= 80) {
          if (globalThis.__OPENBITFUN_PERF_TRACE_ENABLED__ === true) {
            startupTrace.markPhase('git_state_refresh', {
              reason,
              force,
              silent,
              requestedLayers: layers,
              refreshedLayers: layersToRefresh,
              durationMs,
              outcome: probeOutcome,
              error: probeError,
              source,
            });
          }
          sendDebugProbe('GitStateManager.ts:doRefresh', 'Git refresh completed', {
            repositoryPath,
            reason,
            force,
            silent,
            source,
            requestedLayers: layers,
            refreshedLayers: layersToRefresh,
            durationMs,
            outcome: probeOutcome,
            error: probeError,
          });
        }
        this.refreshLocks.delete(repositoryPath);
      }
    })();

    this.refreshLocks.set(repositoryPath, refreshPromise);
    await refreshPromise;
  }

  /**
   * Asks the host that owns the repository whether Git is refusing it on
   * ownership grounds, for a failure that could not say so itself.
   *
   * Not every execution domain classifies. The CLI peer implements
   * `git_get_repository_trust` but not `git_get_status`, so its status refresh
   * fails with an ordinary "unsupported command" — no stable code, no flag, no
   * Trust button, and the authorization entry point this feature adds is
   * unreachable from a controller talking to that peer. One read-only probe
   * makes it reachable.
   *
   * Returns the probe's verdict, or `undefined` when it could not produce one —
   * a host too old to answer, a transport that failed. Only a verdict may move
   * the trust flag; a failure we cannot explain must neither be dressed up as
   * an ownership wall nor be taken as proof that one has come down. The
   * original error is never replaced by the probe's own.
   */
  private async probeRepositoryTrust(
    repositoryPath: string
  ): Promise<{ trustRequired: boolean; path?: string } | undefined> {
    try {
      const report = await gitAPI.getRepositoryTrust(this.scopeForKey(repositoryPath));
      if (report.state !== 'trust_required') {
        return { trustRequired: false };
      }
      return { trustRequired: true, path: report.repositoryPath ?? repositoryPath };
    } catch (error) {
      log.debug('Git trust probe unavailable after a failed refresh', { repositoryPath, error });
      return undefined;
    }
  }

  /**
   * Refresh basic + status layers.
   */
  private async refreshBasicAndStatus(
    repositoryPath: string,
    layersToRefresh: GitStateLayer[]
  ): Promise<void> {
    const isRepo = await gitAPI.isGitRepository(this.scopeForKey(repositoryPath));

    // The probe answers `true` for a repository Git refuses on ownership
    // grounds — local and remote alike — so `false` here really is "no
    // repository", and clearing the trust flag states a fact rather than
    // hiding one. The ownership case falls through to the status read below,
    // whose stable error sets the flag in the caller's catch.
    if (!isRepo) {
      this.updateState(repositoryPath, {
        isRepository: false,
        repositoryTrustRequired: false,
        currentBranch: null,
        ahead: 0,
        behind: 0,
        hasChanges: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
      });
      return;
    }

    const shouldRefreshStatus = layersToRefresh.includes('status');
    if (!shouldRefreshStatus) {
      const repository = await gitAPI.getRepositoryBasic(this.scopeForKey(repositoryPath));
      const currentState = this.getOrCreateState(this.scopeForKey(repositoryPath));
      this.updateState(repositoryPath, {
        isRepository: true,
        currentBranch: repository.current_branch || repository.branch || null,
        hasChanges: currentState.hasChanges,
      });
      return;
    }

    const status = await gitAPI.getStatus(this.scopeForKey(repositoryPath), 'git_state_manager');

    const hasChanges =
      (status.staged?.length || 0) > 0 ||
      (status.unstaged?.length || 0) > 0 ||
      (status.untracked?.length || 0) > 0;

    this.updateState(repositoryPath, {
      isRepository: true,
      currentBranch: status.current_branch || null,
      ahead: status.ahead || 0,
      behind: status.behind || 0,
      hasChanges,
      staged: status.staged || [],
      unstaged: status.unstaged || [],
      untracked: status.untracked || [],
      conflicts: status.conflicts || [],
    });

  }

  /**
   * Refresh detailed layer (branches/commits).
   */
  private async refreshDetailed(repositoryPath: string): Promise<void> {
    const state = this.getState(this.scopeForKey(repositoryPath));
    if (!state?.isRepository) return;

    try {

      const [branches, commits] = await Promise.all([
        gitAPI.getBranches(this.scopeForKey(repositoryPath), true).catch(() => []),
        gitAPI.getCommits(this.scopeForKey(repositoryPath), { maxCount: 20 }).catch(() => []),
      ]);

      this.updateState(repositoryPath, {
        branches: branches.map((b: any) => ({
          name: b.name,
          current: !!b.current,
          remote: !!b.remote,
          remoteName: b.remoteName,
          upstream: b.upstream,
          ahead: b.ahead ?? 0,
          behind: b.behind ?? 0,
          lastCommit: b.lastCommit,
          lastCommitDate: b.lastCommitDate ? new Date(b.lastCommitDate) : undefined,
        })),
        commits: commits.map((c) => ({
          hash: c.hash,
          shortHash: c.hash.substring(0, 7),
          message: c.message,
          author: c.author,
          authorEmail: '',
          date: new Date(c.date),
          parents: [],
        })),
      });

    } catch (error) {
      log.warn('Failed to refresh detailed info', { repositoryPath, error });
    }
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------

  /**
   * Update cached state for a repository.
   */
  private updateState(
    repositoryPath: string,
    partial: Partial<GitState>
  ): GitState {
    const currentState = this.getOrCreateState(this.scopeForKey(repositoryPath));
    const newState: GitState = {
      ...currentState,
      ...partial,

      lastRefreshTime: partial.lastRefreshTime ?? currentState.lastRefreshTime,
      refreshingLayers: partial.refreshingLayers ?? currentState.refreshingLayers,
    };

    this.states.set(repositoryPath, newState);
    return newState;
  }

  /**
   * Notify subscribers.
   */
  private notifySubscribers(
    repositoryPath: string,
    state: GitState,
    prevState: GitState | null,
    changedLayers: GitStateLayer[]
  ): void {
    const entries = this.subscribers.get(repositoryPath);
    if (!entries || entries.size === 0) return;

    for (const entry of entries) {
      const { callback, options } = entry;


      if (options.layers && options.layers.length > 0) {
        const hasRelevantChange = changedLayers.some((layer) =>
          options.layers!.includes(layer)
        );
        if (!hasRelevantChange) {
          continue;
        }
      }

      try {
        callback(state, prevState, changedLayers);
      } catch (error) {
        log.error('Subscriber callback error', { repositoryPath, error });
      }
    }
  }

  /**
   * Emit state-changed events (EventBus + GitEventService).
   */
  private emitStateChanged(
    repositoryPath: string,
    state: GitState,
    changedLayers: GitStateLayer[],
    reason: RefreshReason
  ): void {
    const eventData: GitStateChangedEventData = {
      repositoryPath: this.scopeForKey(repositoryPath),
      state,
      changedLayers,
      reason,
      timestamp: Date.now(),
    };


    globalEventBus.emit('git:state:changed', eventData);


    gitEventService.emit('status:changed', {
      repositoryPath: this.scopeForKey(repositoryPath),
      status: {
        current_branch: state.currentBranch || '',
        staged: state.staged,
        unstaged: state.unstaged,
        untracked: state.untracked,
        ahead: state.ahead,
        behind: state.behind,
      },
      timestamp: new Date(),
    });
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------

  /**
   * Check whether the cache is expired for a layer.
   */
  private isCacheExpired(
    state: GitState,
    layer: GitStateLayer,
    now: number
  ): boolean {
    const lastRefresh = state.lastRefreshTime[layer];
    const ttl = this.cacheConfig[layer];

    if (ttl === Infinity) {

      return lastRefresh === 0;
    }

    return now - lastRefresh > ttl;
  }

  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------

  /**
   * Setup global event listeners once.
   */
  private setupGlobalListeners(): void {
    if (this.globalListenersInitialized) return;
    this.globalListenersInitialized = true;

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleWindowFocus);
      this.globalListenerCleanups.push(() => {
        window.removeEventListener('focus', this.handleWindowFocus);
      });
    }

    // gitEventService.on wraps the listener internally, so removal must go
    // through the returned unsubscribe functions (gitEventService.off with
    // the raw listener would not match the wrapped one).
    this.globalListenerCleanups.push(
      gitEventService.on('operation:completed', this.handleGitOperationCompleted),
      gitEventService.on('branch:changed', this.handleBranchChanged),
    );
  }

  private handleWindowFocus = (): void => {
    if (isPeerDeviceModeActive()) {
      sendDebugProbe('GitStateManager.ts:handleWindowFocus', 'Git window focus refresh skipped in peer mode', {
        participatingRepositoryCount: this.windowFocusRefreshCounts.size,
      });
      return;
    }
    const repositories = Array.from(this.windowFocusRefreshCounts.keys());
    sendDebugProbe('GitStateManager.ts:handleWindowFocus', 'Git window focus refresh queued', {
      participatingRepositoryCount: repositories.length,
      repositories,
    });
    for (const repoPath of repositories) {
      this.refresh(this.scopeForKey(repoPath), {
        layers: ['basic', 'status'],
        reason: 'window-focus',
        silent: true,
      });
    }
  };

  private handleGitOperationCompleted = (event: any): void => {
    const { repositoryPath, operationType } = event.data;
    if (!repositoryPath) return;

    this.invalidateCache(repositoryPath, ['basic', 'status']);

    const detailedOps = ['commit', 'merge', 'rebase', 'cherry-pick', 'branch'];
    if (detailedOps.includes(operationType)) {
      this.invalidateCache(repositoryPath, ['detailed']);
    }

    this.refresh(repositoryPath, {
      layers: ['basic', 'status'],
      reason: 'operation',
      force: true,
    });
  };

  /**
   * Write a completed checkout into the shared state and broadcast it.
   *
   * Both manual switch entry points (the Git scene branch list and the
   * composer branch picker) announce a successful checkout as a
   * `branch:changed` event, so that event is the single place where a manual
   * switch reaches this cache. Writing it here makes every surface that
   * renders `currentBranch` flip at the same moment, instead of each waiting
   * for the reconciling refresh below or, worse, the poll interval.
   *
   * Git stays the source of truth: the forced refresh that follows overwrites
   * whatever we write here, so a guess that does not match reality is
   * corrected rather than persisted. This runs only after a checkout the host
   * reported as successful — it never fabricates one.
   *
   * The cached branch list is patched too, but only the `current` flag, so
   * pickers that render from `state.branches` move their marker immediately
   * without touching names or upstream data.
   */
  private applyBranchChange(scope: GitWorkspaceScope, branchName: string): void {
    // `states`, `subscribers` and `updateState` are all keyed by the
    // normalized workspace key, so normalize once here rather than at each use.
    const repositoryPath = this.normalizePath(scope);
    const prevState = this.states.get(repositoryPath) ?? null;

    const branches = prevState?.branches?.map((branch) => {
      const isCurrent = branch.name === branchName;
      return branch.current === isCurrent ? branch : { ...branch, current: isCurrent };
    });

    const nextState = this.updateState(repositoryPath, {
      isRepository: true,
      repositoryTrustRequired: false,
      currentBranch: branchName,
      ...(branches ? { branches } : {}),
    });

    const comparison = compareStates(prevState, nextState);
    if (!comparison.hasChanges) return;

    this.notifySubscribers(repositoryPath, nextState, prevState, comparison.changedLayers);
    this.emitStateChanged(repositoryPath, nextState, comparison.changedLayers, 'operation');
  }

  private handleBranchChanged = (event: any): void => {
    const { repositoryPath, branch } = event.data;
    if (!repositoryPath) return;

    // Apply the reported branch first so the UI moves now; the forced refresh
    // below then reconciles ahead/behind, the working copy and the branch list.
    const branchName = typeof branch?.name === 'string' ? branch.name : '';
    if (branchName) {
      this.applyBranchChange(repositoryPath, branchName);
    }

    this.invalidateCache(repositoryPath, ['basic', 'status', 'detailed']);
    this.refresh(repositoryPath, {
      layers: ['basic', 'status', 'detailed'],
      reason: 'operation',
      force: true,
    });
  };

  // -------------------------------------------------------------------------
  // Polling — catch external branch / HEAD changes every POLL_INTERVAL_MS.
  // -------------------------------------------------------------------------

  /**
   * Start the interval-based poll if not already running. The poll is global
   * (one timer for all repositories) and pauses while the document is hidden
   * to avoid unnecessary work in background tabs. It only refreshes repos
   * that currently have polling consumers and always uses a silent basic-layer
   * refresh so status/detailed caches are not thrashed.
   */
  private ensurePollingStarted(): void {
    if (typeof window === 'undefined') return;

    if (this.pollVisibilityCleanup === null) {
      const handleVisibility = (): void => {
        if (document.hidden) {
          this.stopPollingTimerOnly();
        } else if (this.pollingCounts.size > 0) {
          // Kick off an immediate refresh so we don't lag by up to one
          // interval after becoming visible, then resume the timer.
          this.pollTick();
          this.startPollingTimer();
        }
      };
      document.addEventListener('visibilitychange', handleVisibility);
      this.pollVisibilityCleanup = () => {
        document.removeEventListener('visibilitychange', handleVisibility);
      };
    }

    // A subscription can be added while the document is hidden. Keep the
    // timer paused in that case; the visibility listener above will start it
    // when the document becomes visible again.
    if (!document.hidden) {
      this.startPollingTimer();
    }
  }

  private startPollingTimer(): void {
    if (this.pollTimer !== null || this.pollingCounts.size === 0) return;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    this.stopPollingTimerOnly();
    if (this.pollVisibilityCleanup) {
      this.pollVisibilityCleanup();
      this.pollVisibilityCleanup = null;
    }
  }

  private stopPollingTimerOnly(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollTick(): void {
    if (isPeerDeviceModeActive()) {
      // In peer-device mode the controller is not the execution host; rely
      // on the transport's state sync instead of issuing local git calls.
      return;
    }
    for (const repoKey of this.pollingCounts.keys()) {
      const scope = this.scopeForKey(repoKey);
      if (gitWorkspaceKey(scope) !== repoKey) continue;
      if ((this.pollSchedules.get(repoKey)?.nextAttemptAt ?? 0) > Date.now() ||
          this.refreshLocks.has(repoKey) || this.pendingRefreshes.has(repoKey)) continue;
      const { connectionId } = this.pollPolicy(scope);
      if (connectionId && this.pollingConnections.has(connectionId)) continue;
      if (connectionId) this.pollingConnections.add(connectionId);
      // Invalidate the basic-layer timestamp so the non-forced refresh below
      // bypasses the Infinity TTL and actually hits Git. We only invalidate
      // `basic` — status/detailed keep their longer TTLs and are refreshed
      // on demand or by user-driven events, not by this tick.
      this.invalidateCache(scope, ['basic']);
      this.refresh(scope, {
        layers: ['basic'],
        reason: 'interval',
        silent: true,
      }).catch(() => {
        // doRefresh reports the failure and schedules exponential retry backoff.
      }).finally(() => {
        if (connectionId) this.pollingConnections.delete(connectionId);
      });
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Normalize path separators for stable map keys.
   */
  private normalizePath(scope: GitWorkspaceScope): string {
    const key = gitWorkspaceKey(scope);
    this.workspaceScopes.set(key, scope);
    return key;
  }

  private workspaceScopes = new Map<string, GitWorkspaceScope>();
  private scopeForKey(key: string): GitWorkspaceScope {
    const scope = this.workspaceScopes.get(key);
    if (!scope) throw new Error('Git workspace ID is unavailable');
    return scope;
  }
}


export const gitStateManager = GitStateManager.getInstance();
