/**
 * Model selector component.
 * Shows the active model and allows quick switching.
 *
 * Config linkage:
 * - Model selection is shared across all future mode sessions through
 *   ai.agent_model_defaults.mode. Delegated subagents keep separate defaults.
 * - Supports 'primary' | 'fast' | specific model IDs
 */

import { subscribeOverlayInteraction, createOverlayPortal, LoadingState, Menu, MenuItem, MenuList, MenuSection, MenuSeparator, OverflowText, SegmentedControl, Spinner } from '@openbitfun/ui';
import React, { useState, useEffect, useId, useRef, useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { Zap } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { agentAPI } from '@/infrastructure/api/service-api/AgentAPI';
import {
  aiApi,
  type AIModelCatalog,
  type ReasoningCatalogProjection,
} from '@/infrastructure/api/service-api/AIApi';
import { ACPClientAPI, type AcpSessionOptions } from '@/infrastructure/api/service-api/ACPClientAPI';
import { getProviderDisplayName, getProviderGroupKey } from '@/infrastructure/config/services/modelConfigs';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { AIModelConfig, AgentModelDefaultsConfig, DefaultModelsConfig } from '@/infrastructure/config/types';
import { Tooltip, Icon } from '@openbitfun/ui';
import { RetainedMountBoundary } from '@/shared/presence';
import { notificationService } from '@/shared/notification-system';
import { FlowChatStore } from '../store/FlowChatStore';
import { getModelMaxTokens } from '../services/flow-chat-manager/SessionModule';
import { acpClientIdFromAgentType } from '../utils/acpSession';
import {
  buildAcpFastModeValue,
  getAcpModelProviderName,
  resolveAcpFastModeState,
  resolveAcpModeState,
  resolveAcpReasoningState,
} from '../utils/acpSessionConfig';
import { sessionProjectWorkspacePath, sessionWorkspaceId } from '../utils/sessionWorkspace';
import { quickActions } from '@/shared/services/ide-control';
import {
  buildContextUsageTooltip,
  buildModelSelectorTooltipDetails,
  type ContextUsageSource,
  type ModelSelectorTooltipDetails,
} from '../utils/tokenUsageDisplay';
import { createLogger } from '@/shared/utils/logger';
import { getModelSelectorDropdownLayout } from './modelSelectorDropdownPosition';
import { AcpModeSelector } from './AcpModeSelector';
import { ModelModeAnimation } from './ModelModeAnimation';
import { ReasoningIntensityControl } from './ReasoningIntensityControl';
import { isAutomaticReasoningPreset, reasoningPresetChoices, reasoningSelectionLabel, resolveReasoningPresetChoice } from './reasoningPresetPresentation';
import {
  getRecentReasoningPreset,
  setRecentReasoningPreset,
} from '../utils/reasoningPresets';
import {
  shouldIncludeInternalModelSession,
  shouldSyncSessionModelSelection,
} from '../utils/modelSelectionTarget';
import {
  filterSelectableTextChatModels,
  isSelectableTextChatModel,
} from '@/infrastructure/config/services/modelCategory';
import {
  resolveModelReference,
  resolveModelSelection,
  type ModelAvailabilityStatus,
} from '../utils/modelResolution';
import { getRecentManualModel, setRecentManualModel } from '../utils/manualModelSelection';
import './ModelSelector.scss';

const log = createLogger('ModelSelector');
const ACP_SESSION_OPTIONS_TIMEOUT_MS = 65_000;
const MODEL_SELECTOR_EXIT_DURATION_MS = 100;

export interface ExternalModelSelection {
  models: string[];
  selectedModelId?: string;
  defaultModelId?: string;
  reasoningCatalog?: AIModelCatalog;
  selectedReasoningPreset?: string;
  providerLabel: string;
  disabled?: boolean;
  /**
   * Also offer this device's own enabled models, and fall back to its catalog
   * for reasoning presets.
   *
   * For a transport that only relays a session elsewhere, `models` is a probe
   * snapshot rather than the set of choices the user has: the executing side
   * is brought up to whatever is picked. Leave this off for a transport that
   * owns a genuinely foreign model list.
   */
  includeLocalCatalog?: boolean;
  onSelect: (modelId: string) => void | Promise<void>;
  onSelectReasoningPreset?: (presetId: string | null) => void | Promise<void>;
}

export interface ModelSelectorAvailability {
  status: ModelAvailabilityStatus;
  canSend: boolean;
}

interface ModelSelectorProps {
  /** Current target agent type. */
  currentMode: string;
  /** Custom class name. */
  className?: string;
  /** Preferred dropdown placement relative to the trigger. */
  dropdownPlacement?: 'top' | 'bottom';
  /** Current session ID (used to update the selected session model). */
  sessionId?: string;
  /** Whether the active input target is a Task subagent session. */
  isSubagentSession?: boolean;
  /** Current token count. */
  currentTokens?: number;
  /** Max token capacity. */
  maxTokens?: number;
  /** Semantic source for the context usage number. */
  contextUsageSource?: ContextUsageSource;
  /** Called when model switching starts or completes, so the parent can gate sending. */
  onLoadingChange?: (loading: boolean) => void;
  /** Reports whether the current target has a model that can accept a turn. */
  onAvailabilityChange?: (availability: ModelSelectorAvailability) => void;
  /** Target-owned model catalog for transports that do not have a local backend session. */
  externalSelection?: ExternalModelSelection;
  /** Agent-profile model used only when the session has no explicit selection. */
  modeDefaultModelId?: string;
  /** Whether a selection also changes OpenBitFun's shared built-in mode default. */
  persistSharedModeDefault?: boolean;
  /** Whether lifecycle ownership currently prevents Session setting changes. */
  disabled?: boolean;
  /** Why the owning composer temporarily prevents setting changes. */
  disabledReason?: string;
  /** Compact trigger treatment supplied by the owning composer. */
  reasoningTriggerPresentation?: 'meter' | 'label';
}

interface ModelInfo {
  id: string;
  /** User-defined configuration name (AIModelConfig.name). */
  configName: string;
  /** Optional label used by symbolic selectors such as Primary and Fast. */
  displayName?: string;
  /** Actual model identifier (AIModelConfig.model_name). */
  modelName: string;
  providerName: string;
  provider: string;
  /** Provider instance this model is configured under, used to group the menu. */
  providerKey?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** One provider instance and the chat models configured under it. */
interface ProviderGroupInfo {
  key: string;
  providerName: string;
  models: ModelInfo[];
}

type ModelSelectorPanel = 'modes' | 'models';
type UpcomingModelMode = 'smart' | 'pool';
type ModelSelectorLevelDirection = 'none' | 'forward' | 'back';

const ModelSelectorTooltipContent: React.FC<{ details: ModelSelectorTooltipDetails }> = ({ details }) => (
  <div className="openbitfun-model-selector__tooltip">
    {details.rows.map(row => (
      <div key={row.key} className="openbitfun-model-selector__tooltip-row">
        <span className="openbitfun-model-selector__tooltip-label">{row.label}</span>
        <span className="openbitfun-model-selector__tooltip-value">{row.value}</span>
      </div>
    ))}
    {details.warning ? (
      <div className="openbitfun-model-selector__tooltip-warning">{details.warning}</div>
    ) : null}
  </div>
);

const ModelSelectorMenuLevel: React.FC<{
  children: React.ReactNode;
  direction: ModelSelectorLevelDirection;
}> = ({ children, direction }) => (
  <div
    className="openbitfun-model-selector__level"
    data-openbitfun-component="model-selector"
    data-openbitfun-part="level"
    data-direction={direction}
  >
    <div
      className="openbitfun-model-selector__list"
      data-openbitfun-component="model-selector"
      data-openbitfun-part="list"
    >
      <MenuSection>{children}</MenuSection>
    </div>
  </div>
);

// Helper: identify special model IDs.
const isSpecialModel = (value: string): value is 'primary' | 'fast' => {
  return value === 'primary' || value === 'fast';
};

function resolveConcreteModelId(
  modelId: string,
  defaultModels: DefaultModelsConfig,
): string | undefined {
  if (modelId === 'primary') return defaultModels.primary ?? undefined;
  if (modelId === 'fast') return defaultModels.fast ?? defaultModels.primary ?? undefined;
  return modelId || undefined;
}

const formatContextWindow = (contextWindow?: number): string | null => {
  if (!contextWindow) return null;
  return `${Math.round(contextWindow / 1000)}k`;
};

const buildModelMetaText = (model: Pick<ModelInfo, 'providerName' | 'contextWindow'>): string => {
  const parts = [model.providerName];
  const contextWindow = formatContextWindow(model.contextWindow);

  if (contextWindow) {
    parts.push(contextWindow);
  }

  return parts.join(' · ');
};

const buildResolvedModelTooltipText = (
  modelName: string | undefined,
  model: Pick<ModelInfo, 'providerName' | 'contextWindow'> | null | undefined,
  fallback: string
): string => {
  if (!model) return fallback;

  const parts = [];
  if (modelName) {
    parts.push(modelName);
  }

  const metaText = buildModelMetaText(model);
  if (metaText) {
    parts.push(metaText);
  }

  return parts.join(' · ') || fallback;
};

const getModelDisplayLabel = (model: ModelInfo | null, fallback: string): string => {
  if (!model) return fallback;
  return model.displayName || model.modelName || model.configName || fallback;
};

const getModelTooltipText = (model: ModelInfo | null, fallback: string): string => {
  if (!model) return fallback;
  if (isSpecialModel(model.id)) {
    return buildResolvedModelTooltipText(model.modelName, model, fallback);
  }
  return buildModelMetaText(model);
};

const getAvailabilityLabel = (
  status: ModelAvailabilityStatus,
  t: (key: string) => string,
): string => {
  switch (status) {
    case 'loading':
      return t('modelSelector.status.loading');
    case 'load-error':
      return t('modelSelector.status.loadError');
    case 'unconfigured':
      return t('modelSelector.status.unconfigured');
    case 'no-enabled-chat-model':
      return t('modelSelector.status.noEnabledChatModel');
    case 'catalog-unavailable':
      return t('modelSelector.status.catalogUnavailable');
    case 'target-model-unavailable':
      return t('modelSelector.status.targetModelUnavailable');
    case 'degraded':
      return t('modelSelector.status.degraded');
    case 'ready':
    default:
      return t('modelSelector.primaryModel');
  }
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      error => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

const syncAcpContextUsageToStore = (
  sessionId: string | undefined,
  options: AcpSessionOptions,
): void => {
  if (!sessionId || !options.contextUsage) {
    return;
  }

  FlowChatStore.getInstance().updateAcpContextUsage(sessionId, options.contextUsage);
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentMode,
  className = '',
  dropdownPlacement = 'top',
  sessionId,
  isSubagentSession = false,
  currentTokens = 0,
  maxTokens = 0,
  contextUsageSource,
  onLoadingChange,
  onAvailabilityChange,
  externalSelection,
  modeDefaultModelId,
  persistSharedModeDefault = true,
  disabled = false,
  disabledReason,
}) => {
  const { t } = useI18n('flow-chat');
  const deviceSurfaceScope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const modelSelectionScopeKey = deviceSurfaceScope.key('model-selector', currentMode, sessionId);
  const modelSelectionScopeRef = useRef(modelSelectionScopeKey);
  modelSelectionScopeRef.current = modelSelectionScopeKey;
  const manualModelRef = useRef<{ scopeKey: string; modelId: string } | null>(null);
  const [allModels, setAllModels] = useState<AIModelConfig[]>([]);
  const [modelCatalog, setModelCatalog] = useState<AIModelCatalog | null>(null);
  const [defaultModels, setDefaultModels] = useState<DefaultModelsConfig>({});
  const [modeModel, setModeModel] = useState('primary');
  const [configLoadState, setConfigLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogLoadState, setCatalogLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [acpOptions, setAcpOptions] = useState<AcpSessionOptions | null>(null);
  const [acpOptionsLoadState, setAcpOptionsLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [keyboardNavigationOpen, setKeyboardNavigationOpen] = useState(false);
  /** Provider whose models the menu is currently showing; null is the provider level. */
  const [activeProviderKey, setActiveProviderKey] = useState<string | null>(null);
  /** Models use a detail view; modes expand horizontally inside the summary card. */
  const [activePanel, setActivePanel] = useState<ModelSelectorPanel | null>(null);
  const [modeSelectionPending, setModeSelectionPending] = useState(false);
  const [modeFocusRevision, setModeFocusRevision] = useState(0);
  const [providerFromSummary, setProviderFromSummary] = useState(false);
  // Upcoming modes execute through primary until the runtime supports routing.
  const [upcomingMode, setUpcomingMode] = useState<{
    id: UpcomingModelMode;
    scopeKey: string;
  } | null>(null);
  /** Direction of navigation within the card. */
  const [levelDirection, setLevelDirection] = useState<ModelSelectorLevelDirection>('none');
  const [loading, setLoading] = useState(false);
  const [reasoningLoading, setReasoningLoading] = useState(false);
  const [preSessionReasoningSelection, setPreSessionReasoningSelection] = useState<{
    modelId: string;
    presetId: string | undefined;
  } | null>(null);
  const acpRestoreToastShownRef = useRef<string | null>(null);
  const acpOptionsRef = useRef<AcpSessionOptions | null>(null);
  const configLoadRequestRef = useRef(0);
  const catalogLoadRequestRef = useRef(0);
  const acpOptionsLoadRequestRef = useRef(0);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const portalDropdownRef = useRef<HTMLDivElement>(null);
  const modelFieldRef = useRef<HTMLButtonElement>(null);
  const modeFieldRef = useRef<HTMLButtonElement>(null);
  const modeChoicesRef = useRef<HTMLDivElement>(null);
  const modeSelectionPendingRef = useRef(false);
  const modeRetryFocusRef = useRef<string | undefined>(undefined);
  const providerFieldRef = useRef<HTMLButtonElement>(null);
  const focusPanelOnOpenRef = useRef(false);
  const focusSummaryOnReturnRef = useRef<ModelSelectorPanel | 'provider' | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    onLoadingChange?.(loading || reasoningLoading);
  }, [loading, onLoadingChange, reasoningLoading]);

  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({
    position: 'fixed',
    visibility: 'hidden',
  });
  const [resolvedDropdownPlacement, setResolvedDropdownPlacement] = useState(dropdownPlacement);
  const activeSession = sessionId ? FlowChatStore.getInstance().getState().sessions.get(sessionId) : undefined;
  const sessionReasoningPreset = useSyncExternalStore(
    useCallback(
      (callback) => FlowChatStore.getInstance().subscribe(() => callback()),
      [],
    ),
    useCallback(
      () => sessionId
        ? FlowChatStore.getInstance().getState().sessions.get(sessionId)?.config.reasoningPreset
        : undefined,
      [sessionId],
    ),
    () => undefined,
  );
  // Model changes must also invalidate the selector. The reasoning snapshot
  // above intentionally only contains the preset, so a subagent (which does
  // not persist the shared mode default) could otherwise keep showing its
  // previous model after a successful switch.
  const sessionModelName = useSyncExternalStore(
    useCallback(
      (callback) => FlowChatStore.getInstance().subscribe(() => callback()),
      [],
    ),
    useCallback(
      () => sessionId
        ? FlowChatStore.getInstance().getState().sessions.get(sessionId)?.config.modelName ?? ''
        : '',
      [sessionId],
    ),
    () => '',
  );
  const acpClientId =
    acpClientIdFromAgentType(activeSession?.config.agentType) ??
    acpClientIdFromAgentType(activeSession?.mode);
  const isAcpSession = Boolean(acpClientId && sessionId);
  const targetIsSubagent = isSubagentSession || activeSession?.sessionKind === 'subagent';

  const loadModelCatalog = useCallback(async () => {
    const requestId = ++catalogLoadRequestRef.current;
    setCatalogLoadState('loading');
    try {
      const catalog = await aiApi.getModelCatalog();
      if (requestId !== catalogLoadRequestRef.current) return false;
      setModelCatalog(catalog);
      setCatalogLoadState('ready');
      return true;
    } catch (error) {
      if (requestId !== catalogLoadRequestRef.current) return false;
      setModelCatalog(null);
      setCatalogLoadState('error');
      log.warn('Failed to load AI model catalog', { error });
      return false;
    }
  }, []);

  // Load configuration data.
  const loadConfigData = useCallback(async () => {
    const requestId = ++configLoadRequestRef.current;
    setConfigLoadState('loading');
    try {
      const configData = await configManager.getConfigs([
        'ai.models',
        'ai.default_models',
        'ai.agent_model_defaults',
      ]);
      const models = Array.isArray(configData['ai.models'])
        ? configData['ai.models'] as AIModelConfig[]
        : [];
      const defaultModelsData = (configData['ai.default_models'] as DefaultModelsConfig | undefined) || {};
      const agentModelDefaults = configData['ai.agent_model_defaults'] as AgentModelDefaultsConfig | undefined;

      if (requestId !== configLoadRequestRef.current) return false;
      setAllModels(models);
      setDefaultModels(defaultModelsData);
      setModeModel(agentModelDefaults?.mode?.trim() || 'primary');
      setConfigLoadState('ready');
      await loadModelCatalog();

      if (requestId !== configLoadRequestRef.current) return false;

      log.debug('Configuration loaded', {
        modelsCount: models.length
      });
      return true;
    } catch (error) {
      if (requestId !== configLoadRequestRef.current) return false;
      setConfigLoadState('error');
      log.error('Failed to load configuration', error);
      return false;
    }
  }, [loadModelCatalog]);
  
  useEffect(() => {
    const unsubscribeCatalog = aiApi.onModelCatalogUpdated(() => {
      void loadModelCatalog();
    });
    void loadConfigData();
    
    const handleConfigUpdate = () => {
      log.debug('Configuration update detected, reloading');
      void loadConfigData();
    };
    
    globalEventBus.on('mode:config:updated', handleConfigUpdate);
    
    const unsubscribe = configManager.onConfigChange((path) => {
      if (path === 'ai' || path.startsWith('ai.')) {
        log.debug('AI configuration changed', { path });
        void loadConfigData();
      }
    });
    
    return () => {
      globalEventBus.off('mode:config:updated', handleConfigUpdate);
      unsubscribe();
      unsubscribeCatalog();
    };
  }, [loadConfigData, loadModelCatalog]);

  const loadAcpOptions = useCallback(async () => {
    const requestId = ++acpOptionsLoadRequestRef.current;
    if (!isAcpSession || !acpClientId || !sessionId) {
      setAcpOptions(null);
      setAcpOptionsLoadState('ready');
      return;
    }

    setAcpOptionsLoadState('loading');
    const shouldShowRestoreToast = !acpOptionsRef.current && acpRestoreToastShownRef.current !== sessionId;
    const restoreRequestId = `acp-options:${sessionId}:${acpClientId}`;
    if (shouldShowRestoreToast) {
      acpRestoreToastShownRef.current = sessionId;
      window.dispatchEvent(new CustomEvent('openbitfun:acp-session-creation', {
        detail: { phase: 'start', clientId: acpClientId, action: 'restore', requestId: restoreRequestId },
      }));
    }

    let succeeded = false;
    try {
      const options = await withTimeout(
        ACPClientAPI.getSessionOptions({
          sessionId,
          clientId: acpClientId,
          workspaceId: activeSession?.workspaceId || activeSession?.config.workspaceId,
          workspacePath: activeSession?.workspacePath || activeSession?.config.workspacePath,
          remoteConnectionId: activeSession?.remoteConnectionId,
          remoteSshHost: activeSession?.remoteSshHost,
        }),
        ACP_SESSION_OPTIONS_TIMEOUT_MS,
        `Timed out restoring ACP session options for ${acpClientId}`,
      );
      succeeded = true;
      if (requestId !== acpOptionsLoadRequestRef.current) return;
      setAcpOptions(options);
      setAcpOptionsLoadState('ready');
      syncAcpContextUsageToStore(sessionId, options);
    } catch (error) {
      if (requestId !== acpOptionsLoadRequestRef.current) return;
      log.warn('Failed to load ACP session model options', { sessionId, acpClientId, error });
      setAcpOptionsLoadState('error');
    } finally {
      if (shouldShowRestoreToast) {
        window.dispatchEvent(new CustomEvent('openbitfun:acp-session-creation', {
          detail: {
            phase: 'finish',
            clientId: acpClientId,
            action: 'restore',
            requestId: restoreRequestId,
            succeeded,
          },
        }));
      }
    }
  }, [
    activeSession?.config.workspacePath,
    activeSession?.remoteConnectionId,
    activeSession?.remoteSshHost,
    activeSession?.workspacePath,
    acpClientId,
    isAcpSession,
    sessionId,
    activeSession?.config.workspaceId,
    activeSession?.workspaceId,
  ]);

  useEffect(() => {
    acpOptionsLoadRequestRef.current += 1;
    acpOptionsRef.current = null;
    acpRestoreToastShownRef.current = null;
    setAcpOptions(null);
    setAcpOptionsLoadState('loading');
  }, [acpClientId, sessionId]);

  useEffect(() => {
    acpOptionsRef.current = acpOptions;
  }, [acpOptions]);

  useEffect(() => {
    loadAcpOptions();
  }, [loadAcpOptions]);

  useEffect(() => {
    if (!isAcpSession || !sessionId || !acpClientId) return;

    return ACPClientAPI.onSessionOptionsChanged((event) => {
      if (event.sessionId === sessionId && event.clientId === acpClientId) {
        loadAcpOptions();
      }
    });
  }, [acpClientId, isAcpSession, loadAcpOptions, sessionId]);
  
  useEffect(() => {
    let removeOverlayMousedown0: (() => void) | undefined;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current && !dropdownRef.current.contains(target)
          && !portalDropdownRef.current?.contains(target)) {
        setDropdownOpen(false);
        setKeyboardNavigationOpen(false);
      }
    };

    if (dropdownOpen) {
      removeOverlayMousedown0 = subscribeOverlayInteraction(portalDropdownRef, 'mousedown', handleClickOutside);
    }

    return () => {
      removeOverlayMousedown0?.();
    };
  }, [dropdownOpen]);

  const acpAvailableModels = useMemo((): ModelInfo[] => {
    if (!isAcpSession || !acpOptions) return [];
    return acpOptions.availableModels.map(model => ({
      id: model.id,
      configName: model.name,
      modelName: model.name,
      providerName: getAcpModelProviderName(model) ?? (acpClientId ? `${acpClientId} ACP` : 'ACP'),
      provider: 'acp',
    }));
  }, [acpClientId, acpOptions, isAcpSession]);

  const acpCurrentModel = useMemo((): ModelInfo | null => {
    if (!isAcpSession || !acpOptions?.currentModelId) return null;
    return acpAvailableModels.find(model => model.id === acpOptions.currentModelId) || {
      id: acpOptions.currentModelId,
      configName: acpOptions.currentModelId,
      modelName: acpOptions.currentModelId,
      providerName: acpClientId ? `${acpClientId} ACP` : 'ACP',
      provider: 'acp',
    };
  }, [acpAvailableModels, acpClientId, acpOptions?.currentModelId, isAcpSession]);

  const externalAvailableModels = useMemo((): ModelInfo[] => {
    if (!externalSelection) return [];
    const localSelectable = externalSelection.includeLocalCatalog
      ? filterSelectableTextChatModels(allModels).map(model => model.id)
      : [];
    return Array.from(new Set([
      ...externalSelection.models,
      ...localSelectable,
    ].filter((model): model is string => !!model?.trim())))
      .map(modelId => {
        // A synced target reports stable config ids because those are what the
        // worker must execute. Reuse the controller catalog for presentation
        // so generated ids never leak into the normal model-picker UI.
        const localModel = allModels.find(model => model.id === modelId);
        return localModel
          ? {
              id: modelId,
              configName: localModel.name,
              modelName: localModel.model_name,
              providerName: getProviderDisplayName(localModel),
              provider: localModel.provider,
              providerKey: getProviderGroupKey(localModel),
              contextWindow: localModel.context_window,
              maxOutputTokens: localModel.max_tokens,
            }
          : {
              id: modelId,
              configName: modelId,
              modelName: modelId,
              providerName: externalSelection.providerLabel,
              provider: 'external',
            };
      });
  }, [allModels, externalSelection]);

  /**
   * This device's own default, resolved to the concrete id the executing side
   * needs. Only consulted when the target reported no default of its own, so a
   * session that has never been given a model still shows what a local session
   * here would run rather than whichever id happens to sort first.
   */
  const externalLocalDefaultModelId = useMemo((): string | undefined => {
    if (!externalSelection?.includeLocalCatalog) return undefined;
    const configured = modeDefaultModelId?.trim() || modeModel;
    const concrete = resolveConcreteModelId(configured, defaultModels);
    return concrete && allModels.some(model => model.id === concrete && isSelectableTextChatModel(model))
      ? concrete
      : undefined;
  }, [
    allModels,
    defaultModels,
    externalSelection?.includeLocalCatalog,
    modeDefaultModelId,
    modeModel,
  ]);
  const externalExplicitModelId =
    externalSelection?.selectedModelId?.trim()
    || externalSelection?.defaultModelId?.trim();
  const externalCurrentModelId =
    externalExplicitModelId
    || externalLocalDefaultModelId
    || externalAvailableModels[0]?.id
    || '';
  const externalCurrentModel = externalAvailableModels.find(
    model => model.id === externalCurrentModelId,
  ) ?? null;
  const externalSelectionIsUnavailable = Boolean(
    externalExplicitModelId
    && !externalCurrentModel,
  );
  const externalReasoningProjection = useMemo((): ReasoningCatalogProjection | null => {
    if (!externalSelection || !externalCurrentModelId) return null;
    // Copying model credentials does not copy the target's reasoning support.
    // Restored projections without a target catalog must not infer presets
    // from a controller that can have a different provider/runtime version.
    return externalSelection.reasoningCatalog?.models.find(
      model => model.id === externalCurrentModelId,
    )?.reasoning ?? null;
  }, [externalCurrentModelId, externalSelection]);

  const acpFastMode = useMemo(
    () => resolveAcpFastModeState(acpOptions?.configOptions ?? []),
    [acpOptions?.configOptions],
  );
  const acpReasoning = useMemo(
    () => resolveAcpReasoningState(acpOptions?.configOptions ?? []),
    [acpOptions?.configOptions],
  );
  const acpMode = useMemo(
    () => resolveAcpModeState(acpOptions?.configOptions ?? []),
    [acpOptions?.configOptions],
  );
  
  const getCurrentModelId = useCallback((): string => {
    const resolution = resolveModelSelection({
      models: allModels,
      sessionModelId: sessionModelName || undefined,
      profileModelId: modeDefaultModelId,
      modeDefaultModelId: targetIsSubagent ? undefined : modeModel,
      defaultModels,
    });
    return resolution.selectorId ?? '';
  }, [allModels, defaultModels, modeDefaultModelId, modeModel, sessionModelName, targetIsSubagent]);

  const currentModel = useMemo((): ModelInfo | null => {
    const modelId = getCurrentModelId();
    if (!modelId) return null;

    if (modelId === 'primary' || modelId === 'fast') {
      const actualModelId = resolveConcreteModelId(modelId, defaultModels);
      if (!actualModelId) return null;

      const model = allModels.find(m => m.id === actualModelId && isSelectableTextChatModel(m));
      if (!model) return null;

      return {
        id: modelId,
        configName: model.name,
        displayName: modelId === 'primary' ? t('modelSelector.primaryModel') : t('modelSelector.fastModel'),
        modelName: model.model_name,
        providerName: getProviderDisplayName(model),
        provider: model.provider,
        contextWindow: model.context_window,
        maxOutputTokens: model.max_tokens,
      };
    }

    const model = allModels.find(m => m.id === modelId && isSelectableTextChatModel(m));
    if (!model) return null;

    return {
      id: model.id || '',
      configName: model.name,
      modelName: model.model_name,
      providerName: getProviderDisplayName(model),
      provider: model.provider,
      contextWindow: model.context_window,
      maxOutputTokens: model.max_tokens,
    };
  }, [getCurrentModelId, allModels, defaultModels, t]);
  
  const availableModels = useMemo((): ModelInfo[] => {
    return filterSelectableTextChatModels(allModels)
      .map(m => ({
        id: m.id || '',
        configName: m.name,
        modelName: m.model_name,
        providerName: getProviderDisplayName(m),
        provider: m.provider,
        providerKey: getProviderGroupKey(m),
        contextWindow: m.context_window,
        maxOutputTokens: m.max_tokens,
      }));
  }, [allModels]);

  /**
   * Configuration order is preserved so a provider does not move between
   * openings, and so the models inside one provider keep the order the user
   * arranged them in on the settings page.
   */
  const providerGroups = useMemo((): ProviderGroupInfo[] => {
    const groups: ProviderGroupInfo[] = [];
    const groupsByKey = new Map<string, ProviderGroupInfo>();

    const sourceModels = externalSelection ? externalAvailableModels
      : isAcpSession ? acpAvailableModels : availableModels;
    for (const model of sourceModels) {
      const key = model.providerKey || `${model.provider}:${model.providerName}`;
      const existing = groupsByKey.get(key);
      if (existing) {
        existing.models.push(model);
        continue;
      }
      const group: ProviderGroupInfo = {
        key,
        providerName: model.providerName,
        models: [model],
      };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    return groups;
  }, [acpAvailableModels, availableModels, externalAvailableModels, externalSelection, isAcpSession]);

  const nativeModelResolution = useMemo(
    () => resolveModelSelection({
      models: allModels,
      sessionModelId: sessionModelName || undefined,
      profileModelId: modeDefaultModelId,
      modeDefaultModelId: targetIsSubagent ? undefined : modeModel,
      defaultModels,
    }),
    [
      allModels,
      defaultModels,
      modeDefaultModelId,
      modeModel,
      sessionModelName,
      targetIsSubagent,
    ],
  );

  const nativeAvailability = useMemo((): ModelSelectorAvailability => {
    let status: ModelAvailabilityStatus;
    if (configLoadState === 'loading') {
      status = 'loading';
    } else if (configLoadState === 'error') {
      status = 'load-error';
    } else if (allModels.length === 0) {
      status = 'unconfigured';
    } else if (availableModels.length === 0) {
      status = 'no-enabled-chat-model';
    } else if (!nativeModelResolution.model) {
      status = 'target-model-unavailable';
    } else if (catalogLoadState === 'error') {
      status = 'catalog-unavailable';
    } else if (nativeModelResolution.recovered) {
      status = 'degraded';
    } else {
      status = 'ready';
    }

    return {
      status,
      canSend: configLoadState === 'ready' && nativeModelResolution.model !== null,
    };
  }, [
    allModels.length,
    availableModels.length,
    catalogLoadState,
    configLoadState,
    nativeModelResolution.model,
    nativeModelResolution.recovered,
  ]);

  const activeProviderGroup = activeProviderKey
    ? providerGroups.find(group => group.key === activeProviderKey) ?? null
    : null;

  const externalAvailability = useMemo((): ModelSelectorAvailability => {
    const targetModels = externalSelection?.models ?? [];
    const isWaitingForLocalCatalog = Boolean(
      externalSelection?.includeLocalCatalog
      && configLoadState === 'loading'
      && targetModels.length === 0,
    );
    if (isWaitingForLocalCatalog) {
      return { status: 'loading', canSend: false };
    }

    if (externalSelectionIsUnavailable) {
      return { status: 'target-model-unavailable', canSend: false };
    }

    if (externalCurrentModel) {
      return { status: 'ready', canSend: true };
    }

    if (externalSelection?.includeLocalCatalog && configLoadState === 'error') {
      return { status: 'load-error', canSend: false };
    }

    return {
      status: allModels.length > 0 ? 'no-enabled-chat-model' : 'unconfigured',
      canSend: false,
    };
  }, [
    allModels.length,
    configLoadState,
    externalCurrentModel,
    externalSelectionIsUnavailable,
    externalSelection?.includeLocalCatalog,
    externalSelection?.models,
  ]);

  const acpAvailability = useMemo((): ModelSelectorAvailability => {
    if (!isAcpSession || !acpOptions) {
      return { status: acpOptionsLoadState === 'error' ? 'load-error' : 'loading', canSend: false };
    }

    const hasAcpExecutionTarget = Boolean(
      acpAvailableModels.length > 0 || acpMode || acpFastMode,
    );
    return {
      status: hasAcpExecutionTarget ? 'ready' : 'unconfigured',
      // ACP can legitimately expose only a mode; the agent owns the actual
      // model in that case and still accepts a turn.
      canSend: hasAcpExecutionTarget,
    };
  }, [acpAvailableModels.length, acpFastMode, acpMode, acpOptions, acpOptionsLoadState, isAcpSession]);

  const availability = useMemo(() => {
    if (externalSelection) return externalAvailability;
    if (isAcpSession) return acpAvailability;
    return nativeAvailability;
  }, [acpAvailability, externalAvailability, externalSelection, isAcpSession, nativeAvailability]);

  useEffect(() => {
    onAvailabilityChange?.(availability);
  }, [availability, onAvailabilityChange]);

  const handleOpenModelSettings = useCallback(() => {
    setDropdownOpen(false);
    setKeyboardNavigationOpen(false);
    quickActions.openSettings({ pageId: 'ai.models' });
  }, []);

  const renderUnavailableModelMenu = useCallback((
    currentAvailability: ModelSelectorAvailability,
    canOpenSettings: boolean,
  ) => (
    <>
      <MenuItem
        disabled
        leading={<Icon name="info" size="sm" aria-hidden />}
        data-testid="chat-model-selector-status"
        data-model-status={currentAvailability.status}
        data-openbitfun-component="model-selector"
        data-openbitfun-part="option"
      >
        {getAvailabilityLabel(currentAvailability.status, t)}
      </MenuItem>
      {canOpenSettings ? (
        <MenuItem
          data-testid="chat-model-selector-open-settings"
          leading={<Icon name="settings" size="sm" aria-hidden />}
          data-openbitfun-component="model-selector"
          data-openbitfun-part="option"
          onClick={handleOpenModelSettings}
        >
          {t('modelSelector.openModelSettings')}
        </MenuItem>
      ) : null}
    </>
  ), [handleOpenModelSettings, t]);

  const focusPreferredPanelItem = useCallback(() => {
    if (modeChoicesRef.current) {
      const buttons = Array.from(modeChoicesRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const preferred = buttons.find(button => button.dataset.openbitfunValue === modeRetryFocusRef.current)
        ?? buttons.find(button => button.getAttribute('aria-pressed') === 'true')
        ?? buttons[0];
      preferred?.focus({ preventScroll: true });
      modeRetryFocusRef.current = undefined;
      return;
    }
    const menu = portalDropdownRef.current;
    const preferredItem = menu?.querySelector<HTMLButtonElement>(
      'button[role="menuitemradio"][aria-checked="true"], button[data-provider-key][data-selected="true"]',
    );
    const firstItem = menu?.querySelector<HTMLButtonElement>(
      'button[role="menuitemradio"]:not(:disabled), button[role="menuitem"]:not(:disabled)',
    );
    (preferredItem ?? firstItem)?.focus({ preventScroll: true });
  }, []);

  const resetDropdownNavigation = useCallback(() => {
    focusSummaryOnReturnRef.current = null;
    focusPanelOnOpenRef.current = false;
    setActiveProviderKey(null);
    setProviderFromSummary(false);
    setActivePanel(null);
    setLevelDirection('none');
  }, []);

  const openPanel = useCallback((kind: ModelSelectorPanel, moveFocus: boolean) => {
    modeRetryFocusRef.current = undefined;
    focusPanelOnOpenRef.current = moveFocus;
    focusSummaryOnReturnRef.current = null;
    setActiveProviderKey(null);
    setProviderFromSummary(false);
    setLevelDirection('forward');
    if (activePanel === kind && moveFocus && !activeProviderKey) {
      focusPanelOnOpenRef.current = false;
      focusPreferredPanelItem();
    }
    setActivePanel(kind);
  }, [activeProviderKey, focusPreferredPanelItem, activePanel]);

  const closePanel = useCallback((restoreFocus: boolean) => {
    focusSummaryOnReturnRef.current = restoreFocus ? activePanel : null;
    focusPanelOnOpenRef.current = false;
    setActiveProviderKey(null);
    setProviderFromSummary(false);
    setActivePanel(null);
    setLevelDirection('back');
  }, [activePanel]);

  const openPanelFromClick = useCallback((kind: ModelSelectorPanel) => {
    openPanel(kind, true);
  }, [openPanel]);

  const openProviderLevel = useCallback((providerKey: string, fromSummary = false) => {
    setActiveProviderKey(providerKey);
    setProviderFromSummary(fromSummary);
    setLevelDirection('forward');
  }, []);

  const closeProviderLevel = useCallback(() => {
    if (providerFromSummary) {
      closePanel(true);
      focusSummaryOnReturnRef.current = 'provider';
      return;
    }
    setActiveProviderKey(null);
    setLevelDirection('back');
  }, [closePanel, providerFromSummary]);

  // Keep the last view intact during exit; trigger handlers reset it on reopening.
  // Catalog refreshes must not leave an open menu on a missing provider view.
  useEffect(() => {
    if (!dropdownOpen) return;
    if (activePanel !== 'models' && activeProviderKey) {
      setActiveProviderKey(null);
      return;
    }
    if (activeProviderKey && !activeProviderGroup) {
      closeProviderLevel();
    }
  }, [activeProviderGroup, activeProviderKey, closeProviderLevel, dropdownOpen, activePanel]);

  const currentNativeModelId = getCurrentModelId();
  const concreteModelId = resolveConcreteModelId(currentNativeModelId, defaultModels);
  /** Provider that owns the pinned model, so the provider level can mark it. */
  const selectedProviderKey = useMemo((): string | null => {
    if (isSpecialModel(currentNativeModelId)) return null;
    return providerGroups.find(
      group => group.models.some(model => model.id === currentNativeModelId),
    )?.key ?? null;
  }, [currentNativeModelId, providerGroups]);
  const currentReasoningProjection = useMemo((): ReasoningCatalogProjection | null => {
    if (!concreteModelId) return null;
    return modelCatalog?.models.find(model => model.id === concreteModelId)?.reasoning ?? null;
  }, [concreteModelId, modelCatalog]);
  const preSessionReasoningPreset = concreteModelId
    ? preSessionReasoningSelection?.modelId === concreteModelId
      ? preSessionReasoningSelection.presetId
      : getRecentReasoningPreset(concreteModelId)
    : undefined;
  const reasoningPresetCandidate = sessionId
    ? sessionReasoningPreset
    : preSessionReasoningPreset;
  // Resolve target-owned presets once so every transport uses the same control.
  const reasoningProjection = externalSelection
    ? externalSelection.onSelectReasoningPreset ? externalReasoningProjection : null
    : isAcpSession ? acpReasoning?.projection : currentReasoningProjection;
  const presentedReasoningPreset = externalSelection
    ? externalSelection.selectedReasoningPreset === 'auto'
      && !externalReasoningProjection?.presets?.some(preset => preset.id === 'auto')
      ? undefined : externalSelection.selectedReasoningPreset
    : isAcpSession ? acpReasoning?.selectedPreset : reasoningPresetCandidate;
  const selectedReasoningPreset = currentReasoningProjection?.status === 'known'
    && currentReasoningProjection.presets?.some(preset => preset.id === reasoningPresetCandidate)
    ? reasoningPresetCandidate
    : undefined;
  const catalogReasoningPresets = useMemo(
    () => reasoningProjection?.status === 'known'
      ? [...(reasoningProjection.presets ?? [])].sort((left, right) => left.order - right.order)
      : [],
    [reasoningProjection],
  );
  const orderedReasoningPresets = reasoningPresetChoices(catalogReasoningPresets);
  const selectedReasoningDescriptor = resolveReasoningPresetChoice(
    catalogReasoningPresets.find(preset => preset.id === presentedReasoningPreset),
    catalogReasoningPresets,
  );
  const defaultReasoningDescriptor = resolveReasoningPresetChoice(
    catalogReasoningPresets.find(preset => preset.id === reasoningProjection?.default_preset),
    catalogReasoningPresets,
  );
  const effectiveReasoningDescriptor = selectedReasoningDescriptor ?? defaultReasoningDescriptor;
  const currentReasoningLabel = reasoningSelectionLabel(selectedReasoningDescriptor, t);
  const isNativeModelSelection = !externalSelection && !isAcpSession;
  const modelInformationLoading = availability.status === 'loading'
    || (isNativeModelSelection && configLoadState === 'ready' && catalogLoadState === 'loading')
    || (isAcpSession && !externalSelection && acpOptionsLoadState === 'loading');
  const currentModelMode = isNativeModelSelection
    && currentNativeModelId === 'primary'
    && upcomingMode?.scopeKey === modelSelectionScopeKey
    ? upcomingMode?.id ?? null : null;
  const hasReasoningSettings = orderedReasoningPresets.length > 0 && !currentModelMode;
  const primaryModelAvailable = allModels.some(model => (
    model.id === defaultModels.primary && isSelectableTextChatModel(model)
  ));
  const hasSettingsPanel = hasReasoningSettings || isNativeModelSelection;
  const automaticReasoning = (selectedReasoningDescriptor && isAutomaticReasoningPreset(selectedReasoningDescriptor))
    || (!selectedReasoningDescriptor && (!isAcpSession || Boolean(externalSelection)));
  useEffect(() => {
    if (!dropdownOpen) return;
    if (activePanel === 'modes' && !isNativeModelSelection) {
      openPanel('models', true);
      return;
    }
    if (!hasSettingsPanel && !activePanel) {
      openPanel('models', keyboardNavigationOpen);
    }
  }, [dropdownOpen, hasSettingsPanel, isNativeModelSelection,
    keyboardNavigationOpen, activePanel, openPanel]);

  // Calculate the portalled dropdown position relative to the trigger button.
  useLayoutEffect(() => {
    if (!dropdownOpen || !dropdownRef.current) return;

    const updatePosition = () => {
      // ACP may have a separate mode control; align with the model trigger.
      const anchor = triggerRef.current ?? dropdownRef.current;
      if (!anchor || !portalDropdownRef.current) return;
      const anchorRect = anchor.getBoundingClientRect();
      const dropdown = portalDropdownRef.current;
      const dropdownRect = dropdown.getBoundingClientRect();
      // max-height can make the rendered box shorter than its contents. Keep
      // measuring the intrinsic height so a later resize can still choose the
      // correct side and then size the scrollable surface to that side.
      const intrinsicDropdownWidth = Math.max(dropdownRect.width, dropdown.offsetWidth);
      const intrinsicDropdownHeight = Math.max(
        dropdownRect.height,
        dropdown.scrollHeight + Math.max(0, dropdown.offsetHeight - dropdown.clientHeight),
      );
      const layout = getModelSelectorDropdownLayout(
        anchorRect,
        { width: intrinsicDropdownWidth, height: intrinsicDropdownHeight },
        dropdownPlacement,
        { width: window.innerWidth, height: window.innerHeight },
        // The trigger lives near the composer's right side, so a start-aligned
        // wide menu overflows the window; right edges align instead.
        'end',
      );
      setDropdownStyle(layout.style);
      setResolvedDropdownPlacement(layout.placement);
    };

    updatePosition();

    const resizeObserver = new ResizeObserver(updatePosition);
    if (portalDropdownRef.current) {
      resizeObserver.observe(portalDropdownRef.current);
    }

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [activePanel, activeProviderKey, dropdownOpen, dropdownPlacement, hasSettingsPanel]);

  useEffect(() => {
    if (
      !externalSelection
      && !isAcpSession
      && !targetIsSubagent
      && concreteModelId
      && selectedReasoningPreset
    ) {
      setRecentReasoningPreset(concreteModelId, selectedReasoningPreset);
    }
  }, [concreteModelId, externalSelection, isAcpSession, selectedReasoningPreset, targetIsSubagent]);

  const recentPresetForModel = useCallback((modelId: string): string | undefined => {
    const resolvedModelId = resolveConcreteModelId(modelId, defaultModels);
    if (!resolvedModelId) return undefined;
    const projection = modelCatalog?.models.find(model => model.id === resolvedModelId)?.reasoning;
    if (projection?.status !== 'known') return undefined;
    const recentPreset = getRecentReasoningPreset(resolvedModelId);
    return projection.presets?.some(preset => preset.id === recentPreset)
      ? recentPreset
      : undefined;
  }, [defaultModels, modelCatalog]);
  
  const handleSelectModel = useCallback(async (modelId: string, mode: UpcomingModelMode | null = null) => {
    if (disabled || externalSelection?.disabled || loading || reasoningLoading) return false;
    if (mode && (!isNativeModelSelection || !primaryModelAvailable)) return false;

    setLoading(true);
    const selectionScope = getActiveSurfaceScope();
    const rememberManualModel = () => {
      // Switching between automatic modes must never overwrite the manual choice with primary.
      const manualModelId = mode ? currentModelMode ? undefined : currentNativeModelId : modelId;
      if (manualModelId) {
        manualModelRef.current = { scopeKey: modelSelectionScopeKey, modelId: manualModelId };
        setRecentManualModel(modelSelectionScopeKey, manualModelId);
      }
    };

    // The optimistic session write below must be undone when the backend
    // rejects the switch; otherwise the selector keeps showing a model the
    // session never adopted, and the next send pushes it to the backend.
    const store = FlowChatStore.getInstance();
    const previousSessionModelName = sessionId
      ? store.getState().sessions.get(sessionId)?.config.modelName
      : undefined;
    const previousReasoningPreset = sessionId
      ? store.getState().sessions.get(sessionId)?.config.reasoningPreset
      : undefined;
    const nextReasoningPreset = mode ? undefined : recentPresetForModel(modelId);
    let sessionModelWrittenOptimistically = false;

    try {
      if (externalSelection) {
        await externalSelection.onSelect(modelId);
        return true;
      }
      if (isAcpSession && acpClientId && sessionId) {
        const options = await ACPClientAPI.setSessionModel({
          sessionId,
          clientId: acpClientId,
          workspaceId: activeSession?.workspaceId || activeSession?.config.workspaceId,
          workspacePath: activeSession?.workspacePath || activeSession?.config.workspacePath,
          remoteConnectionId: activeSession?.remoteConnectionId,
          remoteSshHost: activeSession?.remoteSshHost,
          modelId,
        });
        setAcpOptions(options);
        syncAcpContextUsageToStore(sessionId, options);
        store.updateSessionModelName(sessionId, modelId);
        log.info('ACP session model updated', { sessionId, acpClientId, modelId });
        return true;
      }

      const updateTargetSessionModel = async () => {
        if (!sessionId) return;

        // Update the frontend session model immediately so the UI reflects the
        // switch without waiting for the backend IPC round-trip.
        store.updateSessionModelName(sessionId, modelId);
        store.updateSessionReasoningPreset(sessionId, nextReasoningPreset);
        sessionModelWrittenOptimistically = true;
        const maxContextTokens = await getModelMaxTokens(modelId, currentMode);
        selectionScope.assertCurrent('select model');
        store.updateSessionMaxContextTokens(sessionId, maxContextTokens);
        const session = store.getState().sessions.get(sessionId);
        if (shouldSyncSessionModelSelection(session)) {
          await agentAPI.updateSessionModel({
            sessionId,
            modelName: modelId,
            reasoningPreset: nextReasoningPreset ?? null,
            workspaceId: sessionWorkspaceId(session),
            workspacePath: sessionProjectWorkspacePath(session),
            remoteConnectionId: session.remoteConnectionId,
            remoteSshHost: session.remoteSshHost,
            includeInternal: shouldIncludeInternalModelSession(session),
          });
          selectionScope.assertCurrent('select model');
        }
      };

      if (targetIsSubagent) {
        await updateTargetSessionModel();
        rememberManualModel();
        setUpcomingMode(mode ? { id: mode, scopeKey: modelSelectionScopeKey } : null);
        log.info('Subagent session model updated', { sessionId, modelId });
        return true;
      }

      if (persistSharedModeDefault) {
        await configManager.setConfig('ai.agent_model_defaults.mode', modelId);
        selectionScope.assertCurrent('select model');
        setModeModel(modelId);
        globalEventBus.emit('mode:config:updated');
      }
      await updateTargetSessionModel();
      rememberManualModel();
      setUpcomingMode(mode ? { id: mode, scopeKey: modelSelectionScopeKey } : null);
      setPreSessionReasoningSelection({
        modelId: resolveConcreteModelId(modelId, defaultModels) ?? modelId,
        presetId: nextReasoningPreset,
      });
      if (sessionId && !mode) {
        setRecentReasoningPreset(resolveConcreteModelId(modelId, defaultModels) ?? modelId, nextReasoningPreset);
      }

      log.info('Mode model updated', { mode: currentMode, modelId });
      return true;
    } catch (error) {
      if (!selectionScope.isCurrent()) return false;
      log.error('Failed to switch model', error);
      // Only a previously pinned selection can be restored: the store has no
      // way to express "never pinned" without claiming a session binding.
      if (sessionId && sessionModelWrittenOptimistically && previousSessionModelName) {
        store.updateSessionModelName(sessionId, previousSessionModelName);
      }
      if (sessionId && sessionModelWrittenOptimistically) {
        store.updateSessionReasoningPreset(sessionId, previousReasoningPreset);
      }
      notificationService.error(t('modelSelector.switchFailed'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [
    activeSession?.config.workspacePath,
    activeSession?.remoteConnectionId,
    activeSession?.remoteSshHost,
    activeSession?.workspacePath,
    acpClientId,
    currentMode,
    currentModelMode,
    currentNativeModelId,
    defaultModels,
    disabled,
    externalSelection,
    isAcpSession,
    loading,
    modelSelectionScopeKey,
    persistSharedModeDefault,
    isNativeModelSelection,
    primaryModelAvailable,
    reasoningLoading,
    recentPresetForModel,
    sessionId,
    t,
    targetIsSubagent,
    activeSession?.config.workspaceId,
    activeSession?.workspaceId,
  ]);

  const handleSelectModelFromMenu = useCallback(async (modelId: string, mode: UpcomingModelMode | null = null) => {
    const selected = await handleSelectModel(modelId, mode);
    if (modelSelectionScopeRef.current !== modelSelectionScopeKey) return false;
    if (selected && hasSettingsPanel) closePanel(true);
    return selected;
  }, [closePanel, handleSelectModel, hasSettingsPanel, modelSelectionScopeKey]);

  const handleSelectReasoningPreset = useCallback(async (presetId: string | null) => {
    if (
      disabled
      || loading
      || reasoningLoading
      || !concreteModelId
      || currentReasoningProjection?.status !== 'known'
    ) {
      return false;
    }
    const normalizedPreset = presetId?.trim() || undefined;
    if (
      normalizedPreset
      && !currentReasoningProjection.presets?.some(preset => preset.id === normalizedPreset)
    ) {
      return false;
    }

    if (!sessionId) {
      setRecentReasoningPreset(concreteModelId, normalizedPreset);
      setPreSessionReasoningSelection({
        modelId: concreteModelId,
        presetId: normalizedPreset,
      });
      log.info('New session reasoning preset updated', {
        modelId: concreteModelId,
        presetId: normalizedPreset ?? 'auto',
      });
      return true;
    }

    const store = FlowChatStore.getInstance();
    const session = store.getState().sessions.get(sessionId);
    if (!session) return false;
    const previousPreset = session.config.reasoningPreset;
    if (previousPreset === normalizedPreset) return true;

    setReasoningLoading(true);
    store.updateSessionReasoningPreset(sessionId, normalizedPreset);
    try {
      if (shouldSyncSessionModelSelection(session)) {
        await agentAPI.updateSessionModel({
          sessionId,
          modelName: currentNativeModelId,
          reasoningPreset: normalizedPreset ?? null,
          workspaceId: sessionWorkspaceId(session),
          workspacePath: sessionProjectWorkspacePath(session),
          remoteConnectionId: session.remoteConnectionId,
          remoteSshHost: session.remoteSshHost,
          includeInternal: shouldIncludeInternalModelSession(session),
        });
      }
      if (!targetIsSubagent) {
        setRecentReasoningPreset(concreteModelId, normalizedPreset);
        setPreSessionReasoningSelection({
          modelId: concreteModelId,
          presetId: normalizedPreset,
        });
      }
      log.info('Session reasoning preset updated', {
        sessionId,
        modelId: concreteModelId,
        presetId: normalizedPreset ?? 'auto',
      });
      return true;
    } catch (error) {
      store.updateSessionReasoningPreset(sessionId, previousPreset);
      log.error('Failed to update session reasoning preset', error);
      notificationService.error(t('reasoningSelector.updateFailed'));
      return false;
    } finally {
      setReasoningLoading(false);
    }
  }, [
    concreteModelId,
    currentNativeModelId,
    currentReasoningProjection,
    disabled,
    loading,
    reasoningLoading,
    sessionId,
    t,
    targetIsSubagent,
  ]);

  const handleSetAcpFastMode = useCallback(async (enabled: boolean) => {
    if (disabled || loading || reasoningLoading || !acpFastMode || !acpClientId || !sessionId) return;
    const value = buildAcpFastModeValue(acpFastMode.option, enabled);
    if (!value) return;

    setLoading(true);
    try {
      const options = await ACPClientAPI.setSessionConfigOption({
        sessionId,
        clientId: acpClientId,
        workspaceId: activeSession?.workspaceId || activeSession?.config.workspaceId,
        workspacePath: activeSession?.workspacePath || activeSession?.config.workspacePath,
        remoteConnectionId: activeSession?.remoteConnectionId,
        remoteSshHost: activeSession?.remoteSshHost,
        configId: acpFastMode.option.id,
        value,
      });
      setAcpOptions(options);
      syncAcpContextUsageToStore(sessionId, options);
      log.info('ACP Fast mode updated', { sessionId, acpClientId, enabled });
    } catch (error) {
      log.error('Failed to update ACP Fast mode', error);
    } finally {
      setLoading(false);
    }
  }, [
    activeSession?.config.workspacePath,
    activeSession?.remoteConnectionId,
    activeSession?.remoteSshHost,
    activeSession?.workspacePath,
    acpClientId,
    acpFastMode,
    disabled,
    loading,
    reasoningLoading,
    sessionId,
    activeSession?.config.workspaceId,
    activeSession?.workspaceId,
  ]);

  const handleSelectAcpReasoning = useCallback(async (presetId: string | null) => {
    if (disabled || loading || reasoningLoading || !presetId || !acpReasoning || !acpClientId || !sessionId) return false;
    setReasoningLoading(true);
    try {
      const options = await ACPClientAPI.setSessionConfigOption({
        sessionId,
        clientId: acpClientId,
        workspaceId: activeSession?.workspaceId || activeSession?.config.workspaceId,
        workspacePath: activeSession?.workspacePath || activeSession?.config.workspacePath,
        remoteConnectionId: activeSession?.remoteConnectionId,
        remoteSshHost: activeSession?.remoteSshHost,
        configId: acpReasoning.option.id,
        value: { type: 'select', value: presetId },
      });
      setAcpOptions(options);
      syncAcpContextUsageToStore(sessionId, options);
      log.info('ACP reasoning level updated', { sessionId, acpClientId, presetId });
      return true;
    } catch (error) {
      log.error('Failed to update ACP reasoning level', error);
      notificationService.error(t('reasoningSelector.updateFailed'));
      return false;
    } finally {
      setReasoningLoading(false);
    }
  }, [
    activeSession?.config.workspacePath,
    activeSession?.remoteConnectionId,
    activeSession?.remoteSshHost,
    activeSession?.workspacePath,
    acpClientId,
    acpReasoning,
    disabled,
    loading,
    reasoningLoading,
    sessionId,
    t,
    activeSession?.config.workspaceId,
    activeSession?.workspaceId,
  ]);

  const handleSelectReasoningPresetFromControl = useCallback(async (presetId: string | null) => {
    if (disabled || loading || reasoningLoading || externalSelection?.disabled) return false;
    let selected = false;
    if (externalSelection) {
      if (!externalSelection.onSelectReasoningPreset) return false;
      setReasoningLoading(true);
      try {
        await externalSelection.onSelectReasoningPreset(presetId);
        selected = true;
      } catch (error) {
        log.error('Failed to update target reasoning preset', error);
        notificationService.error(t('reasoningSelector.updateFailed'));
      } finally {
        setReasoningLoading(false);
      }
    } else if (isAcpSession) {
      selected = await handleSelectAcpReasoning(presetId);
    } else {
      selected = await handleSelectReasoningPreset(presetId);
    }
    return selected;
  }, [disabled, externalSelection, handleSelectAcpReasoning, handleSelectReasoningPreset,
    isAcpSession, loading, reasoningLoading, t]);

  const handleSelectUpcomingMode = useCallback(async (mode: UpcomingModelMode) => {
    const selected = await handleSelectModelFromMenu('primary', mode);
    if (!selected) return;
    notificationService.info(t('modelSelector.modes.developmentNotice'), {
      title: mode === 'smart' ? t('modelSelector.modes.smart') : t('modelSelector.modes.pool'),
    });
  }, [handleSelectModelFromMenu, t]);

  const handleSelectManualMode = useCallback(async () => {
    if (disabled || loading || reasoningLoading) return;
    const rememberedModelId = manualModelRef.current?.scopeKey === modelSelectionScopeKey
      ? manualModelRef.current.modelId : getRecentManualModel(modelSelectionScopeKey);
    const modelId = rememberedModelId ?? currentNativeModelId;
    if (!resolveModelReference(allModels, modelId, defaultModels)) {
      if (rememberedModelId) notificationService.warning(t('modelSelector.modes.manualUnavailable'));
      openPanel('models', true);
      return;
    }
    if (!currentModelMode && modelId === currentNativeModelId) {
      closePanel(true);
      return;
    }
    await handleSelectModelFromMenu(modelId);
  }, [allModels, closePanel, currentModelMode, currentNativeModelId, defaultModels, disabled,
    handleSelectModelFromMenu, loading, modelSelectionScopeKey, openPanel, reasoningLoading, t]);

  const handleSelectMode = async (mode: string) => {
    if (mode !== 'manual' && mode !== 'smart' && mode !== 'pool') return;
    if (disabled || loading || reasoningLoading || modeSelectionPendingRef.current || !isNativeModelSelection) return;
    if (mode !== 'manual' && !primaryModelAvailable) return;
    if (mode === currentModelMode) {
      closePanel(true);
      return;
    }
    modeSelectionPendingRef.current = true;
    modeRetryFocusRef.current = mode;
    setModeSelectionPending(true);
    try {
      if (mode === 'manual') await handleSelectManualMode();
      else await handleSelectUpcomingMode(mode);
    } finally {
      modeSelectionPendingRef.current = false;
      setModeSelectionPending(false);
      // Keep failed choices focused even when a fast save batches both loading updates.
      focusPanelOnOpenRef.current = true;
      setModeFocusRevision(revision => revision + 1);
    }
  };

  const handleModeChoicesKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePanel(true);
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = event.key === 'ArrowRight' ? !rtl : rtl;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (forward ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  };

  const handleSelectAcpMode = useCallback(async (value: string) => {
    if (loading || !acpMode || !acpClientId || !sessionId) return;
    // A locked picker is disabled in the UI; refusing here too keeps a stray
    // keyboard activation from asking the agent for something it will refuse.
    if (acpMode.locked || acpMode.currentValue === value) return;

    setLoading(true);
    try {
      const options = await ACPClientAPI.setSessionConfigOption({
        sessionId,
        clientId: acpClientId,
        workspaceId: activeSession?.workspaceId || activeSession?.config.workspaceId,
        workspacePath: activeSession?.workspacePath || activeSession?.config.workspacePath,
        remoteConnectionId: activeSession?.remoteConnectionId,
        remoteSshHost: activeSession?.remoteSshHost,
        configId: acpMode.option.id,
        value: { type: 'select', value },
      });
      setAcpOptions(options);
      syncAcpContextUsageToStore(sessionId, options);
      log.info('ACP session mode updated', { sessionId, acpClientId, value });
    } catch (error) {
      log.error('Failed to update ACP session mode', error);
      notificationService.error(t('modelSelector.acpModeFailed'));
    } finally {
      setLoading(false);
    }
  }, [
    activeSession?.config.workspacePath,
    activeSession?.remoteConnectionId,
    activeSession?.remoteSshHost,
    activeSession?.workspacePath,
    acpClientId,
    acpMode,
    loading,
    sessionId,
    t,
    activeSession?.config.workspaceId,
    activeSession?.workspaceId,
  ]);

  const handleTriggerKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!dropdownOpen) resetDropdownNavigation();
      setKeyboardNavigationOpen(true);
      setDropdownOpen(true);
      if (isAcpSession && !externalSelection && !modelInformationLoading) {
        void loadAcpOptions();
      }
      if (!hasSettingsPanel) {
        openPanel('models', true);
      }
      return;
    }

    if (event.key === 'Escape' && dropdownOpen) {
      event.preventDefault();
      setDropdownOpen(false);
    }
  }, [
    dropdownOpen,
    externalSelection,
    hasSettingsPanel,
    isAcpSession,
    loadAcpOptions,
    modelInformationLoading,
    openPanel,
    resetDropdownNavigation,
  ]);

  const handlePanelTriggerKeyDown = useCallback((
    kind: ModelSelectorPanel,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    openPanel(kind, true);
  }, [openPanel]);

  const handleDropdownKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      triggerRef.current?.focus({ preventScroll: true });
      setDropdownOpen(false);
      return;
    }

    if (event.key === 'ArrowRight') {
      const focusedElement = document.activeElement as HTMLElement | null;
      const focusedTarget = focusedElement?.dataset?.modelMenuTarget;
      if (focusedTarget === 'modes' || focusedTarget === 'models') {
        event.preventDefault();
        openPanel(focusedTarget, true);
      }
    }

  }, [openPanel]);

  const handlePanelKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;

    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      if (activeProviderKey) {
        closeProviderLevel();
      } else if (activePanel === 'models' && !hasSettingsPanel) {
        triggerRef.current?.focus();
        setDropdownOpen(false);
      } else {
        closePanel(true);
      }
      return;
    }

    if (event.key === 'ArrowRight' && activePanel === 'models' && !activeProviderKey) {
      const focusedElement = document.activeElement as HTMLElement | null;
      const focusedProviderKey = focusedElement?.dataset?.providerKey;
      if (focusedProviderKey) {
        event.preventDefault();
        event.stopPropagation();
        openProviderLevel(focusedProviderKey);
      }
    }
  }, [
    activeProviderKey,
    closePanel,
    closeProviderLevel,
    hasSettingsPanel,
    activePanel,
    openProviderLevel,
  ]);

  useEffect(() => {
    if (!dropdownOpen || !keyboardNavigationOpen || modelInformationLoading) return;

    const frameId = window.requestAnimationFrame(() => {
      const menu = portalDropdownRef.current;
      // The user may already have entered or returned from a detail view before
      // this initial focus frame runs. Preserve that more recent navigation.
      if (menu?.contains(document.activeElement)) return;
      const selectedItem = menu?.querySelector<HTMLButtonElement>(
        'button[role="menuitemradio"][aria-checked="true"], button[role="menuitem"][data-selected="true"]',
      );
      const firstItem = menu?.querySelector<HTMLButtonElement>(
        'button[role="menuitemradio"]:not(:disabled), button[role="menuitem"]:not(:disabled)',
      );
      (selectedItem ?? firstItem)?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [dropdownOpen, keyboardNavigationOpen, modelInformationLoading]);

  // Every in-card step replaces its trigger, so restore focus after the new
  // controls mount. A delayed opening frame must not steal that newer focus.
  const previousProviderKeyRef = useRef(activeProviderKey);
  useLayoutEffect(() => {
    const previousProviderKey = previousProviderKeyRef.current;
    previousProviderKeyRef.current = activeProviderKey;
    if (!dropdownOpen) return;
    if (!activePanel) {
      const returnTarget = focusSummaryOnReturnRef.current;
      focusSummaryOnReturnRef.current = null;
      if (returnTarget) {
        const field = returnTarget === 'provider' ? providerFieldRef.current
          : returnTarget === 'modes' ? modeFieldRef.current : modelFieldRef.current;
        (field ?? modeFieldRef.current ?? modelFieldRef.current)?.focus({ preventScroll: true });
      }
      return;
    }
    if (activePanel === 'modes' && (modeSelectionPending || loading || reasoningLoading)) return;
    const providerLevelChanged = activePanel === 'models'
      && previousProviderKey !== activeProviderKey;
    if (!focusPanelOnOpenRef.current && !providerLevelChanged) return;
    focusPanelOnOpenRef.current = false;

    const menu = portalDropdownRef.current;
    if (!menu) return;

    if (activeProviderKey) {
      const selectedModel = menu.querySelector<HTMLButtonElement>(
        'button[role="menuitemradio"][aria-checked="true"]',
      );
      const firstModel = menu.querySelector<HTMLButtonElement>(
        'button[role="menuitemradio"]:not(:disabled)',
      );
      (selectedModel ?? firstModel)?.focus();
      return;
    }

    if (activePanel === 'models' && previousProviderKey) {
      const providerRows = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('button[data-provider-key]'),
      );
      const targetRow = providerRows.find(
        row => row.dataset.providerKey === previousProviderKey,
      );
      (targetRow ?? providerRows[0])?.focus();
      return;
    }

    focusPreferredPanelItem();
  }, [
    activeProviderKey,
    dropdownOpen,
    focusPreferredPanelItem,
    activePanel,
    loading,
    reasoningLoading,
    modeSelectionPending,
    modeFocusRevision,
  ]);

  useEffect(() => {
    if (!dropdownOpen && keyboardNavigationOpen) {
      triggerRef.current?.focus();
    }
  }, [dropdownOpen, keyboardNavigationOpen]);
  
  const resolvedContextUsageSource: ContextUsageSource =
    contextUsageSource ?? (isAcpSession ? 'acp_context' : 'agent_prompt');
  const currentModelId = externalSelection ? externalCurrentModelId
    : isAcpSession ? acpOptions?.currentModelId || acpAvailableModels[0]?.id || ''
      : currentNativeModelId;
  const displayedModel = externalSelection ? externalCurrentModel
    : isAcpSession ? acpCurrentModel ?? acpAvailableModels[0] ?? null : currentModel;
  const isAcpSelection = isAcpSession && !externalSelection;
  const showAcpStatusTrigger = isAcpSelection && (!acpOptions
    || (acpAvailableModels.length === 0 && !acpFastMode && !acpMode && !acpReasoning));
  const showModelChoices = !isAcpSelection || acpAvailableModels.length > 0 || showAcpStatusTrigger;
  const showModelTrigger = showModelChoices || hasReasoningSettings || (isAcpSelection && Boolean(acpFastMode));
  const displayedAvailability = externalSelection ? externalAvailability
    : isAcpSession ? acpAvailability : nativeAvailability;
  const showModelLoadingState = modelInformationLoading && (
    isNativeModelSelection ? !modelCatalog : isAcpSelection ? !acpOptions : !displayedModel
  );
  useEffect(() => {
    // An ACP response may hand model ownership entirely to its separate mode control.
    if (dropdownOpen && !showModelTrigger) setDropdownOpen(false);
  }, [dropdownOpen, showModelTrigger]);
  const modelLabel = isAcpSelection && !showModelChoices
    ? t('modelSelector.modelSettings')
    : currentModelMode === 'smart' ? t('modelSelector.modes.smart')
      : currentModelMode === 'pool' ? t('modelSelector.modes.pool')
        : getModelDisplayLabel(displayedModel, getAvailabilityLabel(displayedAvailability.status, t));
  const settingsModelLabel = currentModelMode ? modelLabel : displayedModel?.modelName || modelLabel;
  const rememberedManualModelId = manualModelRef.current?.scopeKey === modelSelectionScopeKey
    ? manualModelRef.current.modelId : getRecentManualModel(modelSelectionScopeKey);
  const manualModelConfig = allModels.find(model => model.id === resolveConcreteModelId(
    rememberedManualModelId ?? currentNativeModelId, defaultModels,
  ));
  const manualModelLabel = manualModelConfig?.model_name
    || getAvailabilityLabel(rememberedManualModelId ? 'target-model-unavailable' : nativeAvailability.status, t);
  const displayedProviderGroup = providerGroups.find(group => group.models.some(model => (
    model.id === (isNativeModelSelection ? concreteModelId : currentModelId)
  )));
  const openCurrentProvider = () => {
    if (!displayedProviderGroup || disabled || loading || externalSelection?.disabled) return;
    openPanel('models', true);
    openProviderLevel(displayedProviderGroup.key, true);
  };
  const acpModeLabel = acpMode?.option.options.find(option => option.value === acpMode.currentValue)?.name
    ?? acpMode?.currentValue ?? '';
  const targetTooltip = buildContextUsageTooltip({
    baseTooltip: currentModelMode ? modelLabel : displayedModel
      ? getModelTooltipText(displayedModel, externalSelection?.providerLabel ?? `${acpClientId} ACP`)
      : isAcpSelection && !showModelTrigger
        ? acpMode?.option.description ?? `${acpMode?.option.name ?? ''}: ${acpModeLabel}`
        : modelLabel,
    usage: { current: currentTokens, max: maxTokens, source: resolvedContextUsageSource },
    t,
  });
  const acpFastModeItem = isAcpSelection && acpFastMode ? (
    <Tooltip content={t('modelSelector.fastModeDescription')} placement="right">
      <MenuItem
        role="menuitemcheckbox"
        checked={acpFastMode.enabled}
        disabled={disabled || loading || reasoningLoading}
        aria-busy={loading}
        leading={<Zap size={13} aria-hidden />}
        metadata={acpFastMode.enabled ? <Icon name="check-line" size="sm" aria-hidden /> : null}
        onClick={() => { void handleSetAcpFastMode(!acpFastMode.enabled); }}
      >
        {t('modelSelector.fastMode')}
      </MenuItem>
    </Tooltip>
  ) : null;

  const fallbackTooltip = t('modelSelector.primaryModelDesc');
  const tooltipDetails = buildModelSelectorTooltipDetails({
    configName: currentModel?.configName ?? fallbackTooltip,
    modelName: currentModel?.modelName,
    contextWindow: currentModel?.contextWindow,
    configuredMaxOutputTokens: currentModel?.maxOutputTokens,
    usage: {
      current: currentTokens,
      max: maxTokens,
      source: resolvedContextUsageSource,
    },
    t,
  });
  const tooltipContent = externalSelection || isAcpSession || currentModelMode
    ? targetTooltip : <ModelSelectorTooltipContent details={tooltipDetails} />;

  const modeControl = isNativeModelSelection ? (
    <MenuItem
      ref={modeFieldRef}
      className="openbitfun-model-selector__mode-control"
      data-testid="chat-model-selector-settings-mode"
      data-model-menu-target="modes"
      aria-expanded={activePanel === 'modes'}
      aria-controls={`${menuId}-mode-choices`}
      aria-label={`${t('modelSelector.modes.selection')}: ${currentModelMode === 'smart'
        ? t('modelSelector.modes.smart') : currentModelMode === 'pool'
          ? t('modelSelector.modes.pool') : t('modelSelector.modes.manual')}`}
      onClick={() => openPanelFromClick('modes')}
      onKeyDown={event => handlePanelTriggerKeyDown('modes', event)}
      disabled={disabled || loading || reasoningLoading}
    >
      {currentModelMode === 'smart' ? t('modelSelector.modes.smart')
        : currentModelMode === 'pool' ? t('modelSelector.modes.pool') : t('modelSelector.modes.manual')}
    </MenuItem>
  ) : undefined;

  return (
    <div data-openbitfun-component="model-selector" data-openbitfun-part="root"
      ref={dropdownRef}
      className={`openbitfun-model-selector ${className}`}
      data-openbitfun-state={[modelInformationLoading ? 'loading' : displayedAvailability.status, dropdownOpen && 'open'].filter(Boolean).join(' ')}
    >
      {showModelTrigger && (
      <Tooltip content={disabledReason || tooltipContent} disabled={dropdownOpen}>
        <button data-overflow-trigger
          ref={triggerRef}
          data-testid="chat-model-selector-btn"
          className={`openbitfun-model-selector__trigger ${dropdownOpen ? 'openbitfun-model-selector__trigger--open' : ''}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={dropdownOpen}
          aria-busy={modelInformationLoading || undefined}
          aria-controls={dropdownOpen ? menuId : undefined}
          onKeyDown={handleTriggerKeyDown}
          onClick={(event) => {
            const nextOpen = !dropdownOpen;
            if (nextOpen) {
              resetDropdownNavigation();
              setKeyboardNavigationOpen(event.detail === 0);
              if (isAcpSelection && !modelInformationLoading) void loadAcpOptions();
              if (!hasSettingsPanel) {
                openPanel('models', event.detail === 0);
              }
            } else if (event.detail !== 0) {
              setKeyboardNavigationOpen(false);
            }
            setDropdownOpen(nextOpen);
          }}
          disabled={
            disabled
            || loading
            || reasoningLoading
            || externalSelection?.disabled
          }
         data-openbitfun-component="model-selector" data-openbitfun-part="trigger" data-openbitfun-state={dropdownOpen ? 'open' : undefined}>
          {modelInformationLoading && <Spinner size="xs" />}
          <OverflowText className="openbitfun-model-selector__name" data-openbitfun-component="model-selector" data-openbitfun-part="name">
             {modelLabel}
          </OverflowText>
          {isAcpSelection && acpFastMode?.enabled && (
            <Icon glyph={Zap} size="xs" className="openbitfun-model-selector__fast-icon" />
          )}
          {hasReasoningSettings && (
            <span
              className="openbitfun-model-selector__trigger-reasoning"
              data-testid="chat-model-selector-trigger-reasoning"
              data-openbitfun-component="model-selector"
              data-openbitfun-part="reasoningSummary"
            >
              {t('reasoningSelector.title')}: {' '}
              {currentReasoningLabel}
            </span>
          )}
          <Icon name="chevron-down" size="xs" className="openbitfun-model-selector__chevron" data-testid="chat-model-selector-dropdown-indicator" />
        </button>
      </Tooltip>
      )}

      {isAcpSelection && acpMode && (
        <AcpModeSelector
          mode={acpMode}
          clientId={acpClientId ?? undefined}
          disabled={disabled}
          loading={loading}
          dropdownPlacement={dropdownPlacement}
          onSelect={handleSelectAcpMode}
          {...(showModelTrigger ? {} : { tooltip: targetTooltip })}
        />
      )}

      <RetainedMountBoundary
        present={dropdownOpen}
        retainForMs={MODEL_SELECTOR_EXIT_DURATION_MS}
        minimumRetainMs={MODEL_SELECTOR_EXIT_DURATION_MS}
      >
        {createOverlayPortal(
          <Menu
            id={menuId}
            className="openbitfun-model-selector__dropdown"
            data-openbitfun-component="model-selector"
            data-openbitfun-part="dropdown"
            ref={portalDropdownRef}
            style={{
              ...dropdownStyle,
              '--_model-selector-exit-duration': `${MODEL_SELECTOR_EXIT_DURATION_MS}ms`,
            } as React.CSSProperties}
            data-testid="chat-model-selector-menu"
            data-keyboard-open={keyboardNavigationOpen ? 'true' : 'false'}
            data-placement={resolvedDropdownPlacement}
            data-open={dropdownOpen ? 'true' : 'false'}
            data-menu-level={activeProviderGroup ? 'provider' : activePanel === 'models' ? 'models' : 'settings'}
            data-model-mode={currentModelMode ?? 'manual'}
            aria-busy={modelInformationLoading || undefined}
            aria-hidden={!dropdownOpen}
            {...(!dropdownOpen ? { inert: '' } : {})}
            aria-label={activeProviderGroup?.providerName ?? (activePanel === 'modes'
                ? t('modelSelector.modes.selection') : t('modelSelector.modelSettings'))}
            onKeyDown={activePanel === 'models' ? handlePanelKeyDown : handleDropdownKeyDown}
          >
            {!showModelLoadingState && activePanel !== 'models' && !activeProviderGroup
              && (currentModelMode === 'smart' || currentModelMode === 'pool') && (
                <ModelModeAnimation mode={currentModelMode} />
              )}
            {showModelLoadingState ? (
              <div
                className="openbitfun-model-selector__loading"
                data-testid="chat-model-selector-loading"
                data-openbitfun-component="model-selector"
                data-openbitfun-part="loading"
                role="status"
              >
                <LoadingState size="sm">{t('modelSelector.status.loading')}</LoadingState>
              </div>
            ) : activePanel === 'models' ? (
              <div data-testid="chat-model-selector-options" data-panel-kind={activePanel}>
                <ModelSelectorMenuLevel
                  key={activeProviderGroup ? `provider:${activeProviderGroup.key}` : activePanel}
                  direction={levelDirection}
                >
                  {hasSettingsPanel && !activeProviderGroup && (
                    <>
                      <MenuItem
                        className="openbitfun-model-selector__selection-back"
                        data-testid="chat-model-selector-summary-back"
                        aria-label={t('modelSelector.backToSettings')}
                        aria-describedby={activePanel === 'models' ? `${menuId}-current-selection` : undefined}
                        leading={<Icon name="chevron-left" size="xs" aria-hidden />}
                        metadata={activePanel === 'models' ? (
                          <Tooltip
                            content={currentModelMode ? undefined : displayedModel?.providerName}
                            disabled={Boolean(currentModelMode) || !displayedModel?.providerName}
                            placement="right"
                          >
                            <OverflowText id={`${menuId}-current-selection`} data-testid="chat-model-selector-current-selection">
                              {settingsModelLabel}
                            </OverflowText>
                          </Tooltip>
                        ) : undefined}
                        onClick={() => closePanel(true)}
                      >
                        {t('modelSelector.model')}
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  )}
                  {(externalSelection || isAcpSession) && !activeProviderGroup ? (
                    <>
                      {showModelChoices && (
                        <MenuSection title={externalSelection
                          ? `${t('modelSelector.modelSelection')} · ${externalSelection.providerLabel}`
                          : `${t('modelSelector.modelSelection')} · ${acpClientId} ACP`}>
                          {(externalSelection ? externalAvailableModels : acpAvailableModels).length === 0
                            ? renderUnavailableModelMenu(displayedAvailability,
                              Boolean(externalSelection?.includeLocalCatalog && !externalSelectionIsUnavailable))
                            : (externalSelection ? externalAvailableModels : acpAvailableModels).map(model => (
                              <Tooltip key={model.id} content={buildModelMetaText(model)} placement="right">
                                <MenuItem
                                  role="menuitemradio"
                                  checked={currentModelId === model.id}
                                  data-testid="chat-model-selector-option"
                                  data-model-id={model.id}
                                  data-model-name={model.modelName}
                                  data-selected={currentModelId === model.id ? 'true' : 'false'}
                                  data-openbitfun-component="model-selector"
                                  data-openbitfun-part="option"
                                  data-openbitfun-state={currentModelId === model.id ? 'selected' : undefined}
                                  metadata={currentModelId === model.id ? <Icon name="check-line" size="sm" aria-hidden /> : null}
                                  onClick={() => handleSelectModelFromMenu(model.id)}
                                >
                                  {model.modelName}
                                </MenuItem>
                              </Tooltip>
                            ))}
                        </MenuSection>
                      )}
                      {!hasSettingsPanel && acpFastModeItem}
                    </>
                  ) : activeProviderGroup ? (
                    <>
                      <MenuItem
                        data-testid="chat-model-selector-back"
                        data-openbitfun-component="model-selector"
                        data-openbitfun-part="back"
                        aria-label={t(providerFromSummary ? 'modelSelector.backToSettings' : 'modelSelector.backToProviders')}
                        leading={<Icon name="chevron-left" size="xs" aria-hidden />}
                        onClick={closeProviderLevel}
                      >
                        {activeProviderGroup.providerName}
                      </MenuItem>

                      {activeProviderGroup.models.map(model => {
                        const isSelected = (isNativeModelSelection ? concreteModelId : currentModelId) === model.id;

                        return (
                          <Tooltip key={model.id} content={buildModelMetaText(model)} placement="right">
                            <MenuItem
                              role="menuitemradio"
                              checked={isSelected}
                              data-testid="chat-model-selector-option"
                              data-model-id={model.id}
                              data-model-name={model.modelName}
                              data-selected={isSelected ? 'true' : 'false'}
                              data-openbitfun-component="model-selector"
                              data-openbitfun-part="option"
                              data-openbitfun-state={isSelected ? 'selected' : undefined}
                              metadata={isSelected ? <Icon name="check-line" size="sm" aria-hidden /> : null}
                              onClick={() => handleSelectModelFromMenu(model.id)}
                            >
                              {model.modelName}
                            </MenuItem>
                          </Tooltip>
                        );
                      })}
                    </>
                  ) : availableModels.length === 0 ? (
                    <>{renderUnavailableModelMenu(nativeAvailability, true)}</>
                  ) : (
                    <>
                      {(() => {
                        const primaryModel = allModels.find(
                          m => m.id === defaultModels.primary && isSelectableTextChatModel(m),
                        );
                        const primaryTooltip = primaryModel
                          ? buildResolvedModelTooltipText(primaryModel.model_name, {
                            providerName: getProviderDisplayName(primaryModel),
                            contextWindow: primaryModel.context_window
                          }, t('modelSelector.primaryModelDesc'))
                          : t('modelSelector.primaryModelDesc');
                        return (
                          <Tooltip content={primaryTooltip} placement="right">
                            <MenuItem
                              role="menuitemradio"
                              checked={currentModelId === 'primary' && !currentModelMode}
                              data-testid="chat-model-selector-option"
                              data-model-id="primary"
                              data-model-name={primaryModel?.model_name || 'primary'}
                              data-selected={currentModelId === 'primary' && !currentModelMode ? 'true' : 'false'}
                              data-openbitfun-component="model-selector"
                              data-openbitfun-part="option"
                              data-openbitfun-state={currentModelId === 'primary' && !currentModelMode ? 'selected' : undefined}
                              metadata={currentModelId === 'primary' && !currentModelMode ? <Icon name="check-line" size="sm" aria-hidden /> : null}
                               disabled={!primaryModel}
                               onClick={() => handleSelectModelFromMenu('primary')}
                            >
                              {t('modelSelector.primaryModel')}
                            </MenuItem>
                          </Tooltip>
                        );
                      })()}

                      {(() => {
                        const fastModel = allModels.find(
                          m => m.id === defaultModels.fast && isSelectableTextChatModel(m),
                        ) ?? allModels.find(
                          m => m.id === defaultModels.primary && isSelectableTextChatModel(m),
                        );
                        const fastTooltip = fastModel
                          ? buildResolvedModelTooltipText(fastModel.model_name, {
                            providerName: getProviderDisplayName(fastModel),
                            contextWindow: fastModel.context_window
                          }, t('modelSelector.fastModelDesc'))
                          : t('modelSelector.fastModelDesc');
                        return (
                          <Tooltip content={fastTooltip} placement="right">
                            <MenuItem
                              role="menuitemradio"
                              checked={currentModelId === 'fast'}
                              data-testid="chat-model-selector-option"
                              data-model-id="fast"
                              data-model-name={fastModel?.model_name || 'fast'}
                              data-selected={currentModelId === 'fast' ? 'true' : 'false'}
                              data-openbitfun-component="model-selector"
                              data-openbitfun-part="option"
                              data-openbitfun-state={currentModelId === 'fast' ? 'selected' : undefined}
                              metadata={currentModelId === 'fast' ? <Icon name="check-line" size="sm" aria-hidden /> : null}
                              onClick={() => handleSelectModelFromMenu('fast')}
                            >
                              {t('modelSelector.fastModel')}
                            </MenuItem>
                          </Tooltip>
                        );
                      })()}

                      <MenuSeparator />

                      {providerGroups.map(group => {
                        const isSelected = selectedProviderKey === group.key;

                        return (
                          <Tooltip
                            key={group.key}
                            content={`${group.providerName} · ${t('modelSelector.providerModelCount', { total: group.models.length })}`}
                            placement="right"
                          >
                            <MenuItem data-overflow-trigger
                              data-testid="chat-model-selector-provider"
                              data-provider-key={group.key}
                              data-selected={isSelected ? 'true' : 'false'}
                              data-openbitfun-component="model-selector"
                              data-openbitfun-part="providerOption"
                              data-openbitfun-state={isSelected ? 'selected' : undefined}
                              metadata={group.models.length}
                              shortcut={<Icon name="chevron-right" size="sm" aria-hidden />}
                              onClick={() => openProviderLevel(group.key)}
                            >
                              <span className="openbitfun-model-selector__option-main" data-openbitfun-component="model-selector" data-openbitfun-part="optionMain">
                                <OverflowText className="openbitfun-model-selector__option-name">
                                  {group.providerName}
                                </OverflowText>
                                {isSelected && (
                                  <Icon name="check-line" size="xs" aria-hidden="true" className="openbitfun-model-selector__option-selected-check" data-testid="chat-model-selector-provider-selected-check" />
                                )}
                              </span>
                            </MenuItem>
                          </Tooltip>
                        );
                      })}

                    </>
                  )}
                </ModelSelectorMenuLevel>
              </div>
            ) : (
              <MenuSection
                data-testid="chat-model-selector-settings"
                aria-label={t('modelSelector.modelSettings')}
              >
                <MenuList
                  className="openbitfun-model-selector__settings-card"
                  data-model-mode={currentModelMode ?? undefined}
                  data-has-model={showModelChoices}
                  data-has-reasoning={hasReasoningSettings}
                  data-selecting-mode={activePanel === 'modes' ? 'true' : undefined}
                >
                  {activePanel === 'modes' && (
                    <div
                      className="openbitfun-model-selector__mode-choices"
                      data-openbitfun-component="model-selector"
                      data-openbitfun-part="modeChoices"
                      aria-busy={modeSelectionPending || undefined}
                      onKeyDown={handleModeChoicesKeyDown}
                    >
                      <SegmentedControl
                        ref={modeChoicesRef}
                        id={`${menuId}-mode-choices`}
                        data-testid="chat-model-selector-mode-choices"
                        aria-label={t('modelSelector.modes.selection')}
                        interaction="buttons"
                        distribution="fill"
                        labelBehavior="static"
                        tone="neutral"
                        value={currentModelMode ?? 'manual'}
                        disabled={disabled || loading || reasoningLoading || modeSelectionPending || !isNativeModelSelection}
                        options={([
                          { value: 'manual', label: t('modelSelector.modes.manual') },
                          { value: 'smart', label: t('modelSelector.modes.smart') },
                          { value: 'pool', label: t('modelSelector.modes.pool') },
                        ] as const).map(mode => ({
                          value: mode.value,
                          disabled: mode.value !== 'manual' && !primaryModelAvailable,
                          label: (
                            <Tooltip content={mode.value === 'manual' ? manualModelLabel
                              : t(primaryModelAvailable ? 'modelSelector.modes.comingSoon' : 'modelSelector.modes.primaryRequired')}>
                              <OverflowText>{mode.label}</OverflowText>
                            </Tooltip>
                          ),
                        }))}
                        onValueChange={value => { void handleSelectMode(value); }}
                      />
                    </div>
                  )}
                  {((showModelChoices && !currentModelMode) || hasReasoningSettings) && (
                    <div
                      className="openbitfun-model-selector__model-summary"
                      aria-hidden={activePanel === 'modes' || undefined}
                      {...(activePanel === 'modes' ? { inert: '' } : {})}
                    >
                      {showModelChoices && !currentModelMode && (
                        <MenuList
                          className="openbitfun-model-selector__model-field"
                          data-openbitfun-component="model-selector"
                          data-openbitfun-part="selectionSummary"
                        >
                          <MenuItem data-overflow-trigger
                            ref={modelFieldRef}
                            className="openbitfun-model-selector__model-control"
                            labelBehavior="static"
                            data-testid="chat-model-selector-settings-model"
                            data-model-menu-target="models"
                            aria-label={`${t('modelSelector.model')}: ${settingsModelLabel}`}
                            onClick={() => openPanelFromClick('models')}
                            onKeyDown={(event) => handlePanelTriggerKeyDown('models', event)}
                            disabled={disabled || loading || externalSelection?.disabled}
                          >
                            <OverflowText className="openbitfun-model-selector__model-name">
                              {settingsModelLabel}
                            </OverflowText>
                          </MenuItem>
                        </MenuList>
                      )}
                      {hasReasoningSettings && (
                        <div
                          className="openbitfun-model-selector__reasoning-control"
                          data-reasoning-mode={automaticReasoning ? 'auto' : 'manual'}
                        >
                          <ReasoningIntensityControl
                            key={`${sessionId ?? ''}:${currentModelId}`}
                            presets={catalogReasoningPresets}
                            selectedPreset={isAcpSelection ? effectiveReasoningDescriptor : selectedReasoningDescriptor}
                            allowDefaultReset={!isAcpSelection}
                            active={dropdownOpen}
                            disabled={disabled || loading || reasoningLoading || externalSelection?.disabled}
                            onSelect={handleSelectReasoningPresetFromControl}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {(modeControl || (showModelChoices && !currentModelMode && displayedModel?.providerName)) && (
                    <MenuList
                      className={currentModelMode
                        ? 'openbitfun-model-selector__mode-summary' : 'openbitfun-model-selector__mode-footer'}
                      aria-hidden={activePanel === 'modes' || undefined}
                      {...(activePanel === 'modes' ? { inert: '' } : {})}
                    >
                      {modeControl}
                      {showModelChoices && !currentModelMode && displayedModel?.providerName && (
                        <MenuItem data-overflow-trigger
                          ref={providerFieldRef}
                          className="openbitfun-model-selector__provider-control"
                          labelBehavior="static"
                          data-testid="chat-model-selector-settings-provider"
                          data-provider-key={displayedProviderGroup?.key}
                          disabled={disabled || loading || externalSelection?.disabled || !displayedProviderGroup}
                          onClick={openCurrentProvider}
                          onKeyDown={event => {
                            if (event.key !== 'ArrowRight') return;
                            event.preventDefault();
                            event.stopPropagation();
                            openCurrentProvider();
                          }}
                        >
                          <OverflowText className="openbitfun-model-selector__model-provider">
                            {displayedModel.providerName}
                          </OverflowText>
                        </MenuItem>
                      )}
                    </MenuList>
                  )}
                </MenuList>

                {acpFastModeItem}
              </MenuSection>
            )}
          </Menu>,
          getAppearanceOverlayHost(),
          null,
          { open: dropdownOpen, ownerRef: dropdownRef },
        )}
      </RetainedMountBoundary>
    </div>
  );
};
export default ModelSelector;
