import {
  Button,
  ConfirmDialog,
  Icon,
  IconButton,
  MenuPopover,
  NumberInput,
  Select,
  StatusPill,
  type MenuEntry,
  type SelectOption,
  Switch,
  Tooltip,
} from '@openbitfun/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Play, RotateCcw } from 'lucide-react';
import { ConfigLoadingState, ConfigMessage, ConfigRetryState } from '@/infrastructure/config/components/common';

import { useNotification } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { useI18n } from '@/infrastructure/i18n';
import { agentAPI, type MemoryStatusResponse } from '@/infrastructure/api/service-api/AgentAPI';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { configManager } from '../services/ConfigManager';
import { getModelDisplayName } from '../services/modelConfigs';
import type { AIModelConfig, MemoriesConfig as MemoriesConfigShape } from '../types';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
} from './common';
import './MemorySettingsPage.scss';

const log = createLogger('MemorySettings');

/**
 * Mirrors `MemoriesConfig::default()` in
 * `src/crates/contracts/config-contracts/src/types.rs`.
 *
 * The backend persists only non-default keys (`prune_default_memories_config`),
 * so a value that differs here is not a harmless UI default: it would render a
 * state the host does not have, and the next save would persist it. Keep this
 * object field-for-field identical to the Rust defaults.
 */
const DEFAULT_MEMORIES_CONFIG: MemoriesConfigShape = {
  generate_memories: false,
  generate_for_btw_sessions: false,
  use_memories: false,
  external_context_policy: 'clear_tool_results',
  max_raw_memories_for_consolidation: 64,
  max_unused_days: 30,
  max_rollout_age_days: 10,
  max_failure_report_days: 14,
  max_rollouts_per_startup: 2,
  max_rollouts_scan_limit: 2000,
  min_rollout_idle_hours: 6,
  phase1_max_concurrency: 1,
  phase1_retry_backoff_minutes: 60,
  phase1_lease_seconds: 60 * 60,
  phase2_lease_seconds: 60 * 60,
  phase2_success_cooldown_seconds: 6 * 60 * 60,
  phase2_retry_delay_seconds: 60 * 60,
  extract_model: null,
  consolidation_model: null,
};

/** Edits that change the Phase-1/Phase-2 window and must not invert it. */
const MEMORY_WINDOW_KEYS: readonly (keyof MemoriesConfigShape)[] = [
  'max_rollout_age_days',
  'max_unused_days',
];

const STATUS_POLL_INTERVAL_MS = 5_000;
const STATUS_POLL_MAX_DURATION_MS = 10 * 60 * 1_000;

type MemoryStatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: MemoryStatusResponse }
  | { kind: 'unavailable'; error: string };

type PipelineRunState = 'idle' | 'running' | 'timed-out';

function normalizeSelectValue(value: string | number | (string | number)[]): string {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved == null ? '' : String(resolved);
}

/**
 * Applies host defaults for keys the backend omitted.
 *
 * There is deliberately no cross-field rewrite here. `max_rollout_age_days`
 * (Phase-1 source age) and `max_unused_days` (Phase-2 candidate retention) are
 * independent in the backend: `MemoriesConfig` keeps both exactly as stored,
 * even when the source age exceeds the retention. Clamping one to the other
 * would silently persist a value the user never chose. An inverted window is
 * refused at edit time with a visible hint instead (see `updateConfig`).
 */
function normalizeMemoriesConfig(config: Partial<MemoriesConfigShape> | null | undefined): MemoriesConfigShape {
  const normalized = {
    ...DEFAULT_MEMORIES_CONFIG,
    ...(config ?? {}),
  };
  return {
    generate_memories: normalized.generate_memories,
    generate_for_btw_sessions: normalized.generate_for_btw_sessions,
    use_memories: normalized.use_memories,
    external_context_policy: normalized.external_context_policy,
    max_raw_memories_for_consolidation: normalized.max_raw_memories_for_consolidation,
    max_unused_days: normalized.max_unused_days,
    max_rollout_age_days: normalized.max_rollout_age_days,
    max_failure_report_days: normalized.max_failure_report_days,
    max_rollouts_per_startup: normalized.max_rollouts_per_startup,
    max_rollouts_scan_limit: normalized.max_rollouts_scan_limit,
    min_rollout_idle_hours: normalized.min_rollout_idle_hours,
    phase1_max_concurrency: normalized.phase1_max_concurrency,
    phase1_retry_backoff_minutes: normalized.phase1_retry_backoff_minutes,
    phase1_lease_seconds: normalized.phase1_lease_seconds,
    phase2_lease_seconds: normalized.phase2_lease_seconds,
    phase2_success_cooldown_seconds: normalized.phase2_success_cooldown_seconds,
    phase2_retry_delay_seconds: normalized.phase2_retry_delay_seconds,
    extract_model: normalized.extract_model,
    consolidation_model: normalized.consolidation_model,
  };
}

function isValidMemoryWindowConfig(config: MemoriesConfigShape): boolean {
  return config.max_rollout_age_days <= config.max_unused_days;
}

function shortSessionId(sessionId: string | undefined): string {
  const value = (sessionId ?? '').trim();
  if (!value) {
    return '';
  }
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

/**
 * When a failed extraction happened, as a compact date.
 *
 * The age is what makes "is this stale?" answerable at a glance: a failure from
 * months ago is a dead end, while one from today still deserves a retry. The
 * host reports the timestamp only when it stored one, so a missing value renders
 * nothing instead of a guessed date.
 */
function formatFailureAge(
  failedAtUnixSecs: number | null | undefined,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
): string | null {
  if (typeof failedAtUnixSecs !== 'number' || !Number.isFinite(failedAtUnixSecs)) {
    return null;
  }
  return formatDate(new Date(failedAtUnixSecs * 1000), { dateStyle: 'short' });
}

/**
 * Character budget of a visible error summary.
 *
 * The full message stays reachable through the element's `title`, so the list
 * stays scannable instead of printing a provider JSON body verbatim.
 */
const MEMORY_ERROR_SUMMARY_MAX_CHARS = 120;

/**
 * Drops a trailing provider JSON body from an error string.
 *
 * Stage-1 failures are stored verbatim, so a provider rejection can look like
 * `<message> {"error":{"message":"...","type":"..."}}`. The human sentence in
 * front of that payload is the useful part; everything from the first `{"error`
 * marker on is left to the `title` attribute.
 */
function stripProviderJsonTail(rawError: string): string {
  const jsonStart = rawError.indexOf('{"error');
  return jsonStart > 0 ? rawError.slice(0, jsonStart).trim() : rawError;
}

/** Condenses a raw pipeline error into one short, readable line. */
function summarizeMemoryError(rawError: string | null | undefined): string {
  const raw = (rawError ?? '').trim();
  if (!raw) {
    return '';
  }
  const withoutPayload = stripProviderJsonTail(raw);
  const firstLine = withoutPayload
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  // The dropped payload can leave the line's opening brace behind; a summary
  // ending in `{` reads like a broken value.
  const condensed = (firstLine ?? withoutPayload.replace(/\s+/g, ' ').trim())
    .replace(/[{\s]+$/, '');
  return condensed.length > MEMORY_ERROR_SUMMARY_MAX_CHARS
    ? `${condensed.slice(0, MEMORY_ERROR_SUMMARY_MAX_CHARS).trimEnd()}…`
    : condensed;
}

const MemorySettingsPage: React.FC = () => {
  const { t, formatDate, formatNumber } = useI18n(['settings/memory', 'shared']);
  const { error: notifyError, info: notifyInfo, success: notifySuccess } = useNotification();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [config, setConfig] = useState<MemoriesConfigShape>(DEFAULT_MEMORIES_CONFIG);
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [savingKey, setSavingKey] = useState<keyof MemoriesConfigShape | null>(null);
  const [actionBusy, setActionBusy] = useState<'reset-settings' | 'open-directory' | 'reset-memory' | 'clear-failures' | null>(null);
  const [resetMemoryConfirmOpen, setResetMemoryConfirmOpen] = useState(false);
  const [clearFailuresConfirmOpen, setClearFailuresConfirmOpen] = useState(false);
  const [resetSettingsConfirmOpen, setResetSettingsConfirmOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatusState>({ kind: 'loading' });
  const [pipelineRun, setPipelineRun] = useState<PipelineRunState>('idle');
  const pipelineBaselineFinishedAtRef = useRef<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);

    try {
      const loadedConfig = await configManager.getConfig<Partial<MemoriesConfigShape>>('memories');
      // Do not fall through to the default object: the backend stores only
      // non-default keys, so rendering the defaults would claim a host state
      // that was never read.
      setConfig(normalizeMemoriesConfig(loadedConfig));
    } catch (error) {
      log.error('Failed to load memories config', error);
      setLoadFailed(true);
    }

    try {
      const loadedModels = await configManager.getConfig<AIModelConfig[]>('ai.models');
      setModels(Array.isArray(loadedModels) ? loadedModels : []);
    } catch (error) {
      // The model list only feeds the two model selectors; a failure here must
      // not mark the memory settings themselves as unavailable.
      log.error('Failed to load AI models for the memory model selectors', error);
      setModels([]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const refreshMemoryStatus = useCallback(async (): Promise<MemoryStatusResponse | null> => {
    try {
      const data = await agentAPI.getMemoryStatus();
      setMemoryStatus({ kind: 'ready', data });
      return data;
    } catch (error) {
      log.error('Failed to load memory status', error);
      setMemoryStatus({
        kind: 'unavailable',
        error: error instanceof Error ? error.message : t('status.messages.loadFailed'),
      });
      return null;
    }
  }, [t]);

  useEffect(() => {
    void refreshMemoryStatus();
  }, [refreshMemoryStatus]);

  useEffect(() => {
    if (pipelineRun !== 'running') {
      return undefined;
    }

    const deadline = Date.now() + STATUS_POLL_MAX_DURATION_MS;
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) {
        setPipelineRun('timed-out');
        return;
      }

      void refreshMemoryStatus().then((data) => {
        if (!data) {
          return;
        }
        // Phase 2 stamps `finished_at` on every pass it runs, including a no-op
        // one, so a changed value means the triggered pass reached its end.
        const finishedAt = data.phase2LastFinishedAtUnixSecs ?? null;
        if (finishedAt !== null && finishedAt !== pipelineBaselineFinishedAtRef.current) {
          setPipelineRun('idle');
        }
      });
    }, STATUS_POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [pipelineRun, refreshMemoryStatus]);

  const enabledModels = useMemo(() => models.filter((model) => model.enabled && model.id), [models]);

  const buildModelOptions = useCallback((followLabel: string, selectedValue: string | null): SelectOption[] => {
    const options: SelectOption[] = [
      { value: '', label: followLabel },
      { value: 'primary', label: t('models.primary') },
      { value: 'fast', label: t('models.fast') },
      ...enabledModels.map((model) => ({
        value: model.id as string,
        label: getModelDisplayName(model),
      })),
    ];
    if (selectedValue
      && selectedValue !== 'primary'
      && selectedValue !== 'fast'
      && !options.some(option => option.value === selectedValue)) {
      options.push({ value: selectedValue, label: t('models.unavailable', { id: selectedValue }), disabled: true });
    }
    return options;
  }, [enabledModels, t]);

  const externalContextPolicyOptions = useMemo<SelectOption[]>(() => [
    { value: 'clear_tool_results', label: t('externalContextPolicy.clearToolResults') },
    { value: 'allow', label: t('externalContextPolicy.allow') },
    { value: 'skip_session', label: t('externalContextPolicy.skipSession') },
  ], [t]);

  const updateConfig = useCallback(async <K extends keyof MemoriesConfigShape>(
    key: K,
    value: MemoriesConfigShape[K],
  ) => {
    const previous = config;
    const next = {
      ...config,
      [key]: value,
    };
    // Only a window edit is validated against the other window field. A window
    // stored by the host that the backend accepts must not block an unrelated
    // setting, and the UI must never rewrite it silently.
    if (MEMORY_WINDOW_KEYS.includes(key) && !isValidMemoryWindowConfig(next)) {
      notifyError(t('messages.rolloutAgeExceedsRetention'));
      return;
    }
    setSavingKey(key);
    setConfig(next);
    try {
      const persisted = await configManager.updateConfig<Partial<MemoriesConfigShape>>(
        'memories',
        current => {
          const latest = {
            ...normalizeMemoriesConfig(current),
            [key]: value,
          };
          if (MEMORY_WINDOW_KEYS.includes(key) && !isValidMemoryWindowConfig(latest)) {
            throw new Error(t('messages.rolloutAgeExceedsRetention'));
          }
          return latest;
        },
      );
      setConfig(normalizeMemoriesConfig(persisted));
      notifySuccess(t('messages.saved'));
    } catch (error) {
      log.error('Failed to save memories config', { key, error });
      setConfig(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [config, notifyError, notifySuccess, t]);

  const updateMemoryEnabled = useCallback(async (enabled: boolean) => {
    const previous = config;
    const next = {
      ...config,
      generate_memories: enabled,
      use_memories: enabled,
    };
    setSavingKey('generate_memories');
    setConfig(next);
    try {
      const persisted = await configManager.updateConfig<Partial<MemoriesConfigShape>>(
        'memories',
        current => ({
          ...normalizeMemoriesConfig(current),
          generate_memories: enabled,
          use_memories: enabled,
        }),
      );
      setConfig(normalizeMemoriesConfig(persisted));
      notifySuccess(t('messages.saved'));
    } catch (error) {
      log.error('Failed to save memory enabled state', error);
      setConfig(previous);
      notifyError(error instanceof Error ? error.message : t('messages.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  }, [config, notifyError, notifySuccess, t]);

  const updateModelSelector = useCallback((
    key: 'extract_model' | 'consolidation_model',
    value: string | number | (string | number)[],
  ) => {
    const selector = normalizeSelectValue(value).trim();
    void updateConfig(key, selector ? selector : null);
  }, [updateConfig]);

  const handleResetSettings = useCallback(async () => {
    setResetSettingsConfirmOpen(false);
    setActionBusy('reset-settings');
    try {
      await configManager.resetConfig('memories');
      await loadData();
      notifySuccess(t('messages.settingsReset'));
    } catch (error) {
      log.error('Failed to reset memories settings', error);
      notifyError(error instanceof Error ? error.message : t('messages.settingsResetFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [loadData, notifyError, notifySuccess, t]);

  const handleOpenMemoryDirectory = useCallback(async () => {
    setActionBusy('open-directory');
    try {
      const paths = await agentAPI.getMemoryPaths();
      await workspaceAPI.revealInExplorer(paths.memoriesRootDir);
    } catch (error) {
      log.error('Failed to open memory directory', error);
      notifyError(error instanceof Error ? error.message : t('messages.openDirectoryFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [notifyError, t]);

  const handleResetMemory = useCallback(async () => {
    setResetMemoryConfirmOpen(false);
    setActionBusy('reset-memory');
    try {
      await agentAPI.resetMemory();
      notifySuccess(t('messages.memoryReset'));
      await refreshMemoryStatus();
    } catch (error) {
      log.error('Failed to reset memory', error);
      notifyError(error instanceof Error ? error.message : t('messages.memoryResetFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [notifyError, notifySuccess, refreshMemoryStatus, t]);

  /**
   * Clears the failed-extraction bookkeeping of the current host.
   *
   * The action deletes failure records only: extracted memories are kept, and
   * the cleared sessions become eligible for extraction again on the next memory
   * run, so the status card is re-read instead of patched locally.
   */
  const handleClearFailures = useCallback(async () => {
    setClearFailuresConfirmOpen(false);
    setActionBusy('clear-failures');
    try {
      const result = await agentAPI.clearMemoryStage1Failures();
      notifySuccess(t('status.failed.cleared', { count: result.clearedCount ?? 0 }));
      await refreshMemoryStatus();
    } catch (error) {
      log.error('Failed to clear failed memory extractions', error);
      notifyError(error instanceof Error ? error.message : t('status.failed.clearFailed'));
    } finally {
      setActionBusy(null);
    }
  }, [notifyError, notifySuccess, refreshMemoryStatus, t]);

  const handleRunPipelineNow = useCallback(async () => {
    const baseline = memoryStatus.kind === 'ready'
      ? memoryStatus.data.phase2LastFinishedAtUnixSecs ?? null
      : null;
    pipelineBaselineFinishedAtRef.current = baseline;
    setPipelineRun('running');

    try {
      const result = await agentAPI.runMemoryPipelineNow();
      if (!result.started) {
        setPipelineRun('idle');
        notifyInfo(t('status.messages.pipelineDisabled'));
        return;
      }
      notifySuccess(t('status.messages.pipelineStarted'));
      const data = await refreshMemoryStatus();
      const finishedAt = data?.phase2LastFinishedAtUnixSecs ?? null;
      if (finishedAt !== null && finishedAt !== baseline) {
        setPipelineRun('idle');
      }
    } catch (error) {
      log.error('Failed to start the memory pipeline', error);
      setPipelineRun('idle');
      notifyError(error instanceof Error ? error.message : t('status.messages.startFailed'));
    }
  }, [memoryStatus, notifyError, notifyInfo, notifySuccess, refreshMemoryStatus, t]);

  const actionMenuItems = useMemo<MenuEntry[]>(() => [
    {
      id: 'open-directory',
      label: t('actions.openDirectory'),
      icon: <FolderOpen size={16} />,
      disabled: actionBusy !== null,
      onSelect: () => { void handleOpenMemoryDirectory(); },
    },
    {
      id: 'reset-settings',
      label: t('actions.resetSettings'),
      icon: <RotateCcw size={16} />,
      disabled: actionBusy !== null,
      onSelect: () => setResetSettingsConfirmOpen(true),
    },
    {
      id: 'separator-danger',
      label: '',
      separator: true,
    },
    {
      id: 'clear-memory',
      label: t('actions.resetMemory'),
      icon: <Icon name="delete" size="sm" />,
      tone: 'danger',
      disabled: actionBusy !== null,
      onSelect: () => setResetMemoryConfirmOpen(true),
    },
  ], [actionBusy, handleOpenMemoryDirectory, t]);

  if (loading || loadFailed) {
    return (
      <ConfigPageLayout
        className="openbitfun-memories-config"
        data-openbitfun-component="config"
        data-openbitfun-part="root"
      >
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent>
          {loading ? (
            <ConfigLoadingState label={t('messages.loading')} />
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void loadData()}
            />
          )}
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  const memoryEnabled = config.generate_memories && config.use_memories;
  const memoryWorkDisabled = !memoryEnabled;
  const statusData = memoryStatus.kind === 'ready' ? memoryStatus.data : null;
  // Run-now enablement follows the memory config this page manages, never the
  // status fetch: a status read that fails (or reports a stale gate) must not
  // leave the user with a dead end after they enable generation right here.
  // When the config itself is unreadable there is no trustworthy value to enable
  // from, so the action stays blocked until the user retries the settings read.
  const pipelineCanRun = !loadFailed && config.generate_memories;
  const failedSessions = statusData?.stage1Failed ?? [];
  const phase2Status = statusData?.phase2Status ?? null;
  const phase2FinishedAt = typeof statusData?.phase2LastFinishedAtUnixSecs === 'number'
    ? formatDate(new Date(statusData.phase2LastFinishedAtUnixSecs * 1000), {
      dateStyle: 'short',
      timeStyle: 'short',
    })
    : null;

  const formatEnabled = (enabled: boolean | undefined): string => (
    enabled ? t('status.enabled') : t('status.disabled')
  );

  const formatBytes = (bytes: number | null | undefined): string => (
    typeof bytes === 'number' ? t('status.bytes', { size: formatNumber(bytes) }) : t('status.unknown')
  );

  const formatPhase2Status = (status: string | null): string => {
    switch (status) {
      case null:
      case '':
        return t('status.phase2Status.never');
      case 'running':
        return t('shared:statuses.running');
      case 'done':
        return t('shared:statuses.done');
      case 'error':
        return t('shared:statuses.failed');
      default:
        // An unknown value from a newer host is shown verbatim instead of hidden.
        return status;
    }
  };

  return (
    <ConfigPageLayout
      className="openbitfun-memories-config"
      data-openbitfun-component="config"
      data-openbitfun-part="root"
    >
      <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
      <ConfigPageContent>
        <ConfigMessage message={{ type: 'info', text: t('scopeNotice') }} />
        <ConfigPageSection
          data-testid="memories-status-card"
          title={t('status.title')}
          description={t('status.description')}
          extra={(
            <Button
              data-testid="memories-run-now-btn"
              type="button"
              variant="outline"
              size="sm"
              leadingIcon={<Play size={16} />}
              onClick={() => void handleRunPipelineNow()}
              loading={pipelineRun === 'running'}
              disabled={pipelineRun === 'running' || !pipelineCanRun}
            >
              {t('status.actions.runNow')}
            </Button>
          )}
        >
          {memoryStatus.kind === 'loading' && (
            <ConfigMessage message={{ type: 'info', text: t('status.messages.loading') }} />
          )}
          {memoryStatus.kind === 'unavailable' && (
            <ConfigMessage
              message={{
                type: 'error',
                text: t('status.messages.unavailable', { error: memoryStatus.error }),
              }}
            />
          )}
          {statusData && (
            <>
              <ConfigPageRow
                label={t('status.fields.memoryRoot')}
                description={t('status.fields.memoryRootHint')}
                align="center"
                multiline
              >
                <span data-testid="memories-status-memory-root">{statusData.memoryRootDir || t('status.unknown')}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.generateMemories')}
                description={t('fields.generateMemories.description')}
                align="center"
              >
                <span data-testid="memories-status-generate">{formatEnabled(statusData.generateMemories)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.useMemories')}
                description={t('fields.useMemories.description')}
                align="center"
              >
                <span data-testid="memories-status-use">{formatEnabled(statusData.useMemories)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.storedOutputs')}
                description={t('status.fields.storedOutputsHint')}
                align="center"
              >
                <span data-testid="memories-status-stored-outputs">{formatNumber(statusData.stage1OutputCount ?? 0)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.pendingPromotion')}
                description={t('status.fields.pendingPromotionHint')}
                align="center"
              >
                <span data-testid="memories-status-pending-promotion">{formatNumber(statusData.stage1PendingPromotionCount ?? 0)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.phase2')}
                description={phase2FinishedAt
                  ? t('status.fields.phase2LastRun', { time: phase2FinishedAt })
                  : t('status.fields.phase2NeverRun')}
                align="center"
              >
                <span data-testid="memories-status-phase2">{formatPhase2Status(phase2Status)}</span>
              </ConfigPageRow>

              {statusData.phase2LastError ? (
                <ConfigPageRow
                  label={t('status.fields.phase2LastError')}
                  align="center"
                  multiline
                >
                  <div
                    className="openbitfun-memory-settings__error-detail"
                    data-testid="memories-status-phase2-last-error"
                  >
                    {/* The full message stays on `title`: a timeout report can be
                        hundreds of characters and must not read like a value. */}
                    <span
                      className="openbitfun-memory-settings__error-detail-text"
                      title={statusData.phase2LastError}
                    >
                      {summarizeMemoryError(statusData.phase2LastError)}
                    </span>
                  </div>
                </ConfigPageRow>
              ) : null}

              <ConfigPageRow
                label={t('status.fields.memoryIndex')}
                description={t('status.fields.memoryIndexHint')}
                align="center"
              >
                <span>{formatBytes(statusData.files?.memoryIndexBytes)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.memorySummary')}
                description={t('status.fields.memorySummaryHint')}
                align="center"
              >
                <span>{formatBytes(statusData.files?.memorySummaryBytes)}</span>
              </ConfigPageRow>

              <ConfigPageRow
                label={t('status.fields.rolloutSummaries')}
                description={t('status.fields.rolloutSummariesHint')}
                align="center"
              >
                <span data-testid="memories-status-rollout-summaries">
                  {typeof statusData.files?.rolloutSummaryCount === 'number'
                    ? formatNumber(statusData.files.rolloutSummaryCount)
                    : t('status.unknown')}
                </span>
              </ConfigPageRow>

              <ConfigPageRow
                label={(
                  <span className="openbitfun-memory-settings__inline-header">
                    <span className="openbitfun-memory-settings__inline-header-main">
                      <span>{t('status.failed.title')}</span>
                    </span>
                    {failedSessions.length > 0 ? (
                      <span className="openbitfun-memory-settings__inline-header-actions">
                        <Button
                          data-testid="memories-clear-failed-btn"
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setClearFailuresConfirmOpen(true)}
                          loading={actionBusy === 'clear-failures'}
                          disabled={actionBusy !== null}
                        >
                          {t('status.failed.clearAction')}
                        </Button>
                      </span>
                    ) : null}
                  </span>
                )}
                description={t('status.failed.description')}
                multiline
              >
                {failedSessions.length === 0 ? (
                  <span>{t('status.failed.none')}</span>
                ) : (
                  <div
                    className="openbitfun-memory-settings__failure-list"
                    data-testid="memories-status-stage1-failed"
                  >
                    {failedSessions.map((failure, index) => {
                      const failedAt = formatFailureAge(failure.failedAtUnixSecs, formatDate);
                      return (
                        <div
                          className="openbitfun-memory-settings__failure-entry"
                          data-testid="memories-status-stage1-failed-entry"
                          key={failure.sessionId ?? index}
                        >
                          <div className="openbitfun-memory-settings__failure-head">
                            <span
                              className="openbitfun-memory-settings__failure-session"
                              title={failure.sessionId}
                            >
                              {shortSessionId(failure.sessionId)}
                            </span>
                            {failedAt ? (
                              <span data-testid="memories-status-stage1-failed-at">
                                {t('status.failed.failedAt', { time: failedAt })}
                              </span>
                            ) : null}
                            {failure.retryExhausted ? (
                              <StatusPill tone="danger" emphasis>
                                {t('status.failed.retryExhausted')}
                              </StatusPill>
                            ) : null}
                          </div>
                          <div
                            className="openbitfun-memory-settings__failure-error"
                            data-testid="memories-status-stage1-failed-error"
                            title={failure.lastError}
                          >
                            {summarizeMemoryError(failure.lastError)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ConfigPageRow>
            </>
          )}
          {pipelineRun === 'timed-out' && (
            <ConfigMessage message={{ type: 'warning', text: t('status.messages.pollTimedOut') }} />
          )}
        </ConfigPageSection>

        <ConfigPageSection title={t('sections.basic.title')} description={t('sections.basic.description')}>
          <ConfigPageRow
            label={t('fields.memoryEnabled.label')}
            description={t('fields.memoryEnabled.description')}
            align="center"
          >
            <Switch
              data-testid="memories-enabled-toggle"
              checked={memoryEnabled}
              onChange={(event) => void updateMemoryEnabled(event.target.checked)}
              disabled={savingKey === 'generate_memories' || savingKey === 'use_memories'}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.generateForBtwSessions.label')}
            description={t('fields.generateForBtwSessions.description')}
            align="center"
          >
            <Switch
              checked={config.generate_for_btw_sessions}
              onChange={(event) => void updateConfig('generate_for_btw_sessions', event.target.checked)}
              disabled={savingKey === 'generate_for_btw_sessions' || memoryWorkDisabled}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.externalContextPolicy.label')}
            description={t('fields.externalContextPolicy.description')}
            align="center"
          >
            <Select
              value={config.external_context_policy}
              onValueChange={(value) => {
                void updateConfig(
                  'external_context_policy',
                  normalizeSelectValue(value) as MemoriesConfigShape['external_context_policy'],
                );
              }}
              options={externalContextPolicyOptions}
              size="sm"
              disabled={savingKey === 'external_context_policy' || memoryWorkDisabled}
            />
          </ConfigPageRow>

          <ConfigPageRow
            label={t('fields.memoryActions.label')}
            description={t('fields.memoryActions.description')}
            align="center"
          >
            <>
              <Button
                ref={actionMenuAnchorRef}
                type="button"
                variant="outline"
                size="sm"
                trailingIcon={<Icon name="chevron-down" size="sm" />}
                onClick={() => setActionMenuOpen((open) => !open)}
                loading={actionBusy !== null}
                disabled={actionBusy !== null}
                aria-label={t('fields.memoryActions.label')}
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
              >
                {t('actions.manage')}
              </Button>
              <MenuPopover
                items={actionMenuItems}
                open={actionMenuOpen}
                onClose={() => setActionMenuOpen(false)}
                anchorRef={actionMenuAnchorRef}
                placement="bottom"
                aria-label={t('fields.memoryActions.label')}
              />
            </>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection title={t('sections.models.title')} description={t('sections.models.description')}>
          <ConfigPageRow
            label={t('fields.extractModel.label')}
            description={t('fields.extractModel.description')}
            align="center"
          >
            <Select
              value={config.extract_model ?? ''}
              onValueChange={(value) => updateModelSelector('extract_model', value)}
              options={buildModelOptions(t('models.followPrimary'), config.extract_model ?? null)}
              size="sm"
              disabled={savingKey === 'extract_model' || memoryWorkDisabled}
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={t('fields.consolidationModel.label')}
            description={t('fields.consolidationModel.description')}
            align="center"
          >
            <Select
              value={config.consolidation_model ?? ''}
              onValueChange={(value) => updateModelSelector('consolidation_model', value)}
              options={buildModelOptions(t('models.followExtraction'), config.consolidation_model ?? null)}
              size="sm"
              disabled={savingKey === 'consolidation_model' || memoryWorkDisabled}
            />
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('sections.advanced.title')}
          description={t('sections.advanced.description')}
          extra={(
            <Tooltip
              content={t(advancedOpen ? 'actions.collapseAdvanced' : 'actions.expandAdvanced')}
              placement="bottom"
            >
              <IconButton
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-label={t(advancedOpen ? 'actions.collapseAdvanced' : 'actions.expandAdvanced')}
                aria-expanded={advancedOpen}
                icon={advancedOpen ? <Icon name="chevron-up" size="lg" /> : <Icon name="chevron-down" size="lg" />}
              />
            </Tooltip>
          )}
        >
          {advancedOpen && (
            <>
              <ConfigPageRow
                label={t('fields.minRolloutIdleHours.label')}
                description={t('fields.minRolloutIdleHours.description')}
                align="center"
              >
                <NumberInput
                  value={config.min_rollout_idle_hours}
                  onValueChange={(value) => void updateConfig('min_rollout_idle_hours', value)}
                  min={1}
                  max={48}
                  step={1}
                  unit={t('units.hours')}
                  size="sm"
                  disabled={savingKey === 'min_rollout_idle_hours' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutAgeDays.label')}
                description={t('fields.maxRolloutAgeDays.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollout_age_days}
                  onValueChange={(value) => void updateConfig('max_rollout_age_days', value)}
                  min={0}
                  max={365}
                  step={1}
                  unit={t('units.days')}
                  size="sm"
                  disabled={savingKey === 'max_rollout_age_days' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutsPerStartup.label')}
                description={t('fields.maxRolloutsPerStartup.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollouts_per_startup}
                  onValueChange={(value) => void updateConfig('max_rollouts_per_startup', value)}
                  min={1}
                  max={128}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'max_rollouts_per_startup' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxRolloutsScanLimit.label')}
                description={t('fields.maxRolloutsScanLimit.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_rollouts_scan_limit}
                  onValueChange={(value) => void updateConfig('max_rollouts_scan_limit', value)}
                  min={1}
                  max={50000}
                  step={100}
                  size="sm"
                  disabled={savingKey === 'max_rollouts_scan_limit' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.phase1MaxConcurrency.label')}
                description={t('fields.phase1MaxConcurrency.description')}
                align="center"
              >
                <NumberInput
                  value={config.phase1_max_concurrency}
                  onValueChange={(value) => void updateConfig('phase1_max_concurrency', value)}
                  min={1}
                  max={16}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'phase1_max_concurrency' || memoryWorkDisabled}
                />
              </ConfigPageRow>
              <ConfigPageRow
                label={t('fields.maxRawMemories.label')}
                description={t('fields.maxRawMemories.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_raw_memories_for_consolidation}
                  onValueChange={(value) => void updateConfig('max_raw_memories_for_consolidation', value)}
                  min={1}
                  max={4096}
                  step={1}
                  size="sm"
                  disabled={savingKey === 'max_raw_memories_for_consolidation' || memoryWorkDisabled}
                />
              </ConfigPageRow>

              <ConfigPageRow
                label={t('fields.maxUnusedDays.label')}
                description={t('fields.maxUnusedDays.description')}
                align="center"
              >
                <NumberInput
                  value={config.max_unused_days}
                  onValueChange={(value) => void updateConfig('max_unused_days', value)}
                  min={1}
                  max={365}
                  step={1}
                  unit={t('units.days')}
                  size="sm"
                  disabled={savingKey === 'max_unused_days' || memoryWorkDisabled}
                />
              </ConfigPageRow>
            </>
          )}
        </ConfigPageSection>
      </ConfigPageContent>
      <ConfirmDialog
        open={resetSettingsConfirmOpen}
        onOpenChange={() => setResetSettingsConfirmOpen(false)}
        onConfirm={() => void handleResetSettings()}
        title={t('actions.resetSettingsConfirmTitle')}
        message={t('actions.resetSettingsConfirm')}
        type="warning"
        confirmText={t('actions.resetSettingsConfirmAction')}
      />
      <ConfirmDialog
        open={resetMemoryConfirmOpen}
        onOpenChange={() => setResetMemoryConfirmOpen(false)}
        onConfirm={() => void handleResetMemory()}
        title={t('actions.resetMemory')}
        message={t('actions.resetMemoryConfirm')}
        type="warning"
        confirmDanger
        confirmText={t('actions.resetMemoryConfirmAction')}
      />
      <ConfirmDialog
        open={clearFailuresConfirmOpen}
        onOpenChange={() => setClearFailuresConfirmOpen(false)}
        onConfirm={() => void handleClearFailures()}
        title={t('status.failed.clearConfirmTitle')}
        message={t('status.failed.clearConfirm')}
        type="warning"
        confirmText={t('status.failed.clearConfirmAction')}
      />
    </ConfigPageLayout>
  );
};

export default MemorySettingsPage;
