import { OverflowText,
  Button,
  Icon,
  IconButton,
  NumberInput,
  Select,
  Switch,
  StatusPill,
  Tooltip,
  type ComboboxOption,
  type SelectOption,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ConfigLoadingState,
  ConfigMessage,
  ConfigRefreshButton,
  ConfigRetryState,
} from '@/infrastructure/config/components/common';
import { confirmDanger } from '@/infrastructure/confirm-dialog';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageRow,
  ConfigPageSection,
  formatStandaloneUiText,
} from './common';
import { aiExperienceConfigService, type AIExperienceSettings } from '../services/AIExperienceConfigService';
import {
  DEFAULT_AGENT_COMPANION_PET,
  deleteAgentCompanionPetPackage,
  importAgentCompanionPetPackage,
  listAgentCompanionPets,
  releaseAgentCompanionPetPreviewBlobs,
  type AgentCompanionPetPackage,
} from '../services/AgentCompanionPetService';
import { getPetSpriteLayout } from '../services/agentCompanionPetSprite';
import { configManager } from '../services/ConfigManager';
import { useComputerUseEnabled } from '../hooks/useComputerUseEnabled';
import {
  DEFAULT_TOOL_PERMISSION_CONFIG,
  normalizeToolPermissionConfig,
  permissionConfigService,
} from '../services/PermissionConfigService';
import { i18nService } from '@/infrastructure/i18n';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { useNotification, notificationService } from '@/shared/notification-system';
import type {
  PermissionRule,
  ToolPermissionConfig,
} from '../types';
import { GlobalPermissionRulesDialog } from './GlobalPermissionRulesDialog';
import SessionTitleConfig from './SessionTitleConfig';
import DefaultHarnessConfig from './DefaultHarnessConfig';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { isRemoteWorkspace } from '@/shared/types/global-state';
import { WORKSPACE_SEARCH_AVAILABLE } from '@/infrastructure/config/workspaceSearchAvailability';
import ReviewCapacitySection from './ReviewCapacitySection';
import ToolJsonRepairSection from './ToolJsonRepairSection';
import { open } from '@tauri-apps/plugin-dialog';
import { createLogger } from '@/shared/utils/logger';
import { usePeerDeviceModeOptional } from '@/infrastructure/peer-device/peerDeviceContextState';
import './RuntimeSettingsPages.scss';

type DescribedSelectOption = SelectOption & { description?: string };

const log = createLogger('RuntimeSettings');

const IS_TAURI_DESKTOP = typeof window !== 'undefined' && '__TAURI__' in window;

/**
 * A peer host that refuses Browser Control / Computer Use (CLI Peer returns
 * "local-only and cannot run on peer"; Desktop Peer would surface a different
 * error). We detect that string so the settings section can show an explicit
 * "unsupported on this peer" notice instead of firing invokes that silently
 * fail on every refresh. See PR #2428 review #4 issue #1.
 */
function isPeerUnsupportedBrowserControlError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /is local-only and cannot run on peer|is not supported on CLI peer host/i.test(message);
}

type ComputerUseStatusPayload = {
  computerUseEnabled: boolean;
  accessibilityGranted: boolean;
  screenCaptureGranted: boolean;
  platformNote: string | null;
};

type BrowserControlLaunchResponse = {
  success: boolean;
  status: string;
  message: string | null;
  browserKind: string;
  setupUrl?: string;
};

type BrowserControlDisconnectResponse = {
  success: boolean;
  status: string;
  browserKind: string;
};

type BrowserControlBrowserOption = {
  value: string;
  label: string;
  installed: boolean;
};

type SubagentBatchExecutionPolicy = 'safe_only' | 'force_parallel' | 'serial';
type ToolPermissionMode = 'ask' | 'auto' | 'full_access';

const DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY: SubagentBatchExecutionPolicy = 'force_parallel';
const DEFAULT_SUBAGENT_MAX_CONCURRENCY = 5;
const DEFAULT_SWARM_MAX_CONCURRENCY = 16;
// Match the setting.tools.execution integer ranges in the product control registry.
const SUBAGENT_MAX_CONCURRENCY_LIMIT = 32;
const SWARM_MAX_CONCURRENCY_LIMIT = 64;
const SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH = 'app.flow_chat.show_permission_mode_control';

function normalizeSubagentBatchExecutionPolicy(value: unknown): SubagentBatchExecutionPolicy {
  return value === 'force_parallel' || value === 'serial' || value === 'safe_only'
    ? value
    : DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY;
}

function resolveToolPermissionMode(config: ToolPermissionConfig): ToolPermissionMode {
  if (config.policy.preset === 'full_access') return 'full_access';
  return config.interaction.auto_approve_ask ? 'auto' : 'ask';
}

function browserSetupUrlFallback(browser: string): string {
  const normalized = browser.toLowerCase();
  if (normalized.includes('edge')) return 'edge://inspect/#remote-debugging';
  if (normalized.includes('chrome')) return 'chrome://inspect/#remote-debugging';
  return '';
}

const DEFAULT_BROWSER_CONTROL_BROWSER = 'default';

export type RuntimeSettingsPageKind =
  | 'pet'
  | 'session-workspace'
  | 'execution'
  | 'browser-desktop-control';

interface RuntimeSettingsPageProps {
  page: RuntimeSettingsPageKind;
  isActive?: boolean;
}

const RuntimeSettingsPage: React.FC<RuntimeSettingsPageProps> = ({
  page,
  isActive = true,
}) => {
  const { t } = useTranslation('settings/runtime');
  const { t: tNavigation } = useTranslation('settings');
  const { t: tTools } = useTranslation('settings/agentic-tools');
  const notification = useNotification();

  // ── Session config state ─────────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const hasLoadedPageDataRef = useRef(false);
  const toolPermissionSaveInFlightRef = useRef(false);
  const [settings, setSettings] = useState<AIExperienceSettings | null>(null);
  const [companionPets, setCompanionPets] = useState<AgentCompanionPetPackage[]>([]);
  const [companionPetImporting, setCompanionPetImporting] = useState(false);
  const [companionPetDeletingPath, setCompanionPetDeletingPath] = useState<string | null>(null);
  const [enableDeferredToolLoading, setEnableDeferredToolLoading] = useState(true);
  const [subagentMaxConcurrency, setSubagentMaxConcurrency] = useState(DEFAULT_SUBAGENT_MAX_CONCURRENCY);
  const [swarmMaxConcurrency, setSwarmMaxConcurrency] = useState(DEFAULT_SWARM_MAX_CONCURRENCY);
  const [executionTimeout, setExecutionTimeout] = useState('');
  const [userQuestionTimeout, setUserQuestionTimeout] = useState('180');
  const [subagentBatchExecutionPolicy, setSubagentBatchExecutionPolicy] =
    useState<SubagentBatchExecutionPolicy>(DEFAULT_SUBAGENT_BATCH_EXECUTION_POLICY);
  const [toolExecConfigLoading, setToolExecConfigLoading] = useState(false);
  const [deferredToolLoadingConfigSaving, setDeferredToolLoadingConfigSaving] = useState(false);
  const [toolPermissionConfig, setToolPermissionConfig] = useState<ToolPermissionConfig>(DEFAULT_TOOL_PERMISSION_CONFIG);
  const [permissionConfigSaving, setPermissionConfigSaving] = useState(false);
  const [showPermissionModeControl, setShowPermissionModeControl] = useState(true);
  const [permissionModeControlVisibilitySaving, setPermissionModeControlVisibilitySaving] = useState(false);
  const [isGlobalPermissionRulesDialogOpen, setIsGlobalPermissionRulesDialogOpen] = useState(false);

  const { computerUseEnabled, setComputerUseEnabled } = useComputerUseEnabled();
  // Browser Control / Computer Use run on the host that runs the Tool. Desktop
  // Peer B executes them on B; CLI Peer refuses them (deny.rs). When the
  // rendered peer is a CLI Peer the refresh invokes return "local-only and
  // cannot run on peer" — we surface that as an explicit unsupported notice
  // instead of silently degrading. Null = controller local (no peer) or peer
  // capabilities not yet probed (optimistically supported). See PR #2428 #1.
  const peerDevice = usePeerDeviceModeOptional();
  const peerModeActive = peerDevice?.peerMode.active === true;
  const [peerBrowserControlUnsupported, setPeerBrowserControlUnsupported] = useState(false);
  const [computerUseAccess, setComputerUseAccess] = useState(false);
  const [computerUseScreen, setComputerUseScreen] = useState(false);
  const [computerUseBusy, setComputerUseBusy] = useState(false);
  const [computerUseStatusLoading, setComputerUseStatusLoading] = useState(false);
  const [computerUseStatusError, setComputerUseStatusError] = useState(false);
  const [computerUsePlatformNote, setComputerUsePlatformNote] = useState<string | null>(null);

  // ── Browser control state ───────────────────────────────────────────────
  const [browserCdpAvailable, setBrowserCdpAvailable] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [browserAutoConnectOnStartup, setBrowserAutoConnectOnStartup] = useState(false);
  const [browserDefaultCdpSupported, setBrowserDefaultCdpSupported] = useState(false);
  const [browserDefaultCdpEnabled, setBrowserDefaultCdpEnabled] = useState(false);
  const [browserSetupUrl, setBrowserSetupUrl] = useState('');
  const [browserKind, setBrowserKind] = useState('');
  const [browserVersion, setBrowserVersion] = useState<string | null>(null);
  const [browserPageCount, setBrowserPageCount] = useState(0);
  const [browserOptions, setBrowserOptions] = useState<BrowserControlBrowserOption[]>([]);
  const [preferredBrowser, setPreferredBrowser] = useState(DEFAULT_BROWSER_CONTROL_BROWSER);
  const [browserControlBusy, setBrowserControlBusy] = useState(false);
  const [browserStatusLoading, setBrowserStatusLoading] = useState(false);
  const [browserStatusError, setBrowserStatusError] = useState(false);
  const [platform, setPlatform] = useState<string>('');
  const [browserRestartPrompt, setBrowserRestartPrompt] = useState<BrowserControlLaunchResponse | null>(null);

  const refreshComputerUseStatus = useCallback(async (): Promise<boolean> => {
    if (!IS_TAURI_DESKTOP) return false;
    setComputerUseStatusLoading(true);
    setComputerUseStatusError(false);
    try {
      const s = await api.invoke<ComputerUseStatusPayload>('computer_use_get_status');
      setPeerBrowserControlUnsupported(false);
      setComputerUseEnabled(s.computerUseEnabled);
      setComputerUseAccess(s.accessibilityGranted);
      setComputerUseScreen(s.screenCaptureGranted);
      setComputerUsePlatformNote(s.platformNote);
      return true;
    } catch (error) {
      if (isPeerUnsupportedBrowserControlError(error)) {
        setPeerBrowserControlUnsupported(true);
        setComputerUseStatusError(false);
        return false;
      }
      log.error('computer_use_get_status failed', error);
      setComputerUseStatusError(true);
      return false;
    } finally {
      setComputerUseStatusLoading(false);
    }
  }, [setComputerUseEnabled]);

  const refreshBrowserControlStatus = useCallback(async () => {
    if (!IS_TAURI_DESKTOP) return;
    setBrowserStatusLoading(true);
    setBrowserStatusError(false);
    try {
      const [s, browsers] = await Promise.all([
        api.invoke<{
          cdpAvailable: boolean;
          defaultCdpSupported: boolean;
          defaultCdpEnabled: boolean;
          setupUrl?: string;
          browserReady: boolean;
          browserKind: string;
          browserVersion: string | null;
          port: number;
          pageCount: number;
        }>('browser_control_get_status', { request: { port: 9222 } }),
        api.invoke<{ options: BrowserControlBrowserOption[] }>('browser_control_list_browsers'),
      ]);
      setPeerBrowserControlUnsupported(false);
      setBrowserCdpAvailable(s.cdpAvailable);
      setBrowserDefaultCdpSupported(s.defaultCdpSupported);
      setBrowserDefaultCdpEnabled(s.defaultCdpEnabled);
      setBrowserSetupUrl(s.setupUrl ?? browserSetupUrlFallback(s.browserKind));
      setBrowserReady(s.browserReady);
      setBrowserKind(s.browserKind);
      setBrowserVersion(s.browserVersion);
      setBrowserPageCount(s.pageCount);
      setBrowserOptions(browsers.options);
    } catch (error) {
      if (isPeerUnsupportedBrowserControlError(error)) {
        setPeerBrowserControlUnsupported(true);
        setBrowserStatusError(false);
      } else {
        setBrowserStatusError(true);
        log.error('browser_control_get_status failed', error);
      }
    } finally {
      setBrowserStatusLoading(false);
    }
  }, []);

  // Browser Control / Computer Use route to the rendered host. Re-probe on every
  // surface switch (local ↔ peer A ↔ peer B): a CLI Peer returns unsupported,
  // a Desktop Peer / local host returns status. Resets the unsupported flag so
  // a switch away from a CLI Peer re-shows controls instead of the notice.
  // The current peer's deviceId is part of the dep so A→B (both peers) fires.
  const renderedPeerDeviceId = peerDevice?.peerMode.active
    ? peerDevice.peerMode.deviceId
    : null;
  useEffect(() => {
    if (!IS_TAURI_DESKTOP) return;
    setPeerBrowserControlUnsupported(false);
    if (page === 'browser-desktop-control') {
      void refreshComputerUseStatus();
      void refreshBrowserControlStatus();
      void systemAPI.getSystemInfo()
        .then((info) => setPlatform(info.platform || ''))
        .catch((error) => log.warn('getSystemInfo failed', error));
    }
  }, [
    page,
    peerModeActive,
    renderedPeerDeviceId,
    refreshComputerUseStatus,
    refreshBrowserControlStatus,
  ]);

  const reloadCompanionPets = useCallback(async () => {
    setCompanionPets(await listAgentCompanionPets());
  }, []);

  const loadPageData = useCallback(async () => {
    const isInitialLoad = !hasLoadedPageDataRef.current;
    if (isInitialLoad) {
      setIsLoading(true);
      setLoadError(false);
    }
    try {
      if (page === 'pet') {
        const [loadedSettings] = await Promise.all([
          aiExperienceConfigService.getSettingsAsync(),
          reloadCompanionPets(),
        ]);
        setSettings(loadedSettings);
      } else if (page === 'session-workspace') {
        setSettings(await aiExperienceConfigService.getSettingsAsync());
      } else if (page === 'execution') {
        const [
          deferredToolLoadingEnabled,
          loadedSubagentMaxConcurrency,
          loadedSwarmMaxConcurrency,
          execTimeout,
          loadedSubagentBatchExecutionPolicy,
          loadedToolPermissionConfig,
          loadedUserQuestionTimeout,
          loadedPermissionModeControlVisibility,
        ] = await Promise.all([
          configManager.getConfig<boolean>('ai.enable_deferred_tool_loading'),
          configManager.getConfig<number | null>('ai.subagent_max_concurrency'),
          configManager.getConfig<number | null>('ai.swarm_max_concurrency'),
          configManager.getConfig<number | null>('ai.tool_execution_timeout_secs'),
          configManager.getConfig<SubagentBatchExecutionPolicy>('ai.subagent_batch_execution_policy'),
          permissionConfigService.getConfig(),
          configManager.getOptionalConfig<number | null>('ai.user_question_timeout_secs'),
          configManager.getOptionalConfig<boolean>(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH),
        ]);
        setEnableDeferredToolLoading(deferredToolLoadingEnabled ?? true);
        setSubagentMaxConcurrency(loadedSubagentMaxConcurrency != null
          ? loadedSubagentMaxConcurrency
          : DEFAULT_SUBAGENT_MAX_CONCURRENCY);
        setSwarmMaxConcurrency(loadedSwarmMaxConcurrency != null
          ? loadedSwarmMaxConcurrency
          : DEFAULT_SWARM_MAX_CONCURRENCY);
        setExecutionTimeout(execTimeout != null ? String(execTimeout) : '');
        setUserQuestionTimeout(loadedUserQuestionTimeout === undefined || loadedUserQuestionTimeout === 180
          ? '180'
          : loadedUserQuestionTimeout === null ? '0' : String(loadedUserQuestionTimeout));
        setSubagentBatchExecutionPolicy(normalizeSubagentBatchExecutionPolicy(loadedSubagentBatchExecutionPolicy));
        setToolPermissionConfig(normalizeToolPermissionConfig(loadedToolPermissionConfig));
        setShowPermissionModeControl(loadedPermissionModeControlVisibility !== false);
      } else if (page === 'browser-desktop-control') {
        const [
          computerUseCfg,
          browserControlPreferredBrowser,
          browserControlAutoConnect,
        ] = await Promise.all([
          configManager.getConfig<boolean>('ai.computer_use_enabled'),
          configManager.getConfig<string>('ai.browser_control_preferred_browser'),
          configManager.getConfig<boolean>('ai.browser_control_auto_connect_on_startup'),
        ]);
        if (!IS_TAURI_DESKTOP) {
          setComputerUseEnabled(computerUseCfg ?? false);
        }
        setPreferredBrowser(browserControlPreferredBrowser || DEFAULT_BROWSER_CONTROL_BROWSER);
        setBrowserAutoConnectOnStartup(browserControlAutoConnect === true);
      }
      hasLoadedPageDataRef.current = true;
    } catch (error) {
      log.error('Failed to load settings page data', { page, error });
      if (isInitialLoad) setLoadError(true);
    } finally {
      if (isInitialLoad) setIsLoading(false);
    }
  }, [page, reloadCompanionPets, setComputerUseEnabled]);

  const saveToolPermissionConfig = async (
    nextConfig: ToolPermissionConfig,
    previousConfig: ToolPermissionConfig,
  ): Promise<boolean> => {
    if (toolPermissionSaveInFlightRef.current) return false;
    toolPermissionSaveInFlightRef.current = true;
    setToolPermissionConfig(nextConfig);
    setPermissionConfigSaving(true);
    try {
      await permissionConfigService.saveConfig(nextConfig);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
      return true;
    } catch (error) {
      log.error('Failed to save tool permission config', error);
      setToolPermissionConfig(previousConfig);
      notificationService.error(t('messages.saveFailed'));
      return false;
    } finally {
      toolPermissionSaveInFlightRef.current = false;
      setPermissionConfigSaving(false);
    }
  };

  const handlePermissionModeChange = async (value: string | number | (string | number)[]) => {
    const nextModeValue = String(Array.isArray(value) ? value[0] : value);
    const nextMode: ToolPermissionMode = nextModeValue === 'full_access'
      ? 'full_access'
      : nextModeValue === 'auto'
        ? 'auto'
        : 'ask';
    const previousConfig = toolPermissionConfig;
    const currentMode = resolveToolPermissionMode(previousConfig);
    if (nextMode === currentMode) return;

    if (nextMode === 'full_access') {
      const confirmed = await confirmDanger(
        t('permissionPolicy.fullAccessWarningTitle'),
        t('permissionPolicy.fullAccessWarningMessage'),
        {
          confirmText: t('permissionPolicy.fullAccessConfirm'),
          cancelText: t('permissionPolicy.cancel'),
        },
      );
      if (!confirmed) return;
    }

    await saveToolPermissionConfig(
      {
        policy: {
          ...previousConfig.policy,
          preset: nextMode === 'full_access' ? 'full_access' : 'ask',
        },
        interaction: {
          ...previousConfig.interaction,
          auto_approve_ask: nextMode === 'auto',
        },
      },
      previousConfig,
    );
  };

  const handleSaveGlobalPermissionRules = async (rules: PermissionRule[]): Promise<boolean> => {
    const previousConfig = toolPermissionConfig;
    return saveToolPermissionConfig(
      { ...previousConfig, policy: { ...previousConfig.policy, rules } },
      previousConfig,
    );
  };

  const handlePermissionModeControlVisibilityChange = async (visible: boolean) => {
    const previousVisibility = showPermissionModeControl;
    setShowPermissionModeControl(visible);
    setPermissionModeControlVisibilitySaving(true);
    try {
      await configManager.setConfig(SHOW_PERMISSION_MODE_CONTROL_CONFIG_PATH, visible);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save permission mode control visibility', error);
      setShowPermissionModeControl(previousVisibility);
      notificationService.error(t('messages.saveFailed'));
    } finally {
      setPermissionModeControlVisibilitySaving(false);
    }
  };

  useEffect(() => {
    if (page === 'pet' && !isActive) return;
    void loadPageData();
  }, [isActive, loadPageData, page]);

  // ── Session config handlers ──────────────────────────────────────────────

  const updateSetting = async <K extends keyof AIExperienceSettings>(
    key: K,
    value: AIExperienceSettings[K]
  ) => {
    if (!settings) return;
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    try {
      await aiExperienceConfigService.saveSettings({ [key]: value });
      notification.success(t('messages.saveSuccess'));
    } catch (error) {
      log.error('Failed to save AI features settings', error);
      notification.error(t('messages.saveFailed'));
      setSettings(settings);
    }
  };

  const handleImportCompanionPet = async () => {
    if (!IS_TAURI_DESKTOP) return;
    setCompanionPetImporting(true);
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t('features.pet.importDialogTitle'),
        filters: [{ name: 'Petdex', extensions: ['zip'] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const imported = await importAgentCompanionPetPackage(selected);
      await reloadCompanionPets();
      await updateSetting('agent_companion_pet', {
        id: imported.id,
        displayName: imported.displayName,
        description: imported.description,
        source: imported.source,
        packagePath: imported.packagePath,
        spritesheetPath: imported.spritesheetPath,
        spritesheetMimeType: imported.spritesheetMimeType,
        spriteVersionNumber: imported.spriteVersionNumber,
      });
    } catch (error) {
      log.error('Failed to import Agent companion pet', error);
      notification.error(t('features.pet.importFailed'));
    } finally {
      setCompanionPetImporting(false);
    }
  };

  const handleDeleteCompanionPet = async (event: React.MouseEvent, pet: AgentCompanionPetPackage) => {
    event.preventDefault();
    event.stopPropagation();
    if (!IS_TAURI_DESKTOP || pet.source !== 'user' || !settings) return;
    const confirmed = await confirmDanger(
      t('features.pet.deleteConfirmTitle'),
      t('features.pet.deleteConfirmBody'),
      { confirmText: t('features.pet.delete') },
    );
    if (!confirmed) return;
    setCompanionPetDeletingPath(pet.packagePath);
    try {
      await deleteAgentCompanionPetPackage(pet.packagePath);
      releaseAgentCompanionPetPreviewBlobs(pet.packagePath, pet.spritesheetPath);
      await reloadCompanionPets();
      if (settings.agent_companion_pet?.packagePath === pet.packagePath) {
        const next = { ...settings, agent_companion_pet: DEFAULT_AGENT_COMPANION_PET };
        setSettings(next);
        await aiExperienceConfigService.saveSettings({ agent_companion_pet: DEFAULT_AGENT_COMPANION_PET });
      }
      notification.success(t('features.pet.deleteSuccess'));
    } catch (error) {
      log.error('Failed to delete Agent companion pet', error);
      notification.error(t('features.pet.deleteFailed'));
    } finally {
      setCompanionPetDeletingPath(null);
    }
  };

  const subagentBatchExecutionPolicyOptions: DescribedSelectOption[] = [
    {
      value: 'safe_only',
      label: tTools('config.subagentBatchPolicy.safeOnly'),
      description: tTools('config.subagentBatchPolicy.safeOnlyDesc'),
    },
    {
      value: 'force_parallel',
      label: tTools('config.subagentBatchPolicy.forceParallel'),
      description: tTools('config.subagentBatchPolicy.forceParallelDesc'),
    },
  ];

  const selectedCompanionPetValue = settings?.agent_companion_pet?.packagePath
    ?? DEFAULT_AGENT_COMPANION_PET.packagePath;

  const handleCompanionPetChange = async (value: string | number | (string | number)[]) => {
    const selectedValue = String(Array.isArray(value) ? value[0] : value);
    const pet = companionPets.find(item => item.packagePath === selectedValue);
    if (!pet) return;
    await updateSetting('agent_companion_pet', {
      id: pet.id,
      displayName: pet.displayName,
      description: pet.description,
      source: pet.source,
      packagePath: pet.packagePath,
      spritesheetPath: pet.spritesheetPath,
      spritesheetMimeType: pet.spritesheetMimeType,
      spriteVersionNumber: pet.spriteVersionNumber,
    });
  };

  const handleDeferredToolLoadingChange = async (checked: boolean) => {
    const previous = enableDeferredToolLoading;
    setEnableDeferredToolLoading(checked);
    setDeferredToolLoadingConfigSaving(true);
    try {
      await configManager.setConfig('ai.enable_deferred_tool_loading', checked);
      notificationService.success(t('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save enable_deferred_tool_loading', error);
      notificationService.error(
        `${t('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
      setEnableDeferredToolLoading(previous);
    } finally {
      setDeferredToolLoadingConfigSaving(false);
    }
  };

  const handleSubagentBatchExecutionPolicyChange = async (value: string | number | (string | number)[]) => {
    const nextPolicy = normalizeSubagentBatchExecutionPolicy(Array.isArray(value) ? value[0] : value);
    const previousPolicy = subagentBatchExecutionPolicy;
    setSubagentBatchExecutionPolicy(nextPolicy);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.subagent_batch_execution_policy', nextPolicy);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
    } catch (error) {
      log.error('Failed to save subagent_batch_execution_policy', error);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
      setSubagentBatchExecutionPolicy(previousPolicy);
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleSwarmMaxConcurrencyChange = async (input: number) => {
    if (!Number.isFinite(input)) return;
    const value = Math.min(SWARM_MAX_CONCURRENCY_LIMIT, Math.max(1, Math.round(input)));
    const previous = swarmMaxConcurrency;
    setSwarmMaxConcurrency(value);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.swarm_max_concurrency', value);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save swarm_max_concurrency', error);
      setSwarmMaxConcurrency(previous);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleSubagentMaxConcurrencyChange = async (input: number) => {
    if (!Number.isFinite(input)) return;
    const value = Math.min(SUBAGENT_MAX_CONCURRENCY_LIMIT, Math.max(1, Math.round(input)));
    const previous = subagentMaxConcurrency;
    setSubagentMaxConcurrency(value);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.subagent_max_concurrency', value);
      notificationService.success(tTools('messages.saveSuccess'), { duration: 2000 });
    } catch (error) {
      log.error('Failed to save subagent_max_concurrency', error);
      setSubagentMaxConcurrency(previous);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleComputerUseEnabledChange = async (checked: boolean) => {
    setComputerUseBusy(true);
    setComputerUseEnabled(checked);
    try {
      await configManager.setConfig('ai.computer_use_enabled', checked);
      const { globalEventBus } = await import('@/infrastructure/event-bus');
      globalEventBus.emit('mode:config:updated');
      notificationService.success(
        checked ? t('messages.saveSuccess') : t('messages.saveSuccess'),
        { duration: 2000 }
      );
      if (checked) {
        // Proactively surface the OS permission prompt (macOS Accessibility /
        // Screen Recording) the moment the user opts in, instead of waiting
        // for the first agent tool call to fail with a permission error.
        try {
          await api.invoke('computer_use_request_permissions');
        } catch (permError) {
          log.warn('computer_use_request_permissions failed', permError);
        }
      }
      await refreshComputerUseStatus();
    } catch (error) {
      log.error('Failed to save computer_use_enabled', error);
      notificationService.error(t('messages.saveFailed'));
      setComputerUseEnabled(!checked);
    } finally {
      setComputerUseBusy(false);
    }
  };

  const handleComputerUseOpenSettings = async (pane: 'accessibility' | 'screen_capture') => {
    try {
      await api.invoke('computer_use_open_system_settings', { request: { pane } });
    } catch (error) {
      log.error('computer_use_open_system_settings failed', error);
      notificationService.error(t('messages.saveFailed'));
    }
  };

  const handleBrowserControlBrowserChange = async (value: string | number) => {
    const nextValue = String(value || DEFAULT_BROWSER_CONTROL_BROWSER);
    const previousValue = preferredBrowser;
    setPreferredBrowser(nextValue);
    setBrowserControlBusy(true);
    try {
      await configManager.setConfig(
        'ai.browser_control_preferred_browser',
        nextValue === DEFAULT_BROWSER_CONTROL_BROWSER ? '' : nextValue,
      );
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('Failed to save browser_control_preferred_browser', error);
      setPreferredBrowser(previousValue);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserAutoConnectChange = async (checked: boolean) => {
    const previousValue = browserAutoConnectOnStartup;
    setBrowserAutoConnectOnStartup(checked);
    try {
      await configManager.setConfig('ai.browser_control_auto_connect_on_startup', checked);
    } catch (error) {
      log.error('Failed to save browser_control_auto_connect_on_startup', error);
      setBrowserAutoConnectOnStartup(previousValue);
      notificationService.error(
        `${tTools('messages.saveFailed')}: ` + (error instanceof Error ? error.message : String(error))
      );
    }
  };

  const presentBrowserControlLaunchResult = (result: BrowserControlLaunchResponse) => {
    const setupUrl = result.setupUrl
      || browserSetupUrl
      || browserSetupUrlFallback(result.browserKind);
    if (result.success) {
      notificationService.success(
        t('browserControl.connectSuccess', { browser: result.browserKind }),
        { duration: 3000 }
      );
    } else if (result.status === 'requires_user_profile_setup') {
      notificationService.info(
        t('browserControl.userProfileSetupRequired', {
          browser: result.browserKind,
          url: setupUrl,
        }),
        { duration: 12000 }
      );
    } else if (result.status === 'requires_manual_user_profile_setup') {
      // The platform could not open the settings page, so the URL itself is
      // the actionable part of the message.
      notificationService.info(
        t('browserControl.userProfileSetupManual', {
          browser: result.browserKind,
          url: setupUrl,
        }),
        { duration: 20000 }
      );
    } else if (result.status === 'user_profile_connection_failed') {
      notificationService.info(
        t('browserControl.userProfileConnectionFailed', { browser: result.browserKind }),
        { duration: 12000 }
      );
    } else if (result.status === 'needs_restart') {
      setBrowserRestartPrompt(result);
    } else if (result.message) {
      notificationService.info(result.message, { duration: 8000 });
    }
  };

  const handleBrowserControlLaunch = async () => {
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>('browser_control_launch', { request: { port: 9222 } });
      presentBrowserControlLaunchResult(result);
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_launch failed', error);
      notificationService.error(t('browserControl.connectFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlEnableDefaultCdp = async () => {
    setBrowserControlBusy(true);
    const setupUrl = browserSetupUrl || browserSetupUrlFallback(browserKind);
    const promptNotificationId = notificationService.info(
      t(
        browserDefaultCdpEnabled
          ? 'browserControl.defaultCdpConnectPrompt'
          : 'browserControl.defaultCdpEnablePrompt',
        { browser: browserKind, url: setupUrl },
      ),
      { duration: 0 },
    );
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>(
        'browser_control_enable_default_cdp',
        { request: { port: 9222 } },
      );
      notificationService.dismiss(promptNotificationId);
      presentBrowserControlLaunchResult(result);
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_enable_default_cdp failed', error);
      notificationService.error(t('browserControl.connectFailed'));
    } finally {
      notificationService.dismiss(promptNotificationId);
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlDisconnect = async () => {
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlDisconnectResponse>(
        'browser_control_disconnect',
        { request: { port: 9222 } },
      );
      notificationService.success(
        t('browserControl.disconnectSuccess', { browser: result.browserKind }),
        { duration: 4000 },
      );
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_disconnect failed', error);
      notificationService.error(t('browserControl.disconnectFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleBrowserControlRestart = async () => {
    if (!browserRestartPrompt) return;
    setBrowserControlBusy(true);
    try {
      const result = await api.invoke<BrowserControlLaunchResponse>('browser_control_restart_with_cdp', {
        request: { port: 9222 },
      });
      if (result.success) {
        notificationService.success(
          t('browserControl.restartSuccess', { browser: result.browserKind }),
          { duration: 3000 }
        );
        setBrowserRestartPrompt(null);
      } else if (result.message) {
        notificationService.info(result.message, { duration: 8000 });
      }
      await refreshBrowserControlStatus();
    } catch (error) {
      log.error('browser_control_restart_with_cdp failed', error);
      notificationService.error(t('browserControl.restartFailed'));
    } finally {
      setBrowserControlBusy(false);
    }
  };

  const handleToolTimeoutChange = async (value: string) => {
    const configKey = 'ai.tool_execution_timeout_secs';
    const trimmedValue = value.trim();
    if (trimmedValue !== '') {
      const numValue = parseInt(trimmedValue, 10);
      if (Number.isNaN(numValue) || numValue < 0) return;
    }
    const previous = executionTimeout;
    setExecutionTimeout(trimmedValue);
    setToolExecConfigLoading(true);
    const numValue = trimmedValue === '' ? null : parseInt(trimmedValue, 10);
    try {
      await configManager.setConfig(configKey, numValue);
    } catch (error) {
      log.error('Failed to save tool timeout config', { error });
      setExecutionTimeout(previous);
      notificationService.error(tTools('messages.saveFailed'));
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  const handleUserQuestionTimeoutChange = async (value: string) => {
    const trimmed = value.trim();
    if (trimmed !== '' && (!/^\d+$/.test(trimmed) || Number(trimmed) > 3600)) return;
    if (toolExecConfigLoading || Number(trimmed) === Number(userQuestionTimeout)) return;
    const previous = userQuestionTimeout;
    setUserQuestionTimeout(trimmed);
    setToolExecConfigLoading(true);
    try {
      await configManager.setConfig('ai.user_question_timeout_secs', trimmed === '' ? null : Number(trimmed));
    } catch (error) {
      log.error('Failed to save user question timeout config', { error });
      setUserQuestionTimeout(previous);
      notificationService.error(tTools('messages.saveFailed'));
    } finally {
      setToolExecConfigLoading(false);
    }
  };

  // ── Derived values ───────────────────────────────────────────────────────

  const computerUseAccessLabel = computerUseStatusLoading
    ? t('loading.text')
    : computerUseStatusError ? t('computerUse.statusUnavailable')
    : computerUseAccess ? t('computerUse.granted') : t('computerUse.notGranted');
  const computerUseScreenLabel = computerUseStatusLoading
    ? t('loading.text')
    : computerUseStatusError ? t('computerUse.statusUnavailable')
    : computerUseScreen ? t('computerUse.granted') : t('computerUse.notGranted');
  const computerUsePlatformMessage = computerUsePlatformNote
    ? platform === 'macos'
      ? t('computerUse.platformNotes.macos')
      : platform === 'windows'
        ? t('computerUse.platformNotes.windows')
        : platform === 'linux'
          ? t('computerUse.platformNotes.linux')
          : t('computerUse.platformNotes.generic')
    : null;
  const browserStatusLabel = browserStatusLoading
    ? t('loading.text')
    : browserStatusError
      ? t('browserControl.statusUnavailable')
      : browserCdpAvailable
        ? t('browserControl.connected')
        : browserReady
          ? t('browserControl.ready')
          : t('browserControl.notConnected');
  const browserStatusDescription = !browserStatusLoading && !browserStatusError
    ? browserCdpAvailable
      ? `${browserKind} · ${i18nService.formatNumber(browserPageCount)} ${t('browserControl.tabs')}`
      : browserReady ? t('browserControl.readyNotConnected') : undefined
    : undefined;
  const browserSelectOptions: ComboboxOption[] = browserOptions.map((option) => {
    const label = option.value === DEFAULT_BROWSER_CONTROL_BROWSER
      ? t('browserControl.defaultBrowser')
      : option.label;
    return {
      value: option.value,
      label: option.installed ? label : `${label} (${t('browserControl.notInstalled')})`,
      disabled: !option.installed,
    };
  });

  const pageCopyKey = page === 'session-workspace'
    ? 'sessionWorkspace'
    : page === 'browser-desktop-control'
      ? 'browserDesktopControl'
      : page;
  const pageTitle = tNavigation(`navigation.pages.${pageCopyKey}.label`);
  const pageSubtitle = tNavigation(`navigation.pages.${pageCopyKey}.description`);
  const appearanceView = page;
  const showsExecutionSettings = page === 'execution';

  const { workspace } = useCurrentWorkspace();
  const requiresExperienceSettings = page === 'pet' || page === 'session-workspace';
  if (loadError) {
    return (
      <ConfigPageLayout className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view={appearanceView}>
        <ConfigPageHeader title={pageTitle} subtitle={pageSubtitle} />
        <ConfigPageContent className="openbitfun-runtime-settings__content" data-openbitfun-component="runtime-settings" data-openbitfun-part="content">
          <ConfigRetryState
            message={t('loading.failed')}
            retryLabel={t('loading.retry')}
            onRetry={() => void loadPageData()}
          />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }
  if (isLoading || (requiresExperienceSettings && !settings)) {
    return (
      <ConfigPageLayout className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view={appearanceView}>
        <ConfigPageHeader title={pageTitle} subtitle={pageSubtitle} />
        <ConfigPageContent className="openbitfun-runtime-settings__content" data-openbitfun-component="runtime-settings" data-openbitfun-part="content">
          <ConfigLoadingState label={t('loading.text')} />
        </ConfigPageContent>
      </ConfigPageLayout>
    );
  }

  return (
    <ConfigPageLayout className="openbitfun-runtime-settings" data-openbitfun-component="runtime-settings" data-openbitfun-part="root" data-openbitfun-view={appearanceView}>
      <ConfigPageHeader title={pageTitle} subtitle={pageSubtitle} />

      <ConfigPageContent className="openbitfun-runtime-settings__content" data-openbitfun-component="runtime-settings" data-openbitfun-part="content">

        {page === 'pet' && settings ? (
          <>

        {/* ── Desktop Agent companion ───────────────────────────── */}
        <ConfigPageSection
          title={t('features.pet.title')}
          description={t('features.pet.subtitle')}
        >
          <ConfigPageRow label={t('features.pet.enable')} align="center">
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Switch
                checked={settings.enable_agent_companion}
                onChange={(e) => updateSetting('enable_agent_companion', e.target.checked)}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          className="openbitfun-runtime-settings__pet-picker"
          title={t('features.pet.petLabel')}
          description={t('features.pet.petDescription')}
          bodySurface={false}
          extra={(
            <div
              className="openbitfun-runtime-settings__pet-actions"
              data-openbitfun-component="runtime-settings"
              data-openbitfun-part="petActions"
            >
              <Button
                size="md"
                variant="primary"
                onClick={() => void handleImportCompanionPet()}
                disabled={!IS_TAURI_DESKTOP || companionPetImporting}
                title={t('features.pet.importHint')}
              >
                {companionPetImporting ? t('features.pet.importing') : t('features.pet.import')}
              </Button>
            </div>
          )}
          data-openbitfun-component="runtime-settings"
          data-openbitfun-part="petPicker"
        >
          <div
            className="openbitfun-runtime-settings__pet-chooser"
            data-openbitfun-component="runtime-settings"
            data-openbitfun-part="petChooser"
          >
            <div
              className="openbitfun-runtime-settings__pet-gallery"
              data-openbitfun-component="runtime-settings"
              data-openbitfun-part="petList"
              role="radiogroup"
              aria-label={t('features.pet.petLabel')}
            >
              {companionPets.map((pet) => {
                const label = pet.source === 'preset' && pet.id === 'blue-golden'
                  ? t('features.pet.presets.blueGolden.name')
                  : pet.displayName;
                const sourceLabel = pet.source === 'preset'
                  ? t('features.pet.groupPreset')
                  : t('features.pet.groupImported');
                const isUserPet = pet.source === 'user';
                const isDeleting = companionPetDeletingPath === pet.packagePath;
                const isSelected = pet.packagePath === selectedCompanionPetValue;
                const isDisabled = isDeleting;
                const previewStyle = {
                  '--openbitfun-pet-preview-src': `url("${pet.previewSrc}")`,
                  backgroundSize: `800% ${getPetSpriteLayout(pet.spriteVersionNumber).rows * 100}%`,
                } as React.CSSProperties;

                return (
                  <article
                    key={pet.packagePath}
                    className="openbitfun-runtime-settings__pet-card"
                    data-testid="companion-pet-card"
                    data-pet-id={pet.id}
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="petOption"
                    data-openbitfun-state={isSelected ? 'selected' : undefined}
                  >
                    <button data-overflow-trigger
                      type="button"
                      className="openbitfun-runtime-settings__pet-card-select"
                      data-openbitfun-component="runtime-settings"
                      data-openbitfun-part="petTrigger"
                      data-openbitfun-state={isSelected ? 'selected' : undefined}
                      role="radio"
                      aria-checked={isSelected}
                      aria-label={label}
                      disabled={isDisabled}
                      onClick={() => void handleCompanionPetChange(pet.packagePath)}
                    >
                      <span className="openbitfun-runtime-settings__pet-card-preview" aria-hidden>
                        <span
                          className="openbitfun-runtime-settings__pet-preview-sprite"
                          style={previewStyle}
                        />
                        {isSelected && (
                          <span className="openbitfun-runtime-settings__pet-selected-mark">
                            <Icon name="check-line" size="xs" />
                          </span>
                        )}
                      </span>
                      <span
                        className="openbitfun-runtime-settings__pet-card-body"
                        data-openbitfun-component="runtime-settings"
                        data-openbitfun-part="petOptionMain"
                      >
                        <strong><OverflowText>{label}</OverflowText></strong>
                        <OverflowText data-openbitfun-component="runtime-settings" data-openbitfun-part="petGroup">
                          {sourceLabel}
                        </OverflowText>
                      </span>
                    </button>
                    {isUserPet && IS_TAURI_DESKTOP && (
                      <Tooltip content={t('features.pet.delete')}>
                        <IconButton
                          type="button"
                          size="sm"
                          tone="danger"
                          className="openbitfun-runtime-settings__pet-card-delete"
                          disabled={isDeleting}
                          aria-label={`${t('features.pet.delete')}: ${label}`}
                          onClick={(event) => void handleDeleteCompanionPet(event, pet)}
                          icon={<Icon name="delete" size="sm" />}
                        />
                      </Tooltip>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </ConfigPageSection>

          </>
        ) : null}

        {page === 'session-workspace' && settings ? (
          <>

        <DefaultHarnessConfig />

        {/* Accelerated search is available for local workspaces only. */}
        {WORKSPACE_SEARCH_AVAILABLE && !isRemoteWorkspace(workspace) && (
          <ConfigPageSection
            title={t('features.workspaceSearch.title')}
            description={t('features.workspaceSearch.subtitle')}
          >
            <ConfigPageRow label={t('features.workspaceSearch.enable')} align="center">
              <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                <Switch
                  checked={settings.enable_workspace_search}
                  onChange={(e) => updateSetting('enable_workspace_search', e.target.checked)}
                />
              </div>
            </ConfigPageRow>
          </ConfigPageSection>
        )}

        <SessionTitleConfig />

          </>
        ) : null}

        {showsExecutionSettings ? (
          <>

        <ConfigPageSection
          title={t('permissionPolicy.sectionTitle')}
          description={t('permissionPolicy.sectionDescription')}
        >
          <ConfigPageRow
            label={t('permissionPolicy.mode')}
            description={`${resolveToolPermissionMode(toolPermissionConfig) === 'full_access'
              ? t('permissionPolicy.fullAccessDescription')
              : resolveToolPermissionMode(toolPermissionConfig) === 'auto'
                ? t('permissionPolicy.autoApproveDescription')
                : t('permissionPolicy.askDescription')} ${t('permissionPolicy.modeDescription')}`}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Select
                size="sm"
                value={resolveToolPermissionMode(toolPermissionConfig)}
                options={[
                  { value: 'ask', label: t('permissionPolicy.ask') },
                  { value: 'auto', label: t('permissionPolicy.autoApprove') },
                  { value: 'full_access', label: t('permissionPolicy.fullAccess') },
                ]}
                disabled={permissionConfigSaving}
                onValueChange={handlePermissionModeChange}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.showInChatInput')}
            description={t('permissionPolicy.showInChatInputDescription')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control">
              <Switch
                checked={showPermissionModeControl}
                disabled={permissionModeControlVisibilitySaving}
                onChange={event => void handlePermissionModeControlVisibilityChange(event.target.checked)}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={t('permissionPolicy.globalRules')}
            description={t('permissionPolicy.globalRulesDescription')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={permissionConfigSaving}
                onClick={() => setIsGlobalPermissionRulesDialogOpen(true)}
              >
                {t('permissionPolicy.manageGlobalRules')}
              </Button>
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <GlobalPermissionRulesDialog
          isOpen={isGlobalPermissionRulesDialogOpen}
          rules={toolPermissionConfig.policy.rules}
          isSaving={permissionConfigSaving}
          onSave={handleSaveGlobalPermissionRules}
          onClose={() => setIsGlobalPermissionRulesDialogOpen(false)}
        />

        {/* ── Tool execution behavior ────────────────────────────── */}
        <ConfigPageSection
          title={t('toolExecution.sectionTitle')}
          description={t('toolExecution.sectionDescription')}
        >
          <ConfigPageRow
            label={tTools('config.executionTimeout')}
            description={tTools('config.executionTimeoutDesc')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <NumberInput
                value={executionTimeout === '' ? 0 : parseInt(executionTimeout, 10)}
                onValueChange={(val) => handleToolTimeoutChange(val === 0 ? '' : String(val))}
                min={0}
                max={3600}
                step={5}
                unit={tTools('config.seconds')}
                size="sm"
                variant="compact"
                disabled={toolExecConfigLoading}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={tTools('config.userQuestionTimeout')}
            description={tTools('config.userQuestionTimeoutDesc')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <NumberInput
                value={userQuestionTimeout === '' ? 0 : parseInt(userQuestionTimeout, 10)}
                onValueChange={(val) => void handleUserQuestionTimeoutChange(val === 0 ? '0' : String(val))}
                min={0}
                max={3600}
                step={5}
                unit={tTools('config.seconds')}
                size="sm"
                variant="compact"
                disabled={toolExecConfigLoading}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={tTools('config.subagentBatchPolicy.label')}
            description={tTools('config.subagentBatchPolicy.desc')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Select
                value={subagentBatchExecutionPolicy}
                options={subagentBatchExecutionPolicyOptions.map(option => ({
                  disabled: option.disabled,
                  label: option.description
                    ? `${option.label} — ${formatStandaloneUiText(option.description)}`
                    : option.label,
                  value: option.value,
                }))}
                size="sm"
                disabled={toolExecConfigLoading}
                onValueChange={handleSubagentBatchExecutionPolicyChange}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={tTools('config.subagentMaxConcurrency')}
            description={tTools('config.subagentMaxConcurrencyDesc')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <NumberInput
                value={subagentMaxConcurrency}
                onValueChange={(val) => void handleSubagentMaxConcurrencyChange(val)}
                min={1}
                max={SUBAGENT_MAX_CONCURRENCY_LIMIT}
                step={1}
                size="sm"
                variant="compact"
                disabled={toolExecConfigLoading}
              />
            </div>
          </ConfigPageRow>
          <ConfigPageRow
            label={tTools('config.swarmMaxConcurrency')}
            description={tTools('config.swarmMaxConcurrencyDesc')}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <NumberInput
                value={swarmMaxConcurrency}
                onValueChange={(val) => void handleSwarmMaxConcurrencyChange(val)}
                min={1}
                max={SWARM_MAX_CONCURRENCY_LIMIT}
                step={1}
                size="sm"
                variant="compact"
                disabled={toolExecConfigLoading}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection
          title={t('deferredToolLoading.sectionTitle')}
          description={t('deferredToolLoading.sectionDescription')}
        >
          <ConfigPageRow
            label={t('common.enable')}
            description={!enableDeferredToolLoading ? t('deferredToolLoading.warning') : undefined}
            align="center"
          >
            <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
              <Switch
                checked={enableDeferredToolLoading}
                onChange={(event) => handleDeferredToolLoadingChange(event.target.checked)}
                disabled={deferredToolLoadingConfigSaving}
              />
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <ToolJsonRepairSection />
        <ReviewCapacitySection />

          </>
        ) : null}

        {page === 'browser-desktop-control' ? (
          <>

        {/* ── Computer use (desktop) ─────────────────────────────── */}
        <ConfigPageSection
          title={t('computerUse.sectionTitle')}
          description={
            IS_TAURI_DESKTOP ? t('computerUse.sectionDescription') : t('computerUse.desktopOnly')
          }
          extra={IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
            <ConfigRefreshButton
              tooltip={t('computerUse.refreshStatus')}
              loading={computerUseStatusLoading}
              disabled={computerUseBusy}
              onClick={() => void refreshComputerUseStatus()}
            />
          ) : undefined}
        >
          {IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
            <>
              <ConfigMessage
                message={computerUseStatusError
                  ? { type: 'error', text: t('computerUse.statusLoadFailed') }
                  : null}
              />
              <ConfigPageRow label={t('computerUse.enable')} description={t('computerUse.enableDesc')} align="center">
                <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                  <Switch
                    checked={computerUseEnabled}
                    onChange={(e) => handleComputerUseEnabledChange(e.target.checked)}
                    disabled={computerUseBusy || computerUseStatusLoading || computerUseStatusError}
                  />
                </div>
              </ConfigPageRow>
              <ConfigPageRow
                label={t('computerUse.accessibility')}
                description={t('computerUse.accessibilityDesc')}
                align="center"
                className="openbitfun-runtime-settings__status-row"
              >
                <div
                  className="openbitfun-runtime-settings__status-actions"
                  data-openbitfun-component="runtime-settings"
                  data-openbitfun-part="control"
                >
                  <StatusPill
                    tone={computerUseStatusLoading ? 'neutral' : computerUseStatusError ? 'warning' : computerUseAccess ? 'success' : 'warning'}
                    role="status"
                  >
                    {computerUseAccessLabel}
                  </StatusPill>
                  {platform === 'macos' && (
                    <Button
                      className="openbitfun-runtime-settings__row-action-btn"
                      size="sm"
                      variant="outline"
                      disabled={computerUseBusy || computerUseStatusLoading}
                      onClick={() => void handleComputerUseOpenSettings('accessibility')}
                    >
                      {t('computerUse.openSettings')}
                    </Button>
                  )}
                </div>
              </ConfigPageRow>
              <ConfigPageRow
                label={t('computerUse.screenCapture')}
                description={t('computerUse.screenCaptureDesc')}
                align="center"
                className="openbitfun-runtime-settings__status-row"
              >
                <div
                  className="openbitfun-runtime-settings__status-actions"
                  data-openbitfun-component="runtime-settings"
                  data-openbitfun-part="control"
                >
                  <StatusPill
                    tone={computerUseStatusLoading ? 'neutral' : computerUseStatusError ? 'warning' : computerUseScreen ? 'success' : 'warning'}
                    role="status"
                  >
                    {computerUseScreenLabel}
                  </StatusPill>
                  {platform === 'macos' && (
                    <Button
                      className="openbitfun-runtime-settings__row-action-btn"
                      size="sm"
                      variant="outline"
                      disabled={computerUseBusy || computerUseStatusLoading}
                      onClick={() => void handleComputerUseOpenSettings('screen_capture')}
                    >
                      {t('computerUse.openSettings')}
                    </Button>
                  )}
                </div>
              </ConfigPageRow>
              {computerUsePlatformMessage && (
                <div
                  className="openbitfun-runtime-settings__platform-note"
                  data-openbitfun-component="runtime-settings"
                  data-openbitfun-part="platformNote"
                  role="note"
                >
                  <Icon
                    aria-hidden="true"
                    className="openbitfun-runtime-settings__platform-note-icon"
                    name="info"
                    size="sm"
                  />
                  <p className="openbitfun-runtime-settings__platform-note-copy">
                    <strong>{t('computerUse.platformNote')}: </strong>
                    {computerUsePlatformMessage}
                  </p>
                </div>
              )}
            </>
          ) : peerBrowserControlUnsupported ? (
            <ConfigPageRow
              label={t('computerUse.peerUnsupported')}
              description=""
              align="center"
            >
              <span />
            </ConfigPageRow>
          ) : null}
        </ConfigPageSection>

        {/* ── Browser control (CDP) ──────────────────────────────── */}
        <ConfigPageSection
          title={t('browserControl.sectionTitle')}
          extra={IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
            <ConfigRefreshButton
              tooltip={t('browserControl.refreshStatus')}
              loading={browserStatusLoading}
              disabled={browserControlBusy}
              onClick={() => void refreshBrowserControlStatus()}
            />
          ) : undefined}
          description={
            IS_TAURI_DESKTOP ? t('browserControl.sectionDescription') : t('browserControl.desktopOnly')
          }
        >
          {IS_TAURI_DESKTOP && !peerBrowserControlUnsupported ? (
            <>
              <ConfigMessage
                message={browserStatusError
                  ? { type: 'error', text: t('browserControl.statusLoadFailed') }
                  : null}
              />
              <ConfigPageRow
                label={t('browserControl.preferredBrowser')}
                description={t(browserCdpAvailable ? 'browserControl.preferredBrowserConnectedDesc' : 'browserControl.preferredBrowserDesc')}
                align="center"
              >
                <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                  <Select
                    value={preferredBrowser}
                    options={browserSelectOptions}
                    size="sm"
                    disabled={browserCdpAvailable || browserControlBusy || browserStatusLoading || browserStatusError || browserSelectOptions.length === 0}
                    onValueChange={(value) => void handleBrowserControlBrowserChange(value)}
                  />
                </div>
              </ConfigPageRow>
              {browserDefaultCdpSupported && (
                <ConfigPageRow
                  label={t('browserControl.defaultCdp')}
                  description={t('browserControl.defaultCdpDesc')}
                  align="center"
                  className="openbitfun-runtime-settings__status-row"
                >
                  <div
                    className="openbitfun-runtime-settings__status-actions"
                    data-openbitfun-component="runtime-settings"
                    data-openbitfun-part="control"
                  >
                    <StatusPill
                      tone={browserStatusLoading ? 'neutral' : browserStatusError ? 'warning' : browserDefaultCdpEnabled ? 'success' : 'neutral'}
                      role="status"
                    >
                      {t(browserStatusLoading ? 'loading.text' : browserStatusError ? 'browserControl.statusUnavailable' : browserDefaultCdpEnabled
                        ? 'browserControl.defaultCdpEnabled'
                        : 'browserControl.defaultCdpDisabled')}
                    </StatusPill>
                  </div>
                </ConfigPageRow>
              )}
              {browserDefaultCdpSupported && (
                <ConfigPageRow
                  label={t('browserControl.autoConnectOnStartup')}
                  description={t('browserControl.autoConnectOnStartupDesc')}
                  align="center"
                >
                  <div className="openbitfun-runtime-settings__row-control" data-openbitfun-component="runtime-settings" data-openbitfun-part="control">
                    <Switch
                      checked={browserAutoConnectOnStartup}
                      onChange={(e) => void handleBrowserAutoConnectChange(e.target.checked)}
                      disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                    />
                  </div>
                </ConfigPageRow>
              )}
              <ConfigPageRow
                label={t('browserControl.status')}
                description={browserStatusDescription}
                align="center"
                className="openbitfun-runtime-settings__status-row"
              >
                <div
                  className="openbitfun-runtime-settings__status-actions"
                  data-openbitfun-component="runtime-settings"
                  data-openbitfun-part="control"
                >
                  <StatusPill
                    tone={browserStatusLoading ? 'neutral' : browserStatusError ? 'warning' : browserCdpAvailable ? 'success' : 'neutral'}
                    role="status"
                    title={browserCdpAvailable && browserVersion ? `${browserKind} ${browserVersion}` : undefined}
                  >
                    {browserStatusLabel}
                  </StatusPill>
                  {browserCdpAvailable ? (
                    <Button
                      className="openbitfun-runtime-settings__row-action-btn"
                      size="sm"
                      variant="outline"
                      disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                      onClick={() => void handleBrowserControlDisconnect()}
                    >
                      {t('browserControl.disconnect')}
                    </Button>
                  ) : (
                    <Button
                      className="openbitfun-runtime-settings__row-action-btn"
                      size="sm"
                      variant="outline"
                      disabled={browserControlBusy || browserStatusLoading || browserStatusError}
                      onClick={() => void (browserDefaultCdpSupported
                        ? handleBrowserControlEnableDefaultCdp()
                        : handleBrowserControlLaunch())}
                    >
                      {t(browserDefaultCdpSupported && !browserDefaultCdpEnabled
                        ? 'browserControl.enableDefaultCdp'
                        : 'browserControl.connect')}
                    </Button>
                  )}
                </div>
              </ConfigPageRow>
            </>
          ) : peerBrowserControlUnsupported ? (
            <ConfigPageRow
              label={t('browserControl.peerUnsupported')}
              description=""
              align="center"
            >
              <span />
            </ConfigPageRow>
          ) : null}
        </ConfigPageSection>

        <Dialog
          open={browserRestartPrompt !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && !browserControlBusy) setBrowserRestartPrompt(null);
          }}
          size="sm"
          closeOnPointerOutside={!browserControlBusy}
        >
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t('browserControl.restartModal.title')}</DialogTitle>
            </DialogHeading>
            <DialogClose />
          </DialogHeader>
          <DialogBody inset="none">
          <div className="openbitfun-debug-config__modal-body" data-openbitfun-component="runtime-settings" data-openbitfun-part="restartModal">
            <p>{t('browserControl.restartModal.description', { browser: browserRestartPrompt?.browserKind || browserKind })}</p>
            <p>{t('browserControl.restartModal.warning')}</p>
            {browserRestartPrompt?.message ? (
              <p className="openbitfun-runtime-settings__hint">{browserRestartPrompt.message}</p>
            ) : null}
          </div>
          <div className="openbitfun-debug-config__modal-footer" data-openbitfun-component="runtime-settings" data-openbitfun-part="modalFooter">
            <Button
              variant="fill"
              size="sm"
              onClick={() => setBrowserRestartPrompt(null)}
              disabled={browserControlBusy}
            >
              {t('browserControl.restartModal.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleBrowserControlRestart()}
              disabled={browserControlBusy}
            >
              {browserControlBusy
                ? t('browserControl.restartModal.restarting')
                : t('browserControl.restartModal.confirm')}
            </Button>
          </div>
                  </DialogBody>
        </Dialog>

          </>
        ) : null}

      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export function PetSettingsPage({ isActive }: { isActive?: boolean }): React.ReactElement {
  return <RuntimeSettingsPage page="pet" isActive={isActive} />;
}

export function SessionWorkspaceSettingsPage(): React.ReactElement {
  return <RuntimeSettingsPage page="session-workspace" />;
}

export function ExecutionSettingsPage(): React.ReactElement {
  return <RuntimeSettingsPage page="execution" />;
}

export function BrowserDesktopControlSettingsPage(): React.ReactElement {
  return <RuntimeSettingsPage page="browser-desktop-control" />;
}
