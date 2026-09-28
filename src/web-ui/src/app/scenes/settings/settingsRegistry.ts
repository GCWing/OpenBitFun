import { lazyWithRecovery, type RecoverableLazyComponent } from '@/shared/utils/lazyWithRecovery';
import type { ComponentType } from 'react';
import { i18nService } from '@/infrastructure/i18n/core/I18nService';
import type { I18nNamespace } from '@/infrastructure/i18n/types';
import type {
  SettingsCategoryId,
  SettingsPageId,
  SettingsPageProps,
  SettingsViewId,
} from './settingsTypes';

export interface SettingsSearchPhrase {
  namespace: I18nNamespace;
  key: string;
}

export interface SettingsViewManifest {
  id: SettingsViewId;
  labelKey: string;
  keywords: readonly string[];
  searchPhrases: readonly SettingsSearchPhrase[];
}

type SettingsPageModule = { default: ComponentType<SettingsPageProps> };

export interface SettingsPageManifest {
  id: SettingsPageId;
  categoryId: SettingsCategoryId;
  labelKey: string;
  descriptionKey: string;
  keywords: readonly string[];
  namespaces: readonly I18nNamespace[];
  searchPhrases: readonly SettingsSearchPhrase[];
  views?: readonly SettingsViewManifest[];
  load: () => Promise<SettingsPageModule>;
  component: RecoverableLazyComponent<ComponentType<SettingsPageProps>>;
}

type SettingsPageDefinition = Omit<SettingsPageManifest, 'component'>;

function definePage(definition: SettingsPageDefinition): SettingsPageManifest {
  const component = lazyWithRecovery(definition.load);
  return {
    ...definition,
    load: component.preload,
    component,
  };
}

const phrase = (namespace: I18nNamespace, key: string): SettingsSearchPhrase => ({ namespace, key });

export const SETTINGS_PAGE_MANIFESTS: readonly SettingsPageManifest[] = [
  definePage({
    id: 'application.general',
    categoryId: 'application',
    labelKey: 'navigation.pages.general.label',
    descriptionKey: 'navigation.pages.general.description',
    keywords: ['startup', 'launch', 'update', 'sleep', 'window', 'notification'],
    namespaces: ['settings', 'settings/application'],
    searchPhrases: [
      phrase('settings/application', 'applicationGroups.startupAndUpdates.title'),
      phrase('settings/application', 'applicationGroups.startupAndUpdates.description'),
      phrase('settings/application', 'applicationGroups.windowAndNotifications.title'),
      phrase('settings/application', 'applicationGroups.windowAndNotifications.description'),
      phrase('settings/application', 'launchAtLogin.title'),
      phrase('settings/application', 'autoUpdate.title'),
      phrase('settings/application', 'notifications.title'),
    ],
    load: () => import('../../../infrastructure/config/components/ApplicationSettingsPages').then((module) => ({
      default: module.GeneralSettingsPage,
    })),
  }),
  definePage({
    id: 'application.appearance',
    categoryId: 'application',
    labelKey: 'navigation.pages.appearance.label',
    descriptionKey: 'navigation.pages.appearance.description',
    keywords: [
      'theme', 'language', 'locale', 'font', 'size', 'motion', 'animation',
      'appearance pack', 'skin', 'import',
    ],
    namespaces: ['settings/appearance', 'settings/application'],
    searchPhrases: [
      phrase('settings/appearance', 'title'),
      phrase('settings/appearance', 'subtitle'),
      phrase('settings/appearance', 'package.title'),
      phrase('settings/appearance', 'package.description'),
      phrase('settings/application', 'appearance.fontSize.title'),
    ],
    load: () => import('../../../infrastructure/config/components/AppearanceSettingsPage'),
  }),
  definePage({
    id: 'application.pet',
    categoryId: 'application',
    labelKey: 'navigation.pages.pet.label',
    descriptionKey: 'navigation.pages.pet.description',
    keywords: ['pet', 'companion', 'desktop', 'input', 'sprite'],
    namespaces: ['settings', 'settings/runtime', 'settings/agentic-tools'],
    searchPhrases: [
      phrase('settings/runtime', 'features.pet.title'),
      phrase('settings/runtime', 'features.pet.petDescription'),
    ],
    load: () => import('../../../infrastructure/config/components/RuntimeSettingsPages').then((module) => ({
      default: module.PetSettingsPage,
    })),
  }),
  definePage({
    id: 'application.voice',
    categoryId: 'application',
    labelKey: 'navigation.pages.voice.label',
    descriptionKey: 'navigation.pages.voice.description',
    keywords: ['voice', 'speech', 'microphone', 'dictation', 'transcription'],
    namespaces: ['settings', 'settings/voice-input'],
    searchPhrases: [
      phrase('settings/voice-input', 'title'),
      phrase('settings/voice-input', 'subtitle'),
    ],
    load: () => import('../../../infrastructure/config/components/VoiceInputConfig'),
  }),
  definePage({
    id: 'application.shortcuts',
    categoryId: 'application',
    labelKey: 'navigation.pages.shortcuts.label',
    descriptionKey: 'navigation.pages.shortcuts.description',
    keywords: ['keyboard', 'shortcut', 'keybinding', 'hotkey'],
    namespaces: ['settings'],
    searchPhrases: [
      phrase('settings', 'keyboard.title'),
      phrase('settings', 'keyboard.description'),
    ],
    load: () => import('./components/KeyboardShortcutsTab'),
  }),
  definePage({
    id: 'application.terminal',
    categoryId: 'application',
    labelKey: 'navigation.pages.terminal.label',
    descriptionKey: 'navigation.pages.terminal.description',
    keywords: ['terminal', 'shell', 'pwsh', 'powershell', 'panel'],
    namespaces: ['settings', 'settings/application'],
    searchPhrases: [
      phrase('settings/application', 'terminal.sections.terminal'),
      phrase('settings/application', 'terminal.sections.terminalHint'),
    ],
    load: () => import('../../../infrastructure/config/components/ApplicationSettingsPages').then((module) => ({
      default: module.TerminalSettingsPage,
    })),
  }),
  definePage({
    id: 'application.editor',
    categoryId: 'application',
    labelKey: 'navigation.pages.editor.label',
    descriptionKey: 'navigation.pages.editor.description',
    keywords: ['editor', 'font', 'indent', 'minimap', 'word wrap', 'format'],
    namespaces: ['settings/editor'],
    searchPhrases: [
      phrase('settings/editor', 'title'),
      phrase('settings/editor', 'subtitle'),
      phrase('settings/editor', 'sections.appearance.title'),
      phrase('settings/editor', 'sections.behavior.title'),
      phrase('settings/editor', 'sections.display.title'),
      phrase('settings/editor', 'sections.advanced.title'),
    ],
    load: () => import('./pages/EditorSettingsPage'),
  }),
  definePage({
    id: 'ai.models',
    categoryId: 'ai',
    labelKey: 'navigation.pages.models.label',
    descriptionKey: 'navigation.pages.models.description',
    keywords: ['model', 'provider', 'api key', 'base url', 'proxy', 'network', 'subscription'],
    namespaces: ['settings/models', 'settings/default-model', 'components'],
    searchPhrases: [
      phrase('settings/models', 'title'),
      phrase('settings/default-model', 'sections.defaults'),
      phrase('settings/default-model', 'sections.providers'),
      phrase('settings/default-model', 'sections.proxy'),
      phrase('settings/models', 'streamIdleTimeout.title'),
    ],
    load: () => import('../../../infrastructure/config/components/ModelSettingsPage'),
  }),
  definePage({
    id: 'ai.memory',
    categoryId: 'ai',
    labelKey: 'navigation.pages.memory.label',
    descriptionKey: 'navigation.pages.memory.description',
    keywords: ['memory', 'remember', 'recall', 'consolidation', 'learning', 'knowledge'],
    namespaces: ['settings/memory'],
    searchPhrases: [
      phrase('settings/memory', 'title'),
      phrase('settings/memory', 'subtitle'),
      phrase('settings/memory', 'sections.basic.title'),
      phrase('settings/memory', 'sections.basic.description'),
      phrase('settings/memory', 'sections.models.title'),
      phrase('settings/memory', 'sections.advanced.title'),
      phrase('settings/memory', 'fields.memoryEnabled.label'),
      phrase('settings/memory', 'fields.generateForBtwSessions.label'),
      phrase('settings/memory', 'fields.externalContextPolicy.label'),
      phrase('settings/memory', 'fields.extractModel.label'),
      phrase('settings/memory', 'fields.consolidationModel.label'),
      phrase('settings/memory', 'fields.maxRolloutsPerStartup.label'),
      phrase('settings/memory', 'fields.maxRolloutsScanLimit.label'),
      phrase('settings/memory', 'fields.phase1MaxConcurrency.label'),
    ],
    load: () => import('../../../infrastructure/config/components/MemorySettingsPage'),
  }),
  definePage({
    id: 'workspace.session',
    categoryId: 'workspace',
    labelKey: 'navigation.pages.sessionWorkspace.label',
    descriptionKey: 'navigation.pages.sessionWorkspace.description',
    keywords: ['session', 'workspace', 'search', 'index', 'title'],
    namespaces: ['settings', 'settings/runtime', 'settings/agentic-tools', 'settings/models'],
    searchPhrases: [
      phrase('settings/runtime', 'features.workspaceSearch.title'),
      phrase('settings/models', 'sessionTitle.title'),
    ],
    load: () => import('../../../infrastructure/config/components/RuntimeSettingsPages').then((module) => ({
      default: module.SessionWorkspaceSettingsPage,
    })),
  }),
  definePage({
    id: 'workspace.worktrees',
    categoryId: 'workspace',
    labelKey: 'navigation.pages.worktrees.label',
    descriptionKey: 'navigation.pages.worktrees.description',
    keywords: ['git', 'worktree', 'isolation', 'parallel', 'branch'],
    namespaces: ['worktrees'],
    searchPhrases: [
      phrase('worktrees', 'settings.title'),
      phrase('worktrees', 'settings.description'),
      phrase('worktrees', 'management.title'),
    ],
    load: () => import('../../../infrastructure/config/components/WorktreeSettingsPage'),
  }),
  definePage({
    id: 'tools.execution',
    categoryId: 'tools',
    labelKey: 'navigation.pages.execution.label',
    descriptionKey: 'navigation.pages.execution.description',
    keywords: ['permission', 'approval', 'tool', 'timeout', 'parallel', 'review', 'json repair'],
    namespaces: ['settings', 'settings/runtime', 'settings/agentic-tools', 'settings/review-capacity', 'settings/models'],
    searchPhrases: [
      phrase('settings/runtime', 'permissionPolicy.sectionTitle'),
      phrase('settings/runtime', 'permissionPolicy.globalRules'),
      phrase('settings/runtime', 'toolExecution.sectionTitle'),
      phrase('settings/runtime', 'deferredToolLoading.sectionTitle'),
      phrase('settings/review-capacity', 'capacity.title'),
      phrase('settings/models', 'toolArgumentJsonRepair.title'),
    ],
    load: () => import('./pages/ExecutionSettingsPage'),
  }),
  definePage({
    id: 'tools.desktop-control',
    categoryId: 'tools',
    labelKey: 'navigation.pages.browserDesktopControl.label',
    descriptionKey: 'navigation.pages.browserDesktopControl.description',
    keywords: [
      'browser', 'cdp', 'chrome', 'edge', 'remote debugging', 'connection',
      'desktop', 'computer use', 'accessibility', 'screen capture', 'mouse', 'keyboard',
    ],
    namespaces: ['settings', 'settings/runtime'],
    searchPhrases: [
      phrase('settings/runtime', 'computerUse.sectionTitle'),
      phrase('settings/runtime', 'computerUse.accessibility'),
      phrase('settings/runtime', 'computerUse.screenCapture'),
      phrase('settings/runtime', 'browserControl.sectionTitle'),
      phrase('settings/runtime', 'browserControl.preferredBrowser'),
      phrase('settings/runtime', 'browserControl.autoConnectOnStartup'),
    ],
    load: () => import('../../../infrastructure/config/components/RuntimeSettingsPages').then((module) => ({
      default: module.BrowserDesktopControlSettingsPage,
    })),
  }),
  definePage({
    id: 'tools.automation',
    categoryId: 'tools',
    labelKey: 'navigation.pages.automation.label',
    descriptionKey: 'navigation.pages.automation.description',
    keywords: ['automation', 'quick action', 'hook', 'lifecycle', 'command'],
    namespaces: ['settings', 'settings/quick-actions', 'settings/hooks'],
    searchPhrases: [],
    views: [
      {
        id: 'quick-actions',
        labelKey: 'navigation.views.quick-actions',
        keywords: ['quick action', 'commit', 'pull request', 'post coding'],
        searchPhrases: [phrase('settings/quick-actions', 'page.title'), phrase('settings/quick-actions', 'page.subtitle')],
      },
      {
        id: 'hooks',
        labelKey: 'navigation.views.hooks',
        keywords: ['hook', 'hooks', 'lifecycle', 'command'],
        searchPhrases: [phrase('settings/hooks', 'title'), phrase('settings/hooks', 'activation.title')],
      },
    ],
    load: () => import('./pages/AutomationSettingsPage'),
  }),
  definePage({
    id: 'tools.webSearch',
    categoryId: 'tools',
    labelKey: 'navigation.pages.webSearch.label',
    descriptionKey: 'navigation.pages.webSearch.description',
    keywords: ['web search', 'exa', 'tavily', 'http', 'provider', 'api key'],
    namespaces: ['settings/web-search'],
    searchPhrases: [
      phrase('settings/web-search', 'title'),
      phrase('settings/web-search', 'sections.provider.title'),
      phrase('settings/web-search', 'sections.http.title'),
      phrase('settings/web-search', 'sections.credential.title'),
    ],
    load: () => import('../../../infrastructure/config/components/WebSearchSettingsPage'),
  }),
  definePage({
    id: 'tools.mcp',
    categoryId: 'tools',
    labelKey: 'navigation.pages.mcp.label',
    descriptionKey: 'navigation.pages.mcp.description',
    keywords: ['mcp', 'model context protocol', 'server', 'stdio', 'sse', 'tools'],
    namespaces: ['settings', 'settings/mcp-tools', 'settings/mcp', 'shared'],
    searchPhrases: [
      phrase('settings/mcp-tools', 'title'),
      phrase('settings/mcp', 'section.serverList.title'),
    ],
    load: () => import('../../../infrastructure/config/components/McpToolsConfig'),
  }),
  definePage({
    id: 'tools.acp',
    categoryId: 'tools',
    labelKey: 'navigation.pages.acp.label',
    descriptionKey: 'navigation.pages.acp.description',
    keywords: ['acp', 'agent client protocol', 'external agent', 'opencode', 'claude code', 'codex'],
    namespaces: ['settings', 'settings/acp-agents'],
    searchPhrases: [],
    views: [
      {
        id: 'local',
        labelKey: 'navigation.views.local',
        keywords: ['local', 'registry', 'dependency', 'cli'],
        searchPhrases: [
          phrase('settings/acp-agents', 'title'),
          phrase('settings/acp-agents', 'registry.title'),
        ],
      },
      {
        id: 'ssh',
        labelKey: 'navigation.views.ssh',
        keywords: ['ssh', 'remote', 'host', 'server'],
        searchPhrases: [phrase('settings/acp-agents', 'remote.title')],
      },
      {
        id: 'json',
        labelKey: 'navigation.views.json',
        keywords: ['json', 'advanced', 'environment variables'],
        searchPhrases: [phrase('settings/acp-agents', 'json.title')],
      },
    ],
    load: () => import('./pages/AcpSettingsPage'),
  }),
  definePage({
    id: 'data.usage',
    categoryId: 'data',
    labelKey: 'navigation.pages.usage.label',
    descriptionKey: 'navigation.pages.usage.description',
    keywords: ['usage', 'token', 'cost', 'statistics', 'request', 'cache', 'history'],
    namespaces: ['settings/usage'],
    searchPhrases: [phrase('settings/usage', 'title'), phrase('settings/usage', 'subtitle')],
    load: () => import('../../../infrastructure/config/components/UsageStatisticsConfig'),
  }),
  definePage({
    id: 'data.archived',
    categoryId: 'data',
    labelKey: 'navigation.pages.archivedSessions.label',
    descriptionKey: 'navigation.pages.archivedSessions.description',
    keywords: ['archive', 'archived', 'session', 'restore', 'unarchive', 'delete', 'history'],
    namespaces: ['common'],
    searchPhrases: [
      phrase('common', 'nav.sessions.archivedSessions'),
      phrase('common', 'nav.sessions.archivedSessionsDescription'),
      phrase('common', 'nav.sessions.restore'),
    ],
    load: () => import('./components/ArchivedSessionsConfig'),
  }),
  definePage({
    id: 'data.diagnostics',
    categoryId: 'data',
    labelKey: 'navigation.pages.diagnostics.label',
    descriptionKey: 'navigation.pages.diagnostics.description',
    keywords: ['log', 'logging', 'diagnostics', 'debug', 'maintenance'],
    namespaces: ['settings', 'settings/application'],
    searchPhrases: [
      phrase('settings/application', 'logging.sections.logging'),
      phrase('settings/application', 'logging.sections.loggingHint'),
    ],
    load: () => import('../../../infrastructure/config/components/ApplicationSettingsPages').then((module) => ({
      default: module.DiagnosticsSettingsPage,
    })),
  }),
] as const;

export interface SettingsCategory {
  id: SettingsCategoryId;
  labelKey: string;
  pages: readonly SettingsPageManifest[];
}

const CATEGORY_ORDER: readonly SettingsCategoryId[] = ['application', 'ai', 'workspace', 'tools', 'data'];

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = CATEGORY_ORDER.map((categoryId) => ({
  id: categoryId,
  labelKey: `navigation.categories.${categoryId}`,
  pages: SETTINGS_PAGE_MANIFESTS.filter((page) => page.categoryId === categoryId),
}));

export const DEFAULT_SETTINGS_PAGE_ID: SettingsPageId = 'application.general';

const PAGE_BY_ID = new Map(SETTINGS_PAGE_MANIFESTS.map((page) => [page.id, page]));
const readyPages = new Set<SettingsPageId>();

export function getSettingsPageManifest(pageId: SettingsPageId): SettingsPageManifest {
  return PAGE_BY_ID.get(pageId) ?? PAGE_BY_ID.get(DEFAULT_SETTINGS_PAGE_ID)!;
}

export function isSettingsPageId(value: string): value is SettingsPageId {
  return PAGE_BY_ID.has(value as SettingsPageId);
}

export function isSettingsPageReady(pageId: SettingsPageId): boolean {
  return readyPages.has(pageId);
}

async function preloadNamespaces(namespaces: readonly I18nNamespace[]): Promise<void> {
  await Promise.all(namespaces.map((namespace) => i18nService.loadNamespace(namespace).catch(() => undefined)));
}

export function preloadSettingsShell(): Promise<void> {
  return preloadNamespaces(['settings']);
}

export async function preloadSettingsPage(pageId: SettingsPageId): Promise<void> {
  if (readyPages.has(pageId)) return;
  const page = getSettingsPageManifest(pageId);
  await Promise.all([page.load(), preloadNamespaces(page.namespaces)]);
  readyPages.add(pageId);
}
