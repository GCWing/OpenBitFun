import '@/app/scenes/settings/pages/ai/ModelSettingsPage.scss';
import { ModelDiscoveryPicker, type ModelDiscoveryOption } from './ModelDiscoveryPicker';
import { ModelPoolCardActions } from './ModelPoolCardActions';
import { aiApi, systemAPI } from '@/infrastructure/api';
import type {
  SubscriptionAccount,
  SubscriptionLoginMethod,
} from '@/infrastructure/api/service-api/AIApi';
import {
  ConfigActionBar,
  ConfigLoadingState,
  ConfigCollectionItem,
  ConfigEmptyState,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import DefaultModelConfig from '@/infrastructure/config/components/DefaultModelConfig';
import ModelTagsField from '@/infrastructure/config/components/ModelTagsField';
import {
  configsNeedingAutoTest,
  providerConnectionChanged,
  stableJson,
} from '@/infrastructure/config/components/modelConnectionTestPlan';
import { ModelDiscoveryCoordinator } from '@/infrastructure/config/components/modelDiscoveryCoordinator';
import {
  getModelEditorRequestSettings,
  updateModelEditorRequestSettings,
  type ModelEditorRequestSettings,
} from '@/infrastructure/config/components/modelEditorRequestSettings';
import { isOpenCodeApiKeyConfig, isOpenCodeZenOAuth, openCodeZenModels, resolveOpenCodeModelRoute, savedOpenCodeApiKeyRoute } from '@/infrastructure/config/components/openCodeApiKeyRouting';
import ReasoningConfigPanel, { type ReasoningConfigApplyResult } from '@/infrastructure/config/components/ReasoningConfigPanel';
import { getSubscriptionAccountState } from '@/infrastructure/config/components/subscriptionAccountState';
import {
  preferredSubscriptionLoginMethod,
  settleSubscriptionLoginStart,
  SubscriptionLoginCoordinator,
  subscriptionLoginRequiresLocalDevice,
  type SubscriptionLoginOperation,
} from '@/infrastructure/config/components/subscriptionLoginCoordinator';
import { resolveProviderTemplates } from '@/infrastructure/config/services/builtinProviderCatalog';
import { useConfigSeed } from '@/infrastructure/config/hooks/useConfigSeed';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { getCapabilitiesByCategory, getEffectiveModelCapabilities, resolveModelCategory } from '@/infrastructure/config/services/modelCategory';
import { getModelTags, getModelUserTags, preserveModelAnnotations } from '@/infrastructure/config/services/modelTags';
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
} from '@/infrastructure/config/services/modelConfigs';
import { normalizeProviderBaseUrl } from '@/infrastructure/config/services/providerCatalog';
import {
  useSettingsDraft,
} from '@/infrastructure/config/settingsDraftRegistry';
import type { DefaultModelsConfig, ModelCapability, SubscriptionProvider } from '@/infrastructure/config/types';
import {
  AIModelConfig as AIModelConfigType,
  ModelCategory,
  ProxyConfig,
  ReasoningCatalogBinding,
  ReasoningCatalogProjection,
  ReasoningConfig,
} from '@/infrastructure/config/types';
import { supportsResponsesReasoning } from '@/infrastructure/config/utils/reasoning';
import {
  canonicalReasoningConfig,
  cloneReasoningConfig,
  validateReasoningConfig,
} from '@/infrastructure/config/utils/reasoningPresets';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import { isTauriRuntime } from '@/infrastructure/runtime';
import { LONG_CONTEXT_WARNING_THRESHOLD_TOKENS } from '@/shared/constants/modelContext';
import { useNotification } from '@/shared/notification-system';
import type { ProviderRegion } from '@/shared/types';
import { translateConnectionTestMessage } from '@/shared/utils/aiConnectionTestMessages';
import { createLogger } from '@/shared/utils/logger';
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  Combobox,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Disclosure,
  FieldGroup,
  Icon,
  IconButton,
  Input,
  NumberInput,
  OverflowText,
  ScrollArea,
  SearchField,
  Select,
  StatusPill,
  Switch,
  Textarea,
  ToolbarGroup,
  Tooltip,
  type ComboboxOption,
} from '@openbitfun/ui';
import { AlertTriangle, EyeOff, FolderOpen, Loader, Wifi } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

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
  contextWindowEdited?: boolean;
  maxTokens?: number;
  /** Undefined preserves the latest saved tags until the user edits this model. */
  userTags?: string[];
  reasoning: ReasoningConfig;
  requestSettings: ModelEditorRequestSettings;
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
    key: overrides?.key ?? overrides?.configId ?? baseConfig?.id
      ?? `model-draft:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
    configId: overrides?.configId ?? baseConfig?.id,
    modelName: trimmedModelName,
    manualRequestFormat: overrides?.manualRequestFormat ?? baseConfig?.provider,
    category: overrides?.category ?? baseConfig?.category ?? 'general_chat',
    contextWindow: overrides?.contextWindow ?? baseConfig?.context_window ?? 300000,
    maxTokens: overrides?.maxTokens ?? baseConfig?.max_tokens,
    reasoning,
    requestSettings: overrides?.requestSettings ?? getModelEditorRequestSettings(baseConfig),
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
    stableJson(draft.reasoning) !== stableJson(canonicalReasoningConfig(persisted)) ||
    stableJson(draft.requestSettings) !== stableJson(getModelEditorRequestSettings(persisted)) ||
    (draft.userTags !== undefined && stableJson(draft.userTags) !== stableJson(getModelUserTags(persisted)))
  );
}

function getPoolProviderKey(model: AIModelConfigType): string {
  return model.auth?.type === 'subscription'
    ? `subscription:${model.auth.provider}`
    : `api:${getProviderDisplayName(model)}`;
}

const ModelSettingsPage: React.FC = () => {
  const { t, i18n } = useI18n('settings/models');
  const { t: tDefault } = useI18n('settings/default-model');
  const { t: tComponents } = useI18n('components');
  const peerDevice = usePeerDeviceModeOptional();
  const modelDiscoverySurface = peerDevice?.peerMode.active ? peerDevice.peerMode.deviceId : 'local';
  const connectionTestSupported = !peerDevice?.peerMode.active
    || peerDevice.currentPeerCapabilities?.hostKind !== 'cli';
  const modelSeed = useConfigSeed(['ai.models', 'ai.default_models']);
  const proxySeed = useConfigSeed(['ai.proxy']);
  const timeoutSeed = useConfigSeed(['ai.stream_idle_timeout_secs', 'ai.stream_ttft_timeout_secs']);
  const initialProxy = proxySeed.get<ProxyConfig | null>('ai.proxy', null) ?? { enabled: false, url: '', username: '', password: '' };
  const initialIdle = timeoutSeed.get<number | null>('ai.stream_idle_timeout_secs', null);
  const initialTtft = timeoutSeed.get<number | null>('ai.stream_ttft_timeout_secs', null);
  const [aiModels, setAiModels] = useState<AIModelConfigType[]>(modelSeed.get<AIModelConfigType[] | null>('ai.models', null) ?? []);
  const [poolDefaults, setPoolDefaults] = useState<DefaultModelsConfig>(modelSeed.get<DefaultModelsConfig | null>('ai.default_models', null) ?? {});
  const [poolQuery, setPoolQuery] = useState('');
  const [poolCapability, setPoolCapability] = useState<ModelCapability | ''>('');
  const [poolProvider, setPoolProvider] = useState('');
  const [showTagSyncNotice, setShowTagSyncNotice] = useState(false);
  const [showSubscriptionManager, setShowSubscriptionManager] = useState(false);
  const [showProviderManager, setShowProviderManager] = useState(false);
  const [subscriptionLoadError, setSubscriptionLoadError] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(!modelSeed.loaded);
  const [configLoadError, setConfigLoadError] = useState(false);
  const [proxyLoadState, setProxyLoadState] = useState<'loading' | 'ready' | 'error'>(proxySeed.loaded ? 'ready' : 'loading');
  const [streamTimeoutLoadState, setStreamTimeoutLoadState] = useState<'loading' | 'ready' | 'error'>(timeoutSeed.loaded ? 'ready' : 'loading');
  const modelConfigReady = !isConfigLoading && !configLoadError;
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
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig>(initialProxy);
  const [savedProxyConfig, setSavedProxyConfig] = useState<ProxyConfig>(initialProxy);
  const [streamIdleTimeoutInput, setStreamIdleTimeoutInput] = useState(initialIdle == null ? '' : String(initialIdle));
  const [streamTtftTimeoutInput, setStreamTtftTimeoutInput] = useState(initialTtft == null ? '' : String(initialTtft));
  const [savedStreamTimeouts, setSavedStreamTimeouts] = useState({ idle: initialIdle == null ? '' : String(initialIdle), ttft: initialTtft == null ? '' : String(initialTtft) });
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
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
  const providerIdentityLocked = !!editingConfig?.id || editingProviderModelIds.size > 0;
  const configuredProvider = aiModels.find(model => editingConfig?.id
    ? model.id === editingConfig.id
    : editingProviderModelIds.has(model.id || ''));
  const [manualModelInput, setManualModelInput] = useState('');
  const [isAddingCustomModel, setIsAddingCustomModel] = useState(false);
  const manualModelInputActiveRef = React.useRef(false);
  const manualModelAddButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [managingSubscriptionProvider, setManagingSubscriptionProvider] = useState<SubscriptionProvider | null>(null);
  const subscriptionManageButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const subscriptionManagementRef = React.useRef<HTMLDivElement | null>(null);
  const returnSubscriptionFocusRef = React.useRef(false);
  const [modelPanelDraftKey, setModelPanelDraftKey] = useState<string | null>(null);
  const modelPanelInitialRef = React.useRef<{ draft: SelectedModelDraft; advancedOpen: boolean } | null>(null);
  const modelCapsuleRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const returnModelFocusKeyRef = React.useRef<string | null>(null);
  const modelPanelDraft = modelPanelDraftKey
    ? selectedModelDrafts.find(draft => draft.key === modelPanelDraftKey)
    : undefined;
  const singleModelEditorDraft = modelPanelDraft || (editingConfig?.id ? selectedModelDrafts[0] : undefined);
  const [reasoningPanelDraftKey, setReasoningPanelDraftKey] = useState<string | null>(null);
  const reasoningPanelInitialRef = React.useRef<Pick<
    SelectedModelDraft,
    'key' | 'reasoning' | 'reasoningProjectionCatalog' | 'reasoningProjectionSnapshot'
  > | null>(null);
  const resetEditorPanels = useCallback(() => {
    setModelPickerOpen(false);
    manualModelInputActiveRef.current = false;
    setIsAddingCustomModel(false);
    setManualModelInput('');
    setManagingSubscriptionProvider(null);
    returnSubscriptionFocusRef.current = false;
    setModelPanelDraftKey(null);
    modelPanelInitialRef.current = null;
    returnModelFocusKeyRef.current = null;
    setReasoningPanelDraftKey(null);
    reasoningPanelInitialRef.current = null;
  }, []);
  useEffect(() => {
    const draftKey = returnModelFocusKeyRef.current;
    if (isEditing && !modelPanelDraftKey && !reasoningPanelDraftKey && draftKey) {
      modelCapsuleRefs.current.get(draftKey)?.focus();
      returnModelFocusKeyRef.current = null;
    }
  }, [isEditing, modelPanelDraftKey, reasoningPanelDraftKey]);
  useEffect(() => {
    if (isEditing && managingSubscriptionProvider) {
      subscriptionManagementRef.current?.focus();
    } else if (isEditing && returnSubscriptionFocusRef.current) {
      subscriptionManageButtonRef.current?.focus();
      returnSubscriptionFocusRef.current = false;
    }
  }, [isEditing, managingSubscriptionProvider]);
  const [subscriptionAccounts, setSubscriptionAccounts] = useState<SubscriptionAccount[]>([]);
  const subscriptionRefreshesRef = React.useRef(new Set<SubscriptionProvider>());
  const [refreshingSubscriptionProviders, setRefreshingSubscriptionProviders] = useState<ReadonlySet<SubscriptionProvider>>(new Set());
  const [isLoadingSubscriptions, setIsLoadingSubscriptions] = useState(true);
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
    const scope = getActiveSurfaceScope();
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
      if (!scope.isCurrent()) return;
      setModelCatalog(localCatalogs
        ? {
          ...hostCatalog,
          provider_catalog: localCatalogs.provider_catalog,
          models_dev_reasoning_catalog: localCatalogs.models_dev_reasoning_catalog,
        }
        : hostCatalog);
    } catch (error) {
      if (!scope.isCurrent()) return;
      setModelCatalog(null);
      log.warn('Failed to load model reasoning catalog', { error });
    }
  }, []);

  const loadModelsDevStatus = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    try {
      const status = await aiApi.getModelsDevCatalogStatus();
      if (!scope.isCurrent()) return;
      setModelsDevStatus(status);
      setModelsDevStatusAvailable(true);
    } catch (error) {
      if (!scope.isCurrent()) return;
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
    const scope = getActiveSurfaceScope();
    setIsConfigLoading(true);
    setConfigLoadError(false);
    try {
      // Optional reads preserve missing-key compatibility while propagating host
      // failures, instead of presenting a failed model read as an empty pool.
      const [models, defaults] = await Promise.all([
        configManager.getOptionalConfig<AIModelConfigType[]>('ai.models'),
        configManager.getOptionalConfig<DefaultModelsConfig>('ai.default_models'),
      ]);
      if (!scope.isCurrent()) return;
      setAiModels(models || []);
      setPoolDefaults(defaults || {});
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to load AI model config', error);
      setConfigLoadError(true);
    } finally {
      if (scope.isCurrent()) setIsConfigLoading(false);
    }
  }, []);

  const loadProxyConfig = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    setProxyLoadState('loading');
    try {
      const proxy = await configManager.getConfig<ProxyConfig>('ai.proxy');
      if (!scope.isCurrent()) return;
      const resolvedProxy = proxy || { enabled: false, url: '', username: '', password: '' };
      setProxyConfig(resolvedProxy);
      setSavedProxyConfig(resolvedProxy);
      setProxyLoadState('ready');
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to load AI proxy config', error);
      setProxyLoadState('error');
    }
  }, []);

  const loadStreamTimeouts = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    setStreamTimeoutLoadState('loading');
    try {
      const [streamIdleTimeoutSecs, streamTtftTimeoutSecs] = await Promise.all([
        configManager.getConfig<number | null>('ai.stream_idle_timeout_secs'),
        configManager.getConfig<number | null>('ai.stream_ttft_timeout_secs'),
      ]);
      if (!scope.isCurrent()) return;
      const idle = streamIdleTimeoutSecs != null ? String(streamIdleTimeoutSecs) : '';
      const ttft = streamTtftTimeoutSecs != null ? String(streamTtftTimeoutSecs) : '';
      setStreamIdleTimeoutInput(idle);
      setStreamTtftTimeoutInput(ttft);
      setSavedStreamTimeouts({ idle, ttft });
      setStreamTimeoutLoadState('ready');
    } catch (error) {
      if (!scope.isCurrent()) return;
      log.error('Failed to load AI stream timeout config', error);
      setStreamTimeoutLoadState('error');
    }
  }, []);

  useEffect(() => {
    const unsubscribeCatalog = aiApi.onModelCatalogUpdated(() => {
      void loadModelCatalog();
      void loadModelsDevStatus();
    });
    // Independent sections become usable as soon as their own data is ready.
    if (!modelSeed.loaded) void loadConfig();
    if (!proxySeed.loaded) void loadProxyConfig();
    if (!timeoutSeed.loaded) void loadStreamTimeouts();
    void loadModelCatalog();
    void loadModelsDevStatus();
    return unsubscribeCatalog;
  }, [loadConfig, loadProxyConfig, loadStreamTimeouts, loadModelCatalog, loadModelsDevStatus, modelDiscoverySurface, modelSeed, proxySeed, timeoutSeed]);

  const refreshSubscriptionAccounts = useCallback(async () => {
    const scope = getActiveSurfaceScope();
    setIsLoadingSubscriptions(true);
    setSubscriptionLoadError(false);
    try {
      const items = await aiApi.listSubscriptionAccounts();
      if (!scope.isCurrent()) return;
      setSubscriptionAccounts(items);
    } catch (e) {
      if (!scope.isCurrent()) return;
      setSubscriptionLoadError(true);
      log.warn('list_subscription_accounts failed', { error: String(e) });
    } finally {
      if (scope.isCurrent()) setIsLoadingSubscriptions(false);
    }
  }, []);

  useEffect(() => {
    refreshSubscriptionAccounts();
  }, [refreshSubscriptionAccounts, modelDiscoverySurface]);

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
    if (isAddingCustomModel && manualModelInput.trim()) return true;
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
  }, [aiModels, editingConfig, editingProviderModelIds, isAddingCustomModel, manualModelInput, selectedModelDrafts]);

  const createDraftsFromConfigs = (configs: AIModelConfigType[]) => (
    configs.map(config => createModelDraft(config.model_name, config, {
      configId: config.id,
      contextWindow: config.context_window || 300000,
      maxTokens: config.max_tokens,
      reasoning: canonicalReasoningConfig(config),
    }))
  );

  const resetRemoteModelDiscovery = useCallback(() => {
    setModelPickerOpen(false);
    setRemoteModelOptions([]);
    setIsFetchingRemoteModels(false);
    setRemoteModelsError(null);
    setHasAttemptedRemoteFetch(false);
    modelDiscoveryRef.current.reset();
  }, []);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refreshPool = async () => {
      const scope = getActiveSurfaceScope();
      const requestRevision = ++revision;
      try {
        const [models, defaults] = await Promise.all([
          configManager.getOptionalConfig<AIModelConfigType[]>('ai.models'),
          configManager.getOptionalConfig<DefaultModelsConfig>('ai.default_models'),
        ]);
        if (disposed || !scope.isCurrent() || revision !== requestRevision) return;
        setAiModels(models || []);
        setPoolDefaults(defaults || {});
      } catch (error) {
        if (!disposed && scope.isCurrent()) log.warn('Failed to refresh model pool', { error });
      }
    };
    const unsubscribe = configManager.onConfigChange(path => {
      if (!path || path === 'ai' || path.startsWith('ai.models') || path.startsWith('ai.default_models')) {
        void refreshPool();
      }
    });
    return () => { disposed = true; unsubscribe(); };
  }, [modelDiscoverySurface]);
  useEffect(() => {
    const coordinator = modelDiscoveryRef.current;
    resetRemoteModelDiscovery();
    setPoolProvider('');
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
            key: existingDraft.key,
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

  const updateModelDraft = (draftKey: string, updates: Partial<SelectedModelDraft>) => {
    setSelectedModelDrafts(prevDrafts => prevDrafts.map(draft => (
      draft.key === draftKey ? { ...draft, ...updates } : draft
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

  const openModelPanel = (draft: SelectedModelDraft) => {
    modelPanelInitialRef.current = {
      draft,
      advancedOpen: showAdvancedSettings,
    };
    setModelPanelDraftKey(draft.key);
    setShowModelValidation(false);
    const settings = draft.requestSettings;
    setShowAdvancedSettings(
      !!settings.skip_ssl_verify
      || settings.custom_request_body_mode === 'trim'
      || !!settings.custom_request_body?.trim()
      || Object.keys(settings.custom_headers || {}).length > 0,
    );
  };

  const returnToProviderEditor = () => {
    returnModelFocusKeyRef.current = modelPanelDraftKey;
    setShowAdvancedSettings(modelPanelInitialRef.current?.advancedOpen ?? false);
    setModelPanelDraftKey(null);
    modelPanelInitialRef.current = null;
    setShowModelValidation(false);
  };

  const finishModelPanel = () => {
    if (!modelPanelDraft) return;
    setShowModelValidation(true);
    const modelName = modelPanelDraft.modelName.trim();
    if (!modelName) {
      notification.warning(t('messages.missingFields', { fields: t('form.modelName') }));
      return;
    }
    if (selectedModelDrafts.some(draft => draft.key !== modelPanelDraft.key
      && modelNameLookupKey(draft.modelName) === modelNameLookupKey(modelName))) {
      notification.warning(t('messages.duplicateModelNameUnderProvider'));
      return;
    }
    if (modelPanelDraft.contextWindow < 32000) {
      notification.warning(t('messages.contextWindowTooSmall'));
      return;
    }
    updateModelDraft(modelPanelDraft.key, { modelName });
    returnToProviderEditor();
  };

  const cancelModelPanel = () => {
    const initial = modelPanelInitialRef.current;
    if (initial && initial.draft.key === modelPanelDraftKey) {
      updateModelDraft(initial.draft.key, initial.draft);
    }
    returnToProviderEditor();
  };

  const removeSelectedModelDraft = (modelName: string) => {
    const remainingModelNames = selectedModelDrafts
      .filter(draft => draft.modelName !== modelName)
      .map(draft => draft.modelName);

    syncSelectedModelDrafts(remainingModelNames, editingConfig || undefined, !!editingConfig?.id);
  };

  const startManualModelDraft = () => {
    setModelPickerOpen(false);
    setManualModelInput('');
    manualModelInputActiveRef.current = true;
    setIsAddingCustomModel(true);
  };

  const cancelManualModelDraft = () => {
    manualModelInputActiveRef.current = false;
    setIsAddingCustomModel(false);
    setManualModelInput('');
  };

  const addManualModelDraft = () => {
    if (!manualModelInputActiveRef.current || isEditorSaving) return;
    // Enter unmounts the input and may also trigger blur; apply the draft only once.
    cancelManualModelDraft();
    const trimmedModelName = manualModelInput.trim();
    if (!trimmedModelName) return;

    const alreadyInDrafts = selectedModelDrafts.some(
      draft => modelNameLookupKey(draft.modelName) === modelNameLookupKey(trimmedModelName)
    );

    if (alreadyInDrafts) {
      notification.info(t('providerSelection.modelAlreadyInList'));
      return;
    }

    const nextModelNames = editingConfig?.id
      ? [trimmedModelName]
      : uniqModelNames([
        ...selectedModelDrafts.map(draft => draft.modelName),
        trimmedModelName,
      ]);

    syncSelectedModelDrafts(nextModelNames, editingConfig || undefined, !!editingConfig?.id);
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
    setModelPickerOpen(isOpen);
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
        setShowProviderManager(false);
        setShowSubscriptionManager(false);
        setIsEditing(true);
        return;
      }
      pendingEditorOpenRef.current = { open };
      setDraftConflictConfirmOpen(true);
      return;
    }
    resetEditorPanels();
    open();
  }, [editingConfig, editingModalHasUnsavedChanges, editingTargetKey, isEditing, resetEditorPanels]);

  const handleCreateNew = () => {
    requestEditorOpen('new-provider', () => {
      setShowProviderManager(false);
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
      setShowSubscriptionManager(false);
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
        void aiApi.cancelSubscriptionLogin(pending.provider, pending.sessionId).catch(() => { });
      }
    };
  }, []);

  const handleSubscriptionLogin = useCallback(async (provider: SubscriptionProvider) => {
    if ((!isTauriRuntime() || isPeerDeviceModeActive()) && subscriptionLoginRequiresLocalDevice(provider)) {
      notification.error(t('subscriptionAuth.peerLoginRequiresLocalDevice'));
      return;
    }
    // The settings surface intentionally permits one authorization flow at a
    // time. This prevents a stale provider poll/finally block from clearing a
    // newer provider's state or leaving an undiscoverable backend session.
    const operation = loginCoordinatorRef.current.begin(provider);
    if (!operation) return;
    const requestedMethod = preferredSubscriptionLoginMethod(
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
      setShowProviderManager(false);
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
      if (config.auth?.type === 'subscription') void refreshSubscriptionAccounts();
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
      setShowProviderManager(false);
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
    if (providerIdentityLocked && !configuredProvider) {
      notification.error(t('messages.providerRemoved'));
      return false;
    }
    // Persist the saved identity, including legacy API-key configs without auth.
    // Removing controls alone must not allow a retained draft to migrate a service.
    const providerConfig = configuredProvider ? {
      ...editingConfig,
      name: getProviderDisplayName(configuredProvider),
      auth: configuredProvider.auth || { type: 'api_key' as const },
    } : editingConfig;
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
      const providerName = providerConfig.name?.trim() || '';
      const baseUrl = providerConfig.base_url?.trim() || '';
      if (!hasHttpUrlScheme(baseUrl)) {
        notification.warning(t('messages.invalidBaseUrlScheme'));
        return false;
      }
      const draftsToSave = dedupeSelectedModelDraftsByModelName(selectedModelDrafts)
        .map(draft => ({ ...draft, modelName: draft.modelName.trim() }));
      if (draftsToSave.length !== selectedModelDrafts.length) {
        notification.warning(t('messages.duplicateModelNameUnderProvider'));
        return false;
      }
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
      const existingProviderInstanceId = getProviderInstanceId(providerConfig);
      const isProviderGroupEdit = !providerConfig.id && editingProviderModelIds.size > 0;
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
      const zenOAuth = isOpenCodeZenOAuth(providerConfig);
      const routeConfig = providerConfig;
      if (zenOAuth && apiKeyModels.length === 0) {
        const scope = getActiveSurfaceScope();
        const account = await aiApi.refreshSubscriptionAccount('opencode');
        if (!scope.isCurrent()) return false;
        apiKeyModels = openCodeZenModels(account.api_offerings ?? []);
      }
      if (isOpenCodeApiKeyConfig(providerConfig) && apiKeyModels.length === 0) {
        const scope = getActiveSurfaceScope();
        const discoveryConfig = buildModelDiscoveryConfig(providerConfig);
        if (!discoveryConfig) throw new Error(t('providerSelection.fillApiKeyBeforeFetch'));
        apiKeyModels = await aiApi.listModelsByConfig(discoveryConfig);
        if (!scope.isCurrent()) return false;
      }
      const configsToSave: AIModelConfigType[] = draftsToSave.map((draft) => {
        const id = providerConfig.id
          || draft.configId
          || allocateModelConfigId(draft.modelName, allocatedConfigIds);
        allocatedConfigIds.add(id);
        const apiKeyRoute = resolveOpenCodeModelRoute(routeConfig, draft.modelName, apiKeyModels);
        if ((zenOAuth || isOpenCodeApiKeyConfig(routeConfig)) && !apiKeyRoute
          && apiKeyModels.some(model => model.id === draft.modelName.trim())) {
          throw new Error(t('providerSelection.modelRoutingUnavailable'));
        }
        const existingModel = isOpenCodeApiKeyConfig(providerConfig)
          ? aiModels.find(model => model.id === (draft.configId || providerConfig.id)
            && model.model_name === draft.modelName && model.base_url === baseUrl)
          : undefined;
        const format = apiKeyRoute?.format
          || (isOpenCodeApiKeyConfig(routeConfig) ? draft.manualRequestFormat : undefined)
          || existingModel?.provider || providerConfig.provider || 'openai';
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
          api_key: providerConfig.api_key || '',
          model_name: draft.modelName,
          provider: format,
          enabled: providerConfig.enabled ?? true,
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
          recommended_for: providerConfig.recommended_for || [],
          metadata: {
            ...(providerConfig.metadata || {}),
            [PROVIDER_INSTANCE_METADATA_KEY]: providerInstanceId,
          },
          reasoning: draft.reasoning,
          ...draft.requestSettings,
          auth: providerConfig.auth || { type: 'api_key' },
        };
      });
      let previousModelsBeforeSave: AIModelConfigType[] = [];
      const updatedModels = await configManager.updateConfig<AIModelConfigType[]>('ai.models', current => {
        previousModelsBeforeSave = current;
        if (providerConfig.id) {
          if (!current.some(model => model.id === providerConfig.id)) {
            throw new Error('The model was removed while it was being edited');
          }
          return current.map(model => model.id === providerConfig.id
            ? { ...model, ...preserveModelAnnotations(model, configsToSave[0], draftsToSave[0].userTags) }
            : model);
        }
        if (isProviderGroupEdit) {
          return [
            ...current.filter(model => !providerGroupModelIds.has(model.id || '')),
            ...configsToSave.map((config, index) => preserveModelAnnotations(
              current.find(model => model.id === config.id), config, draftsToSave[index].userTags,
            )),
          ];
        }
        return [...current, ...configsToSave.map((config, index) => (
          preserveModelAnnotations(undefined, config, draftsToSave[index].userTags)
        ))];
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
      resetEditorPanels();
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

  const finishSubscriptionManagement = () => {
    if (loggingInProvider) return;
    returnSubscriptionFocusRef.current = true;
    setManagingSubscriptionProvider(null);
  };

  const closeEditingModal = () => {
    resetRemoteModelDiscovery();
    resetEditorPanels();
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
    setDraftCloseConfirmOpen(false);
    setDraftConflictConfirmOpen(false);
    pendingEditorOpenRef.current = null;
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
    if (proxyLoadState !== 'ready') return false;
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
    if (streamTimeoutLoadState !== 'ready') return false;
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
    setShowProviderManager(false);
    setShowSubscriptionManager(false);
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

  const apiProviderGroups = providerGroups.filter(group => group.models[0].auth?.type !== 'subscription');
  const subscriptionProviderGroups = providerGroups.filter(group => group.models[0].auth?.type === 'subscription');

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

  // The slot badges are projections of the existing selectors, not a second
  // set of defaults stored with each model's descriptive tags.
  const poolRoles = useMemo(() => [
    { modelId: poolDefaults.primary, label: tDefault('core.primary.label') },
    { modelId: poolDefaults.fast, label: tDefault('core.fast.label') },
    { modelId: poolDefaults.image_understanding, label: tDefault('optional.capabilities.image_understanding.label') },
    { modelId: poolDefaults.speech_recognition, label: tDefault('optional.capabilities.speech_recognition.label') },
  ], [poolDefaults, tDefault]);

  const importedSubscriptions = useMemo(() => {
    const providers = new Set<SubscriptionProvider>();
    aiModels.forEach(model => {
      if (model.auth?.type === 'subscription') providers.add(model.auth.provider);
    });
    return [...providers].map(provider => ({
      provider,
      label: subscriptionAccounts.find(account => account.provider === provider)?.display_label
        || t(`subscriptionAuth.options.${provider}`),
    }));
  }, [aiModels, subscriptionAccounts, t]);
  const poolProviderOptions = useMemo(() => {
    const providers = new Map<string, string>();
    aiModels.forEach(model => {
      const auth = model.auth;
      const label = auth?.type === 'subscription'
        ? importedSubscriptions.find(item => item.provider === auth.provider)?.label
        : undefined;
      providers.set(getPoolProviderKey(model), label || getProviderDisplayName(model));
    });
    return [...providers].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [aiModels, importedSubscriptions]);
  const subscriptionModelCount = aiModels.filter(model => model.auth?.type === 'subscription').length;
  const visiblePoolModels = useMemo(() => {
    const query = poolQuery.trim().toLowerCase();
    const priority = (model: AIModelConfigType) => (
      model.id === poolDefaults.primary ? 0 : model.id === poolDefaults.fast ? 1 : 2
    );
    return aiModels.filter(model => {
      if (poolCapability && !getEffectiveModelCapabilities(model).includes(poolCapability)) return false;
      if (poolProvider && getPoolProviderKey(model) !== poolProvider) return false;
      const labels = poolRoles.filter(role => role.modelId && role.modelId === model.id).map(role => role.label);
      return !query || [model.model_name, getProviderDisplayName(model), ...labels, ...getModelTags(model)]
        .join(' ').toLowerCase().includes(query);
    }).sort((a, b) => priority(a) - priority(b));
  }, [aiModels, poolQuery, poolCapability, poolProvider, poolRoles, poolDefaults]);

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
    const isProviderScopedEditing = !editingConfig.id && !modelPanelDraft;
    const requestSettings = singleModelEditorDraft?.requestSettings
      ?? getModelEditorRequestSettings(editingConfig);
    const updateRequestSettings = (updates: Partial<ModelEditorRequestSettings>) => {
      setSelectedModelDrafts(drafts => updateModelEditorRequestSettings(drafts, updates, singleModelEditorDraft?.key));
      if (!modelPanelDraft) {
        setEditingConfig(previous => previous ? { ...previous, ...updates } : previous);
      }
    };
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
    const catalogModelOptions: ModelDiscoveryOption[] = (catalogProvider?.models || [])
      .filter(model => (
        !selectedEndpointId
        || !model.endpoint_ids?.length
        || model.endpoint_ids.includes(selectedEndpointId)
      ))
      .map(model => ({
        label: model.display_name || model.id,
        value: model.id,
        description: model.display_name && model.display_name !== model.id ? model.id : undefined,
        source: model.source,
      }));
    const fetchedOrPresetModelOptions: ModelDiscoveryOption[] = remoteModelOptions.length > 0
      ? remoteModelOptions.map(model => ({
        label: model.display_name || model.id,
        value: model.id,
        description: model.display_name && model.display_name !== model.id ? model.id : undefined,
      }))
      : editingConfig.auth?.type === 'subscription'
        ? []
        : catalogModelOptions.length > 0
          ? catalogModelOptions
          : (currentTemplate?.models || []).map(model => ({
            label: model,
            value: model,
          }));
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

    const renderModelField = (
      label: string,
      control: React.ReactElement,
      options: { hint?: string; description?: React.ReactNode; className?: string } = {},
    ) => {
      const labelAction = options.hint ? (
        <Tooltip content={options.hint} placement="top">
          <IconButton
            size="xs"
            variant="quiet"
            aria-label={options.hint}
            icon={<Icon name="info" size="sm" />}
          />
        </Tooltip>
      ) : undefined;

      return (
        <ConfigPageRow
          label={labelAction ? (
            <span className="openbitfun-model-settings__inline-header-main">{label}{labelAction}</span>
          ) : label}
          description={options.description}
          className={options.className}
          align="center"
        >
          {control}
        </ConfigPageRow>
      );
    };

    const renderModelFields = (draft: SelectedModelDraft) => {
      const reasoningProjection = resolveDraftReasoningProjection(draft);
      const catalogHasModel = remoteModelOptions.some(model => model.id === draft.modelName.trim());
      const canEditManualRoute = remoteModelOptions.length > 0 && !catalogHasModel && !isFetchingRemoteModels;
      const savedModelId = draft.configId || editingConfig.id;
      const savedModel = savedModelId ? aiModels.find(model => model.id === savedModelId) : undefined;
      const modelRoute = resolveOpenCodeModelRoute(routeConfig, draft.modelName, remoteModelOptions)
        || (!catalogHasModel && !canEditManualRoute ? savedOpenCodeApiKeyRoute(
          { ...routeConfig, id: savedModelId },
          draft.modelName,
          savedModel,
        ) : undefined);
      const manualFormat = draft.manualRequestFormat || editingConfig.provider || 'openai';
      const contextWarning = draft.contextWindowEdited && draft.contextWindow > LONG_CONTEXT_WARNING_THRESHOLD_TOKENS ? (
        <span role="status" id={`model-context-warning-${draft.key}`} className="openbitfun-model-settings__warning-inline openbitfun-model-settings__context-window-warning">
          <AlertTriangle size={14} />
          <span>{t('form.contextWindowLongWarning')}</span>
        </span>
      ) : undefined;
      const editReasoning = () => {
        reasoningPanelInitialRef.current = {
          key: draft.key,
          reasoning: cloneReasoningConfig(draft.reasoning),
          reasoningProjectionCatalog: draft.reasoningProjectionCatalog,
          reasoningProjectionSnapshot: draft.reasoningProjectionSnapshot,
        };
        setReasoningPanelDraftKey(draft.key);
      };

      return (
        <>
          {automaticOpenCodeRouting && renderModelField(
            t('form.provider'),
            modelRoute ? (
              <span>{requestFormatLabelMap[modelRoute.format] || modelRoute.format}</span>
            ) : canEditManualRoute ? (
              <Select
                aria-label={t('form.provider')}
                value={manualFormat}
                onValueChange={value => updateModelDraft(draft.key, { manualRequestFormat: String(value) })}
                options={requestFormatOptions.filter(option => ['openai', 'responses', 'anthropic'].includes(String(option.value)))}
                size="sm"
              />
            ) : (
              <span>{t(catalogHasModel ? 'providerSelection.modelRoutingUnavailable' : 'providerSelection.modelRoutingPending')}</span>
            ),
          )}
          {renderModelField(
            t('category.label'),
            <Combobox
              aria-label={t('category.label')}
              value={draft.category}
              onValueChange={value => updateModelDraft(draft.key, { category: value as ModelCategory })}
              options={categoryOptions}
              size="sm"
              className="openbitfun-model-settings__selected-model-category-select"
            />,
          )}
          {renderModelField(
            t('form.contextWindow'),
            <NumberInput
              aria-label={t('form.contextWindow')}
              aria-describedby={contextWarning ? `model-context-warning-${draft.key}` : undefined}
              className="openbitfun-model-settings__selected-model-context-input"
              value={draft.contextWindow}
              formatValue={value => i18nService.formatNumber(value, { useGrouping: true, maximumFractionDigits: 0 })}
              onValueChange={value => updateModelDraft(draft.key, { contextWindow: value, contextWindowEdited: true })}
              min={32000}
              max={2000000}
              step={1000}
              size="sm"
              disableWheel
            />,
            {
              hint: t('form.contextWindowHint'),
              description: contextWarning,
              className: 'openbitfun-model-settings__context-window-row',
            },
          )}
          {automaticOpenCodeRouting && (modelRoute || canEditManualRoute) && renderModelField(
            t('form.resolvedUrlLabel'),
            <span className="openbitfun-model-settings__resolved-url-value">
              {modelRoute?.request_url || resolveRequestUrl(editingConfig.base_url || '', manualFormat, draft.modelName)}
            </span>,
          )}
          <ModelTagsField
            key={draft.key}
            layout="row"
            tags={draft.userTags ?? getModelUserTags(savedModel ?? {})}
            recommendedTags={savedModel?.recommended_for}
            disabled={isEditorSaving}
            onChange={userTags => updateModelDraft(draft.key, { userTags })}
          />
          <ConfigPageRow
            label={t('reasoningPresets.configTitle')}
            description={formatReasoningSummary(draft, reasoningProjection)}
            align="center"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={editReasoning}
              data-testid="settings-model-reasoning-edit"
            >
              {t('actions.edit')}
            </Button>
          </ConfigPageRow>
        </>
      );
    };

    const renderSelectedModelRows = () => {
      return (
        <div
          className="openbitfun-model-settings__selected-models-list"
          data-testid="settings-model-selected-list"
          data-selected-count={selectedModelDrafts.length}
        >
          {selectedModelDrafts.length === 0 && !isAddingCustomModel && (
            <small
              className="openbitfun-model-settings__selected-models-empty"
              data-testid="settings-model-selected-list-empty"
              data-selected-count="0"
            >
              {t('providerSelection.noModelsSelected')}
            </small>
          )}
          {selectedModelDrafts.map(draft => (
            <div
              key={draft.key}
              className="openbitfun-model-settings__model-capsule"
              data-testid="settings-model-selected-row"
              data-model-id={draft.modelName}
              data-model-name={draft.modelName}
              data-selected="true"
              data-unsaved={modelDraftHasUnsavedChanges(draft, aiModels) ? 'true' : 'false'}
            >
              <Button
                ref={element => {
                  if (element) modelCapsuleRefs.current.set(draft.key, element);
                  else modelCapsuleRefs.current.delete(draft.key);
                }}
                variant="outline"
                size="xs"
                className="openbitfun-model-settings__model-capsule-edit"
                data-testid="settings-model-capsule-edit"
                aria-label={t('providerSelection.editModelSettings', { name: draft.modelName })}
                onClick={() => openModelPanel(draft)}
                disabled={isEditorSaving}
              >
                {draft.modelName}
              </Button>
              <Tooltip content={t('providerSelection.removeModel')}>
                <IconButton
                  className="openbitfun-model-settings__model-capsule-dismiss"
                  aria-label={t('providerSelection.removeModelByName', { name: draft.modelName })}
                  data-testid="settings-model-selected-remove-btn"
                  data-model-id={draft.modelName}
                  data-model-name={draft.modelName}
                  size="xs"
                  shape="circle"
                  variant="quiet"
                  onClick={() => removeSelectedModelDraft(draft.modelName)}
                  disabled={isEditorSaving}
                  icon={<Icon name="xmark" size="xs" />}
                />
              </Tooltip>
            </div>
          ))}
          {isAddingCustomModel && (
            <Input
              autoFocus
              size="xs"
              shape="pill"
              className="openbitfun-model-settings__manual-model-input"
              data-testid="settings-model-manual-name-input"
              aria-label={t('providerSelection.addCustomModel')}
              placeholder={t('providerSelection.inputModelName')}
              value={manualModelInput}
              disabled={isEditorSaving}
              onChange={event => setManualModelInput(event.target.value)}
              onBlur={addManualModelDraft}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key !== 'Enter' && event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                if (event.key === 'Enter') addManualModelDraft();
                else cancelManualModelDraft();
                requestAnimationFrame(() => manualModelAddButtonRef.current?.focus());
              }}
            />
          )}
        </div>
      );
    };

    const authType = editingConfig.auth?.type || 'api_key';
    const authIsSubscription = authType === 'subscription';
    const showSubscriptionAuthTag = authIsSubscription && providerIdentityLocked;
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
    const subscriptionState = getSubscriptionAccountState(
      matchedSubscription, isLoadingSubscriptions, subscriptionLoadError,
    );
    const subscriptionStatusLabels = {
      loading: t('subscriptionAuth.accountState.loading'),
      loadFailed: t('subscriptionAuth.accountState.loadFailed'),
      unavailable: t('subscriptionAuth.accountState.unavailable'),
      vaultUnavailable: t('subscriptionAuth.accountState.vaultUnavailable'),
      reauthenticationRequired: t('subscriptionAuth.accountState.reauthenticationRequired'),
      disconnected: t('subscriptionAuth.notSignedIn'),
      refreshRequired: t('subscriptionAuth.accountState.refreshRequired'),
      connected: t('subscriptionAuth.accountState.connected'),
    };
    const subscriptionAccountLabel = matchedSubscription?.account?.trim()
      || (subscriptionState === 'loading'
        ? t('subscriptionAuth.loadingAccount')
        : matchedSubscription?.connected
          ? t('subscriptionAuth.accountIdentityUnavailable')
          : t('subscriptionAuth.accountUnavailable'));
    const subscriptionAccountHint = legacyOpenCode
      ? t(providerIdentityLocked ? 'subscriptionAuth.openCodeLegacyConnection' : 'subscriptionAuth.openCodeRemoved')
      : subscriptionState === 'loadFailed'
        ? t('acquisition.loadFailed')
        : subscriptionState === 'unavailable'
          ? t('subscriptionAuth.serviceUnavailable')
          : subscriptionState === 'vaultUnavailable'
            ? t('subscriptionAuth.vaultUnavailable')
            : subscriptionState === 'reauthenticationRequired'
              ? t('subscriptionAuth.reauthenticationRequired')
              : subscriptionState === 'refreshRequired'
                ? t('subscriptionAuth.credentialExpired')
                : subscriptionState === 'disconnected'
                  ? t('subscriptionAuth.signInToUse')
                  : subscriptionState === 'connected' && matchedSubscription?.expires_at != null
                    ? t('subscriptionAuth.credentialExpiresAt', {
                      time: i18nService.formatDate(new Date(matchedSubscription.expires_at * 1000), {
                        dateStyle: 'short', timeStyle: 'short',
                      }),
                    })
                    : null;

    const renderAuthRow = () => (
      <ConfigPageRow label={t('subscriptionAuth.label')} align="center" wide>
        {providerIdentityLocked ? (
          <span className="openbitfun-model-settings__connection-value" data-testid="settings-model-auth-readonly">
            {t(authIsSubscription ? 'subscriptionAuth.accountAuthentication' : 'subscriptionAuth.options.apiKey')}
          </span>
        ) : (
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
        )}
      </ConfigPageRow>
    );

    const renderSubscriptionAccountRow = () => (
      <div className="openbitfun-model-settings__connection-row openbitfun-model-settings__connection-row--single openbitfun-model-settings__subscription-account-row">
        <ConfigPageRow label={t('subscriptionAuth.accountLabel')} align="center" wide>
          <div className="openbitfun-model-settings__subscription-account" data-testid="settings-model-subscription-account">
            <div className="openbitfun-model-settings__subscription-account-heading" aria-live="polite" aria-busy={isLoadingSubscriptions}>
              <OverflowText className="openbitfun-model-settings__subscription-account-name">
                {subscriptionAccountLabel}
              </OverflowText>
              <StatusPill tone={subscriptionState === 'connected' ? 'success' : subscriptionState === 'loading' ? 'neutral' : 'warning'}>
                {subscriptionStatusLabels[subscriptionState]}
              </StatusPill>
            </div>
            <div className="openbitfun-model-settings__subscription-account-actions">
              <Tooltip content={t('subscriptionAuth.rescan')}>
                <IconButton
                  size="sm"
                  variant="quiet"
                  aria-label={t('subscriptionAuth.rescan')}
                  icon={<Icon name="refresh" size="sm" />}
                  disabled={isLoadingSubscriptions}
                  onClick={() => void refreshSubscriptionAccounts()}
                />
              </Tooltip>
              <Button
                ref={subscriptionManageButtonRef}
                size="sm"
                variant="outline"
                onClick={() => {
                  if (selectedSubscriptionProvider) setManagingSubscriptionProvider(selectedSubscriptionProvider);
                }}
              >
                {t('subscriptionAuth.manageAccount')}
              </Button>
            </div>
          </div>
        </ConfigPageRow>
        {subscriptionAccountHint && (
          <div className="openbitfun-model-settings__subscription-account-hint" aria-live="polite">
            {subscriptionAccountHint}
          </div>
        )}
      </div>
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

    const renderSingleModelEditor = () => {
      const draft = singleModelEditorDraft;
      if (!draft) return null;

      return (
        <FieldGroup
          data-testid="settings-model-editor"
          appearance="subtle"
          dividers={false}
          fieldSurface="default"
        >
          <ConfigPageRow label={t('form.modelName')} required align="center">
            <Input
              aria-label={t('form.modelName')}
              data-testid="settings-model-name-input"
              required
              invalid={showModelValidation && !draft.modelName.trim()}
              autoFocus={!!modelPanelDraft}
              value={draft.modelName}
              onChange={event => updateModelDraft(draft.key, { modelName: event.target.value })}
              size="sm"
            />
          </ConfigPageRow>
          {renderModelFields(draft)}
        </FieldGroup>
      );
    };

    const renderAdvancedSettings = () => (
      !authIsSubscription && (
        <Disclosure
          summary={t('advancedSettings.title')}
          description={isProviderScopedEditing ? t('advancedSettings.description') : undefined}
          className={isProviderScopedEditing
            ? 'openbitfun-model-settings__advanced-settings'
            : 'openbitfun-model-settings__single-model-advanced'}
          contentInnerClassName={isProviderScopedEditing ? undefined : 'openbitfun-model-settings__single-model-advanced-content'}
          open={showAdvancedSettings}
          onOpenChange={setShowAdvancedSettings}
        >
          {showAdvancedSettings && (
            <FieldGroup appearance={isProviderScopedEditing ? 'plain' : 'subtle'} dividers={false}>
              {(editingConfig.provider === 'openai' || editingConfig.provider === 'anthropic') && (
                <ConfigPageRow
                  label={t('advancedSettings.inlineThinkInText.label')}
                  description={t('advancedSettings.inlineThinkInText.hint')}
                  align="center"
                  className="openbitfun-model-settings__toggle-row"
                >
                  <Switch
                    checked={requestSettings.inline_think_in_text ?? true}
                    onChange={(e) => updateRequestSettings({ inline_think_in_text: e.target.checked })}
                  />
                </ConfigPageRow>
              )}
              <ConfigPageRow
                label={t('advancedSettings.skipSslVerify.label')}
                description={requestSettings.skip_ssl_verify ? (
                  <span className="openbitfun-model-settings__warning-inline">
                    <AlertTriangle size={14} />
                    <span>{t('advancedSettings.skipSslVerify.warning')}</span>
                  </span>
                ) : undefined}
                align="center"
                className="openbitfun-model-settings__toggle-row"
              >
                <Switch
                  checked={requestSettings.skip_ssl_verify || false}
                  onChange={(e) => updateRequestSettings({ skip_ssl_verify: e.target.checked })}
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
                              {(requestSettings.custom_headers_mode || 'merge') === 'replace'
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
                          variant={(requestSettings.custom_headers_mode || 'merge') === 'merge' ? 'fill' : 'outline'}
                          size="sm"
                          className="openbitfun-model-settings__mode-button"
                          onClick={() => updateRequestSettings({ custom_headers_mode: 'merge' })}
                        >
                          {t('advancedSettings.customHeaders.modeMerge')}
                        </Button>
                      </Tooltip>
                      <Tooltip content={t('advancedSettings.customHeaders.modeReplaceHint')} placement="top">
                        <Button
                          type="button"
                          variant={requestSettings.custom_headers_mode === 'replace' ? 'fill' : 'outline'}
                          size="sm"
                          className="openbitfun-model-settings__mode-button"
                          onClick={() => updateRequestSettings({ custom_headers_mode: 'replace' })}
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
                    {Object.entries(requestSettings.custom_headers || {}).map(([key, value], index) => (
                      <div key={index} className="openbitfun-model-settings__header-row">
                        <Input
                          value={key}
                          onChange={(e) => { const nh = { ...requestSettings.custom_headers }; const ov = nh[key]; delete nh[key]; if (e.target.value) nh[e.target.value] = ov; updateRequestSettings({ custom_headers: nh }); }}
                          placeholder={t('advancedSettings.customHeaders.keyPlaceholder')}
                          className="openbitfun-model-settings__header-key"
                          size="sm"
                        />
                        <Input
                          value={value}
                          onChange={(e) => { const nh = { ...requestSettings.custom_headers }; nh[key] = e.target.value; updateRequestSettings({ custom_headers: nh }); }}
                          placeholder={t('advancedSettings.customHeaders.valuePlaceholder')}
                          className="openbitfun-model-settings__header-value"
                          size="sm"
                        />
                        <Tooltip content={t('actions.delete')}>
                          <IconButton
                            aria-label={t('actions.delete')}
                            size="sm"
                            onClick={() => { const nh = { ...requestSettings.custom_headers }; delete nh[key]; updateRequestSettings({ custom_headers: Object.keys(nh).length > 0 ? nh : undefined }); }}
                            icon={<Icon name="xmark" size="sm" />}
                          />
                        </Tooltip>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" onClick={() => updateRequestSettings({ custom_headers: { ...requestSettings.custom_headers, '': '' } })} className="openbitfun-model-settings__add-header-btn" leadingIcon={<Icon name="plus" size="sm" />}>{t('advancedSettings.customHeaders.addHeader')}</Button>
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
                            <span>{getCustomRequestBodyModeHint(editingConfig.provider, requestSettings.custom_request_body_mode)}</span>
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
                          variant={(requestSettings.custom_request_body_mode || 'merge') === 'merge' ? 'fill' : 'outline'}
                          size="sm"
                          className="openbitfun-model-settings__mode-button"
                          onClick={() => updateRequestSettings({ custom_request_body_mode: 'merge' })}
                        >
                          {t('advancedSettings.customRequestBody.modeMerge')}
                        </Button>
                      </Tooltip>
                      <Tooltip content={getCustomRequestBodyTrimHint(editingConfig.provider)} placement="top">
                        <Button
                          type="button"
                          variant={requestSettings.custom_request_body_mode === 'trim' ? 'fill' : 'outline'}
                          size="sm"
                          className="openbitfun-model-settings__mode-button"
                          onClick={() => updateRequestSettings({ custom_request_body_mode: 'trim' })}
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
                  <Textarea value={requestSettings.custom_request_body || ''} onChange={(e) => updateRequestSettings({ custom_request_body: e.target.value })} placeholder={t('advancedSettings.customRequestBody.placeholder')} rows={8} style={{ fontFamily: 'var(--openbitfun-type-code-md-font-family)', fontSize: 'var(--openbitfun-type-code-md-font-size)' }} />
                  {requestSettings.custom_request_body && requestSettings.custom_request_body.trim() !== '' && (() => {
                    try { JSON.parse(requestSettings.custom_request_body); return <small className="openbitfun-model-settings__json-status openbitfun-model-settings__json-status--success">{t('advancedSettings.customRequestBody.validJson')}</small>; }
                    catch { return <small className="openbitfun-model-settings__json-status openbitfun-model-settings__json-status--error">{t('advancedSettings.customRequestBody.invalidJson')}</small>; }
                  })()}
                </div>
              </ConfigPageRow>
            </FieldGroup>
          )}
        </Disclosure>
      )
    );

    return (
      <>
        <div className={[
          'openbitfun-model-settings__form openbitfun-model-settings__form--modal',
          !isProviderScopedEditing && 'openbitfun-model-settings__form--single-model',
        ].filter(Boolean).join(' ')} data-openbitfun-component="model-settings" data-openbitfun-part="form">
          <div className="openbitfun-model-settings__form-content" data-openbitfun-component="model-settings" data-openbitfun-part="formBody">
            {isProviderScopedEditing && (
              <ConfigPageSection
                title={t('editProviderSettingsTitle')}
                description={t(authIsSubscription
                  ? 'subscriptionAuth.editorDescription'
                  : providerIdentityLocked ? 'editConfiguredProviderSubtitle' : 'editProviderSubtitle')}
                className="openbitfun-model-settings__edit-section openbitfun-model-settings__connection-section"
                fieldSurface="default"
              >
                <div className={[
                  'openbitfun-model-settings__connection-row',
                  showSubscriptionAuthTag && 'openbitfun-model-settings__connection-row--single',
                ].filter(Boolean).join(' ')}>
                  <ConfigPageRow label={t('form.configName')} required={!providerIdentityLocked} align="center" wide>
                    {providerIdentityLocked ? (
                      <div className="openbitfun-model-settings__provider-identity">
                        <OverflowText className="openbitfun-model-settings__connection-value" data-testid="settings-model-provider-readonly">
                          {configuredProvider ? getProviderDisplayName(configuredProvider) : editingConfig.name}
                        </OverflowText>
                        {showSubscriptionAuthTag && (
                          <StatusPill tone="neutral" data-testid="settings-model-auth-readonly">
                            {t('subscriptionAuth.accountAuthentication')}
                          </StatusPill>
                        )}
                      </div>
                    ) : (
                      <Input
                        data-testid="settings-model-provider-name-input"
                        invalid={showModelValidation && missingModelFields.name}
                        required
                        value={editingConfig.name || ''}
                        onChange={(e) => setEditingConfig(prev => ({ ...prev, name: e.target.value }))}
                        placeholder={t('form.configNamePlaceholder')}
                        size="sm"
                      />
                    )}
                  </ConfigPageRow>
                  {!showSubscriptionAuthTag && renderAuthRow()}
                </div>
                {authIsSubscription && renderSubscriptionAccountRow()}
                {!authIsSubscription && (
                  <>
                    <div className={`openbitfun-model-settings__connection-row${automaticOpenCodeRouting ? ' openbitfun-model-settings__connection-row--single' : ''}`}>
                      {renderApiKeyRow(t('form.apiKey'))}
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
                    </div>
                    <ConfigPageRow label={t('form.baseUrl')} required wide className="openbitfun-model-settings__endpoint-row">
                      <div className="openbitfun-model-settings__control-stack">
                        <div className="openbitfun-model-settings__endpoint-inputs">
                          {isFromTemplate && currentTemplate?.baseUrlOptions && currentTemplate.baseUrlOptions.length > 0 && (
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
                              options={currentTemplate.baseUrlOptions.map(opt => ({
                                label: opt.note || requestFormatLabelMap[opt.format] || opt.format,
                                value: opt.url,
                              }))}
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
                            placeholder={isFromTemplate ? currentTemplate?.baseUrl : 'https://open.bigmodel.cn/api/paas/v4/chat/completions'}
                            size="sm"
                          />
                        </div>
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
                  </>
                )}
              </ConfigPageSection>
            )}

            {isProviderScopedEditing ? (
              <ConfigPageSection
                title={t('title')}
                className="openbitfun-model-settings__edit-section"
                fieldSurface="default"
              >
                <ConfigPageRow label={t('form.modelSelection')} required wide className="openbitfun-model-settings__model-selection-row">
                  <div className="openbitfun-model-settings__control-stack">
                    <div className="openbitfun-model-settings__model-selection-actions">
                      <ModelDiscoveryPicker
                        open={modelPickerOpen}
                        onOpenChange={handleModelSelectionOpenChange}
                        options={fetchedOrPresetModelOptions}
                        value={selectedModelValues}
                        onValueChange={value => syncSelectedModelDrafts(value, editingConfig, false)}
                        loading={isFetchingRemoteModels}
                        fetched={remoteModelOptions.length > 0}
                        hint={modelFetchHint}
                        error={!!remoteModelsError}
                        invalid={showModelValidation && missingModelFields.model}
                        onRefresh={() => void fetchRemoteModels(editingConfig, true)}
                      />
                      <Button
                        ref={manualModelAddButtonRef}
                        data-testid="settings-model-add-custom-btn"
                        variant="outline"
                        size="xs"
                        disabled={isEditorSaving || isAddingCustomModel}
                        onClick={startManualModelDraft}
                      >
                        {t('providerSelection.addCustomModel')}
                      </Button>
                    </div>
                    {renderSelectedModelRows()}
                  </div>
                </ConfigPageRow>
                {renderAdvancedSettings()}
              </ConfigPageSection>
            ) : (
              <>
                {renderSingleModelEditor()}
                {renderAdvancedSettings()}
              </>
            )}
          </div>

        </div>
      </>
    );
  };

  const renderSubscriptionManagerContent = (provider?: SubscriptionProvider) => {
    const accounts = provider
      ? subscriptionAccounts.filter(account => account.provider === provider)
      : subscriptionAccounts;
    return (
      <>
        {subscriptionLoadError && (
          <ConfigRetryState message={t('acquisition.loadFailed')} retryLabel={t('messages.retry')}
            loading={isLoadingSubscriptions} onRetry={() => void refreshSubscriptionAccounts()} />
        )}
        {isLoadingSubscriptions && <p className="openbitfun-model-settings__dialog-status" role="status">{t('messages.loading')}</p>}
        {!isLoadingSubscriptions && !subscriptionLoadError && accounts.length === 0 && (
          <ConfigEmptyState icon={<Wifi aria-hidden="true" />} description={t(provider ? 'subscriptionAuth.serviceUnavailable' : 'acquisition.noServices')} />
        )}
        <div className="openbitfun-model-settings__cli-discovery" data-openbitfun-component="model-settings" data-openbitfun-part="subscriptionArea">
          {accounts.map((account) => {
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
            const anyLoginInProgress = loggingInProvider !== null || isLoadingSubscriptions || subscriptionLoadError;
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
                          disabled={anyLoginInProgress || !modelConfigReady}
                          onClick={() => requestSubscriptionLogout(account)}
                        >
                          {t('subscriptionAuth.logout')}
                        </Button>
                        {!provider && (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={anyLoginInProgress || !modelConfigReady}
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
                      <Button
                        size="sm"
                        variant="primary"
                        loading={isLoggingIn}
                        disabled={anyLoginInProgress}
                        onClick={() => void handleSubscriptionLogin(account.provider)}
                      >
                        {t(loginPanel?.status === 'failed'
                          ? 'subscriptionAuth.retryLogin'
                          : 'subscriptionAuth.login')}
                      </Button>
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
      </>
    );
  };

  const renderModelCollectionItem = (config: AIModelConfigType, presentation: 'row' | 'card' = 'row') => {
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
        {presentation === 'row' && <span
          className="openbitfun-model-settings__meta-tag"
          data-openbitfun-component="model-settings"
          data-openbitfun-part="modelMeta"
        >
          {t(`category.${config.category}`)}
        </span>}
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
            aria-label={t('pool.enableModel', { model: modelLabel })}
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

    if (presentation === 'card') {
      const roles = poolRoles.filter(role => role.modelId && role.modelId === config.id);
      const roleLabels = new Set(roles.map(role => role.label));
      const tags = getModelTags(config).filter(tag => !roleLabels.has(tag));
      return (
        <div key={config.id} className="openbitfun-model-settings__pool-item"
          data-openbitfun-component="model-settings" data-openbitfun-part="modelItem"
          data-openbitfun-state={!config.enabled ? 'disabled' : undefined}
          data-testid="settings-model-row" data-config-id={config.id || ''}
          data-model-id={config.model_name} data-model-name={config.model_name}>
          <Card appearance="subtle" padding="md" gap="sm" className="openbitfun-model-settings__pool-card">
            <CardHeader
              className="openbitfun-model-settings__pool-card-header"
              contentAlign="start"
              title={(
                <div className="openbitfun-model-settings__pool-card-title">
                  <OverflowText>{modelLabel}</OverflowText>
                  {(roles.length > 0 || tags.length > 0) && (
                    <div className="openbitfun-model-settings__pool-tags">
                      {roles.map(role => <StatusPill key={role.label} tone="neutral">{role.label}</StatusPill>)}
                      {tags.map(tag => <StatusPill key={tag} tone="neutral">{tag}</StatusPill>)}
                    </div>
                  )}
                  {(isTesting || testResult) && badge}
                </div>
              )}
            />
            <CardFooter align="between" className="openbitfun-model-settings__pool-card-footer">
              <OverflowText className="openbitfun-model-settings__pool-card-source">
                {providerDisplayName}
              </OverflowText>
              <ModelPoolCardActions
                modelLabel={modelLabel}
                enabled={config.enabled}
                isTesting={isTesting}
                connectionTestSupported={connectionTestSupported}
                onEdit={() => handleEdit(config)}
                onTest={() => void handleTest(config)}
                onDelete={() => void requestDelete(config)}
                onEnabledChange={enabled => void handleToggleEnabled(config, enabled)}
              />
            </CardFooter>
          </Card>
        </div>
      );
    }

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
    updateModelDraft(reasoningPanelDraft.key, {
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
      updateModelDraft(reasoningPanelDraft.key, {
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
  const modelsDevUpdatedAt = !modelsDevStatus
    ? t('modelsDevCatalog.loading')
    : modelsDevStatus.cache_updated_at_ms
      ? i18nService.formatDate(new Date(modelsDevStatus.cache_updated_at_ms), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
      : t('modelsDevCatalog.noCache');
  const pendingConfigSummary = (
    <span className="openbitfun-model-settings__pool-caption" role="status">
      {isConfigLoading ? t('messages.loading') : tDefault('messages.loadFailed')}
    </span>
  );
  const renderSectionLoadState = (state: 'loading' | 'ready' | 'error', onRetry: () => Promise<void>) => (
    state === 'loading' ? (
      <ConfigLoadingState label={t('messages.loading')} variant="list" />
    ) : state === 'error' ? (
      <ConfigRetryState message={t('messages.loadFailedLocked')} retryLabel={t('messages.retry')}
        onRetry={() => void onRetry()} />
    ) : null
  );
  const streamTimeoutPlaceholder = streamTimeoutLoadState === 'loading'
    ? t('messages.loading')
    : streamTimeoutLoadState === 'error' ? tDefault('messages.loadFailed') : undefined;
  const proxyPlaceholder = proxyLoadState === 'loading'
    ? t('messages.loading')
    : proxyLoadState === 'error' ? tDefault('messages.loadFailed') : undefined;

  return (
    <ConfigPageLayout className="openbitfun-model-settings" data-openbitfun-component="model-settings" data-openbitfun-part="root" data-openbitfun-view="settings">
      <ConfigPageHeader
        title={t('title')}
        subtitle={t('subtitle')}
      />

      <ConfigPageContent className="openbitfun-model-settings__content">
        <ConfigPageSection title={t('sections.acquisition')}>
          <ConfigPageRow multiline className="openbitfun-model-settings__acquisition-row"
            label={(
              <div className="openbitfun-model-settings__import-row">
                <div className="openbitfun-model-settings__import-heading">
                  <span>{t('acquisition.api')}</span>
                  {modelConfigReady && apiProviderGroups.length > 0 && (
                    <span className="openbitfun-model-settings__pool-caption">
                      {t('acquisition.configuredSummary', {
                        providers: i18nService.formatNumber(apiProviderGroups.length),
                        models: i18nService.formatNumber(aiModels.length - subscriptionModelCount),
                      })}
                    </span>
                  )}
                </div>
                <Button size="sm" onClick={handleCreateNew} disabled={!modelConfigReady} leadingIcon={<Icon name="plus" size="sm" />}>
                  {t('actions.addModel')}
                </Button>
              </div>
            )}
          >
            {!modelConfigReady ? pendingConfigSummary : apiProviderGroups.length > 0 ? (
              <ul className="openbitfun-model-settings__import-summary" aria-label={t('acquisition.api')}>
                {apiProviderGroups.map(group => (
                  <li key={group.key} className="openbitfun-model-settings__import-item">
                    <Tooltip content={group.models[0].base_url} trigger="hover-focus">
                      <Button size="sm" variant="outline" className="openbitfun-model-settings__source-pill"
                        aria-label={t('acquisition.configureProvider', { provider: group.providerName })}
                        onClick={() => handleEditProvider(group.models[0])}>
                        {group.providerName}
                      </Button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            ) : <span className="openbitfun-model-settings__pool-caption">{t('acquisition.noneConfigured')}</span>}
          </ConfigPageRow>
          <ConfigPageRow multiline className="openbitfun-model-settings__acquisition-row"
            label={(
              <div className="openbitfun-model-settings__import-row">
                <div className="openbitfun-model-settings__import-heading">
                  <span>{t('acquisition.subscriptions')}</span>
                  {modelConfigReady && subscriptionProviderGroups.length > 0 && (
                    <span className="openbitfun-model-settings__pool-caption">
                      {t('acquisition.importedSummary', {
                        providers: i18nService.formatNumber(subscriptionProviderGroups.length),
                        models: i18nService.formatNumber(subscriptionModelCount),
                      })}
                    </span>
                  )}
                </div>
                <Button size="sm" onClick={() => setShowSubscriptionManager(true)}>
                  {t('acquisition.import')}
                </Button>
              </div>
            )}
          >
            {!modelConfigReady ? pendingConfigSummary : subscriptionProviderGroups.length > 0 ? (
              <ul className="openbitfun-model-settings__import-summary" aria-label={t('acquisition.subscriptions')}>
                {subscriptionProviderGroups.map(group => (
                  <li key={group.key} className="openbitfun-model-settings__import-item">
                    <Button size="sm" variant="outline" className="openbitfun-model-settings__source-pill"
                      aria-label={t('acquisition.configureProvider', { provider: group.providerName })}
                      onClick={() => handleEditProvider(group.models[0])}>
                      {group.providerName}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : <span className="openbitfun-model-settings__pool-caption">{t('acquisition.noneImported')}</span>}
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection title={t('sections.selectionModes')}>
          <ConfigPageRow className="openbitfun-model-settings__mode-row" label={t('selectionModes.smart')} description={t('selectionModes.smartHint')} align="center">
            <StatusPill tone="neutral">{t('selectionModes.unavailable')}</StatusPill>
          </ConfigPageRow>
          <ConfigPageRow className="openbitfun-model-settings__mode-row" label={t('selectionModes.battery')} description={t('selectionModes.batteryHint')} align="center">
            <StatusPill tone="neutral">{t('selectionModes.unavailable')}</StatusPill>
          </ConfigPageRow>
        </ConfigPageSection>

        <div>
          <ConfigPageSection title={t('sections.pool')} bodySurface={false}
            extra={(
              <>
                <Tooltip content={t('pool.syncTags')}>
                  <IconButton size="sm" variant="quiet" aria-label={t('pool.syncTags')}
                    onClick={() => setShowTagSyncNotice(true)}
                    icon={<Icon name="refresh" size="sm" />} />
                </Tooltip>
                {modelsDevStatusAvailable && (
                  <Tooltip content={t('modelsDevCatalog.fetchCatalog')}>
                    <IconButton size="sm" variant="quiet" aria-label={t('modelsDevCatalog.fetchCatalog')}
                      loading={isRefreshingModelsDev}
                      onClick={() => { setShowModelsDevDetails(true); void handleRefreshModelsDev(); }}
                      icon={<Icon name="book-open" size="sm" />} />
                  </Tooltip>
                )}
                {aiModels.length > 0 && (
                  <Tooltip content={t('pool.manageConnections')}>
                    <IconButton
                      size="sm"
                      variant="quiet"
                      aria-label={t('pool.manageConnections')}
                      disabled={!modelConfigReady}
                      onClick={() => setShowProviderManager(true)}
                      icon={<Icon name="plug" size="sm" />}
                    />
                  </Tooltip>
                )}
              </>
            )}>
            <div className="openbitfun-model-settings__pool-slots">
              <DefaultModelConfig compact models={aiModels} defaultModels={poolDefaults}
                loading={isConfigLoading} disabled={configLoadError} onDefaultModelsChange={setPoolDefaults} />
            </div>
            {hasSuspendedEditorDraft && (
              <ConfigActionBar status="unsaved" statusMessage={t('draftClose.retainedHint')}
                saveLabel={t('draftClose.continueEditing')} discardLabel={t('draftClose.discardDraft')}
                onSave={() => setIsEditing(true)} onDiscard={closeEditingModal} />
            )}
            <div className="openbitfun-model-settings__pool-toolbar">
              <SearchField size="sm" value={poolQuery}
                onChange={event => setPoolQuery(event.target.value)} placeholder={t('pool.search')}
                aria-label={t('pool.search')} />
              <Select size="sm" value={poolCapability} aria-label={t('pool.capabilityFilter')}
                onValueChange={value => setPoolCapability(String(value) as ModelCapability | '')}
                options={[
                  { value: '', label: t('pool.allCapabilities') },
                  { value: 'text_chat', label: t('capabilities.text_chat') },
                  { value: 'image_understanding', label: t('capabilities.image_understanding') },
                  { value: 'speech_recognition', label: t('capabilities.speech_recognition') },
                  { value: 'function_calling', label: t('capabilities.function_calling') },
                ]} />
              <Select size="sm" value={poolProvider} aria-label={t('pool.providerFilter')}
                disabled={!modelConfigReady}
                onValueChange={value => setPoolProvider(String(value))}
                options={[{ value: '', label: t('pool.allProviders') }, ...poolProviderOptions]} />
            </div>
            {!modelConfigReady ? (
              renderSectionLoadState(isConfigLoading ? 'loading' : 'error', loadConfig)
            ) : aiModels.length > 0 ? (
              <>
                {visiblePoolModels.length > 0 ? (
                  <div className="openbitfun-model-settings__pool-grid" data-openbitfun-component="model-settings"
                    data-openbitfun-part="collection" data-testid="settings-model-pool">
                    {visiblePoolModels.map(config => renderModelCollectionItem(config, 'card'))}
                  </div>
                ) : (
                  <ConfigEmptyState icon={<Wifi aria-hidden="true" />} description={t('pool.noMatches')}
                    actions={<Button size="sm" onClick={() => { setPoolQuery(''); setPoolCapability(''); setPoolProvider(''); }}>{t('pool.clearFilter')}</Button>} />
                )}
              </>
            ) : (
              <ConfigEmptyState data-openbitfun-component="model-settings" data-openbitfun-part="empty"
                icon={<Wifi aria-hidden="true" />} description={t('pool.empty')}
                actions={<Button size="sm" onClick={() => setShowSubscriptionManager(true)}>{t('acquisition.import')}</Button>} />
            )}
          </ConfigPageSection>
        </div>

        <Disclosure summary={t('sections.more')} className="openbitfun-model-settings__more-settings"
          contentInnerClassName="openbitfun-model-settings__more-content">
          <div className="openbitfun-model-settings__advanced-sections">
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
                  placeholder={streamTimeoutPlaceholder ?? t('streamTtftTimeout.placeholder')}
                  disabled={streamTimeoutLoadState !== 'ready'}
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
                  placeholder={streamTimeoutPlaceholder ?? t('streamIdleTimeout.placeholder')}
                  disabled={streamTimeoutLoadState !== 'ready'}
                  size="sm"
                />
              </ConfigPageRow>
              {renderSectionLoadState(streamTimeoutLoadState, loadStreamTimeouts)}
              {streamTimeoutLoadState === 'ready' && <ConfigActionBar
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
              />}
            </ConfigPageSection>

            <ConfigPageSection
              title={tDefault('sections.proxy')}
              description={t('proxy.enableHint')}
            >
              <ConfigPageRow label={t('proxy.enable')} align="center">
                {proxyLoadState === 'ready' ? <Switch
                  checked={proxyConfig.enabled}
                  onChange={(e) => setProxyConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                /> : <span className="openbitfun-model-settings__loading">{proxyPlaceholder}</span>}
              </ConfigPageRow>
              <ConfigPageRow label={t('proxy.url')} description={t('proxy.urlHint')} align="center">
                <Input
                  value={proxyConfig.url}
                  onChange={(e) => setProxyConfig(prev => ({ ...prev, url: e.target.value }))}
                  placeholder={proxyPlaceholder ?? t('proxy.urlPlaceholder')}
                  disabled={proxyLoadState !== 'ready' || !proxyConfig.enabled}
                  size="sm"
                />
              </ConfigPageRow>
              <ConfigPageRow label={t('proxy.username')} align="center">
                <Input
                  value={proxyConfig.username || ''}
                  onChange={(e) => setProxyConfig(prev => ({ ...prev, username: e.target.value }))}
                  placeholder={proxyPlaceholder ?? t('proxy.usernamePlaceholder')}
                  disabled={proxyLoadState !== 'ready' || !proxyConfig.enabled}
                  size="sm"
                />
              </ConfigPageRow>
              <ConfigPageRow label={t('proxy.password')} align="center">
                <Input
                  type="password"
                  value={proxyConfig.password || ''}
                  onChange={(e) => setProxyConfig(prev => ({ ...prev, password: e.target.value }))}
                  placeholder={proxyPlaceholder ?? t('proxy.passwordPlaceholder')}
                  disabled={proxyLoadState !== 'ready' || !proxyConfig.enabled}
                  size="sm"
                />
              </ConfigPageRow>
              {renderSectionLoadState(proxyLoadState, loadProxyConfig)}
              {proxyLoadState === 'ready' && <ConfigActionBar
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
              />}
            </ConfigPageSection>
          </div>
        </Disclosure>
      </ConfigPageContent>

      <Dialog open={showSubscriptionManager}
        onOpenChange={open => { if (!open && !loggingInProvider) setShowSubscriptionManager(false); }} size="xl">
        <DialogHeader>
          <DialogHeading><DialogTitle>{t('acquisition.importTitle')}</DialogTitle></DialogHeading>
          <IconButton size="sm" aria-label={t('subscriptionAuth.rescan')}
            onClick={() => void refreshSubscriptionAccounts()} disabled={isLoadingSubscriptions}
            icon={<Icon name="refresh" size="sm" />} />
          <DialogClose disabled={!!loggingInProvider} />
        </DialogHeader>
        <DialogBody inset="none">
          {renderSubscriptionManagerContent()}
        </DialogBody>
      </Dialog>

      <Dialog open={showProviderManager} onOpenChange={setShowProviderManager} size="xl">
        <DialogHeader>
          <DialogHeading><DialogTitle>{t('pool.manageConnections')}</DialogTitle></DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
          <ConfigPageSection
            className="openbitfun-model-settings__models-section"
            bodySurface={false}
            title={tDefault('sections.providers')}
            description={t('providersDescription')}
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
        </DialogBody>
      </Dialog>

      <Dialog open={showTagSyncNotice} onOpenChange={setShowTagSyncNotice} size="sm">
        <DialogHeader>
          <DialogHeading><DialogTitle>{t('pool.syncTags')}</DialogTitle></DialogHeading>
          <DialogClose />
        </DialogHeader>
        <DialogBody><p>{t('pool.recommendationsUnavailable')}</p></DialogBody>
        <DialogFooter>
          <Button size="sm" variant="primary" onClick={() => setShowTagSyncNotice(false)}>{t('pool.acknowledge')}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog
        open={showModelsDevDetails}
        onOpenChange={(nextOpen) => { if (!nextOpen) setShowModelsDevDetails(false); }}
        size="sm"
      >
        <DialogHeader>
          <DialogHeading>
            <DialogTitle>{t('modelsDevCatalog.detailsTitle')}</DialogTitle>
          </DialogHeading>
          <Tooltip content={t('modelsDevCatalog.refreshNow')}>
            <IconButton size="sm" aria-label={t('modelsDevCatalog.refreshNow')}
              loading={isRefreshingModelsDev} onClick={() => void handleRefreshModelsDev()}
              icon={<Icon name="refresh" size="sm" />} />
          </Tooltip>
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
          if (!nextOpen && !isEditorSaving && !(managingSubscriptionProvider && loggingInProvider)) {
            requestCloseEditingModal();
          }
        }}
        className="openbitfun-model-settings__editor-dialog"
        size={editingConfig?.id ? 'lg' : 'xl'}
      >
        <DialogHeader className={modelPanelDraft && !reasoningPanelDraft
          ? 'openbitfun-model-settings__model-editor-header'
          : undefined}>
          <ToolbarGroup
            className="openbitfun-model-settings__editor-heading-group"
            gap={modelPanelDraft && !reasoningPanelDraft ? 'sm' : 'md'}
          >
            {(modelPanelDraft || managingSubscriptionProvider) && !reasoningPanelDraft && (
              <IconButton
                variant="quiet"
                size={modelPanelDraft ? 'xs' : 'sm'}
                aria-label={t('actions.back')}
                data-testid="settings-model-back-btn"
                icon={<Icon name="chevron-left" size="sm" />}
                onClick={managingSubscriptionProvider ? finishSubscriptionManagement : finishModelPanel}
                disabled={isEditorSaving || !!loggingInProvider}
              />
            )}
            <DialogHeading>
              <DialogTitle>{managingSubscriptionProvider
                ? t('subscriptionAuth.manageAccount')
                : reasoningPanelDraft
                ? t('reasoningPresets.dialogTitle', {
                  provider: editingConfig?.name?.trim()
                    || currentTemplate?.name
                    || editingConfig?.provider
                    || '',
                  model: reasoningPanelDraft.modelName,
                })
                : modelPanelDraft && editingConfig
                  ? t('modelEditorTitle', {
                    model: modelPanelDraft.modelName || t('editModel'),
                    provider: getProviderDisplayName(editingConfig),
                  })
                : singleModelEditorDraft
                  ? singleModelEditorDraft.modelName || t('editModel')
                  : (providerIdentityLocked
                    ? t('editProvider')
                    : (currentTemplate ? `${t('newProvider')} - ${currentTemplate.name}` : t('newProvider')))}</DialogTitle>
              {editingConfig && !modelPanelDraft && (singleModelEditorDraft || managingSubscriptionProvider) && !reasoningPanelDraft && (
                <DialogDescription>{getProviderDisplayName(editingConfig)}</DialogDescription>
              )}
            </DialogHeading>
          </ToolbarGroup>
          {managingSubscriptionProvider && (
            <IconButton size="sm" aria-label={t('subscriptionAuth.rescan')}
              onClick={() => void refreshSubscriptionAccounts()} disabled={isLoadingSubscriptions || !!loggingInProvider}
              icon={<Icon name="refresh" size="sm" />} />
          )}
          <DialogClose disabled={isEditorSaving || !!(managingSubscriptionProvider && loggingInProvider)} />
        </DialogHeader>
        <DialogBody
          inset="none"
          aria-busy={isEditorSaving}
          {...(isEditorSaving ? { inert: '' } : {})}
        >
          {managingSubscriptionProvider ? (
            <div
              ref={subscriptionManagementRef}
              className="openbitfun-model-settings__subscription-management"
              role="region"
              aria-label={t('subscriptionAuth.manageAccount')}
              tabIndex={-1}
            >
              {renderSubscriptionManagerContent(managingSubscriptionProvider)}
            </div>
          ) : reasoningPanelDraft ? (
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
            {managingSubscriptionProvider ? (
              <Button variant="primary" size="sm" onClick={finishSubscriptionManagement} disabled={!!loggingInProvider}>
                {t('actions.done')}
              </Button>
            ) : (
              <>
                <Button variant="fill" size="sm" onClick={modelPanelDraft ? cancelModelPanel : requestCloseEditingModal} disabled={isEditorSaving}>
                  {t('actions.cancel')}
                </Button>
                <Button
                  data-testid="settings-model-save-btn"
                  variant="primary"
                  size="sm"
                  onClick={() => modelPanelDraft ? finishModelPanel() : void handleSave()}
                  loading={isEditorSaving}
                >
                  {t(modelPanelDraft ? 'actions.done' : 'actions.save')}
                </Button>
              </>
            )}
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
