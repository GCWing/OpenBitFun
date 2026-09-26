import { isOpenCodeApiKeyConfig, isOpenCodeZenOAuth, openCodeZenModels, resolveOpenCodeModelRoute, savedOpenCodeApiKeyRoute } from './openCodeApiKeyRouting';
import { OverflowText,
  Button,
  Field,
  StatusPill,
  Combobox,
  Icon,
  IconButton,
  Input,
  MultiSelect,
  NumberInput,
  SearchField,
  Select,
  Switch,
  Textarea,
  Tooltip,
  ScrollArea,
  type ComboboxOption,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  ConfirmDialog,
} from '@openbitfun/ui';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Wifi, Loader, AlertTriangle, EyeOff, FolderOpen } from 'lucide-react';
import {
  AIModelConfig as AIModelConfigType, 
  ProxyConfig, 
  ModelCategory,
  ReasoningCatalogBinding,
  ReasoningCatalogProjection,
  ReasoningConfig,
} from '../types';
import { configManager } from '../services/ConfigManager';
import { getCapabilitiesByCategory, resolveModelCategory } from '../services/modelCategory';
import {
  allocateModelConfigId,
  countModelConfigReferences,
  getModelDisplayName,
  getProviderDisplayName,
  getProviderGroupKey,
  getProviderInstanceId,
  getProviderTemplateId,
  PROVIDER_INSTANCE_METADATA_KEY,
  removeProviderModelConfigs,
} from '../services/modelConfigs';
import { resolveProviderTemplates } from '../services/builtinProviderCatalog';
import { normalizeProviderBaseUrl } from '../services/providerCatalog';
import { supportsResponsesReasoning } from '../utils/reasoning';
import {
  canonicalReasoningConfig,
  cloneReasoningConfig,
  validateReasoningConfig,
} from '../utils/reasoningPresets';
import { aiApi, systemAPI } from '@/infrastructure/api';
import type {
  SubscriptionAccount,
  SubscriptionLoginMethod,
} from '@/infrastructure/api/service-api/AIApi';
import type { ProviderRegion } from '@/shared/types';
import type { SubscriptionProvider } from '../types';
import { useNotification } from '@/shared/notification-system';
import {
  ConfigActionBar,
  ConfigEmptyState,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageSection,
  ConfigPageRow,
  ConfigCollectionItem,
  ConfigRetryState,
} from './common';
import {
  useSettingsDraft,
} from '@/infrastructure/config/settingsDraftRegistry';
import {
  configsNeedingAutoTest,
  providerConnectionChanged,
  stableJson,
} from './modelConnectionTestPlan';
import DefaultModelConfig from './DefaultModelConfig';
import ReasoningConfigPanel, { type ReasoningConfigApplyResult } from './ReasoningConfigPanel';
import { createLogger } from '@/shared/utils/logger';
import { translateConnectionTestMessage } from '@/shared/utils/aiConnectionTestMessages';
import { i18nService } from '@/infrastructure/i18n';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { LONG_CONTEXT_WARNING_THRESHOLD_TOKENS } from '@/shared/constants/modelContext';
import {
  preferredSubscriptionLoginMethod,
  subscriptionLoginMethodsForSurface,
  settleSubscriptionLoginStart,
  subscriptionLoginRequiresLocalDevice,
  SubscriptionLoginCoordinator,
  type SubscriptionLoginOperation,
} from './subscriptionLoginCoordinator';
import { ModelDiscoveryCoordinator } from './modelDiscoveryCoordinator';
import './ModelSettingsPage.scss';

const log = createLogger('ModelSettings');
const MODELS_DEV_DOWNLOAD_URL = 'https://models.dev/api.json';

/** Rows the preset picker shows before the user searches or expands the list. */
const COLLAPSED_PROVIDER_COUNT = 6;

interface RemoteModelOption {
  id: string;
  display_name?: string;
  routing?: { format: string; base_url: string; request_url: string };
}

interface SelectedModelDraft {
  key: string;
  configId?: string;
  modelName: string;
  manualRequestFormat?: string;
  category: ModelCategory;
  contextWindow: number;
  maxTokens?: number;
  reasoning: ReasoningConfig;
  reasoningProjectionCatalog?: ReasoningCatalogBinding;
  reasoningProjectionSnapshot?: {
    catalog: ReasoningCatalogBinding;
    projection?: ReasoningCatalogProjection | null;
  };
}

interface ProviderGroup {
  key: string;
  providerName: string;
  providerId?: string;
  models: AIModelConfigType[];
}

interface SubscriptionLoginPanelState {
  provider: SubscriptionProvider;
  method?: SubscriptionLoginMethod;
  authorizationUrl: string;
  userCode?: string | null;
  deadlineMs?: number;
  status: 'starting' | 'pending' | 'cancelling' | 'failed';
  error?: string;
}

interface SubscriptionLogoutRequest {
  account: SubscriptionAccount;
  affectedModels: AIModelConfigType[];
}

interface ModelDeleteRequest {
  kind: 'model';
  config: AIModelConfigType;
  modelIds: string[];
  referenceCount: number;
}

interface ProviderDeleteRequest {
  kind: 'provider';
  groupKey: string;
  providerName: string;
  modelIds: string[];
  modelCount: number;
  referenceCount: number;
  discardsRetainedDraft: boolean;
}

type DeleteRequest = ModelDeleteRequest | ProviderDeleteRequest;

interface PendingEditorOpen {
  open: () => void;
}

interface ActiveConnectionTest {
  token: symbol;
  signature: string;
}

const SUBSCRIPTION_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function subscriptionLoginCancelledError(): Error {
  const error = new Error('Login cancelled');
  error.name = 'SubscriptionLoginCancelled';
  return error;
}

function isResponsesProvider(provider?: string): boolean {
  return supportsResponsesReasoning(provider);
}

function createModelDraft(
  modelName: string,
  baseConfig?: Partial<AIModelConfigType>,
  overrides?: Partial<SelectedModelDraft>
): SelectedModelDraft {
  const trimmedModelName = modelName.trim();
  const reasoning = overrides?.reasoning ?? canonicalReasoningConfig(baseConfig as AIModelConfigType);

  return {
    key: overrides?.key ?? overrides?.configId ?? baseConfig?.id ?? trimmedModelName,
    configId: overrides?.configId ?? baseConfig?.id,
    modelName: trimmedModelName,
    manualRequestFormat: overrides?.manualRequestFormat ?? baseConfig?.provider,
    category: overrides?.category ?? baseConfig?.category ?? 'general_chat',
    contextWindow: overrides?.contextWindow ?? baseConfig?.context_window ?? 300000,
    maxTokens: overrides?.maxTokens ?? baseConfig?.max_tokens,
    reasoning,
    reasoningProjectionCatalog: overrides?.reasoningProjectionCatalog ?? reasoning.catalog,
  };
}

function reasoningCatalogBindingsEqual(
  left?: ReasoningCatalogBinding,
  right?: ReasoningCatalogBinding,
): boolean {
  return JSON.stringify(left ?? { source: 'auto' }) === JSON.stringify(right ?? { source: 'auto' });
}

function uniqModelNames(modelNames: string[]): string[] {
  return Array.from(new Set(modelNames.map(name => name.trim()).filter(Boolean)));
}

function modelNameLookupKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Trim, optionally collapse to single selection, then dedupe so one provider
 * instance cannot list the same logical model twice.
 */
function normalizeProviderModelNameList(
  modelNames: string[],
  singleSelection: boolean
): string[] {
  let list = uniqModelNames(modelNames);
  if (singleSelection) {
    list = list.slice(0, 1);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const resolved = raw.trim();
    if (!resolved) continue;
    const key = modelNameLookupKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** Compact display for context/output token counts (e.g. 200000 -> "200K", 1000000 -> "1M"). */
function formatTokenCountShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return String(n);
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const s = m % 1 === 0 ? `${m}` : m.toFixed(1).replace(/\.0$/, '');
    return `${s}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    const s = k % 1 === 0 ? `${k}` : k.toFixed(1).replace(/\.0$/, '');
    return `${s}K`;
  }
  return String(n);
}

function parseOptionalPositiveIntegerInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function generateProviderInstanceId(): string {
  return `provider_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}


/** Last line of defense: same logical model name once per save; prefer draft tied to an existing config id. */
function dedupeSelectedModelDraftsByModelName(drafts: SelectedModelDraft[]): SelectedModelDraft[] {
  const out: SelectedModelDraft[] = [];
  for (const draft of drafts) {
    const k = modelNameLookupKey(draft.modelName);
    const i = out.findIndex(d => modelNameLookupKey(d.modelName) === k);
    if (i < 0) {
      out.push(draft);
      continue;
    }
    const prev = out[i];
    out[i] = !prev.configId && draft.configId ? draft : prev;
  }
  return out;
}

/**
 * Compute the stored request URL from a base URL and provider format.
 * For Gemini, stores the bare base without the /v1beta/models/... suffix;
 * the backend dynamically appends /v1beta/models/{model}:streamGenerateContent?alt=sse.
 */
function resolveRequestUrl(baseUrl: string, provider: string, _modelName = ''): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('#')) {
    return trimmed.slice(0, -1).replace(/\/+$/, '');
  }
  if (provider === 'openai') {
    return trimmed.endsWith('chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  }
  if (isResponsesProvider(provider)) {
    return trimmed.endsWith('responses') ? trimmed : `${trimmed}/responses`;
  }
  if (provider === 'anthropic') {
    if (trimmed.endsWith('/messages')) return trimmed;
    return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
  }
  if (provider === 'gemini') {
    return geminiBaseUrl(trimmed);
  }
  return trimmed;
}

/** Strip /v1beta/models/... or /models/... suffix from a gemini URL to get the bare host+path root. */
function geminiBaseUrl(url: string): string {
  return url
    .replace(/\/v1beta(?:\/models(?:\/[^/?#]*(?::(?:stream)?[Gg]enerateContent)?(?:\?[^]*)?)?)?$/, '')
    .replace(/\/models(?:\/[^/?#]*(?::(?:stream)?[Gg]enerateContent)?(?:\?[^]*)?)?$/, '')
    .replace(/\/+$/, '');
}

/**
 * Build a human-readable preview URL for display in the UI.
 * For Gemini, show the full streaming endpoint with a model placeholder when needed.
 */
function previewRequestUrl(baseUrl: string, provider: string, modelName?: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (provider === 'gemini' && !trimmed.endsWith('#')) {
    const model = modelName?.trim();
    return `${geminiBaseUrl(trimmed)}/v1beta/models/${model ? encodeURIComponent(model) : '{model}'}:streamGenerateContent?alt=sse`;
  }
  return resolveRequestUrl(baseUrl, provider);
}

function hasHttpUrlScheme(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeComparableString(value: string | undefined): string {
  return (value || '').trim();
}

function modelDraftHasUnsavedChanges(
  draft: SelectedModelDraft,
  persistedModels: AIModelConfigType[],
): boolean {
  const persisted = draft.configId
    ? persistedModels.find(model => model.id === draft.configId)
    : undefined;

  if (!persisted) return true;

  return (
    normalizeComparableString(draft.modelName) !== normalizeComparableString(persisted.model_name) ||
    (isOpenCodeApiKeyConfig(persisted) && draft.manualRequestFormat !== persisted.provider) ||
    draft.category !== (persisted.category ?? 'general_chat') ||
    draft.contextWindow !== (persisted.context_window || 300000) ||
    draft.maxTokens !== persisted.max_tokens ||
    stableJson(draft.reasoning) !== stableJson(canonicalReasoningConfig(persisted))
  );
}

const ModelSettingsPage: React.FC = () => {
  const { t, i18n } = useTranslation('settings/models');
  const { t: tDefault } = useTranslation('settings/default-model');
  const { t: tComponents } = useTranslation('components');
  const peerDevice = usePeerDeviceModeOptional();
  const connectionTestSupported = !peerDevice?.peerMode.active
    || peerDevice.currentPeerCapabilities?.hostKind !== 'cli';
  const [aiModels, setAiModels] = useState<AIModelConfigType[]>([]);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [configLoadError, setConfigLoadError] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<Awaited<ReturnType<typeof aiApi.getModelCatalog>> | null>(null);
  const [modelsDevStatus, setModelsDevStatus] = useState<Awaited<ReturnType<typeof aiApi.getModelsDevCatalogStatus>> | null>(null);
  const [modelsDevStatusAvailable, setModelsDevStatusAvailable] = useState(true);
  const [isRefreshingModelsDev, setIsRefreshingModelsDev] = useState(false);
  const [showModelsDevDetails, setShowModelsDevDetails] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isEditorSaving, setIsEditorSaving] = useState(false);
  const [editingConfig, setEditingConfig] = useState<Partial<AIModelConfigType> | null>(null);
  const [editingTargetKey, setEditingTargetKey] = useState<string | null>(null);
  const [draftCloseConfirmOpen, setDraftCloseConfirmOpen] = useState(false);
  const [draftConflictConfirmOpen, setDraftConflictConfirmOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testingConfigs, setTestingConfigs] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string } | null>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [expandedProviderGroupKeys, setExpandedProviderGroupKeys] = useState<Set<string>>(new Set());
  const notification = useNotification();
  
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const [creationMode, setCreationMode] = useState<'selection' | 'form' | null>(null);
  const [providerQuery, setProviderQuery] = useState('');
  const [showAllProviders, setShowAllProviders] = useState(false);

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>({
    enabled: false,
    url: '',
    username: '',
    password: ''
  });
  const [savedProxyConfig, setSavedProxyConfig] = useState<ProxyConfig>({
    enabled: false,
    url: '',
    username: '',
    password: ''
  });
  const [streamIdleTimeoutInput, setStreamIdleTimeoutInput] = useState('');
  const [streamTtftTimeoutInput, setStreamTtftTimeoutInput] = useState('');
  const [savedStreamTimeouts, setSavedStreamTimeouts] = useState({ idle: '', ttft: '' });
  const [isStreamTimeoutSaving, setIsStreamTimeoutSaving] = useState(false);
  const [isProxySaving, setIsProxySaving] = useState(false);
  const [streamTimeoutSaveError, setStreamTimeoutSaveError] = useState<string | null>(null);
  const [proxySaveError, setProxySaveError] = useState<string | null>(null);
  const streamTimeoutSavingRef = React.useRef(false);
  const proxySavingRef = React.useRef(false);
  const [remoteModelOptions, setRemoteModelOptions] = useState<RemoteModelOption[]>([]);
  const [isFetchingRemoteModels, setIsFetchingRemoteModels] = useState(false);
  const [remoteModelsError, setRemoteModelsError] = useState<string | null>(null);
  const [hasAttemptedRemoteFetch, setHasAttemptedRemoteFetch] = useState(false);
  const [selectedModelDrafts, setSelectedModelDrafts] = useState<SelectedModelDraft[]>([]);
  const [showModelValidation, setShowModelValidation] = useState(false);
  useEffect(() => { setShowModelValidation(false); }, [editingTargetKey, isEditing]);
  const missingModelFields = {
    name: !editingConfig?.name?.trim(),
    baseUrl: !editingConfig?.base_url?.trim(),
    apiKey: editingConfig?.auth?.type !== 'subscription' && !editingConfig?.api_key?.trim(),
    model: selectedModelDrafts.length === 0 || selectedModelDrafts.some(draft => !draft.modelName.trim()),
  };

  const [editingProviderModelIds, setEditingProviderModelIds] = useState<Set<string>>(new Set());
  const [manualModelInput, setManualModelInput] = useState('');
  const [expandedModelCards, setExpandedModelCards] = useState<Set<string>>(new Set());
  const [reasoningPanelDraftKey, setReasoningPanelDraftKey] = useState<string | null>(null);
  const reasoningPanelInitialRef = React.useRef<Pick<
    SelectedModelDraft,
    'key' | 'reasoning' | 'reasoningProjectionCatalog' | 'reasoningProjectionSnapshot'
  > | null>(null);
  const [subscriptionAccounts, setSubscriptionAccounts] = useState<SubscriptionAccount[]>([]);
  const subscriptionRefreshesRef = React.useRef(new Set<SubscriptionProvider>());
  const [refreshingSubscriptionProviders, setRefreshingSubscriptionProviders] = useState<ReadonlySet<SubscriptionProvider>>(new Set());
  const [isLoadingSubscriptions, setIsLoadingSubscriptions] = useState(false);
  const [loggingInProvider, setLoggingInProvider] = useState<SubscriptionProvider | null>(null);
  const [subscriptionLoginPanel, setSubscriptionLoginPanel] = useState<SubscriptionLoginPanelState | null>(null);
  const [subscriptionLoginClock, setSubscriptionLoginClock] = useState(() => Date.now());
  const [subscriptionLogoutRequest, setSubscriptionLogoutRequest] = useState<SubscriptionLogoutRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const modelDiscoveryRef = React.useRef(new ModelDiscoveryCoordinator());
  const editorSavingRef = React.useRef(false);
  const pendingEditorOpenRef = React.useRef<PendingEditorOpen | null>(null);
  const activeConnectionTestsRef = React.useRef<Record<string, ActiveConnectionTest>>({});

  const requestFormatOptions = useMemo(
    () => [
      { label: 'OpenAI (chat/completions)', value: 'openai' },
      { label: 'OpenAI (responses)', value: 'responses' },
      { label: 'Anthropic (messages)', value: 'anthropic' },
      { label: 'Gemini (generateContent)', value: 'gemini' },
      { label: 'Gemini Code Assist (cloudcode-pa)', value: 'gemini-code-assist' },
    ],
    []
  );
  const requestFormatLabelMap = useMemo(
    () => Object.fromEntries(
      requestFormatOptions.map(option => [String(option.value), option.label])
    ) as Record<string, string>,
    [requestFormatOptions]
  );

  const categoryOptions = useMemo<ComboboxOption[]>(
    () => [
      { label: t('category.general_chat'), value: 'general_chat' },
      { label: t('category.multimodal'), value: 'multimodal' },
      { label: t('category.speech_recognition'), value: 'speech_recognition' },
    ],
    [t]
  );

  const categoryCompactLabels = useMemo<Record<ModelCategory, string>>(
    () => ({
      general_chat: t('categoryIcons.general_chat'),
      multimodal: t('categoryIcons.multimodal'),
      speech_recognition: t('categoryIcons.speech_recognition'),
    }),
    [t]
  );
  const parsedStreamIdleTimeout = useMemo(
    () => parseOptionalPositiveIntegerInput(streamIdleTimeoutInput),
    [streamIdleTimeoutInput]
  );
  const parsedStreamTtftTimeout = useMemo(
    () => parseOptionalPositiveIntegerInput(streamTtftTimeoutInput),
    [streamTtftTimeoutInput]
  );
  const isStreamIdleTimeoutInvalid = parsedStreamIdleTimeout === undefined;
  const isStreamTtftTimeoutInvalid = parsedStreamTtftTimeout === undefined;
  const isStreamTimeoutInvalid = isStreamIdleTimeoutInvalid || isStreamTtftTimeoutInvalid;
  const isProxyDirty = stableJson(proxyConfig) !== stableJson(savedProxyConfig);
  const isStreamTimeoutDirty = streamIdleTimeoutInput !== savedStreamTimeouts.idle
    || streamTtftTimeoutInput !== savedStreamTimeouts.ttft;

  const getCustomRequestBodyTrimHint = useCallback((provider?: string): string => {
    switch (provider) {
      case 'responses':
        return t('advancedSettings.customRequestBody.trimHintResponses');
      case 'anthropic':
        return t('advancedSettings.customRequestBody.trimHintAnthropic');
      case 'gemini':
        return t('advancedSettings.customRequestBody.trimHintGemini');
      case 'openai':
      default:
        return t('advancedSettings.customRequestBody.trimHintOpenAI');
    }
  }, [t]);

  const getCustomRequestBodyModeHint = useCallback((provider?: string, mode?: string | null): string => {
    return mode === 'trim'
      ? getCustomRequestBodyTrimHint(provider)
      : t('advancedSettings.customRequestBody.modeMergeHint');
  }, [getCustomRequestBodyTrimHint, t]);

  const loadModelCatalog = useCallback(async () => {
    try {
      // Host-owned facts (configured models, defaults, session selection) come
      // from the rendered host. The provider templates and the reasoning
      // catalog describe the public models.dev catalog instead, so this
      // controller composes them from its own snapshot: shipping a peer's copy
      // would put a multi-MiB body on the connection for every settings open,
      // and that data is identical by construction. Per-model reasoning
      // projections stay host-computed, so they still describe the host config
      // that is being edited.
      const [hostCatalog, localCatalogs] = await Promise.all([
        aiApi.getModelCatalog(),
        aiApi.getLocalModelsDevCatalogs().catch((error: unknown) => {
          log.warn('Failed to load local models.dev catalogs', { error });
          return null;
        }),
      ]);
      setModelCatalog(localCatalogs
        ? {
            ...hostCatalog,
            provider_catalog: localCatalogs.provider_catalog,
            models_dev_reasoning_catalog: localCatalogs.models_dev_reasoning_catalog,
          }
        : hostCatalog);
    } catch (error) {
      setModelCatalog(null);
      log.warn('Failed to load model reasoning catalog', { error });
    }
  }, []);

  const loadModelsDevStatus = useCallback(async () => {
    try {
      setModelsDevStatus(await aiApi.getModelsDevCatalogStatus());
      setModelsDevStatusAvailable(true);
    } catch (error) {
      setModelsDevStatusAvailable(false);
      log.warn('Failed to load models.dev catalog status', { error });
    }
  }, []);

  const handleRefreshModelsDev = useCallback(async () => {
    setIsRefreshingModelsDev(true);
    try {
      const result = await aiApi.refreshModelsDevCatalogNow();
      setModelsDevStatus(result.status);
      await loadModelCatalog();
      notification.success(
        result.outcome === 'updated'
          ? t('modelsDevCatalog.refreshSuccess')
          : result.outcome === 'throttled'
            ? t('modelsDevCatalog.refreshThrottled')
            : t('modelsDevCatalog.alreadyCurrent'),
      );
    } catch (error) {
      log.warn('Failed to refresh models.dev catalog', { error });
      notification.error(t('modelsDevCatalog.refreshFailed'));
      await loadModelsDevStatus();
    } finally {
      setIsRefreshingModelsDev(false);
    }
  }, [loadModelCatalog, loadModelsDevStatus, notification, t]);

  const loadConfig = useCallback(async () => {
    setIsConfigLoading(true);
    setConfigLoadError(false);
    try {
      const [models, proxy, streamIdleTimeoutSecs, streamTtftTimeoutSecs] = await Promise.all([
        configManager.getConfig<AIModelConfigType[]>('ai.models'),
        configManager.getConfig<ProxyConfig>('ai.proxy'),
        configManager.getConfig<number | null>('ai.stream_idle_timeout_secs'),
        configManager.getConfig<number | null>('ai.stream_ttft_timeout_secs'),
      ]);
      setAiModels(models || []);
      await loadModelCatalog();
      await loadModelsDevStatus();
      const resolvedProxy = proxy || { enabled: false, url: '', username: '', password: '' };
      const idle = streamIdleTimeoutSecs != null ? String(streamIdleTimeoutSecs) : '';
      const ttft = streamTtftTimeoutSecs != null ? String(streamTtftTimeoutSecs) : '';
      setProxyConfig(resolvedProxy);
      setSavedProxyConfig(resolvedProxy);
      setStreamIdleTimeoutInput(idle);
      setStreamTtftTimeoutInput(ttft);
      setSavedStreamTimeouts({ idle, ttft });
    } catch (error) {
      log.error('Failed to load AI config', error);
      setConfigLoadError(true);
    } finally {
      setIsConfigLoading(false);
    }
  }, [loadModelCatalog, loadModelsDevStatus]);

  useEffect(() => {
    const unsubscribeCatalog = aiApi.onModelCatalogUpdated(() => {
      void loadModelCatalog();
      void loadModelsDevStatus();
    });
    loadConfig();
    return unsubscribeCatalog;
  }, [loadConfig, loadModelCatalog, loadModelsDevStatus]);

  const refreshSubscriptionAccounts = useCallback(async () => {
    setIsLoadingSubscriptions(true);
    try {
      const items = await aiApi.listSubscriptionAccounts();
      setSubscriptionAccounts(items);
    } catch (e) {
      log.warn('list_subscription_accounts failed', { error: String(e) });
    } finally {
      setIsLoadingSubscriptions(false);
    }
  }, []);

  useEffect(() => {
    refreshSubscriptionAccounts();
  }, [refreshSubscriptionAccounts]);

  useEffect(() => {
    if (!subscriptionLoginPanel || subscriptionLoginPanel.status !== 'pending') return;
    setSubscriptionLoginClock(Date.now());
    const timer = window.setInterval(() => setSubscriptionLoginClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subscriptionLoginPanel]);
  
  // Provider options with translations (must be at top level, before any conditional returns)
  const providerTemplates = useMemo(
    () => resolveProviderTemplates(modelCatalog?.provider_catalog),
    [modelCatalog?.provider_catalog],
  );
  const providerOrder = useMemo(
    () => Object.values(providerTemplates)
      .sort((left, right) => (left.displayOrder ?? 999) - (right.displayOrder ?? 999))
      .map(provider => provider.id),
    [providerTemplates],
  );
  // A Chinese UI leads with mainland providers, every other UI leads with the
  // international ones. Both keep the full list, only the order changes.
  const preferredProviderRegion: ProviderRegion = i18n.language.toLowerCase().startsWith('zh') ? 'cn' : 'global';
  const providers = useMemo(() => {
    const regionRank = (region: ProviderRegion) => {
      if (region === 'any') return 0;
      return region === preferredProviderRegion ? 1 : 2;
    };

    // Dynamically get translated name and description
    return Object.values(providerTemplates)
      .map(provider => {
        const localizedName = t(`providers.${provider.id}.name`);
        const localizedDescription = t(`providers.${provider.id}.description`);
        return {
          ...provider,
          name: localizedName,
          description: localizedDescription,
          // Keeps the catalog's English name searchable while a CJK locale renders the localized one.
          searchText: [provider.id, provider.name, localizedName, localizedDescription, ...provider.models]
            .join(' ')
            .toLowerCase(),
        };
      })
      .sort((left, right) => (
        regionRank(left.region ?? 'any') - regionRank(right.region ?? 'any')
        || (left.displayOrder ?? 999) - (right.displayOrder ?? 999)
        || left.name.localeCompare(right.name)
      ));
  }, [preferredProviderRegion, providerTemplates, t]);

  const normalizedProviderQuery = providerQuery.trim().toLowerCase();
  const matchedProviders = useMemo(() => (
    normalizedProviderQuery
      ? providers.filter(provider => provider.searchText.includes(normalizedProviderQuery))
      : providers
  ), [normalizedProviderQuery, providers]);
  // Searching always reveals every hit; only the resting list stays short.
  const canToggleProviderList = !normalizedProviderQuery
    && matchedProviders.length > COLLAPSED_PROVIDER_COUNT;
  const isProviderListCollapsed = canToggleProviderList && !showAllProviders;
  const visibleProviders = isProviderListCollapsed
    ? matchedProviders.slice(0, COLLAPSED_PROVIDER_COUNT)
    : matchedProviders;

  // Current template with translations (must be at top level, before any conditional returns)
  const currentTemplate = useMemo(() => {
    if (!selectedProviderId) return null;
    const template = providerTemplates[selectedProviderId];
    if (!template) return null;
    // Dynamically get translated name, description, and baseUrlOptions notes
    return {
      ...template,
      name: t(`providers.${template.id}.name`),
      description: t(`providers.${template.id}.description`),
      baseUrlOptions: template.baseUrlOptions?.map(opt => ({
        ...opt,
        note: t(`providers.${template.id}.urlOptions.${opt.note}`, { defaultValue: opt.note })
      }))
    };
  }, [providerTemplates, selectedProviderId, t]);

  const editingModalHasUnsavedChanges = useMemo(() => {
    if (!editingConfig) return false;
    const persistedModels = editingConfig.id
      ? aiModels.filter(model => model.id === editingConfig.id)
      : aiModels.filter(model => editingProviderModelIds.has(model.id || ''));
    if (persistedModels.length === 0) return true;

    const persisted = persistedModels[0];
    const comparableConfig = { ...persisted, ...editingConfig } as AIModelConfigType;
    const providerFieldsChanged = providerConnectionChanged(persisted, comparableConfig)
      || normalizeComparableString(editingConfig.name) !== normalizeComparableString(getProviderDisplayName(persisted));
    const draftFieldsChanged = selectedModelDrafts.some(draft => modelDraftHasUnsavedChanges(draft, aiModels));
    const persistedIds = new Set(persistedModels.map(model => model.id).filter(Boolean));
    const draftIds = new Set(selectedModelDrafts.map(draft => draft.configId).filter(Boolean));
    const selectionChanged = persistedIds.size !== draftIds.size
      || Array.from(persistedIds).some(id => !draftIds.has(id));

    return providerFieldsChanged || draftFieldsChanged || selectionChanged;
  }, [aiModels, editingConfig, editingProviderModelIds, selectedModelDrafts]);

  const createDraftsFromConfigs = (configs: AIModelConfigType[]) => (
    configs.map(config => createModelDraft(config.model_name, config, {
      configId: config.id,
      contextWindow: config.context_window || 300000,
      maxTokens: config.max_tokens,
      reasoning: canonicalReasoningConfig(config),
    }))
  );

  const resetRemoteModelDiscovery = useCallback(() => {
    setRemoteModelOptions([]);
    setIsFetchingRemoteModels(false);
    setRemoteModelsError(null);
    setHasAttemptedRemoteFetch(false);
    modelDiscoveryRef.current.reset();
  }, []);

  const modelDiscoverySurface = peerDevice?.peerMode.active ? peerDevice.peerMode.deviceId : 'local';
  useEffect(() => {
    const coordinator = modelDiscoveryRef.current;
    resetRemoteModelDiscovery();
    return () => coordinator.reset();
  }, [modelDiscoverySurface, resetRemoteModelDiscovery]);
  const syncSelectedModelDrafts = (
    modelNames: string[],
    baseConfig?: Partial<AIModelConfigType>,
    singleSelection = false
  ) => {
    const nextModelNames = normalizeProviderModelNameList(
      modelNames,
      singleSelection
    );

    const pinnedRowId =
      singleSelection && baseConfig?.id ? String(baseConfig.id) : undefined;

    setSelectedModelDrafts(prevDrafts =>
      nextModelNames.map(modelName => {
        const lookupKey = modelNameLookupKey(modelName);
        const existingDraft = prevDrafts.find(
          draft => modelNameLookupKey(draft.modelName) === lookupKey
        );

        if (existingDraft) {
          const configId = pinnedRowId ?? existingDraft.configId;
          return {
            ...existingDraft,
            modelName,
            configId,
            key: configId ?? modelName,
          };
        }

        const draftBaseConfig = baseConfig
          ? { ...baseConfig, max_tokens: undefined }
          : undefined;

        const catalogModel = selectedProviderId
          ? modelCatalog?.provider_catalog?.providers
              .find(provider => provider.id === selectedProviderId)
              ?.models.find(model => model.id === modelName)
          : undefined;
        return createModelDraft(modelName, draftBaseConfig, {
          configId: pinnedRowId,
          contextWindow: catalogModel?.limits?.context,
          // New selections start as multimodal; existing model edits retain their category.
          category: pinnedRowId ? (baseConfig?.category ?? 'general_chat') : 'multimodal',
        });
      })
    );

    setEditingConfig(prev => {
      if (!prev) return prev;

      const nextPrimaryModel = nextModelNames[0] || '';
      const providerName = currentTemplate?.name || prev.name || '';
      const oldAutoName = prev.model_name ? `${providerName} - ${prev.model_name}` : '';
      const isAutoGenerated = !prev.name || prev.name === oldAutoName || prev.name === providerName;

      return {
        ...prev,
        model_name: nextPrimaryModel,
        request_url: resolveRequestUrl(
          prev.base_url || currentTemplate?.baseUrl || '',
          prev.provider || currentTemplate?.format || 'openai',
          nextPrimaryModel
        ),
        name: isAutoGenerated ? providerName : prev.name
      };
    });
  };

  const updateModelDraft = (modelName: string, updates: Partial<SelectedModelDraft>) => {
    setSelectedModelDrafts(prevDrafts => prevDrafts.map(draft => (
      draft.modelName === modelName ? { ...draft, ...updates } : draft
    )));
  };

  const resolveDraftCatalogEntry = (draft: SelectedModelDraft) => (
    modelCatalog?.models.find(model => (
      model.id === draft.configId
      || model.id === editingConfig?.id
      || (
        model.model_name === draft.modelName
        && model.provider === (editingConfig?.provider || 'openai')
        && model.base_url === editingConfig?.base_url
      )
    ))
  );

  const resolveDraftReasoningProjection = (draft: SelectedModelDraft) => {
    const snapshot = draft.reasoningProjectionSnapshot;
    if (snapshot && reasoningCatalogBindingsEqual(draft.reasoning.catalog, snapshot.catalog)) {
      return snapshot.projection ?? undefined;
    }
    if (reasoningCatalogBindingsEqual(draft.reasoning.catalog, draft.reasoningProjectionCatalog)) {
      return resolveDraftCatalogEntry(draft)?.reasoning;
    }
    return undefined;
  };

  const toggleSelectedModelCardExpanded = useCallback((draftKey: string) => {
    setExpandedModelCards(prev => {
      const next = new Set(prev);
      if (next.has(draftKey)) next.delete(draftKey);
      else next.add(draftKey);
      return next;
    });
  }, []);

  const onSelectedModelHeadKeyDown = useCallback(
    (e: React.KeyboardEvent, draftKey: string) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleSelectedModelCardExpanded(draftKey);
    },
    [toggleSelectedModelCardExpanded]
  );

  const removeSelectedModelDraft = (modelName: string) => {
    const removed = selectedModelDrafts.find(d => d.modelName === modelName);
    if (removed) {
      setExpandedModelCards(prev => {
        const next = new Set(prev);
        next.delete(removed.key);
        return next;
      });
    }

    const remainingModelNames = selectedModelDrafts
      .filter(draft => draft.modelName !== modelName)
      .map(draft => draft.modelName);

    syncSelectedModelDrafts(remainingModelNames, editingConfig || undefined, !!editingConfig?.id);
  };

  const addManualModelDraft = () => {
    const trimmedModelName = manualModelInput.trim();
    if (!trimmedModelName) return;

    const alreadyInDrafts = selectedModelDrafts.some(
      draft => modelNameLookupKey(draft.modelName) === modelNameLookupKey(trimmedModelName)
    );

    if (alreadyInDrafts) {
      notification.info(t('providerSelection.modelAlreadyInList'));
      setManualModelInput('');
      return;
    }

    const nextModelNames = editingConfig?.id
      ? [trimmedModelName]
      : uniqModelNames([
          ...selectedModelDrafts.map(draft => draft.modelName),
          trimmedModelName,
        ]);

    syncSelectedModelDrafts(nextModelNames, editingConfig || undefined, !!editingConfig?.id);
    setManualModelInput('');
  };

  const buildModelDiscoveryConfig = (config: Partial<AIModelConfigType>): AIModelConfigType | null => {
    const resolvedBaseUrl = (config.base_url || currentTemplate?.baseUrl || '').trim();
    const resolvedProvider = (config.provider || currentTemplate?.format || 'openai').trim();
    const resolvedAuth = config.auth || { type: 'api_key' };
    const resolvedApiKey = (config.api_key || '').trim();
    const resolvedModelName = (
      config.model_name ||
      selectedModelDrafts[0]?.modelName ||
      currentTemplate?.models[0] ||
      'model-discovery'
    ).trim();

    // CLI-backed auth (Codex/Gemini) resolves the bearer token at request time
    // from `~/.codex` or `~/.gemini`, so we must NOT gate discovery on the
    // user pasting an API key. Only the legacy `api_key` mode requires it.
    const requiresApiKey = resolvedAuth.type === 'api_key';
    if (!resolvedBaseUrl || !resolvedProvider || (requiresApiKey && !resolvedApiKey)) {
      return null;
    }

    return {
      id: config.id || 'model_discovery',
      name: config.name || 'Model Discovery',
      provider: resolvedProvider,
      api_key: resolvedApiKey,
      base_url: resolvedBaseUrl,
      request_url: config.request_url || resolveRequestUrl(resolvedBaseUrl, resolvedProvider, resolvedModelName),
      model_name: resolvedModelName,
      context_window: config.context_window || 300000,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      top_p: config.top_p,
      enabled: config.enabled ?? true,
      category: config.category || 'general_chat',
      capabilities: config.capabilities || ['text_chat'],
      recommended_for: config.recommended_for || [],
      metadata: config.metadata || {},
      inline_think_in_text: config.inline_think_in_text ?? true,
      reasoning: canonicalReasoningConfig(config),
      custom_headers: config.custom_headers,
      custom_headers_mode: config.custom_headers_mode,
      skip_ssl_verify: config.skip_ssl_verify ?? false,
      custom_request_body: config.custom_request_body,
      custom_request_body_mode: config.custom_request_body_mode,
      auth: resolvedAuth,
    };
  };

  const buildModelDiscoverySignature = (config: AIModelConfigType): string => JSON.stringify({
    provider: config.provider,
    base_url: config.base_url,
    api_key: config.api_key,
    model_name: config.model_name,
    inline_think_in_text: config.inline_think_in_text ?? true,
    skip_ssl_verify: config.skip_ssl_verify ?? false,
    custom_headers_mode: config.custom_headers_mode || null,
    custom_headers: config.custom_headers || null,
    custom_request_body: config.custom_request_body || null,
    custom_request_body_mode: config.custom_request_body_mode || null,
    auth: config.auth || { type: 'api_key' },
  });

  const fetchRemoteModels = async (config: Partial<AIModelConfigType> | null, force = false) => {
    if (!config) return;
    const discoveryConfig = buildModelDiscoveryConfig(config);
    if (!discoveryConfig) {
      setRemoteModelOptions([]);
      setRemoteModelsError(t('providerSelection.fillApiKeyBeforeFetch'));
      setHasAttemptedRemoteFetch(true);
      return;
    }
    const coordinator = modelDiscoveryRef.current;
    const scope = getActiveSurfaceScope();
    const operation = coordinator.begin(scope.key(buildModelDiscoverySignature(discoveryConfig)), force);
    if (!operation) return;
    const subscription = discoveryConfig.auth?.type === 'subscription';
    setIsFetchingRemoteModels(true);
    setRemoteModelsError(null);
    setHasAttemptedRemoteFetch(true);
    let succeeded = false;
    try {
      let remoteModels: RemoteModelOption[];
      if (isOpenCodeZenOAuth(discoveryConfig)) {
        const account = await aiApi.refreshSubscriptionAccount('opencode');
        if (!scope.isCurrent() || !coordinator.isCurrent(operation)) return;
        setSubscriptionAccounts(current => current.map(item => item.provider === 'opencode' ? account : item));
        remoteModels = openCodeZenModels(account.api_offerings ?? []);
      } else {
        remoteModels = await aiApi.listModelsByConfig(discoveryConfig);
      }
      if (!scope.isCurrent() || !coordinator.isCurrent(operation)) return;
      const dedupedModels = remoteModels.filter((model, index, arr) => (
        !!model.id && arr.findIndex(item => item.id === model.id) === index
      ));
      setRemoteModelOptions(dedupedModels);
      if (dedupedModels.length === 0) {
        setRemoteModelsError(t(subscription
          ? 'providerSelection.subscriptionFetchEmpty'
          : 'providerSelection.fetchEmptyFallback'));
        return;
      }
      succeeded = true;
    } catch (error) {
      if (!scope.isCurrent() || !coordinator.isCurrent(operation)) return;
      log.warn('Failed to fetch remote model list', { error });
      setRemoteModelOptions([]);
      setRemoteModelsError(t(subscription
        ? 'providerSelection.subscriptionFetchFailed'
        : 'providerSelection.fetchFailedFallback'));
    } finally {
      if (coordinator.complete(operation, succeeded) && scope.isCurrent()) setIsFetchingRemoteModels(false);
    }
  };

  const handleModelSelectionOpenChange = (isOpen: boolean) => {
    if (!isOpen || !editingConfig || isFetchingRemoteModels) return;
    const authType = editingConfig.auth?.type ?? 'api_key';
    if (authType === 'api_key' && !editingConfig.api_key?.trim()) return;
    if (hasAttemptedRemoteFetch) return;
    if (remoteModelOptions.length > 0) return;
    void fetchRemoteModels(editingConfig);
  };

  const requestEditorOpen = useCallback((targetKey: string, open: () => void) => {
    const matchesSuspendedDraft = editingTargetKey === targetKey
      || (targetKey === 'new-provider' && editingTargetKey?.startsWith('new-provider:'));
    if (!isEditing && editingConfig && editingModalHasUnsavedChanges) {
      if (matchesSuspendedDraft) {
        setIsEditing(true);
        return;
      }
      pendingEditorOpenRef.current = { open };
      setDraftConflictConfirmOpen(true);
      return;
    }
    open();
  }, [editingConfig, editingModalHasUnsavedChanges, editingTargetKey, isEditing]);

  
  const handleCreateNew = () => {
    requestEditorOpen('new-provider', () => {
      resetRemoteModelDiscovery();
      setSelectedModelDrafts([]);
      setEditingProviderModelIds(new Set());
      setManualModelInput('');
      setShowApiKey(false);
      setSelectedProviderId(null);
      setProviderQuery('');
      setShowAllProviders(false);
      setEditingTargetKey(null);
      setCreationMode('selection');
    });
  };

  const handleImportFromSubscription = useCallback((
    account: SubscriptionAccount,
  ) => {
    const targetKey = `new-provider:subscription:${account.provider}:default`;
    requestEditorOpen(targetKey, () => {
      resetRemoteModelDiscovery();
      setManualModelInput('');
      setShowApiKey(false);
      setSelectedProviderId(null);
      setEditingTargetKey(targetKey);
      setEditingConfig({
        name: account.display_label,
        provider: account.suggested_format,
        base_url: account.provider === 'opencode' ? 'https://opencode.ai/zen/v1' : account.suggested_base_url,
        // Leave request_url + model_name empty so the user must pick a model
        // from the live list. We never inject a hard-coded default slug.
        request_url: '',
        api_key: '',
        model_name: '',
        enabled: true,
        context_window: 300000,
        category: 'multimodal',
        capabilities: getCapabilitiesByCategory('multimodal'),
        recommended_for: [],
        metadata: {},
        inline_think_in_text: true,
        auth: {
          type: 'subscription',
          provider: account.provider,
        },
      });
      setSelectedModelDrafts([]);
      setEditingProviderModelIds(new Set());
      setShowAdvancedSettings(false);
      setCreationMode('form');
      setIsEditing(true);
    });
  }, [requestEditorOpen, resetRemoteModelDiscovery]);

  const loginCoordinatorRef = React.useRef(new SubscriptionLoginCoordinator());
  const subscriptionLoginMountedRef = React.useRef(true);

  const pollSubscriptionLogin = useCallback(async (
    operation: SubscriptionLoginOperation,
    deadline: number,
  ) => {
    while (Date.now() < deadline) {
      if (!loginCoordinatorRef.current.isCurrent(operation)) {
        throw subscriptionLoginCancelledError();
      }
      const snapshot = await aiApi.getSubscriptionLoginStatus(
        operation.provider,
        operation.sessionId,
      );
      if (snapshot.session_id !== operation.sessionId) {
        throw new Error('Subscription login status returned a mismatched session');
      }
      if (snapshot.status === 'authorized') {
        return snapshot;
      }
      if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        throw new Error(snapshot.error || `Login ${snapshot.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error('Login timed out');
  }, []);

  // Cancel any in-flight subscription login when the page unmounts so the
  // backend loopback server / device poll does not linger.
  useEffect(() => {
    const coordinator = loginCoordinatorRef.current;
    subscriptionLoginMountedRef.current = true;
    return () => {
      subscriptionLoginMountedRef.current = false;
      const pending = coordinator.current();
      if (pending && !pending.cancelled) {
        coordinator.requestCancel(pending.provider);
        // Cancel immediately when the backend placeholder already exists;
        // `settleSubscriptionLoginStart` retries after start returns to cover
        // the opposite command-order race.
        void aiApi.cancelSubscriptionLogin(pending.provider, pending.sessionId).catch(() => {});
      }
    };
  }, []);

  const handleSubscriptionLogin = useCallback(async (
    provider: SubscriptionProvider,
    method?: SubscriptionLoginMethod,
  ) => {
    if ((!isTauriRuntime() || isPeerDeviceModeActive()) && subscriptionLoginRequiresLocalDevice(provider)) {
      notification.error(t('subscriptionAuth.peerLoginRequiresLocalDevice'));
      return;
    }
    // The settings surface intentionally permits one authorization flow at a
    // time. This prevents a stale provider poll/finally block from clearing a
    // newer provider's state or leaving an undiscoverable backend session.
    const operation = loginCoordinatorRef.current.begin(provider);
    if (!operation) return;
    const requestedMethod = method ?? preferredSubscriptionLoginMethod(
      provider,
      isTauriRuntime() && !isPeerDeviceModeActive(),
    );
    setLoggingInProvider(provider);
    setSubscriptionLoginPanel({
      provider,
      method: requestedMethod,
      authorizationUrl: '',
      status: 'starting',
    });
    try {
      const started = await aiApi.startSubscriptionLogin(
        provider,
        operation.sessionId,
        requestedMethod,
      );
      const settlement = await settleSubscriptionLoginStart(
        loginCoordinatorRef.current,
        operation,
        () => aiApi.cancelSubscriptionLogin(provider, operation.sessionId),
      );
      if (settlement.cleanupError) {
        log.warn('Failed to cancel subscription login after start settled', {
          provider,
          error: String(settlement.cleanupError),
        });
      }
      if (!settlement.shouldContinue) {
        throw subscriptionLoginCancelledError();
      }
      if (started.session_id !== operation.sessionId) {
        throw new Error('Subscription login start returned a mismatched session');
      }
      // Older backends ignore the new method request and omit `method` in the
      // response. Infer their actual flow from the returned device code so a
      // new UI never shows device instructions for a legacy browser login.
      const actualMethod = started.method || (started.user_code ? 'device' : 'browser');
      // Authorization time starts after the provider has returned its URL or
      // device code; callback binding/device-code acquisition does not consume
      // the user's five-minute completion window.
      const deadlineMs = Date.now() + SUBSCRIPTION_LOGIN_TIMEOUT_MS;
      setSubscriptionLoginPanel({
        provider,
        method: actualMethod,
        authorizationUrl: started.authorization_url,
        userCode: started.user_code,
        deadlineMs,
        status: 'pending',
      });
      if (started.authorization_url) {
        try {
          await systemAPI.openExternal(started.authorization_url);
        } catch (openError) {
          // Keep polling: the backend login session is already running. Surface
          // the URL so the user can open it manually (relative URLs / opener
          // policy failures must not abort an otherwise valid login).
          log.warn('Failed to open subscription authorization URL', {
            provider,
            url: started.authorization_url,
            error: String(openError),
          });
          notification.info(
            t('subscriptionAuth.openUrlManually', { url: started.authorization_url }),
          );
        }
      }
      if (!loginCoordinatorRef.current.isCurrent(operation)) {
        throw subscriptionLoginCancelledError();
      }
      if (started.user_code) {
        notification.info(t('subscriptionAuth.userCodeHint', { code: started.user_code }));
      }
      await pollSubscriptionLogin(operation, deadlineMs);
      if (!loginCoordinatorRef.current.isCurrent(operation)) {
        throw subscriptionLoginCancelledError();
      }
      await refreshSubscriptionAccounts();
      if (!loginCoordinatorRef.current.isCurrent(operation)) {
        throw subscriptionLoginCancelledError();
      }
      setSubscriptionLoginPanel(null);
      notification.success(t('subscriptionAuth.loginSuccess'));
    } catch (e) {
      if ((e as Error).name === 'SubscriptionLoginCancelled' || operation.cancelled) {
        // `startSubscriptionLogin` may reject instead of returning after an
        // early cancellation. Mark that invocation settled and retry the
        // idempotent backend cancellation so no placeholder/session survives.
        if (!operation.startSettled && loginCoordinatorRef.current.owns(operation)) {
          loginCoordinatorRef.current.markStartSettled(operation);
        }
        let authorizationAlreadyCompleted = false;
        try {
          await aiApi.cancelSubscriptionLogin(provider, operation.sessionId);
        } catch (cancelError) {
          log.warn('Failed to finish subscription login cancellation', {
            provider,
            error: String(cancelError),
          });
        }
        try {
          // The backend cancellation command is a commit barrier. Refreshing
          // now truthfully surfaces the narrow case where authorization had
          // already crossed its commit boundary before the user cancelled.
          const accounts = await aiApi.listSubscriptionAccounts();
          if (subscriptionLoginMountedRef.current) {
            setSubscriptionAccounts(accounts);
          }
          authorizationAlreadyCompleted = accounts.some((account) => (
            account.provider === provider && account.connected
          ));
        } catch (refreshError) {
          log.warn('Failed to refresh subscription accounts after cancellation', {
            provider,
            error: String(refreshError),
          });
        }
        if (
          loginCoordinatorRef.current.owns(operation)
          && subscriptionLoginMountedRef.current
        ) {
          setSubscriptionLoginPanel(null);
          notification.info(t(
            authorizationAlreadyCompleted
              ? 'subscriptionAuth.loginCompletedBeforeCancel'
              : 'subscriptionAuth.loginCancelled',
          ));
        }
      } else {
        // Status/start failures can occur while the backend runner is still
        // active. Await the session-scoped cancellation barrier before freeing
        // the coordinator slot or presenting retry UI.
        if (!operation.startSettled && loginCoordinatorRef.current.owns(operation)) {
          loginCoordinatorRef.current.markStartSettled(operation);
        }
        try {
          await aiApi.cancelSubscriptionLogin(provider, operation.sessionId);
        } catch (cancelError) {
          log.warn('Failed to stop subscription login after an operation error', {
            provider,
            sessionId: operation.sessionId,
            error: String(cancelError),
          });
        }
        if (
          loginCoordinatorRef.current.isCurrent(operation)
          && subscriptionLoginMountedRef.current
        ) {
          setSubscriptionLoginPanel({
            provider,
            method: requestedMethod,
            authorizationUrl: '',
            userCode: undefined,
            status: 'failed',
            error: String(e),
          });
          notification.error(t('subscriptionAuth.loginFailed', { error: String(e) }));
        }
      }
    } finally {
      if (loginCoordinatorRef.current.complete(operation)) {
        if (subscriptionLoginMountedRef.current) {
          setLoggingInProvider(null);
        }
      }
    }
  }, [notification, pollSubscriptionLogin, refreshSubscriptionAccounts, t]);

  const handleCancelSubscriptionLogin = useCallback(async (provider: SubscriptionProvider) => {
    const operation = loginCoordinatorRef.current.requestCancel(provider);
    if (!operation) return;
    // Keep the coordinator slot and loading state reserved until the start
    // command has settled and any backend session has been cancelled.
    setSubscriptionLoginPanel((current) => (
      current?.provider === provider
        ? { ...current, status: 'cancelling' }
        : current
    ));
    // This first attempt makes cancellation responsive if the backend has
    // installed its placeholder. The start-settlement path retries, because
    // desktop command scheduling can deliver this request first.
    try {
      await aiApi.cancelSubscriptionLogin(provider, operation.sessionId);
    } catch (e) {
      log.warn('cancel_subscription_login failed', { error: String(e) });
    }
  }, []);

  const handleOpenSubscriptionAuthorization = useCallback(async (url: string) => {
    if (!url) return;
    try {
      await systemAPI.openExternal(url);
    } catch (error) {
      log.warn('Failed to open subscription authorization URL from pending card', {
        url,
        error: String(error),
      });
      notification.info(t('subscriptionAuth.openUrlManually', { url }));
    }
  }, [notification, t]);

  const handleCopySubscriptionCode = useCallback(async (code: string) => {
    try {
      await systemAPI.setClipboard(code);
      notification.success(t('subscriptionAuth.codeCopied'));
    } catch (error) {
      log.warn('Failed to copy subscription device code', { error: String(error) });
      notification.error(t('subscriptionAuth.copyCodeFailed'));
    }
  }, [notification, t]);

  const requestSubscriptionLogout = useCallback((account: SubscriptionAccount) => {
    const affectedModels = aiModels.filter((model) => (
      model.auth?.type === 'subscription' && model.auth.provider === account.provider
    ));
    setSubscriptionLogoutRequest({ account, affectedModels });
  }, [aiModels]);

  const confirmSubscriptionLogout = useCallback(async () => {
    const request = subscriptionLogoutRequest;
    if (!request) return;
    try {
      const result = await aiApi.logoutSubscriptionAccount(request.account.provider);
      // Metadata removal is the source of truth for connection state. Reflect
      // it immediately, then refresh before presenting either outcome notice.
      setSubscriptionAccounts((current) => current.map((account) => (
        account.provider === request.account.provider
          ? {
              ...account,
              connected: false,
              account: null,
              expires_at: null,
              reauthentication_required: false,
              vault_unavailable: false,
            }
          : account
      )));
      await refreshSubscriptionAccounts();
      setSubscriptionLogoutRequest(null);
      if (result.cleanup_pending) {
        log.warn('Subscription logout completed with credential cleanup pending', {
          provider: request.account.provider,
          warning: result.warning,
        });
        notification.warning(t('subscriptionAuth.logoutCleanupPending'));
      } else {
        notification.success(t('subscriptionAuth.logoutSuccess'));
      }
    } catch (e) {
      notification.error(t('subscriptionAuth.logoutFailed', { error: String(e) }));
    }
  }, [notification, refreshSubscriptionAccounts, subscriptionLogoutRequest, t]);

  const handleSubscriptionRefresh = useCallback(async (provider: SubscriptionProvider) => {
    if (subscriptionRefreshesRef.current.has(provider)) return;
    subscriptionRefreshesRef.current.add(provider);
    setRefreshingSubscriptionProviders(new Set(subscriptionRefreshesRef.current));
    const scope = getActiveSurfaceScope();
    try {
      await aiApi.refreshSubscriptionAccount(provider);
      if (!scope.isCurrent() || !subscriptionLoginMountedRef.current) return;
      await refreshSubscriptionAccounts();
      if (!scope.isCurrent() || !subscriptionLoginMountedRef.current) return;
      notification.success(t('subscriptionAuth.refreshSuccess'));
    } catch (e) {
      if (scope.isCurrent() && subscriptionLoginMountedRef.current) {
        notification.error(t('subscriptionAuth.refreshFailed', { error: String(e) }));
      }
    } finally {
      subscriptionRefreshesRef.current.delete(provider);
      if (subscriptionLoginMountedRef.current) {
        setRefreshingSubscriptionProviders(new Set(subscriptionRefreshesRef.current));
      }
    }
  }, [notification, refreshSubscriptionAccounts, t]);

  
  const handleSelectProvider = (providerId: string) => {
    const template = providerTemplates[providerId];
    if (!template) return;
    resetRemoteModelDiscovery();
    setManualModelInput('');
    setShowApiKey(false);
    setSelectedProviderId(providerId);
    setEditingTargetKey(`new-provider:${providerId}`);
    
    // Dynamically get translated name
    const providerName = t(`providers.${template.id}.name`);
    
    setEditingConfig({
      name: providerName,
      base_url: template.baseUrl,
      request_url: '',
      api_key: '',
      model_name: '',
      provider: template.format,
      enabled: true,
      context_window: 300000,
      category: 'multimodal',
      capabilities: getCapabilitiesByCategory('multimodal'),
      recommended_for: [],
      metadata: {},
      inline_think_in_text: true,
    });
    // Provider templates supply available choices, never an implicit selection.
    setSelectedModelDrafts([]);
    setEditingProviderModelIds(new Set());
    setShowAdvancedSettings(false);
    setCreationMode('form');
    setIsEditing(true);
  };

  
  const handleSelectCustom = () => {
    resetRemoteModelDiscovery();
    setManualModelInput('');
    setEditingProviderModelIds(new Set());
    setShowApiKey(false);
    setSelectedProviderId(null);
    setEditingTargetKey('new-provider:custom');
    setEditingConfig({
      name: '',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      request_url: resolveRequestUrl('https://open.bigmodel.cn/api/paas/v4', 'openai'),
      api_key: '',
      model_name: '',
      provider: 'openai',  
      enabled: true,
      context_window: 300000,
      category: 'multimodal',
      capabilities: getCapabilitiesByCategory('multimodal'),
      recommended_for: [],
      metadata: {},
      inline_think_in_text: true,
    });
    setSelectedModelDrafts([]);
    setShowAdvancedSettings(false);  
    setCreationMode('form');
    setIsEditing(true);
  };

  const handleEditProvider = (config: AIModelConfigType) => {
    const providerName = getProviderDisplayName(config);
    const providerGroupKey = getProviderGroupKey(config);
    const targetKey = `provider:${providerGroupKey}`;
    requestEditorOpen(targetKey, () => {
      resetRemoteModelDiscovery();
      setManualModelInput('');
      setShowApiKey(false);

      const configuredProviderModels = aiModels
        .filter(model => getProviderGroupKey(model) === providerGroupKey)
        .sort((a, b) => a.model_name.localeCompare(b.model_name));
      const providerTemplateId = getProviderTemplateId(config);
      setEditingProviderModelIds(new Set(
        configuredProviderModels
          .map(model => model.id)
          .filter((id): id is string => !!id)
      ));
      setSelectedProviderId(providerTemplateId || null);
      setEditingTargetKey(targetKey);
      setEditingConfig({
        name: providerName,
        base_url: config.base_url,
        request_url: resolveRequestUrl(config.base_url, config.provider || 'openai'),
        api_key: config.api_key || '',
        model_name: '',
        provider: config.provider,
        enabled: true,
        context_window: config.context_window || 300000,
        max_tokens: config.max_tokens,
        category: config.category || 'general_chat',
        capabilities: config.capabilities || getCapabilitiesByCategory(config.category || 'general_chat'),
        recommended_for: config.recommended_for || [],
        metadata: config.metadata || {},
        inline_think_in_text: config.inline_think_in_text ?? true,
        custom_headers: config.custom_headers,
        custom_headers_mode: config.custom_headers_mode,
        skip_ssl_verify: config.skip_ssl_verify ?? false,
        custom_request_body: config.custom_request_body,
        custom_request_body_mode: config.custom_request_body_mode,
        auth: config.auth || { type: 'api_key' },
      });
      setSelectedModelDrafts(createDraftsFromConfigs(configuredProviderModels));
      setShowAdvancedSettings(
        !!config.skip_ssl_verify ||
        config.custom_request_body_mode === 'trim' ||
        (!!config.custom_request_body && config.custom_request_body.trim() !== '') ||
        (!!config.custom_headers && Object.keys(config.custom_headers).length > 0)
      );
      setCreationMode('form');
      setIsEditing(true);
    });
  };

  const handleEdit = (config: AIModelConfigType) => {
    const targetKey = `model:${config.id || `${config.provider}:${config.base_url}:${config.model_name}`}`;
    requestEditorOpen(targetKey, () => {
      resetRemoteModelDiscovery();
      setManualModelInput('');
      setEditingProviderModelIds(new Set());
      setShowApiKey(false);
      setEditingTargetKey(targetKey);
      setEditingConfig({ ...config, name: getProviderDisplayName(config) });
      setSelectedModelDrafts([
        createModelDraft(config.model_name, config, {
          contextWindow: config.context_window || 300000,
          maxTokens: config.max_tokens,
          reasoning: canonicalReasoningConfig(config),
        })
      ]);

      const hasCustomHeaders = !!config.custom_headers && Object.keys(config.custom_headers).length > 0;
      const hasCustomBody = !!config.custom_request_body && config.custom_request_body.trim() !== '';
      setShowAdvancedSettings(
        hasCustomHeaders ||
        hasCustomBody ||
        config.custom_request_body_mode === 'trim' ||
        !!config.skip_ssl_verify
      );
      setIsEditing(true);
    });
  };

  const runConfigConnectionTest = useCallback(async (config: AIModelConfigType) => {
    const configId = config.id;
    if (!configId || !connectionTestSupported) return;

    const signature = stableJson(config);
    const activeTest = activeConnectionTestsRef.current[configId];
    if (activeTest?.signature === signature) return;

    const token = Symbol(configId);
    activeConnectionTestsRef.current[configId] = { token, signature };
    setTestingConfigs(previous => ({ ...previous, [configId]: true }));
    setTestResults(previous => ({ ...previous, [configId]: null }));

    try {
      const result = await aiApi.testAIConfigConnection(config);
      if (activeConnectionTestsRef.current[configId]?.token !== token) return;

      const baseMessage = result.success ? t('messages.testSuccess') : t('messages.testFailed');
      let message = baseMessage + (result.response_time_ms ? ` (${result.response_time_ms}ms)` : '');
      const localizedMessage = translateConnectionTestMessage(result.message_code, t);

      if (localizedMessage) {
        message += `\n${localizedMessage}`;
      }
      if (result.error_details) {
        message += result.success
          ? `\n${result.error_details}`
          : `\n${t('messages.errorDetails')}: ${result.error_details}`;
      }

      setTestResults(previous => ({
        ...previous,
        [configId]: { success: result.success, message },
      }));
    } catch (error) {
      if (activeConnectionTestsRef.current[configId]?.token !== token) return;
      const message = `${t('messages.testFailed')}\n${t('messages.errorDetails')}: ${error}`;
      setTestResults(previous => ({
        ...previous,
        [configId]: { success: false, message },
      }));
      log.warn('Model connection test failed', { configId, error });
    } finally {
      if (activeConnectionTestsRef.current[configId]?.token === token) {
        delete activeConnectionTestsRef.current[configId];
        setTestingConfigs(previous => ({ ...previous, [configId]: false }));
      }
    }
  }, [connectionTestSupported, t]);

  const handleSave = async (): Promise<boolean> => {
    if (editorSavingRef.current) return false;
    
    if (!editingConfig) return false;
    setShowModelValidation(true);
    const missingFields = [
      missingModelFields.name && t('form.configName'),
      missingModelFields.baseUrl && t('form.baseUrl'),
      missingModelFields.apiKey && t('form.apiKey'),
      missingModelFields.model && t('form.modelName'),
    ].filter((field): field is string => typeof field === 'string');
    if (missingFields.length > 0) {
      const fields = missingFields.length > 1
        ? `${missingFields.slice(0, -1).join(t('messages.fieldSeparator'))}${t('messages.lastFieldSeparator')}${missingFields.at(-1)}`
        : missingFields[0];
      notification.warning(t('messages.missingFields', { fields }));
      return false;
    }

    editorSavingRef.current = true;
    setIsEditorSaving(true);
    try {
      const providerName = editingConfig.name?.trim() || '';
      const baseUrl = editingConfig.base_url?.trim() || '';
      if (!hasHttpUrlScheme(baseUrl)) {
        notification.warning(t('messages.invalidBaseUrlScheme'));
        return false;
      }
      const draftsToSave = dedupeSelectedModelDraftsByModelName(selectedModelDrafts);
      if (draftsToSave.some(draft => draft.contextWindow < 32000)) {
        notification.warning(t('messages.contextWindowTooSmall'));
        return false;
      }
      const reasoningValidationResults = draftsToSave.map(draft => ({
        modelName: draft.modelName,
        reasoning: draft.reasoning,
        projectionCatalog: draft.reasoningProjectionCatalog,
        snapshotCatalog: draft.reasoningProjectionSnapshot?.catalog,
        generatedPresetIds: resolveDraftReasoningProjection(draft)?.presets
          ?.filter(preset => preset.source !== 'model_config')
          .map(preset => preset.id) ?? [],
      })).map(entry => ({
        ...entry,
        validationError: validateReasoningConfig(entry.reasoning, entry.generatedPresetIds),
      }));
      if (reasoningValidationResults.some(entry => entry.validationError !== null)) {
        notification.warning(t('messages.invalidReasoningPresets'));
        return false;
      }
      const existingProviderInstanceId = getProviderInstanceId(editingConfig);
      const isProviderGroupEdit = !editingConfig.id && editingProviderModelIds.size > 0;
      const providerInstanceId = existingProviderInstanceId || generateProviderInstanceId();
      const providerGroupModelIds = isProviderGroupEdit
        ? editingProviderModelIds
        : new Set<string>();
      const allocatedConfigIds = new Set(
        aiModels
          .map(model => model.id?.trim())
          .filter((id): id is string => Boolean(id))
      );
      let apiKeyModels = remoteModelOptions;
      const zenOAuth = isOpenCodeZenOAuth(editingConfig);
      const routeConfig = editingConfig;
      if (zenOAuth && apiKeyModels.length === 0) {
        const scope = getActiveSurfaceScope();
        const account = await aiApi.refreshSubscriptionAccount('opencode');
        if (!scope.isCurrent()) return false;
        apiKeyModels = openCodeZenModels(account.api_offerings ?? []);
      }
      if (isOpenCodeApiKeyConfig(editingConfig) && apiKeyModels.length === 0) {
        const scope = getActiveSurfaceScope();
        const discoveryConfig = buildModelDiscoveryConfig(editingConfig);
        if (!discoveryConfig) throw new Error(t('providerSelection.fillApiKeyBeforeFetch'));
        apiKeyModels = await aiApi.listModelsByConfig(discoveryConfig);
        if (!scope.isCurrent()) return false;
      }
      const configsToSave: AIModelConfigType[] = draftsToSave.map((draft) => {
        const id = editingConfig.id
          || draft.configId
          || allocateModelConfigId(draft.modelName, allocatedConfigIds);
        allocatedConfigIds.add(id);
        const apiKeyRoute = resolveOpenCodeModelRoute(routeConfig, draft.modelName, apiKeyModels);
        if ((zenOAuth || isOpenCodeApiKeyConfig(routeConfig)) && !apiKeyRoute
          && apiKeyModels.some(model => model.id === draft.modelName.trim())) {
          throw new Error(t('providerSelection.modelRoutingUnavailable'));
        }
        const existingModel = isOpenCodeApiKeyConfig(editingConfig)
          ? aiModels.find(model => model.id === (draft.configId || editingConfig.id)
            && model.model_name === draft.modelName && model.base_url === baseUrl)
          : undefined;
        const format = apiKeyRoute?.format
          || (isOpenCodeApiKeyConfig(routeConfig) ? draft.manualRequestFormat : undefined)
          || existingModel?.provider || editingConfig.provider || 'openai';
        const modelBaseUrl = apiKeyRoute?.base_url || baseUrl;
        return {
          id,
          name: providerName,
          base_url: modelBaseUrl,
          request_url: apiKeyRoute?.request_url || resolveRequestUrl(
            modelBaseUrl,
            format,
            draft.modelName
          ),
          api_key: editingConfig.api_key || '',
          model_name: draft.modelName,
          provider: format,
          enabled: editingConfig.enabled ?? true,
          context_window: draft.contextWindow,
          max_tokens: draft.maxTokens,
          category: resolveModelCategory(
            draft.modelName,
            draft.category,
            format
          ),
          capabilities: getCapabilitiesByCategory(
            resolveModelCategory(
              draft.modelName,
              draft.category,
              format
            )
          ),
          recommended_for: editingConfig.recommended_for || [],
          metadata: {
            ...(editingConfig.metadata || {}),
            [PROVIDER_INSTANCE_METADATA_KEY]: providerInstanceId,
          },
          reasoning: draft.reasoning,
          inline_think_in_text: editingConfig.inline_think_in_text ?? true,
          custom_headers: editingConfig.custom_headers,
          custom_headers_mode: editingConfig.custom_headers_mode,
          skip_ssl_verify: editingConfig.skip_ssl_verify ?? false,
          custom_request_body: editingConfig.custom_request_body,
          custom_request_body_mode: editingConfig.custom_request_body_mode,
          auth: editingConfig.auth || { type: 'api_key' },
        };
      });
      let previousModelsBeforeSave: AIModelConfigType[] = [];
      const updatedModels = await configManager.updateConfig<AIModelConfigType[]>('ai.models', current => {
        previousModelsBeforeSave = current;
        if (editingConfig.id) {
          if (!current.some(model => model.id === editingConfig.id)) {
            throw new Error('The model was removed while it was being edited');
          }
          return current.map(model => model.id === editingConfig.id ? { ...model, ...configsToSave[0] } : model);
        }
        if (isProviderGroupEdit) {
          return [
            ...current.filter(model => !providerGroupModelIds.has(model.id || '')),
            ...configsToSave,
          ];
        }
        return [...current, ...configsToSave];
      });
      const configsToAutoTest = configsNeedingAutoTest(
        previousModelsBeforeSave,
        configsToSave,
        isProviderGroupEdit
      );
      setAiModels(updatedModels);
      // The host reconciles default selectors using model capabilities.
      
      
      setIsEditing(false);
      setEditingConfig(null);
      setCreationMode(null);
      setSelectedProviderId(null);
      setEditingProviderModelIds(new Set());
      setSelectedModelDrafts([]);
      setEditingTargetKey(null);
      setDraftCloseConfirmOpen(false);
      setDraftConflictConfirmOpen(false);
      
      
      const autoTestConfigIds = configsToAutoTest.map(config => config.id).filter((id): id is string => !!id);
      if (connectionTestSupported && autoTestConfigIds.length > 0) {
        setExpandedIds(prev => new Set([...prev, ...autoTestConfigIds]));
      }
      
      
      
      if (connectionTestSupported) {
        void (async () => {
          for (const config of configsToAutoTest) {
            await runConfigConnectionTest(config);
          }
        })();
      } else if (configsToAutoTest.length > 0) {
        notification.info(t('messages.testUnsupportedOnHost'));
      }
      return true;
    } catch (error) {
      log.error('Failed to save config', error);
      notification.error(t('messages.saveFailed'));
      return false;
    } finally {
      editorSavingRef.current = false;
      setIsEditorSaving(false);
    }
  };

  const closeEditingModal = () => {
    resetRemoteModelDiscovery();
    setSelectedModelDrafts([]);
    setEditingProviderModelIds(new Set());
    setManualModelInput('');
    setShowApiKey(false);
    setIsEditing(false);
    setEditingConfig(null);
    setCreationMode(null);
    setSelectedProviderId(null);
    setEditingTargetKey(null);
    setProviderQuery('');
    setShowAllProviders(false);
    setReasoningPanelDraftKey(null);
    setDraftCloseConfirmOpen(false);
    setDraftConflictConfirmOpen(false);
    pendingEditorOpenRef.current = null;
    reasoningPanelInitialRef.current = null;
  };

  const inspectModelReferenceCount = async (modelIds: string[]): Promise<number> => {
    const [defaultModels, taskModels, agentModelDefaults] = await Promise.all([
      configManager.getConfig<unknown>('ai.default_models'),
      configManager.getConfig<unknown>('ai.task_models'),
      configManager.getConfig<unknown>('ai.agent_model_defaults'),
    ]);
    const ids = new Set(modelIds);
    return [defaultModels, taskModels, agentModelDefaults]
      .reduce<number>((count, value) => count + countModelConfigReferences(value, ids), 0);
  };

  const requestDelete = async (config: AIModelConfigType) => {
    if (!config.id) return;
    try {
      const referenceCount = await inspectModelReferenceCount([config.id]);
      setDeleteRequest({ kind: 'model', config, modelIds: [config.id], referenceCount });
    } catch (error) {
      log.error('Failed to inspect model references before deletion', { configId: config.id, error });
      notification.error(t('messages.referenceCheckFailed'));
    }
  };

  const requestProviderDelete = async (group: ProviderGroup) => {
    const modelIds = group.models
      .map(model => model.id)
      .filter((id): id is string => !!id);
    try {
      const referenceCount = await inspectModelReferenceCount(modelIds);
      setDeleteRequest({
        kind: 'provider',
        groupKey: group.key,
        providerName: group.providerName,
        modelIds,
        modelCount: group.models.length,
        referenceCount,
        discardsRetainedDraft: editingModalHasUnsavedChanges
          && editingTargetKey === `provider:${group.key}`,
      });
    } catch (error) {
      log.error('Failed to inspect provider model references before deletion', {
        providerGroupKey: group.key,
        error,
      });
      notification.error(t('messages.providerReferenceCheckFailed'));
    }
  };

  const handleDelete = async () => {
    const request = deleteRequest;
    if (!request) return;
    let deletedModelIds = request.modelIds;
    try {
      const updatedModels = await configManager.updateConfig<AIModelConfigType[]>(
        'ai.models',
        (current) => {
          if (request.kind === 'provider') {
            const result = removeProviderModelConfigs(current, request.groupKey);
            deletedModelIds = result.removed
              .map(model => model.id)
              .filter((id): id is string => !!id);
            return result.remaining;
          }
          return current.filter(model => model.id !== request.config.id);
        },
      );
      const deletedIdSet = new Set(deletedModelIds);
      deletedIdSet.forEach(id => {
        delete activeConnectionTestsRef.current[id];
      });
      setTestingConfigs(current => Object.fromEntries(
        Object.entries(current).filter(([id]) => !deletedIdSet.has(id)),
      ));
      setTestResults(current => Object.fromEntries(
        Object.entries(current).filter(([id]) => !deletedIdSet.has(id)),
      ));
      setExpandedIds(current => new Set([...current].filter(id => !deletedIdSet.has(id))));
      if (request.kind === 'provider') {
        setExpandedProviderGroupKeys(current => {
          const next = new Set(current);
          next.delete(request.groupKey);
          return next;
        });
        if (editingTargetKey === `provider:${request.groupKey}`) {
          closeEditingModal();
        }
      } else if (editingTargetKey === `model:${request.config.id}`) {
        closeEditingModal();
      }
      setAiModels(updatedModels);
      setDeleteRequest(null);
      notification.success(t(
        request.kind === 'provider'
          ? 'messages.providerDeleteSuccess'
          : 'messages.deleteSuccess',
      ));
    } catch (error) {
      log.error(
        request.kind === 'provider' ? 'Failed to delete provider config' : 'Failed to delete model config',
        request.kind === 'provider'
          ? { providerGroupKey: request.groupKey, error }
          : { configId: request.config.id, error },
      );
      notification.error(t(
        request.kind === 'provider'
          ? 'messages.providerDeleteFailed'
          : 'messages.deleteFailed',
      ));
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleTest = async (config: AIModelConfigType) => {
    await runConfigConnectionTest(config);
  };

  const handleToggleEnabled = async (config: AIModelConfigType, enabled: boolean) => {
    if (!config.id) return;

    try {
      const updatedModels = await configManager.updateConfig<AIModelConfigType[]>(
        'ai.models', current => current.map(model => model.id === config.id ? { ...model, enabled } : model)
      );
      setAiModels(updatedModels);
    } catch (error) {
      log.error('Failed to toggle model status', { configId: config.id, enabled, error });
      notification.error(t('messages.saveFailed'));
    }
  };

  
  const handleSaveProxy = async (): Promise<boolean> => {
    if (!isProxyDirty) return true;
    if (proxySavingRef.current) return false;
    if (proxyConfig.enabled && !proxyConfig.url.trim()) {
      setProxySaveError(t('messages.fillRequired'));
      return false;
    }
    proxySavingRef.current = true;
    setIsProxySaving(true);
    setProxySaveError(null);
    try {
      await configManager.setConfig('ai.proxy', proxyConfig);
      setSavedProxyConfig(proxyConfig);
      setProxySaveError(null);
      notification.success(t('proxy.saveSuccess'));
      return true;
    } catch (error) {
      log.error('Failed to save proxy config', error);
      setProxySaveError(t('messages.saveFailed'));
      notification.error(t('messages.saveFailed'));
      return false;
    } finally {
      proxySavingRef.current = false;
      setIsProxySaving(false);
    }
  };

  const handleSaveStreamTimeouts = async (): Promise<boolean> => {
    if (!isStreamTimeoutDirty) return true;
    if (streamTimeoutSavingRef.current) return false;
    if (isStreamTimeoutInvalid) {
      setStreamTimeoutSaveError(t('streamIdleTimeout.invalid'));
      notification.warning(t('streamIdleTimeout.invalid'));
      return false;
    }

    streamTimeoutSavingRef.current = true;
    setIsStreamTimeoutSaving(true);
    setStreamTimeoutSaveError(null);
    try {
      await Promise.all([
        configManager.setConfig(
          'ai.stream_idle_timeout_secs',
          parsedStreamIdleTimeout ?? null
        ),
        configManager.setConfig(
          'ai.stream_ttft_timeout_secs',
          parsedStreamTtftTimeout ?? null
        ),
      ]);
      setStreamIdleTimeoutInput(
        parsedStreamIdleTimeout != null ? String(parsedStreamIdleTimeout) : ''
      );
      setStreamTtftTimeoutInput(
        parsedStreamTtftTimeout != null ? String(parsedStreamTtftTimeout) : ''
      );
      setSavedStreamTimeouts({
        idle: parsedStreamIdleTimeout != null ? String(parsedStreamIdleTimeout) : '',
        ttft: parsedStreamTtftTimeout != null ? String(parsedStreamTtftTimeout) : '',
      });
      setStreamTimeoutSaveError(null);
      notification.success(t('streamIdleTimeout.saveSuccess'));
      return true;
    } catch (error) {
      log.error('Failed to save stream timeouts', error);
      setStreamTimeoutSaveError(t('messages.saveFailed'));
      notification.error(t('messages.saveFailed'));
      return false;
    } finally {
      streamTimeoutSavingRef.current = false;
      setIsStreamTimeoutSaving(false);
    }
  };

  const preserveEditingDraftAndClose = () => {
    setDraftCloseConfirmOpen(false);
    setIsEditing(false);
  };

  const requestCloseEditingModal = () => {
    if (editorSavingRef.current) return;
    if (editingModalHasUnsavedChanges) {
      setDraftCloseConfirmOpen(true);
      return;
    }
    closeEditingModal();
  };

  const continueEditingCurrentDraft = () => {
    pendingEditorOpenRef.current = null;
    setDraftConflictConfirmOpen(false);
    setIsEditing(true);
  };

  const discardDraftBeforeOpeningPendingEditor = () => {
    const pending = pendingEditorOpenRef.current;
    closeEditingModal();
    pending?.open();
  };

  const cancelPendingEditorOpen = () => {
    pendingEditorOpenRef.current = null;
    setDraftConflictConfirmOpen(false);
  };

  const discardProxyDraft = useCallback(() => {
    setProxyConfig(savedProxyConfig);
    setProxySaveError(null);
  }, [savedProxyConfig]);
  const discardStreamTimeoutDraft = useCallback(() => {
    setStreamIdleTimeoutInput(savedStreamTimeouts.idle);
    setStreamTtftTimeoutInput(savedStreamTimeouts.ttft);
    setStreamTimeoutSaveError(null);
  }, [savedStreamTimeouts]);

  useSettingsDraft({
    id: 'model-stream-timeouts',
    pageId: 'ai.models',
    label: t('streamIdleTimeout.title'),
    dirty: isStreamTimeoutDirty,
    saving: isStreamTimeoutSaving,
    save: handleSaveStreamTimeouts,
    discard: discardStreamTimeoutDraft,
  });
  useSettingsDraft({
    id: 'model-network-proxy',
    pageId: 'ai.models',
    label: tDefault('sections.proxy'),
    dirty: isProxyDirty,
    saving: isProxySaving,
    save: handleSaveProxy,
    discard: discardProxyDraft,
  });
  useSettingsDraft({
    id: 'model-provider-editor',
    pageId: 'ai.models',
    label: editingConfig?.id
      ? t('editModel')
      : getProviderInstanceId(editingConfig)
        ? t('editProvider')
        : t('newProvider'),
    dirty: editingConfig !== null && editingModalHasUnsavedChanges,
    saving: isEditorSaving,
    save: handleSave,
    discard: closeEditingModal,
  });

  const hasSuspendedEditorDraft = !isEditing
    && editingConfig !== null
    && editingModalHasUnsavedChanges;

  const providerGroups = useMemo<ProviderGroup[]>(() => {
    const grouped = aiModels.reduce<Map<string, ProviderGroup>>((map, model) => {
      const groupKey = getProviderGroupKey(model);
      const providerName = getProviderDisplayName(model);
      const existingGroup = map.get(groupKey);
      if (existingGroup) {
        existingGroup.models.push(model);
        return map;
      }

      map.set(groupKey, {
        key: groupKey,
        providerName,
        providerId: getProviderTemplateId(model),
        models: [model],
      });
      return map;
    }, new Map());

    return Array.from(grouped.values()).sort((a, b) => {
      const indexA = a.providerId ? providerOrder.indexOf(a.providerId) : -1;
      const indexB = b.providerId ? providerOrder.indexOf(b.providerId) : -1;

      if (indexA !== indexB) {
        return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
      }

      return a.providerName.localeCompare(b.providerName);
    });
  }, [aiModels, providerOrder]);

  const toggleProviderGroup = (groupKey: string) => {
    setExpandedProviderGroupKeys(previous => {
      const next = new Set(previous);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  };

  
  if (isConfigLoading || configLoadError) {
    return (
      <ConfigPageLayout className="openbitfun-model-settings" data-openbitfun-component="model-settings" data-openbitfun-part="root" data-openbitfun-view="settings">
        <ConfigPageHeader title={t('title')} subtitle={t('subtitle')} />
        <ConfigPageContent className="openbitfun-model-settings__content">
          {isConfigLoading ? (
            <div className="openbitfun-model-settings__loading" role="status">{t('messages.loading')}</div>
          ) : (
            <ConfigRetryState
              message={t('messages.loadFailedLocked')}
              retryLabel={t('messages.retry')}
              onRetry={() => void loadConfig()}
            />
          )}
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  if (creationMode === 'selection') {
    return (
      <ConfigPageLayout className="openbitfun-model-settings" data-openbitfun-component="model-settings" data-openbitfun-part="root" data-openbitfun-view="selection">
        <ConfigPageHeader
          title={t('providerSelection.title')}
          subtitle={t('providerSelection.subtitle')}
        />

        <ConfigPageContent className="openbitfun-model-settings__content openbitfun-model-settings__content--selection">
          <div className="openbitfun-model-settings__provider-selection" data-openbitfun-component="model-settings" data-openbitfun-part="providerSelection">
            
            <button
              type="button"
              data-testid="settings-model-custom-config-btn"
              data-provider-id="custom"
              className="openbitfun-model-settings__custom-option"
              onClick={handleSelectCustom}
            >
              <div className="openbitfun-model-settings__custom-option-content" data-openbitfun-component="model-settings" data-openbitfun-part="customOption">
                <Icon name="settings" size="lg" />
                <div>
                  <div className="openbitfun-model-settings__custom-option-title" data-openbitfun-component="model-settings" data-openbitfun-part="customOptionTitle">{t('providerSelection.customTitle')}</div>
                  <div className="openbitfun-model-settings__custom-option-description" data-openbitfun-component="model-settings" data-openbitfun-part="customOptionDescription">{t('providerSelection.customDescription')}</div>
                </div>
              </div>
            </button>

            
            <div className="openbitfun-model-settings__selection-divider" data-openbitfun-component="model-settings" data-openbitfun-part="selectionDivider">
              <span>{t('providerSelection.orSelectProvider')}</span>
            </div>


            <SearchField
              leadingIcon={<Icon name="search" size="lg" aria-hidden />}
              size="sm"
              className="openbitfun-model-settings__provider-search"
              data-testid="settings-model-provider-search"
              data-openbitfun-component="model-settings"
              data-openbitfun-part="providerSearch"
              value={providerQuery}
              placeholder={t('providerSelection.searchProviders')}
              aria-label={t('providerSelection.searchProviders')}
              onValueChange={setProviderQuery}
              onSearch={() => {
                const firstMatch = visibleProviders[0];
                if (normalizedProviderQuery && firstMatch) handleSelectProvider(firstMatch.id);
              }}
            />


            <div className="openbitfun-model-settings__provider-list" data-openbitfun-component="model-settings" data-openbitfun-part="providerList">
              {visibleProviders.map(provider => (
                // The help link is a sibling of the select button, not a child:
                // a button may not contain interactive content.
                <div
                  key={provider.id}
                  className="openbitfun-model-settings__provider-row"
                  data-openbitfun-component="model-settings"
                  data-openbitfun-part="providerRow"
                >
                  <button
                    type="button"
                    data-testid="settings-model-provider-option"
                    data-provider-id={provider.id}
                    className="openbitfun-model-settings__provider-select"
                    data-openbitfun-component="model-settings"
                    data-openbitfun-part="providerSelect"
                    onClick={() => handleSelectProvider(provider.id)}
                  >
                    <span className="openbitfun-model-settings__provider-name" data-openbitfun-component="model-settings" data-openbitfun-part="providerName">{provider.name}</span>
                    <span className="openbitfun-model-settings__provider-description" data-openbitfun-component="model-settings" data-openbitfun-part="providerDescription">{provider.description}</span>
                  </button>
                  {provider.helpUrl && (
                    <a
                      href={provider.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="openbitfun-model-settings__provider-help-link"
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                          await systemAPI.openExternal(provider.helpUrl!);
                        } catch (error) {
                          console.error('[ModelSettings] Failed to open external URL:', error);
                        }
                      }}
                    >
                      <Icon name="arrow-up-right" size="xs" />
                      {t('providerSelection.getApiKey')}
                    </a>
                  )}
                  <Icon name="chevron-right" size="sm" className="openbitfun-model-settings__provider-chevron" aria-hidden="true" />
                </div>
              ))}

              {visibleProviders.length === 0 && (
                <div className="openbitfun-model-settings__provider-empty" data-openbitfun-component="model-settings" data-openbitfun-part="providerEmpty">
                  {t('providerSelection.noProviderMatches')}
                </div>
              )}

              {canToggleProviderList && (
                <button
                  type="button"
                  data-testid="settings-model-provider-expand-btn"
                  className="openbitfun-model-settings__provider-more"
                  data-openbitfun-component="model-settings"
                  data-openbitfun-part="providerMore"
                  onClick={() => setShowAllProviders(previous => !previous)}
                >
                  {isProviderListCollapsed
                    ? t('providerSelection.showAllProviders', { count: matchedProviders.length })
                    : t('providerSelection.collapseProviders')}
                  {isProviderListCollapsed ? <Icon name="chevron-down" size="sm" /> : <Icon name="chevron-up" size="sm" />}
                </button>
              )}
            </div>


            <div className="openbitfun-model-settings__selection-actions" data-openbitfun-component="model-settings" data-openbitfun-part="selectionActions">
              <Button variant="fill" size="sm" onClick={() => setCreationMode(null)}>
                {t('actions.cancel')}
              </Button>
            </div>
          </div>
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  
  const renderEditingForm = () => {
    if (!isEditing || !editingConfig) return null;
    const isFromTemplate = !editingConfig.id && !!currentTemplate;
    const zenOAuth = isOpenCodeZenOAuth(editingConfig);
    const routeConfig = editingConfig;
    const automaticOpenCodeRouting = zenOAuth || isOpenCodeApiKeyConfig(routeConfig);
    const isProviderScopedEditing = !editingConfig.id;
    const catalogProvider = selectedProviderId
      ? modelCatalog?.provider_catalog?.providers.find(provider => provider.id === selectedProviderId)
      : undefined;
    const normalizedEditingBaseUrl = editingConfig.base_url
      ? normalizeProviderBaseUrl(editingConfig.base_url)
      : '';
    const selectedEndpointId = catalogProvider?.endpoints
      .filter(endpoint => !editingConfig.provider || endpoint.api_format === editingConfig.provider)
      .sort((left, right) => (
        normalizeProviderBaseUrl(right.base_url).length
        - normalizeProviderBaseUrl(left.base_url).length
      ))
      .find(endpoint => {
        const normalizedEndpoint = normalizeProviderBaseUrl(endpoint.base_url);
        return normalizedEndpoint === normalizedEditingBaseUrl
          || normalizedEndpoint.startsWith(`${normalizedEditingBaseUrl}/`)
          || normalizedEditingBaseUrl.startsWith(`${normalizedEndpoint}/`);
      })?.id;
    const catalogModelOptions: ComboboxOption[] = (catalogProvider?.models || [])
      .filter(model => (
        !selectedEndpointId
        || !model.endpoint_ids?.length
        || model.endpoint_ids.includes(selectedEndpointId)
      ))
      .map(model => ({
        label: model.display_name || model.id,
        value: model.id,
        description: model.display_name && model.display_name !== model.id ? model.id : undefined,
        testId: 'settings-model-option',
        testAttributes: {
          'data-model-id': model.id,
          'data-model-name': model.id,
          'data-model-source': model.source,
        },
      }));
    const fetchedOrPresetModelOptions: ComboboxOption[] = remoteModelOptions.length > 0
      ? remoteModelOptions.map(model => ({
          label: model.display_name || model.id,
          value: model.id,
          description: model.display_name && model.display_name !== model.id ? model.id : undefined,
          testId: 'settings-model-option',
          testAttributes: {
            'data-model-id': model.id,
            'data-model-name': model.id,
          },
        }))
      : editingConfig.auth?.type === 'subscription'
        ? []
        : catalogModelOptions.length > 0
        ? catalogModelOptions
        : (currentTemplate?.models || []).map(model => ({
          label: model,
          value: model,
          testId: 'settings-model-option',
          testAttributes: {
            'data-model-id': model,
            'data-model-name': model,
          },
        }));
    const selectedModelOptions: ComboboxOption[] = selectedModelDrafts.map(draft => ({
      label: draft.modelName,
      value: draft.modelName,
      testId: 'settings-model-option',
      testAttributes: {
        'data-model-id': draft.modelName,
        'data-model-name': draft.modelName,
      },
    }));
    const availableModelOptions: ComboboxOption[] = Array.from(
      new Map(
        [...fetchedOrPresetModelOptions, ...selectedModelOptions]
          .map(option => [String(option.value), option] as const)
      ).values()
    );
    const modelFetchHint = isFetchingRemoteModels
      ? t('providerSelection.fetchingModels')
      : remoteModelsError
        ? remoteModelsError
        : remoteModelOptions.length > 0
          ? null
          : fetchedOrPresetModelOptions.length > 0
            ? t('providerSelection.usingPresetModels')
            : hasAttemptedRemoteFetch
              ? t('providerSelection.noPresetModels')
              : null;
    const selectedModelValues = selectedModelDrafts.map(draft => draft.modelName);
    const apiKeyVisibilityLabel = showApiKey ? tComponents('hide') : tComponents('show');
    const apiKeySuffix = (
      <IconButton
        type="button"
        className="openbitfun-model-settings__input-visibility-toggle"
        onClick={() => setShowApiKey(prev => !prev)}
        aria-label={apiKeyVisibilityLabel}
        title={apiKeyVisibilityLabel}
        icon={showApiKey ? <EyeOff size={14} /> : <Icon name="eye" size="sm" />}
      />
    );

    const formatReasoningSummary = (
      draft: SelectedModelDraft,
      generatedProjection?: ReasoningCatalogProjection,
    ) => {
      const presetCount = draft.reasoning.presets?.length ?? 0;
      const catalogSource = draft.reasoning.catalog?.source ?? 'auto';
      const catalogLabel = catalogSource === 'models_dev'
        ? t('reasoningPresets.catalogSummary.modelsDev')
        : catalogSource === 'disabled'
          ? t('reasoningPresets.catalogSummary.disabled')
          : t('reasoningPresets.catalogSummary.auto');
      const selected = draft.reasoning.presets?.find(
        preset => preset.id === draft.reasoning.default_preset,
      ) ?? generatedProjection?.presets?.find(
        preset => preset.id === draft.reasoning.default_preset,
      );
      const defaultLabel = draft.reasoning.default_preset
        ? selected?.label?.trim() || selected?.id || draft.reasoning.default_preset
        : t('reasoningPresets.autoShort');
      return presetCount > 0
        ? t('reasoningPresets.summaryWithCustom', {
            source: catalogLabel,
            default: defaultLabel,
            count: presetCount,
          })
        : t('reasoningPresets.summary', {
            source: catalogLabel,
            default: defaultLabel,
          });
    };

    const renderSelectedModelRows = () => {
      if (selectedModelDrafts.length === 0) {
        return (
          <div
            className="openbitfun-model-settings__selected-models-empty"
            data-testid="settings-model-selected-list-empty"
            data-selected-count="0"
          >
            {t('providerSelection.noModelsSelected')}
          </div>
        );
      }

      return (
        <div
          className="openbitfun-model-settings__selected-models-list"
          data-testid="settings-model-selected-list"
          data-selected-count={selectedModelDrafts.length}
        >
          {selectedModelDrafts.map(draft => {
            const isExpanded = expandedModelCards.has(draft.key) || selectedModelDrafts.length === 1;
            const hasUnsavedChanges = modelDraftHasUnsavedChanges(draft, aiModels);
            const categoryLabel = categoryCompactLabels[draft.category] ?? draft.category;
            const canToggleExpand = selectedModelDrafts.length > 1;
            const modelDisplayName = draft.modelName;
            const reasoningProjection = resolveDraftReasoningProjection(draft);
            const catalogHasModel = remoteModelOptions.some(model => model.id === draft.modelName.trim());
            const canEditManualRoute = remoteModelOptions.length > 0 && !catalogHasModel && !isFetchingRemoteModels;
            const savedModelId = draft.configId || editingConfig.id;
            const savedModel = aiModels.find(model => model.id === savedModelId);
            const modelRoute = resolveOpenCodeModelRoute(routeConfig, draft.modelName, remoteModelOptions)
              || (!catalogHasModel && !canEditManualRoute ? savedOpenCodeApiKeyRoute(
                { ...routeConfig, id: savedModelId },
                draft.modelName,
                savedModel,
              ) : undefined);
            const manualFormat = draft.manualRequestFormat || editingConfig.provider || 'openai';

            return (
              <div
                key={draft.key}
                className="openbitfun-model-settings__selected-model-row"
                data-testid="settings-model-selected-row"
                data-model-id={draft.modelName}
                data-model-name={draft.modelName}
                data-selected="true"
                data-expanded={isExpanded ? 'true' : 'false'}
                data-unsaved={hasUnsavedChanges ? 'true' : 'false'}
              >
                <div
                  className={[
                    'openbitfun-model-settings__selected-model-head',
                    canToggleExpand && 'openbitfun-model-settings__selected-model-head--toggleable',
                  ].filter(Boolean).join(' ')}
                  onClick={canToggleExpand ? () => toggleSelectedModelCardExpanded(draft.key) : undefined}
                  onKeyDown={canToggleExpand ? (e) => onSelectedModelHeadKeyDown(e, draft.key) : undefined}
                  role={canToggleExpand ? 'button' : undefined}
                  tabIndex={canToggleExpand ? 0 : undefined}
                  aria-expanded={canToggleExpand ? isExpanded : undefined}
                  aria-label={
                    canToggleExpand
                      ? t(
                          isExpanded
                            ? 'providerSelection.collapseModelSettings'
                            : 'providerSelection.expandModelSettings',
                          { name: modelDisplayName }
                        )
                      : undefined
                  }
                >
                  <div className="openbitfun-model-settings__selected-model-head-title">
                    <div className="openbitfun-model-settings__selected-model-head-top">
                      {canToggleExpand && (
                        <div className="openbitfun-model-settings__selected-model-toggle">
                          {isExpanded ? <Icon name="chevron-down" size="sm" /> : <Icon name="chevron-right" size="sm" />}
                        </div>
                      )}
                      <div className="openbitfun-model-settings__selected-model-name">{modelDisplayName}</div>
                      {hasUnsavedChanges && (
                        <StatusPill
                          tone="warning"
                          className="openbitfun-model-settings__selected-model-unsaved"
                          title={t('providerSelection.unsavedModelHint')}
                          aria-label={t('providerSelection.unsavedModelHint')}
                          data-testid="settings-model-unsaved-badge"
                        >
                          {t('providerSelection.unsavedModel')}
                        </StatusPill>
                      )}
                    </div>
                    {!editingConfig.id && (
                      <Tooltip content={t('providerSelection.removeModel')}>
                        <IconButton
                          aria-label={t('providerSelection.removeModel')}
                          data-testid="settings-model-selected-remove-btn"
                          data-model-id={draft.modelName}
                          data-model-name={draft.modelName}
                          size="sm"
                          className="openbitfun-model-settings__selected-model-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSelectedModelDraft(draft.modelName);
                          }}
                          icon={<Icon name="xmark" size="sm" />}
                        />
                      </Tooltip>
                    )}
                  </div>
                  {!isExpanded && (
                    <div className="openbitfun-model-settings__selected-model-head-bottom">
                      <span className="openbitfun-model-settings__selected-model-summary">
                        {categoryLabel}
                        {' · '}
                        {formatTokenCountShort(draft.contextWindow)} ctx
                        {' · '}
                        {formatReasoningSummary(draft, reasoningProjection)}
                      </span>
                    </div>
                  )}
                </div>
                {isExpanded && (
                  <div className={`openbitfun-model-settings__selected-model-grid${automaticOpenCodeRouting ? ' openbitfun-model-settings__selected-model-grid--with-format' : ''}`}>
                    {automaticOpenCodeRouting && (
                      <>
                        <Field className="openbitfun-model-settings__selected-model-field" label={t('form.provider')} controlWidth="fill">
                          {modelRoute ? (
                            <span>{requestFormatLabelMap[modelRoute.format] || modelRoute.format}</span>
                          ) : canEditManualRoute ? (
                            <Select
                              value={manualFormat}
                              onValueChange={value => updateModelDraft(draft.modelName, { manualRequestFormat: String(value) })}
                              options={requestFormatOptions.filter(option => ['openai', 'responses', 'anthropic'].includes(String(option.value)))}
                              size="sm"
                            />
                          ) : (
                            <span>{t(catalogHasModel ? 'providerSelection.modelRoutingUnavailable' : 'providerSelection.modelRoutingPending')}</span>
                          )}
                        </Field>
                      </>
                    )}
                    <Field className="openbitfun-model-settings__selected-model-field" label={t('category.label')} controlWidth="fill">
                      <Combobox
                        value={draft.category}
                        onValueChange={(value) => updateModelDraft(draft.modelName, { category: value as ModelCategory })}
                        options={categoryOptions}
                        size="sm"
                        className="openbitfun-model-settings__selected-model-category-select"
                      />
                    </Field>
                    <Field
                      className="openbitfun-model-settings__selected-model-field"
                      label={t('form.contextWindow')}
                      controlWidth="fill"
                      labelAction={(
                        <Tooltip content={t('form.contextWindowHint')} placement="top">
                          <IconButton
                            size="xs"
                            variant="quiet"
                            aria-label={t('form.contextWindowHint')}
                            icon={<Icon name="info" size="sm" />}
                          />
                        </Tooltip>
                      )}
                    >
                      <NumberInput
                        className="openbitfun-model-settings__selected-model-context-input"
                        value={draft.contextWindow}
                        formatValue={(value) => i18nService.formatNumber(value, { useGrouping: true, maximumFractionDigits: 0 })}
                        onValueChange={(value) => updateModelDraft(draft.modelName, { contextWindow: value })}
                        min={32000}
                        max={2000000}
                        step={1000}
                        size="sm"
                        disableWheel
                      />
                    </Field>
                    {automaticOpenCodeRouting && (modelRoute || canEditManualRoute) && (
                      <Field className="openbitfun-model-settings__selected-model-field openbitfun-model-settings__selected-model-route" label={t('form.resolvedUrlLabel')} controlWidth="fill">
                        <span className="openbitfun-model-settings__resolved-url-value">
                          {modelRoute?.request_url || resolveRequestUrl(editingConfig.base_url || '', manualFormat, draft.modelName)}
                        </span>
                      </Field>
                    )}
                    {draft.contextWindow > LONG_CONTEXT_WARNING_THRESHOLD_TOKENS && (
                      <div className="openbitfun-model-settings__warning-inline openbitfun-model-settings__context-window-warning">
                        <AlertTriangle size={14} />
                        <span>{t('form.contextWindowLongWarning')}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="openbitfun-model-settings__reasoning-summary"
                      onClick={() => {
                        reasoningPanelInitialRef.current = {
                          key: draft.key,
                          reasoning: cloneReasoningConfig(draft.reasoning),
                          reasoningProjectionCatalog: draft.reasoningProjectionCatalog,
                          reasoningProjectionSnapshot: draft.reasoningProjectionSnapshot,
                        };
                        setReasoningPanelDraftKey(draft.key);
                      }}
                      data-testid="settings-model-reasoning-edit"
                    >
                      <span className="openbitfun-model-settings__reasoning-summary-icon">
                        <Icon name="thinking" size="md" aria-hidden="true" />
                      </span>
                      <span className="openbitfun-model-settings__reasoning-summary-content">
                        <strong>{t('reasoningPresets.configTitle')}</strong>
                        <span>{formatReasoningSummary(draft, reasoningProjection)}</span>
                      </span>
                      <span className="openbitfun-model-settings__reasoning-summary-action">
                        {t('actions.edit')}
                      </span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    };

    const authType = editingConfig.auth?.type || 'api_key';
    const authIsSubscription = authType === 'subscription';
    const selectedSubscriptionProvider: SubscriptionProvider | undefined =
      editingConfig.auth?.type === 'subscription' ? editingConfig.auth.provider : undefined;
    const legacyOpenCode = selectedSubscriptionProvider === 'opencode' && !zenOAuth;
    const authSelectValue = legacyOpenCode ? 'subscription:opencode:go' : authIsSubscription ? `subscription:${selectedSubscriptionProvider || 'codex'}` : 'api_key';
    const authOptions: ComboboxOption[] = [
      { value: 'api_key', label: t('subscriptionAuth.options.apiKey') },
      { value: 'subscription:codex', label: t('subscriptionAuth.options.codex') },
      { value: 'subscription:antigravity', label: t('subscriptionAuth.options.antigravity') },
      { value: 'subscription:grok', label: t('subscriptionAuth.options.grok') },
      { value: 'subscription:hermes', label: t('subscriptionAuth.options.hermes') },
      { value: 'subscription:opencode', label: t('subscriptionAuth.options.opencode') },
    ];
    if (legacyOpenCode) authOptions.push({ value: 'subscription:opencode:go', label: t('subscriptionAuth.openCodeRemoved') });
    const matchedSubscription = selectedSubscriptionProvider
      ? subscriptionAccounts.find((account) => account.provider === selectedSubscriptionProvider)
      : undefined;

    const renderAuthRow = () => (
      <ConfigPageRow label={t('subscriptionAuth.label')} align={authIsSubscription ? 'start' : 'center'} wide>
        <div className="openbitfun-model-settings__control-stack">
          <Select
            value={authSelectValue}
            onValueChange={(value) => {
              const next = String(value);
              if (next === 'api_key') {
                setEditingConfig(prev => prev ? ({
                  ...prev,
                  api_key: legacyOpenCode ? '' : prev.api_key,
                  auth: { type: 'api_key' },
                }) : prev);
                return;
              }
              const provider = next.split(':')[1] as SubscriptionProvider;
              if (next === 'subscription:opencode:go') return;
              resetRemoteModelDiscovery();
              const account = subscriptionAccounts.find(item => item.provider === provider);
              setEditingConfig(prev => prev ? ({
                ...prev,
                provider: account?.suggested_format || prev.provider,
                base_url: provider === 'opencode' ? 'https://opencode.ai/zen/v1' : account?.suggested_base_url || prev.base_url,
                request_url: '',
                auth: { type: 'subscription', provider },
              }) : prev);
            }}
            options={authOptions}
            size="sm"
          />
          {authIsSubscription && (
            <small className={matchedSubscription?.connected
              ? 'resolved-url__hint openbitfun-model-settings__cli-auth-hint'
              : 'resolved-url__hint openbitfun-model-settings__cli-auth-hint openbitfun-model-settings__json-status--error'}
            >
              {legacyOpenCode ? t('subscriptionAuth.openCodeRemoved') : matchedSubscription?.connected
                ? t('subscriptionAuth.detected', {
                    label: matchedSubscription.display_label,
                    account: matchedSubscription.account || t('subscriptionAuth.unknownAccount'),
                  })
                : t('subscriptionAuth.notConnected', {
                    kind: selectedSubscriptionProvider || 'subscription',
                  })}
            </small>
          )}
        </div>
      </ConfigPageRow>
    );

    const renderApiKeyRow = (label: string) => (
      <ConfigPageRow label={label} required align="center" wide>
        <Input
          data-testid="settings-model-api-key-input"
          hideNativePasswordReveal
          invalid={showModelValidation && missingModelFields.apiKey}
          required
          type={showApiKey ? 'text' : 'password'}
          value={editingConfig.api_key || ''}
          onChange={(e) => {
            resetRemoteModelDiscovery();
            setEditingConfig(prev => ({ ...prev, api_key: e.target.value }));
          }}
          placeholder={t('form.apiKeyPlaceholder')}
          trailing={apiKeySuffix}
          size="sm"
        />
      </ConfigPageRow>
    );

    return (
      <>
        <div className="openbitfun-model-settings__form openbitfun-model-settings__form--modal" data-openbitfun-component="model-settings" data-openbitfun-part="form">
          <div className="openbitfun-model-settings__form-content" data-openbitfun-component="model-settings" data-openbitfun-part="formBody">
            <ConfigPageSection
              title={isProviderScopedEditing ? t('editProviderSubtitle') : t('editSubtitle')}
              className="openbitfun-model-settings__edit-section"
              fieldSurface="default"
            >
            {isFromTemplate ? (
              <>
                <ConfigPageRow label={t('form.configName')} required align="center" wide>
                  <Input
                    data-testid="settings-model-provider-name-input"
                    invalid={showModelValidation && missingModelFields.name}
                    required
                    value={editingConfig.name || ''}
                    onChange={(e) => setEditingConfig(prev => ({ ...prev, name: e.target.value }))}
                    placeholder={t('form.configNamePlaceholder')}
                    size="sm"
                  />
                </ConfigPageRow>
                {renderAuthRow()}
                {!authIsSubscription && renderApiKeyRow(t('form.apiKey'))}
                {!authIsSubscription && (
                  <>
                    <ConfigPageRow label={t('form.baseUrl')} required align="center" wide>
                      <div className="openbitfun-model-settings__control-stack">
                        {currentTemplate?.baseUrlOptions && currentTemplate.baseUrlOptions.length > 0 && (
                          <Combobox
                            invalid={showModelValidation && missingModelFields.baseUrl}
                            value={currentTemplate.baseUrlOptions.some(opt => opt.url === editingConfig.base_url) ? editingConfig.base_url : ''}
                            onValueChange={(value) => {
                              const selectedOption = currentTemplate.baseUrlOptions!.find(opt => opt.url === value);
                              const newProvider = selectedOption?.format || editingConfig.provider || 'openai';
                              resetRemoteModelDiscovery();
                              setEditingConfig(prev => ({
                                ...prev,
                                base_url: value as string,
                                request_url: resolveRequestUrl(value as string, newProvider, editingConfig.model_name || ''),
                                provider: newProvider
                              }));
                            }}
                            placeholder={t('form.baseUrl')}
                            options={currentTemplate.baseUrlOptions.map(opt => ({ label: opt.note || opt.url, value: opt.url, description: `${opt.format.toUpperCase()} · ${opt.url}` }))}
                            size="sm"
                          />
                        )}
                        <Input
                          data-testid="settings-model-base-url-input"
                          invalid={showModelValidation && missingModelFields.baseUrl}
                          required
                          type="url"
                          value={editingConfig.base_url || ''}
                          onChange={(e) => {
                            resetRemoteModelDiscovery();
                            setEditingConfig(prev => ({
                              ...prev,
                              base_url: e.target.value,
                              request_url: resolveRequestUrl(e.target.value, prev?.provider || 'openai', prev?.model_name || '')
                            }));
                          }}
                          onFocus={(e) => e.target.select()}
                          placeholder={currentTemplate?.baseUrl}
                          size="sm"
                        />
                        {editingConfig.base_url && !automaticOpenCodeRouting && (
                          <div className="openbitfun-model-settings__resolved-url">
                            <span className="openbitfun-model-settings__resolved-url-label">{t('form.resolvedUrlLabel')}</span>
                            <span className="openbitfun-model-settings__resolved-url-value">
                              {previewRequestUrl(editingConfig.base_url, editingConfig.provider || 'openai', selectedModelDrafts.length === 1 ? selectedModelDrafts[0].modelName : undefined)}
                            </span>
                          </div>
                        )}
                      </div>
                    </ConfigPageRow>
                    {!automaticOpenCodeRouting && (
                    <ConfigPageRow label={t('form.provider')} align="center" wide>
                      <Select
                        data-testid="settings-model-request-format-select"
                        value={editingConfig.provider || 'openai'}
                        onValueChange={(value) => {
                          const provider = value as string;
                          resetRemoteModelDiscovery();
                          setEditingConfig(prev => ({
                            ...prev,
                            provider,
                            request_url: resolveRequestUrl(prev?.base_url || '', provider, prev?.model_name || '')
                          }));
                        }}
                        placeholder={t('form.providerPlaceholder')}
                        options={requestFormatOptions}
                        size="sm"
                      />
                    </ConfigPageRow>
                    )}
                  </>
                )}
                <ConfigPageRow label={t('form.modelSelection')} required multiline className="openbitfun-model-settings__model-selection-row">
                  <div className="openbitfun-model-settings__control-stack">
                    <div className="openbitfun-model-settings__model-picker-row">
                      <MultiSelect
                        aria-required="true"
                        data-testid="settings-model-select"
                        invalid={showModelValidation && missingModelFields.model}
                        value={selectedModelValues}
                        onValueChange={(value) => {
                          const nextModelNames = value.map(item => String(item));
                          syncSelectedModelDrafts(nextModelNames, editingConfig);
                        }}
                        placeholder={t('providerSelection.selectModel')}
                        options={availableModelOptions}
                        loading={isFetchingRemoteModels}
                        onCreateValue={value => value}
                        size="sm"
                        onOpenChange={handleModelSelectionOpenChange}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="settings-model-refresh-btn"
                        disabled={isFetchingRemoteModels}
                        onClick={() => void fetchRemoteModels(editingConfig, true)}
                      >
                        {t('providerSelection.refreshModels')}
                      </Button>
                    </div>
                    <div className="openbitfun-model-settings__manual-model-entry">
                      <Input
                        data-testid="settings-model-manual-name-input"
                        value={manualModelInput}
                        onChange={(e) => setManualModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addManualModelDraft();
                          }
                        }}
                        placeholder={t('providerSelection.inputModelName')}
                        size="sm"
                      />
                      <Button className="openbitfun-model-settings__manual-model-add" data-testid="settings-model-add-custom-btn" variant="outline" size="sm" onClick={addManualModelDraft}>
                        {t('providerSelection.addCustomModel')}
                      </Button>
                    </div>
                    {modelFetchHint && (
                      <small className={`resolved-url__hint openbitfun-model-settings__model-fetch-hint ${remoteModelsError ? 'openbitfun-model-settings__json-status--error' : ''}`}>
                        {modelFetchHint}
                      </small>
                    )}
                    {renderSelectedModelRows()}
                  </div>
                </ConfigPageRow>
              </>
            ) : (
              <>
                {isProviderScopedEditing && (
                  <>
                    <ConfigPageRow label={t('form.configName')} required align="center" wide>
                      <Input
                        data-testid="settings-model-provider-name-input"
                        invalid={showModelValidation && missingModelFields.name}
                        required
                        value={editingConfig.name || ''}
                        onChange={(e) => setEditingConfig(prev => ({ ...prev, name: e.target.value }))}
                        placeholder={t('form.configNamePlaceholder')}
                        size="sm"
                      />
                    </ConfigPageRow>
                    {renderAuthRow()}
                    {!authIsSubscription && renderApiKeyRow(t('form.apiKey'))}
                    {!authIsSubscription && (
                      <>
                        <ConfigPageRow label={t('form.baseUrl')} required align="center" wide>
                          <div className="openbitfun-model-settings__control-stack">
                            <Input
                              data-testid="settings-model-base-url-input"
                              invalid={showModelValidation && missingModelFields.baseUrl}
                              required
                              type="url"
                              value={editingConfig.base_url || ''}
                              onChange={(e) => {
                                resetRemoteModelDiscovery();
                                setEditingConfig(prev => ({
                                  ...prev,
                                  base_url: e.target.value,
                                  request_url: resolveRequestUrl(e.target.value, prev?.provider || 'openai', prev?.model_name || '')
                                }));
                              }}
                              onFocus={(e) => e.target.select()}
                              placeholder={'https://open.bigmodel.cn/api/paas/v4/chat/completions'}
                              size="sm"
                            />
                            {editingConfig.base_url && !automaticOpenCodeRouting && (
                              <div className="openbitfun-model-settings__resolved-url">
                                <span className="openbitfun-model-settings__resolved-url-label">{t('form.resolvedUrlLabel')}</span>
                                <span className="openbitfun-model-settings__resolved-url-value">
                                  {previewRequestUrl(editingConfig.base_url, editingConfig.provider || 'openai', selectedModelDrafts.length === 1 ? selectedModelDrafts[0].modelName : undefined)}
                                </span>
                              </div>
                            )}
                          </div>
                        </ConfigPageRow>
                        {!automaticOpenCodeRouting && (
                        <ConfigPageRow label={t('form.provider')} align="center" wide>
                          <Select data-testid="settings-model-request-format-select" value={editingConfig.provider || 'openai'} onValueChange={(value) => {
                            const provider = value as string;
                            resetRemoteModelDiscovery();
                            setEditingConfig(prev => ({
                              ...prev,
                              provider,
                              request_url: resolveRequestUrl(prev?.base_url || '', provider, prev?.model_name || ''),
                            }));
                          }} placeholder={t('form.providerPlaceholder')} options={requestFormatOptions} size="sm" />
                        </ConfigPageRow>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {!isFromTemplate && (
              <>
                <ConfigPageRow label={t('form.modelSelection')} required multiline className="openbitfun-model-settings__model-selection-row">
                  <div className="openbitfun-model-settings__control-stack">
                    <div className="openbitfun-model-settings__model-picker-row">
                      {editingConfig.id ? (
                        <Combobox
                          aria-required="true"
                          data-testid="settings-model-select"
                          invalid={showModelValidation && missingModelFields.model}
                          value={selectedModelValues[0] || ''}
                          onValueChange={(value) => {
                            syncSelectedModelDrafts([String(value)], editingConfig, true);
                          }}
                          placeholder="glm-5.2"
                          options={availableModelOptions}
                          loading={isFetchingRemoteModels}
                          onCreateValue={value => value}
                          size="sm"
                          onOpenChange={handleModelSelectionOpenChange}
                        />
                      ) : (
                        <MultiSelect
                          aria-required="true"
                          data-testid="settings-model-select"
                          invalid={showModelValidation && missingModelFields.model}
                          value={selectedModelValues}
                          onValueChange={(value) => {
                            syncSelectedModelDrafts(value.map(item => String(item)), editingConfig, false);
                          }}
                          placeholder="glm-5.2"
                          options={availableModelOptions}
                          loading={isFetchingRemoteModels}
                          onCreateValue={value => value}
                          size="sm"
                          onOpenChange={handleModelSelectionOpenChange}
                        />
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="settings-model-refresh-btn"
                        disabled={isFetchingRemoteModels}
                        onClick={() => void fetchRemoteModels(editingConfig, true)}
                      >
                        {t('providerSelection.refreshModels')}
                      </Button>
                    </div>
                    <div className="openbitfun-model-settings__manual-model-entry">
                      <Input
                        data-testid="settings-model-manual-name-input"
                        value={manualModelInput}
                        onChange={(e) => setManualModelInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addManualModelDraft();
                          }
                        }}
                        placeholder={t('providerSelection.inputModelName')}
                        size="sm"
                      />
                      <Button className="openbitfun-model-settings__manual-model-add" data-testid="settings-model-add-custom-btn" variant="outline" size="sm" onClick={addManualModelDraft}>
                        {t('providerSelection.addCustomModel')}
                      </Button>
                    </div>
                    {modelFetchHint && (
                      <small className={`resolved-url__hint openbitfun-model-settings__model-fetch-hint ${remoteModelsError ? 'openbitfun-model-settings__json-status--error' : ''}`}>
                        {modelFetchHint}
                      </small>
                    )}
                    {renderSelectedModelRows()}
                  </div>
                </ConfigPageRow>
              </>
            )}
          </ConfigPageSection>

          {!authIsSubscription && (
            <ConfigPageSection
              title={t('advancedSettings.title')}
              className="openbitfun-model-settings__edit-section"
              fieldSurface="default"
            >
              <ConfigPageRow className="openbitfun-model-settings__toggle-row" label={t('advancedSettings.title')} align="center">
                <Switch checked={showAdvancedSettings} onChange={(e) => setShowAdvancedSettings(e.target.checked)} />
              </ConfigPageRow>

              {showAdvancedSettings && (
                <>
                  {(editingConfig.provider === 'openai' || editingConfig.provider === 'anthropic') && (
                    <ConfigPageRow
                      label={t('advancedSettings.inlineThinkInText.label')}
                      description={t('advancedSettings.inlineThinkInText.hint')}
                      align="center"
                      className="openbitfun-model-settings__toggle-row"
                    >
                      <Switch
                        checked={editingConfig.inline_think_in_text ?? true}
                        onChange={(e) => setEditingConfig(prev => ({ ...prev, inline_think_in_text: e.target.checked }))}
                      />
                    </ConfigPageRow>
                  )}
                  <ConfigPageRow
                    label={t('advancedSettings.skipSslVerify.label')}
                    description={editingConfig.skip_ssl_verify ? (
                      <span className="openbitfun-model-settings__warning-inline">
                        <AlertTriangle size={14} />
                        <span>{t('advancedSettings.skipSslVerify.warning')}</span>
                      </span>
                    ) : undefined}
                    align="center"
                    className="openbitfun-model-settings__toggle-row"
                  >
                    <Switch
                      checked={editingConfig.skip_ssl_verify || false}
                      onChange={(e) => setEditingConfig(prev => ({ ...prev, skip_ssl_verify: e.target.checked }))}
                    />
                  </ConfigPageRow>
                  <ConfigPageRow
                    label={(
                      <span className="openbitfun-model-settings__inline-header">
                        <span className="openbitfun-model-settings__inline-header-main">
                          <span>{t('advancedSettings.customHeaders.label')}</span>
                          <Tooltip
                            content={(
                              <span className="openbitfun-model-settings__header-tooltip">
                                <span>{t('advancedSettings.customHeaders.hint')}</span>
                                <span>
                                  {(editingConfig.custom_headers_mode || 'merge') === 'replace'
                                    ? t('advancedSettings.customHeaders.modeReplaceHint')
                                    : t('advancedSettings.customHeaders.modeMergeHint')}
                                </span>
                              </span>
                            )}
                            placement="top"
                          >
                            <span
                              className="openbitfun-model-settings__inline-header-info"
                              role="button"
                              tabIndex={0}
                              aria-label={t('advancedSettings.customHeaders.hint')}
                            >
                              <Icon name="info" size="sm" />
                            </span>
                          </Tooltip>
                        </span>
                        <span className="openbitfun-model-settings__inline-header-actions">
                          <Tooltip content={t('advancedSettings.customHeaders.modeMergeHint')} placement="top">
                            <Button
                              type="button"
                              variant={(editingConfig.custom_headers_mode || 'merge') === 'merge' ? 'fill' : 'outline'}
                              size="sm"
                              className="openbitfun-model-settings__mode-button"
                              onClick={() => setEditingConfig(prev => ({ ...prev, custom_headers_mode: 'merge' }))}
                            >
                              {t('advancedSettings.customHeaders.modeMerge')}
                            </Button>
                          </Tooltip>
                          <Tooltip content={t('advancedSettings.customHeaders.modeReplaceHint')} placement="top">
                            <Button
                              type="button"
                              variant={editingConfig.custom_headers_mode === 'replace' ? 'fill' : 'outline'}
                              size="sm"
                              className="openbitfun-model-settings__mode-button"
                              onClick={() => setEditingConfig(prev => ({ ...prev, custom_headers_mode: 'replace' }))}
                            >
                              {t('advancedSettings.customHeaders.modeReplace')}
                            </Button>
                          </Tooltip>
                        </span>
                      </span>
                    )}
                    multiline
                    className="openbitfun-model-settings__custom-headers-row"
                  >
                    <div className="openbitfun-model-settings__row-control--stack">
                      <div className="openbitfun-model-settings__custom-headers">
                        {Object.entries(editingConfig.custom_headers || {}).map(([key, value], index) => (
                          <div key={index} className="openbitfun-model-settings__header-row">
                            <Input
                              value={key}
                              onChange={(e) => { const nh = { ...editingConfig.custom_headers }; const ov = nh[key]; delete nh[key]; if (e.target.value) nh[e.target.value] = ov; setEditingConfig(prev => ({ ...prev, custom_headers: nh })); }}
                              placeholder={t('advancedSettings.customHeaders.keyPlaceholder')}
                              className="openbitfun-model-settings__header-key"
                              size="sm"
                            />
                            <Input
                              value={value}
                              onChange={(e) => { const nh = { ...editingConfig.custom_headers }; nh[key] = e.target.value; setEditingConfig(prev => ({ ...prev, custom_headers: nh })); }}
                              placeholder={t('advancedSettings.customHeaders.valuePlaceholder')}
                              className="openbitfun-model-settings__header-value"
                              size="sm"
                            />
                            <Tooltip content={t('actions.delete')}>
                              <IconButton
                                aria-label={t('actions.delete')}
                                size="sm"
                                onClick={() => { const nh = { ...editingConfig.custom_headers }; delete nh[key]; setEditingConfig(prev => ({ ...prev, custom_headers: Object.keys(nh).length > 0 ? nh : undefined })); }}
                                icon={<Icon name="xmark" size="sm" />}
                              />
                            </Tooltip>
                          </div>
                        ))}
                        <Button type="button" variant="outline" size="sm" onClick={() => setEditingConfig(prev => ({ ...prev, custom_headers: { ...prev?.custom_headers, '': '' } }))} className="openbitfun-model-settings__add-header-btn" leadingIcon={<Icon name="plus" size="sm" />}>{t('advancedSettings.customHeaders.addHeader')}</Button>
                      </div>
                    </div>
                  </ConfigPageRow>
                  <ConfigPageRow
                    label={(
                      <span className="openbitfun-model-settings__inline-header">
                        <span className="openbitfun-model-settings__inline-header-main">
                          <span>{t('advancedSettings.customRequestBody.label')}</span>
                          <Tooltip
                            content={(
                              <span className="openbitfun-model-settings__header-tooltip">
                                <span>{t('advancedSettings.customRequestBody.hint')}</span>
                                <span>{getCustomRequestBodyModeHint(editingConfig.provider, editingConfig.custom_request_body_mode)}</span>
                              </span>
                            )}
                            placement="top"
                          >
                            <span
                              className="openbitfun-model-settings__inline-header-info"
                              role="button"
                              tabIndex={0}
                              aria-label={t('advancedSettings.customRequestBody.hint')}
                            >
                              <Icon name="info" size="sm" />
                            </span>
                          </Tooltip>
                        </span>
                        <span className="openbitfun-model-settings__inline-header-actions">
                          <Tooltip content={t('advancedSettings.customRequestBody.modeMergeHint')} placement="top">
                            <Button
                              type="button"
                              variant={(editingConfig.custom_request_body_mode || 'merge') === 'merge' ? 'fill' : 'outline'}
                              size="sm"
                              className="openbitfun-model-settings__mode-button"
                              onClick={() => setEditingConfig(prev => ({ ...prev, custom_request_body_mode: 'merge' }))}
                            >
                              {t('advancedSettings.customRequestBody.modeMerge')}
                            </Button>
                          </Tooltip>
                          <Tooltip content={getCustomRequestBodyTrimHint(editingConfig.provider)} placement="top">
                            <Button
                              type="button"
                              variant={editingConfig.custom_request_body_mode === 'trim' ? 'fill' : 'outline'}
                              size="sm"
                              className="openbitfun-model-settings__mode-button"
                              onClick={() => setEditingConfig(prev => ({ ...prev, custom_request_body_mode: 'trim' }))}
                            >
                              {t('advancedSettings.customRequestBody.modeTrim')}
                            </Button>
                          </Tooltip>
                        </span>
                      </span>
                    )}
                    multiline
                    className="openbitfun-model-settings__custom-request-body-row"
                  >
                    <div className="openbitfun-model-settings__row-control--stack">
                      <Textarea value={editingConfig.custom_request_body || ''} onChange={(e) => setEditingConfig(prev => ({ ...prev, custom_request_body: e.target.value }))} placeholder={t('advancedSettings.customRequestBody.placeholder')} rows={8} style={{ fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-code-md-font-size)' }} />
                      {editingConfig.custom_request_body && editingConfig.custom_request_body.trim() !== '' && (() => {
                        try { JSON.parse(editingConfig.custom_request_body); return <small className="openbitfun-model-settings__json-status openbitfun-model-settings__json-status--success">{t('advancedSettings.customRequestBody.validJson')}</small>; }
                        catch { return <small className="openbitfun-model-settings__json-status openbitfun-model-settings__json-status--error">{t('advancedSettings.customRequestBody.invalidJson')}</small>; }
                      })()}
                    </div>
                  </ConfigPageRow>
                </>
              )}
            </ConfigPageSection>
          )}
          </div>

        </div>
      </>
    );
  };

  const renderModelCollectionItem = (config: AIModelConfigType) => {
    const isExpanded = expandedIds.has(config.id || '');
    const testResult = config.id ? testResults[config.id] : null;
    const isTesting = config.id ? !!testingConfigs[config.id] : false;
    const providerDisplayName = getProviderDisplayName(config);
    const modelDisplayName = getModelDisplayName(config);
    const modelLabel = config.model_name || modelDisplayName;
    const testStatusLabel = isTesting
      ? t('messages.testing')
      : testResult?.message.split('\n', 1)[0];

    const badge = (
      <>
        <span
          className="openbitfun-model-settings__meta-tag"
          data-openbitfun-component="model-settings"
          data-openbitfun-part="modelMeta"
        >
          {t(`category.${config.category}`)}
        </span>
        {(isTesting || testResult) && (
          <span
            data-testid="settings-model-test-status"
            data-config-id={config.id || ''}
            data-model-id={config.model_name}
            data-model-name={config.model_name}
            data-status={isTesting ? 'testing' : testResult?.success ? 'success' : 'error'}
            className={`openbitfun-model-settings__status-dot ${isTesting ? 'is-testing' : testResult?.success ? 'is-success' : 'is-error'}`}
            role="status"
            aria-live="polite"
            aria-label={testStatusLabel}
            title={isTesting ? testStatusLabel : testResult?.message}
          />
        )}
      </>
    );

    const details = (
      <div
        className="openbitfun-model-settings__details"
        data-openbitfun-component="model-settings"
        data-openbitfun-part="modelDetails"
      >
        <div className="openbitfun-model-settings__details-section">
          <div className="openbitfun-model-settings__details-section-title">
            {t('details.basicInfo')}
          </div>
          <div className="openbitfun-model-settings__details-grid">
            <div className="openbitfun-model-settings__details-item">
              <span className="openbitfun-model-settings__details-label">{t('form.configName')}</span>
              <span className="openbitfun-model-settings__details-value">{providerDisplayName}</span>
            </div>
            <div className="openbitfun-model-settings__details-item">
              <span className="openbitfun-model-settings__details-label">{t('details.modelName')}</span>
              <span className="openbitfun-model-settings__details-value">{config.model_name}</span>
            </div>
            <div className="openbitfun-model-settings__details-item">
              <span className="openbitfun-model-settings__details-label">{t('details.contextWindow')}</span>
              <span className="openbitfun-model-settings__details-value">{config.context_window != null ? i18nService.formatNumber(config.context_window) : '128,000'}</span>
            </div>
            <div className="openbitfun-model-settings__details-item openbitfun-model-settings__details-item--wide">
              <span className="openbitfun-model-settings__details-label">{t('details.apiUrl')}</span>
              <span className="openbitfun-model-settings__details-value">{config.base_url}</span>
            </div>
            {config.capabilities && config.capabilities.length > 0 && (
              <div className="openbitfun-model-settings__details-item openbitfun-model-settings__details-item--wide">
                <span className="openbitfun-model-settings__details-label">{t('details.capabilities')}</span>
                <div className="openbitfun-model-settings__details-tags">
                  {config.capabilities.map(capability => (
                    <span key={capability} className="openbitfun-model-settings__details-tag">
                      {t(`capabilities.${capability}`, { defaultValue: capability })}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        {testResult && (
          <div className="openbitfun-model-settings__details-section">
            <div className="openbitfun-model-settings__details-section-title">
              {t('actions.test')}
            </div>
            <div className={`openbitfun-model-settings__test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.message}
            </div>
          </div>
        )}
      </div>
    );

    const control = (
      <>
        <span className="openbitfun-model-settings__model-enable">
          <Switch
            checked={config.enabled}
            onChange={(e) => {
              void handleToggleEnabled(config, e.target.checked);
            }}
          />
        </span>
        <div
          className="openbitfun-model-settings__model-actions"
          data-openbitfun-component="model-settings"
          data-openbitfun-part="modelActions"
        >
          <Tooltip content={connectionTestSupported
            ? t('actions.test')
            : t('messages.testUnsupportedOnHost')}>
            <IconButton
              aria-label={t('actions.test')}
              size="sm"
              loading={isTesting}
              disabled={!connectionTestSupported}
              onClick={() => void handleTest(config)}
              icon={isTesting ? <Loader size={14} /> : <Wifi size={14} />}
            />
          </Tooltip>
          <Tooltip content={t('actions.edit')}>
            <IconButton
              aria-label={t('actions.edit')}
              size="sm"
              onClick={() => handleEdit(config)}
              icon={<Icon name="edit" size="sm" />}
            />
          </Tooltip>
          <Tooltip content={t('actions.delete')}>
            <IconButton
              aria-label={t('actions.delete')}
              tone="danger"
              size="sm"
              onClick={() => void requestDelete(config)}
              icon={<Icon name="delete" size="sm" />}
            />
          </Tooltip>
        </div>
      </>
    );

    return (
      <ConfigCollectionItem
        key={config.id}
        label={modelLabel}
        badge={badge}
        control={control}
        details={details}
        expanded={isExpanded}
        onToggle={() => config.id && toggleExpanded(config.id)}
        toggleOnRowClick
        disabled={!config.enabled}
        detailsDisabled={false}
        data-testid="settings-model-row"
        data-config-id={config.id || ''}
        data-model-id={config.model_name}
        data-model-name={config.model_name}
        data-openbitfun-component="model-settings"
        data-openbitfun-part="modelItem"
        data-openbitfun-state={[isExpanded && 'expanded', !config.enabled && 'disabled'].filter(Boolean).join(' ') || undefined}
      />
    );
  };

  const streamTtftTimeoutLabel = (
    <span className="openbitfun-model-settings__inline-header-main">
      <span>{t('streamTtftTimeout.label')}</span>
      <Tooltip content={t('streamTtftTimeout.hint')} placement="top">
        <span
          className="openbitfun-model-settings__inline-header-info"
          role="button"
          tabIndex={0}
          aria-label={t('streamTtftTimeout.hint')}
        >
          <Icon name="info" size="sm" />
        </span>
      </Tooltip>
    </span>
  );

  const streamIdleTimeoutLabel = (
    <span className="openbitfun-model-settings__inline-header-main">
      <span>{t('streamIdleTimeout.label')}</span>
      <Tooltip content={t('streamIdleTimeout.hint')} placement="top">
        <span
          className="openbitfun-model-settings__inline-header-info"
          role="button"
          tabIndex={0}
          aria-label={t('streamIdleTimeout.hint')}
        >
          <Icon name="info" size="sm" />
        </span>
      </Tooltip>
    </span>
  );
  const reasoningPanelDraft = reasoningPanelDraftKey
    ? selectedModelDrafts.find(draft => draft.key === reasoningPanelDraftKey)
    : undefined;
  const reasoningPanelProjection = reasoningPanelDraft
    ? resolveDraftReasoningProjection(reasoningPanelDraft)
    : undefined;
  const reasoningPanelProjectionRequest = reasoningPanelDraft && editingConfig
    ? {
        provider: editingConfig.provider || 'openai',
        modelName: reasoningPanelDraft.modelName,
        baseUrl: editingConfig.base_url || '',
        contextWindow: reasoningPanelDraft.contextWindow,
        maxTokens: reasoningPanelDraft.maxTokens,
      }
    : undefined;
  const updateReasoningPanelDraft = (result: ReasoningConfigApplyResult) => {
    if (!reasoningPanelDraft) return;
    updateModelDraft(reasoningPanelDraft.modelName, {
      reasoning: result.reasoning,
      reasoningProjectionCatalog: result.projectionCatalog,
      reasoningProjectionSnapshot: {
        catalog: result.projectionCatalog,
        projection: result.projection,
      },
    });
  };
  const finishReasoningPanel = () => {
    reasoningPanelInitialRef.current = null;
    setReasoningPanelDraftKey(null);
  };
  const cancelReasoningPanel = () => {
    const initial = reasoningPanelInitialRef.current;
    if (reasoningPanelDraft && initial?.key === reasoningPanelDraft.key) {
      updateModelDraft(reasoningPanelDraft.modelName, {
        reasoning: cloneReasoningConfig(initial.reasoning),
        reasoningProjectionCatalog: initial.reasoningProjectionCatalog,
        reasoningProjectionSnapshot: initial.reasoningProjectionSnapshot,
      });
    }
    finishReasoningPanel();
  };
  const modelsDevSourceLabel = modelsDevStatus
    ? t(`modelsDevCatalog.source.${modelsDevStatus.active_source}`)
    : t('modelsDevCatalog.loading');
  const modelsDevUpdatedAt = modelsDevStatus?.cache_updated_at_ms
    ? i18nService.formatDate(new Date(modelsDevStatus.cache_updated_at_ms), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : t('modelsDevCatalog.noCache');

  
  return (
    <ConfigPageLayout className="openbitfun-model-settings" data-openbitfun-component="model-settings" data-openbitfun-part="root" data-openbitfun-view="settings">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
      />

      <ConfigPageContent className="openbitfun-model-settings__content">
        <ConfigPageSection
          title={tDefault('sections.defaults')}
          description={tDefault('subtitle')}
        >
          <DefaultModelConfig />
        </ConfigPageSection>

        <ConfigPageSection
          title={t('subscriptionAuth.sectionTitle')}
          description={t('subscriptionAuth.sectionDescription')}
          extra={(
            <Tooltip content={t('subscriptionAuth.rescan')}>
              <IconButton
                size="sm"
                onClick={refreshSubscriptionAccounts}
                aria-label={t('subscriptionAuth.rescan')}
                disabled={isLoadingSubscriptions}
                icon={<Icon name="refresh" size="md" className={isLoadingSubscriptions ? 'openbitfun-model-settings__spin' : ''} />}
              />
            </Tooltip>
          )}
        >
          <div className="openbitfun-model-settings__cli-discovery" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionArea">
            {subscriptionAccounts.map((account) => {
              const descriptionParts: string[] = [];
              if (account.connected && account.account) {
                descriptionParts.push(account.account);
              }
              if (account.connected && account.expires_at) {
                descriptionParts.push(
                  t('subscriptionAuth.expiresAt', {
                    time: i18nService.formatDate(new Date(account.expires_at * 1000), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  }),
                );
              } else if (account.connected) {
                descriptionParts.push(t('subscriptionAuth.tokenValid'));
              } else if (account.vault_unavailable) {
                descriptionParts.push(t('subscriptionAuth.vaultUnavailable'));
              } else if (account.reauthentication_required) {
                descriptionParts.push(t('subscriptionAuth.reauthenticationRequired'));
              } else {
                descriptionParts.push(t('subscriptionAuth.notSignedIn'));
              }
              const isRefreshing = refreshingSubscriptionProviders.has(account.provider);
              const isLoggingIn = loggingInProvider === account.provider;
              const anyLoginInProgress = loggingInProvider !== null;
              const loginMethods = subscriptionLoginMethodsForSurface(
                account.provider,
                account.login_methods,
                isTauriRuntime() && !isPeerDeviceModeActive(),
              );
              const loginChoices = loginMethods.length ? loginMethods : [undefined];
              const loginPanel = subscriptionLoginPanel?.provider === account.provider
                ? subscriptionLoginPanel
                : null;
              const remainingSeconds = loginPanel?.deadlineMs
                ? Math.max(0, Math.ceil((loginPanel.deadlineMs - subscriptionLoginClock) / 1000))
                : 0;
              const countdown = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;
              return (
                <React.Fragment key={account.provider}>
                  <ConfigPageRow
                    label={account.display_label}
                    description={descriptionParts.map((part) => (
                      <span
                        key={part}
                        className="openbitfun-model-settings__cli-description-line"
                      >
                        {part}
                      </span>
                    ))}
                    className="openbitfun-model-settings__cli-account"
                    align="center"
                  >
                    <div className="openbitfun-model-settings__cli-actions">
                      {account.connected ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            loading={isRefreshing}
                            disabled={anyLoginInProgress || isRefreshing}
                            onClick={() => void handleSubscriptionRefresh(account.provider)}
                          >
                            {t('subscriptionAuth.refresh')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={anyLoginInProgress}
                            onClick={() => requestSubscriptionLogout(account)}
                          >
                            {t('subscriptionAuth.logout')}
                          </Button>
                          {(
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={anyLoginInProgress}
                              onClick={() => handleImportFromSubscription(account)}
                            >
                              {t('subscriptionAuth.import')}
                            </Button>
                          )}
                        </>
                      ) : account.vault_unavailable ? (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={isRefreshing}
                          disabled={anyLoginInProgress || isRefreshing}
                          onClick={() => void handleSubscriptionRefresh(account.provider)}
                        >
                          {t('subscriptionAuth.retryVault')}
                        </Button>
                      ) : (
                        <>
                          {loginChoices.map((method, index) => (
                            <Button
                              key={method ?? 'default'}
                              size="sm"
                              variant={index === 0 ? 'primary' : 'outline'}
                              loading={isLoggingIn && subscriptionLoginPanel?.method === method}
                              disabled={anyLoginInProgress}
                              onClick={() => void handleSubscriptionLogin(account.provider, method)}
                            >
                              {t(method === 'device'
                                ? 'subscriptionAuth.deviceLogin'
                                : method === 'browser'
                                  ? 'subscriptionAuth.browserLogin'
                                  : loginPanel?.status === 'failed'
                                    ? 'subscriptionAuth.retryLogin'
                                    : 'subscriptionAuth.login')}
                            </Button>
                          ))}
                        </>
                      )}
                      {isLoggingIn && (
                        <Button
                          size="sm"
                          variant="fill"
                          disabled={loginPanel?.status === 'cancelling'}
                          onClick={() => void handleCancelSubscriptionLogin(account.provider)}
                        >
                          {t('subscriptionAuth.cancel')}
                        </Button>
                      )}
                    </div>
                  </ConfigPageRow>

                  {loginPanel && (
                    <div
                      className={`openbitfun-model-settings__subscription-login-panel openbitfun-model-settings__subscription-login-panel--${loginPanel.status}`}
                      data-openbitfun-component="model-settings"
                      data-openbitfun-part="subscriptionPanel"
                      data-openbitfun-status={loginPanel.status}
                      role={loginPanel.status === 'failed' ? 'alert' : undefined}
                    >
                      <div className="openbitfun-model-settings__subscription-login-summary" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionSummary">
                        <strong>
                          {loginPanel.status === 'failed'
                            ? t('subscriptionAuth.loginNeedsRetry')
                            : loginPanel.status === 'cancelling'
                              ? t('subscriptionAuth.loginCancelling')
                              : t('subscriptionAuth.loginPending')}
                        </strong>
                        {loginPanel.status === 'pending' && (
                          <>
                            <span>
                              {t(loginPanel.method === 'browser'
                                ? 'subscriptionAuth.browserInstructions'
                                : 'subscriptionAuth.deviceInstructions')}
                            </span>
                            <span>{t('subscriptionAuth.timeRemaining', { time: countdown })}</span>
                          </>
                        )}
                        {loginPanel.status === 'failed' && loginPanel.error && (
                          <span>{t('subscriptionAuth.loginFailedInline', { error: loginPanel.error })}</span>
                        )}
                      </div>

                      {loginPanel.status === 'pending' && loginPanel.userCode && (
                        <div className="openbitfun-model-settings__subscription-code" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionCode">
                          <span>{t('subscriptionAuth.verificationCode')}</span>
                          <code>{loginPanel.userCode}</code>
                        </div>
                      )}

                      {loginPanel.status === 'pending' && (
                        <div className="openbitfun-model-settings__subscription-login-actions" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionActions">
                          {loginPanel.userCode && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleCopySubscriptionCode(loginPanel.userCode!)}
                            >
                              {t('subscriptionAuth.copyCode')}
                            </Button>
                          )}
                          {loginPanel.authorizationUrl && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleOpenSubscriptionAuthorization(loginPanel.authorizationUrl)}
                              leadingIcon={<Icon name="arrow-up-right" size="sm" aria-hidden="true" />}
                            >
                              {t('subscriptionAuth.openAuthorization')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </ConfigPageSection>

        <ConfigPageSection
          className="openbitfun-model-settings__models-section"
          bodySurface={false}
          title={tDefault('sections.providers')}
          description={t('subtitle')}
          extra={(
            <Tooltip content={t('actions.addProvider')}>
              <IconButton
                aria-label={t('actions.addProvider')}
                size="sm"
                onClick={handleCreateNew}
                icon={<Icon name="plus" size="md" />}
              />
            </Tooltip>
          )}
        >
          {hasSuspendedEditorDraft && (
            <ConfigActionBar
              status="unsaved"
              statusMessage={t('draftClose.retainedHint')}
              saveLabel={t('draftClose.continueEditing')}
              discardLabel={t('draftClose.discardDraft')}
              onSave={() => setIsEditing(true)}
              onDiscard={closeEditingModal}
            />
          )}
          {aiModels.length === 0 ? (
            <ConfigEmptyState
              data-openbitfun-component="model-settings"
              data-openbitfun-part="empty"
              icon={<Wifi aria-hidden="true" />}
              description={t('empty.noModels')}
              actions={(
                <Button data-testid="settings-model-create-first-config-btn" variant="primary" size="sm" onClick={handleCreateNew} leadingIcon={<Icon name="plus" size="sm" />}>
                  {t('actions.createFirst')}
                </Button>
              )}
            />
          ) : (
            <div className="openbitfun-model-settings__collection" data-openbitfun-component="model-settings" data-openbitfun-part="collection" data-testid="settings-model-list">
              {providerGroups.map(group => {
                const isExpanded = expandedProviderGroupKeys.has(group.key);

                return (
                  <div
                    key={group.key}
                    className="openbitfun-model-settings__provider-group"
                    data-openbitfun-component="model-settings"
                    data-openbitfun-part="providerGroup"
                    data-openbitfun-state={isExpanded ? 'expanded' : undefined}
                  >
                    <div
                      className="openbitfun-model-settings__provider-group-header"
                      data-openbitfun-component="model-settings"
                      data-openbitfun-part="providerGroupHeader"
                      data-expanded={isExpanded ? 'true' : 'false'}
                    >
                      <button
                        type="button"
                        className="openbitfun-model-settings__provider-group-toggle"
                        aria-expanded={isExpanded}
                        aria-label={`${tComponents(isExpanded ? 'tooltip.collapse' : 'tooltip.expand')} ${group.providerName}`}
                        onClick={() => toggleProviderGroup(group.key)}
                      >
                        <Icon
                          name={isExpanded ? 'chevron-down' : 'chevron-right'}
                          size="sm"
                          className="openbitfun-model-settings__provider-group-chevron"
                          aria-hidden="true"
                        />
                        <span className="openbitfun-model-settings__provider-group-title" data-openbitfun-component="model-settings" data-openbitfun-part="providerGroupTitle">
                          <span>{group.providerName}</span>
                          <span className="openbitfun-model-settings__provider-group-count">{group.models.length}</span>
                          <span className="openbitfun-model-settings__meta-tag">
                            {requestFormatLabelMap[group.models[0]?.provider || 'openai'] || (group.models[0]?.provider || 'openai')}
                          </span>
                        </span>
                      </button>
                      <div className="openbitfun-model-settings__provider-group-actions" data-openbitfun-component="model-settings" data-openbitfun-part="providerGroupActions">
                        <Tooltip content={t('actions.edit')}>
                          <IconButton
                            aria-label={t('actions.edit')}
                            size="sm"
                            onClick={() => handleEditProvider(group.models[0])}
                            icon={<Icon name="edit" size="sm" />}
                          />
                        </Tooltip>
                        <Tooltip content={t('actions.deleteProvider')}>
                          <IconButton
                            aria-label={`${t('actions.deleteProvider')}: ${group.providerName}`}
                            tone="danger"
                            size="sm"
                            onClick={() => void requestProviderDelete(group)}
                            icon={<Icon name="delete" size="sm" />}
                          />
                        </Tooltip>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="openbitfun-model-settings__provider-group-list" data-openbitfun-component="model-settings" data-openbitfun-part="providerGroupList">
                        {group.models.map(config => renderModelCollectionItem(config))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ConfigPageSection>

        {modelsDevStatusAvailable && <ConfigPageSection
          title={t('modelsDevCatalog.title')}
          description={t('modelsDevCatalog.description')}
          bodySurface={false}
          extra={(
            <div className="openbitfun-model-settings__catalog-actions">
              <Tooltip content={t('modelsDevCatalog.viewDetails')}>
                <IconButton
                  aria-label={t('modelsDevCatalog.viewDetails')}
                  size="sm"
                  onClick={() => setShowModelsDevDetails(true)}
                  icon={<Icon name="eye" size="sm" aria-hidden="true" />}
                />
              </Tooltip>
              <Tooltip content={t(isRefreshingModelsDev
                  ? 'modelsDevCatalog.refreshing'
                  : 'modelsDevCatalog.refreshNow')}>
                <IconButton
                  aria-label={t(isRefreshingModelsDev
                    ? 'modelsDevCatalog.refreshing'
                    : 'modelsDevCatalog.refreshNow')}
                  size="sm"
                  onClick={() => void handleRefreshModelsDev()}
                  disabled={isRefreshingModelsDev}
                  icon={<Icon name="refresh" size="sm" className={isRefreshingModelsDev ? 'openbitfun-model-settings__spin' : ''} />}
                />
              </Tooltip>
            </div>
          )}
        >
          <span />
        </ConfigPageSection>}

        <ConfigPageSection
          title={t('streamIdleTimeout.title')}
          description={t('streamIdleTimeout.effectiveNextRound')}
        >
          <ConfigPageRow
            label={streamTtftTimeoutLabel}
            align="center"
          >
            <Input
              value={streamTtftTimeoutInput}
              onChange={(e) => setStreamTtftTimeoutInput(e.target.value)}
              placeholder={t('streamTtftTimeout.placeholder')}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow
            label={streamIdleTimeoutLabel}
            align="center"
          >
            <Input
              value={streamIdleTimeoutInput}
              onChange={(e) => setStreamIdleTimeoutInput(e.target.value)}
              placeholder={t('streamIdleTimeout.placeholder')}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigActionBar
            status={isStreamTimeoutSaving
              ? 'saving'
              : streamTimeoutSaveError
                ? 'error'
                : isStreamTimeoutDirty
                  ? 'unsaved'
                  : 'saved'}
            statusMessage={streamTimeoutSaveError}
            saving={isStreamTimeoutSaving}
            saveDisabled={isStreamTimeoutInvalid || !isStreamTimeoutDirty}
            discardDisabled={!isStreamTimeoutDirty}
            saveLabel={t('streamIdleTimeout.save')}
            onSave={() => void handleSaveStreamTimeouts()}
            onDiscard={discardStreamTimeoutDraft}
          />
        </ConfigPageSection>

        <ConfigPageSection
          title={tDefault('sections.proxy')}
          description={t('proxy.enableHint')}
        >
          <ConfigPageRow label={t('proxy.enable')} align="center">
            <Switch
              checked={proxyConfig.enabled}
              onChange={(e) => setProxyConfig(prev => ({ ...prev, enabled: e.target.checked }))}
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('proxy.url')} description={t('proxy.urlHint')} align="center">
            <Input
              value={proxyConfig.url}
              onChange={(e) => setProxyConfig(prev => ({ ...prev, url: e.target.value }))}
              placeholder={t('proxy.urlPlaceholder')}
              disabled={!proxyConfig.enabled}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('proxy.username')} align="center">
            <Input
              value={proxyConfig.username || ''}
              onChange={(e) => setProxyConfig(prev => ({ ...prev, username: e.target.value }))}
              placeholder={t('proxy.usernamePlaceholder')}
              disabled={!proxyConfig.enabled}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigPageRow label={t('proxy.password')} align="center">
            <Input
              type="password"
              value={proxyConfig.password || ''}
              onChange={(e) => setProxyConfig(prev => ({ ...prev, password: e.target.value }))}
              placeholder={t('proxy.passwordPlaceholder')}
              disabled={!proxyConfig.enabled}
              size="sm"
            />
          </ConfigPageRow>
          <ConfigActionBar
            status={isProxySaving
              ? 'saving'
              : proxySaveError
                ? 'error'
                : isProxyDirty
                  ? 'unsaved'
                  : 'saved'}
            statusMessage={proxySaveError}
            saving={isProxySaving}
            saveDisabled={!isProxyDirty || (proxyConfig.enabled && !proxyConfig.url.trim())}
            discardDisabled={!isProxyDirty}
            saveLabel={t('proxy.save')}
            onSave={() => void handleSaveProxy()}
            onDiscard={discardProxyDraft}
          />
        </ConfigPageSection>
      </ConfigPageContent>

      <Dialog
        open={showModelsDevDetails}
        onOpenChange={(nextOpen) => { if (!nextOpen) setShowModelsDevDetails(false); }}
        size="sm"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('modelsDevCatalog.detailsTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody inset="none">
        <div className="openbitfun-model-settings__catalog-details">
          <ConfigPageRow label={t('modelsDevCatalog.activeSource')} align="center">
            <span className="openbitfun-model-settings__catalog-status-value">{modelsDevSourceLabel}</span>
          </ConfigPageRow>
          <ConfigPageRow label={t('modelsDevCatalog.catalogSize')} align="center">
            <span className="openbitfun-model-settings__catalog-status-value">
              {modelsDevStatus
                ? t('modelsDevCatalog.catalogSizeValue', {
                    providers: i18nService.formatNumber(modelsDevStatus.provider_count),
                    models: i18nService.formatNumber(modelsDevStatus.reasoning_model_count),
                  })
                : t('modelsDevCatalog.loading')}
            </span>
          </ConfigPageRow>
          <ConfigPageRow label={t('modelsDevCatalog.cacheUpdatedAt')} align="center">
            <span className="openbitfun-model-settings__catalog-status-value">{modelsDevUpdatedAt}</span>
          </ConfigPageRow>
          <ConfigPageRow label={t('modelsDevCatalog.cachePath')} align="center" wide>
            <div className="openbitfun-model-settings__catalog-path">
              <code title={modelsDevStatus?.cache_path}><OverflowText>{modelsDevStatus?.cache_path || '—'}</OverflowText></code>
              <Tooltip content={t('modelsDevCatalog.reveal')}>
                <IconButton
                  aria-label={t('modelsDevCatalog.reveal')}
                  size="sm"
                  onClick={() => {
                    void aiApi.revealModelsDevCacheDirectory().catch((error) => {
                      log.warn('Failed to reveal models.dev cache', { error });
                      notification.error(t('modelsDevCatalog.revealFailed'));
                    });
                  }}
                  icon={<FolderOpen size={14} aria-hidden="true" />}
                />
              </Tooltip>
            </div>
          </ConfigPageRow>
          <ConfigPageRow label={t('modelsDevCatalog.revision')} align="center">
            <code className="openbitfun-model-settings__catalog-revision" title={modelsDevStatus?.revision}>
              {modelsDevStatus?.revision ? `${modelsDevStatus.revision.slice(0, 12)}…` : '—'}
            </code>
          </ConfigPageRow>
          <div className="openbitfun-model-settings__catalog-offline-help" role="note">
            <Icon name="info" size="sm" aria-hidden="true" />
            <div>
              <strong>{t('modelsDevCatalog.offlineTitle')}</strong>
              <p>{t('modelsDevCatalog.offlineDescription')}</p>
              <div className="openbitfun-model-settings__catalog-offline-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void systemAPI.openExternal(MODELS_DEV_DOWNLOAD_URL)}
                  leadingIcon={<Icon name="arrow-up-right" size="sm" aria-hidden="true" />}
                >

                  {t('modelsDevCatalog.downloadOriginal')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void aiApi.revealModelsDevCacheDirectory().catch((error) => {
                      log.warn('Failed to reveal models.dev cache directory', { error });
                      notification.error(t('modelsDevCatalog.revealFailed'));
                    });
                  }}
                  leadingIcon={<FolderOpen size={14} aria-hidden="true" />}
                >

                  {t('modelsDevCatalog.openCacheDirectory')}
                </Button>
              </div>
            </div>
          </div>
        </div>
              </DialogBody>
      </Dialog>

      <Dialog
        open={!!subscriptionLogoutRequest}
        onOpenChange={(nextOpen) => { if (!nextOpen) setSubscriptionLogoutRequest(null); }}
        size="sm"
        closeOnPointerOutside={false}
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('subscriptionAuth.logoutConfirmTitle')}</DialogTitle>
          </DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody inset="none">
        <div className="openbitfun-model-settings__subscription-logout-confirm" data-openbitfun-component="model-settings" data-openbitfun-part="logoutConfirm">
          <p>
            {subscriptionLogoutRequest?.affectedModels.length
              ? t('subscriptionAuth.logoutAffectedModels', {
                  count: subscriptionLogoutRequest.affectedModels.length,
                })
              : t('subscriptionAuth.logoutNoAffectedModels')}
          </p>
          {!!subscriptionLogoutRequest?.affectedModels.length && (
            <ScrollArea className="openbitfun-model-settings__subscription-logout-list">
              <ul>
                {subscriptionLogoutRequest.affectedModels.map((model) => (
                  <li key={model.id}>{model.name} · {model.model_name}</li>
                ))}
              </ul>
            </ScrollArea>
          )}
          <p>{t('subscriptionAuth.logoutConsequence')}</p>
        </div>
              </DialogBody>
        <DialogFooter>{(
          <>
            <Button
              size="sm"
              variant="fill"
              onClick={() => setSubscriptionLogoutRequest(null)}
            >
              {t('subscriptionAuth.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              tone="danger"
              onClick={() => void confirmSubscriptionLogout()}
            >
              {t('subscriptionAuth.confirmLogout')}
            </Button>
          </>
        )}</DialogFooter>
      </Dialog>

      <Dialog
        open={isEditing && !!editingConfig}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isEditorSaving) {
            if (reasoningPanelDraft) finishReasoningPanel();
            else requestCloseEditingModal();
          }
        }}
        className="openbitfun-model-settings__editor-dialog"
        size="xl"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{reasoningPanelDraft
          ? t('reasoningPresets.dialogTitle', {
              provider: editingConfig?.name?.trim()
                || currentTemplate?.name
                || editingConfig?.provider
                || '',
              model: reasoningPanelDraft.modelName,
            })
          : editingConfig?.id
            ? t('editModel')
            : (getProviderInstanceId(editingConfig)
              ? t('editProvider')
              : (currentTemplate ? `${t('newProvider')} - ${currentTemplate.name}` : t('newProvider')))}</DialogTitle>
          </DialogHeading>
          <DialogClose disabled={isEditorSaving} />
        </DialogHeader>
        <DialogBody
          inset="none"
          aria-busy={isEditorSaving}
          {...(isEditorSaving ? { inert: '' } : {})}
        >
        {reasoningPanelDraft ? (
          <ReasoningConfigPanel
            key={reasoningPanelDraft.key}
            value={reasoningPanelDraft.reasoning}
            generatedProjection={reasoningPanelProjection}
            modelsDevReasoningCatalog={modelCatalog?.models_dev_reasoning_catalog}
            projectionRequest={reasoningPanelProjectionRequest}
            requestFormatLabel={reasoningPanelProjectionRequest
              ? requestFormatLabelMap[reasoningPanelProjectionRequest.provider]
                || reasoningPanelProjectionRequest.provider
              : undefined}
            onCancel={cancelReasoningPanel}
            onDraftChange={updateReasoningPanelDraft}
            onApply={(result: ReasoningConfigApplyResult) => {
              updateReasoningPanelDraft(result);
              finishReasoningPanel();
            }}
          />
        ) : renderEditingForm()}
              </DialogBody>
        {!reasoningPanelDraft && (
          <DialogFooter appearance="floating">
            <Button variant="fill" size="sm" onClick={requestCloseEditingModal} disabled={isEditorSaving}>
              {t('actions.cancel')}
            </Button>
            <Button
              data-testid="settings-model-save-btn"
              variant="primary"
              size="sm"
              onClick={() => void handleSave()}
              loading={isEditorSaving}
            >
              {t('actions.save')}
            </Button>
          </DialogFooter>
        )}
      </Dialog>
      <ConfirmDialog
        open={draftCloseConfirmOpen}
        onOpenChange={(open) => { if (!open) setDraftCloseConfirmOpen(false); }}
        onConfirm={preserveEditingDraftAndClose}
        onSecondary={closeEditingModal}
        title={t('draftClose.title')}
        message={t('draftClose.message')}
        confirmText={t('draftClose.keepAndClose')}
        secondaryText={t('draftClose.discard')}
        cancelText={t('draftClose.continueEditing')}
        closeOnPointerOutside={false}
        type="warning"
      />
      <ConfirmDialog
        open={draftConflictConfirmOpen}
        onOpenChange={(open) => { if (!open) cancelPendingEditorOpen(); }}
        onConfirm={continueEditingCurrentDraft}
        onSecondary={discardDraftBeforeOpeningPendingEditor}
        title={t('draftConflict.title')}
        message={t('draftConflict.message')}
        confirmText={t('draftConflict.continueDraft')}
        secondaryText={t('draftConflict.discardAndContinue')}
        cancelText={t('draftConflict.cancel')}
        closeOnPointerOutside={false}
        type="warning"
      />
      <ConfirmDialog
        open={!!deleteRequest}
        onOpenChange={(open) => { if (!open) setDeleteRequest(null); }}
        onConfirm={handleDelete}
        title={t(deleteRequest?.kind === 'provider'
          ? 'providerDeleteConfirm.title'
          : 'deleteConfirm.title')}
        message={deleteRequest?.kind === 'provider'
          ? t(deleteRequest.discardsRetainedDraft
            ? 'providerDeleteConfirm.messageWithDraft'
            : 'providerDeleteConfirm.message', {
              name: deleteRequest.providerName,
              modelCount: deleteRequest.modelCount,
              referenceCount: deleteRequest.referenceCount,
            })
          : t('deleteConfirm.message', {
              name: deleteRequest?.config.model_name || '',
              count: deleteRequest?.referenceCount ?? 0,
            })}
        confirmText={t(deleteRequest?.kind === 'provider'
          ? 'providerDeleteConfirm.confirm'
          : 'deleteConfirm.confirm')}
        type="warning"
        confirmDanger
      />
    </ConfigPageLayout>
  );
};

export default ModelSettingsPage;
