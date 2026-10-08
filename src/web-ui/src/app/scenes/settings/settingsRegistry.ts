import type { I18nNamespace } from '@/infrastructure/i18n/types';
import { lazyWithRecovery, type RecoverableLazyComponent } from '@/shared/utils/lazyWithRecovery';
import type { ComponentType } from 'react';
import type {
  SettingsCategoryId,
  SettingsPageId,
  SettingsPageProps,
  SettingsSectionId,
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

export interface SettingsSectionManifest {
  id: SettingsSectionId;
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
  sections?: readonly SettingsSectionManifest[];
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
    keywords: ['startup', 'launch', 'update', 'sleep', 'window', 'notification', 'language', 'locale'],
    namespaces: ['settings', 'settings/application'],
    searchPhrases: [
      phrase('settings/application', 'appearance.language'),
      phrase('settings/application', 'applicationGroups.startupAndUpdates.title'),
      phrase('settings/application', 'applicationGroups.windowAndNotifications.title'),
      phrase('settings/application', 'launchAtLogin.toggleLabel'),
      phrase('settings/application', 'preventSleep.toggleLabel'),
      phrase('settings/application', 'autoUpdate.toggleLabel'),
      phrase('settings/application', 'notifications.title'),
    ],
    load: () => import('./pages/application/GeneralSettingsPage'),
  }),
  definePage({
    id: 'application.appearance',
    categoryId: 'application',
    labelKey: 'navigation.pages.appearance.label',
    descriptionKey: 'navigation.pages.appearance.description',
    keywords: [
      'theme', 'font', 'size', 'motion', 'animation',
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
    load: () => import('./pages/application/AppearanceSettingsPage'),
  }),
  definePage({
    id: 'application.pet',
    categoryId: 'application',
    labelKey: 'navigation.pages.pet.label',
    descriptionKey: 'navigation.pages.pet.description',
    keywords: ['pet', 'companion', 'desktop', 'input', 'sprite'],
    namespaces: ['settings', 'settings/runtime', 'settings/agentic-tools', 'settings/voice-input'],
    searchPhrases: [
      phrase('settings/runtime', 'features.pet.title'),
      phrase('settings/runtime', 'features.pet.petDescription'),
    ],
    sections: [
      { id: 'voice-call', labelKey: 'navigation.sections.voice-call', keywords: ['realtime', 'voice call', 'assistant', 'volcengine'], searchPhrases: [phrase('settings/voice-input', 'voiceCall.title'), phrase('settings/voice-input', 'voiceCall.description')] },
      { id: 'pet', labelKey: 'navigation.sections.pet', keywords: ['pet', 'companion'], searchPhrases: [phrase('settings/runtime', 'features.pet.title')] },
    ],
    load: () => import('./pages/application/PetAssistantSettingsPage'),
  }),
  definePage({
    id: 'application.input',
    categoryId: 'application',
    labelKey: 'navigation.pages.input.label',
    descriptionKey: 'navigation.pages.input.description',
    keywords: ['input', 'voice', 'speech', 'keyboard', 'shortcut', 'keybinding', 'hotkey', 'selection', 'annotation', 'excerpt'],
    namespaces: ['settings', 'settings/application', 'settings/voice-input'],
    searchPhrases: [],
    sections: [
      {
        id: 'text-selection',
        labelKey: 'navigation.sections.text-selection',
        keywords: ['selection', 'annotation', 'excerpt', 'toolbar', 'popup', 'flowchat'],
        searchPhrases: [phrase('settings/application', 'textSelection.title'), phrase('settings/application', 'textSelection.autoShowToolbar'), phrase('settings/application', 'textSelection.autoShowToolbarDescription')],
      },
      {
        id: 'voice',
        labelKey: 'navigation.sections.voice',
        keywords: ['voice', 'speech', 'microphone', 'dictation', 'transcription'],
        searchPhrases: [phrase('settings/voice-input', 'title'), phrase('settings/voice-input', 'subtitle')],
      },
      {
        id: 'shortcuts',
        labelKey: 'navigation.sections.shortcuts',
        keywords: ['keyboard', 'shortcut', 'keybinding', 'hotkey'],
        searchPhrases: [phrase('settings', 'keyboard.title'), phrase('settings', 'keyboard.description')],
      },
    ],
    load: () => import('./pages/application/InputSettingsPage'),
  }),
  definePage({
    id: 'ai.models',
    categoryId: 'ai',
    labelKey: 'navigation.pages.models.label',
    descriptionKey: 'navigation.pages.models.description',
    keywords: ['model', 'provider', 'api key', 'base url', 'proxy', 'network', 'subscription', 'pool', 'tag', 'smart', 'battery'],
    namespaces: ['settings/models', 'settings/default-model', 'components'],
    searchPhrases: [
      phrase('settings/models', 'title'),
      phrase('settings/models', 'sections.acquisition'),
      phrase('settings/models', 'sections.selectionModes'),
      phrase('settings/models', 'sections.pool'),
      phrase('settings/models', 'selectionModes.smart'),
      phrase('settings/models', 'selectionModes.battery'),
      phrase('settings/models', 'pool.tagsLabel'),
      phrase('settings/default-model', 'sections.defaults'),
      phrase('settings/default-model', 'sections.providers'),
      phrase('settings/default-model', 'sections.proxy'),
      phrase('settings/models', 'subscriptionAuth.sectionTitle'),
      phrase('settings/models', 'modelsDevCatalog.title'),
      phrase('settings/models', 'streamIdleTimeout.title'),
    ],
    load: () => import('./pages/ai/ModelSettingsPage'),
  }),
  definePage({
    id: 'ai.session-memory',
    categoryId: 'ai',
    labelKey: 'navigation.pages.sessionMemory.label',
    descriptionKey: 'navigation.pages.sessionMemory.description',
    keywords: ['session', 'memory', 'harness', 'title', 'remember', 'recall'],
    namespaces: ['settings', 'settings/runtime', 'settings/models', 'settings/memory', 'flow-chat'],
    searchPhrases: [],
    sections: [
      {
        id: 'session',
        labelKey: 'navigation.sections.session',
        keywords: ['session', 'harness', 'mode', 'title'],
        searchPhrases: [phrase('settings/runtime', 'defaultHarness.title'), phrase('settings/models', 'sessionTitle.title')],
      },
      {
        id: 'memory',
        labelKey: 'navigation.sections.memory',
        keywords: ['memory', 'remember', 'recall', 'consolidation', 'learning', 'knowledge'],
        searchPhrases: [
          phrase('settings/memory', 'title'),
          phrase('settings/memory', 'subtitle'),
          phrase('settings/memory', 'sections.basic.title'),
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
      },
    ],
    load: () => import('./pages/ai/SessionMemorySettingsPage'),
  }),
  definePage({
    id: 'ai.execution',
    categoryId: 'ai',
    labelKey: 'navigation.pages.execution.label',
    descriptionKey: 'navigation.pages.execution.description',
    keywords: ['tool', 'timeout', 'parallel', 'review', 'json repair'],
    namespaces: ['settings', 'settings/runtime', 'settings/agentic-tools', 'settings/review-capacity', 'settings/models'],
    searchPhrases: [
      phrase('settings/runtime', 'toolExecution.sectionTitle'),
      phrase('settings/runtime', 'deferredToolLoading.sectionTitle'),
      phrase('settings/review-capacity', 'capacity.title'),
      phrase('settings/models', 'toolArgumentJsonRepair.title'),
    ],
    load: () => import('./pages/ai/ExecutionSettingsPage'),
  }),
  definePage({
    id: 'ai.permissions',
    categoryId: 'ai',
    labelKey: 'navigation.pages.permissions.label',
    descriptionKey: 'navigation.pages.permissions.description',
    keywords: ['permission', 'approval', 'rules', 'allow', 'deny', 'full access'],
    namespaces: ['settings', 'settings/runtime'],
    searchPhrases: [
      phrase('settings/runtime', 'permissionPolicy.sectionTitle'),
      phrase('settings/runtime', 'permissionPolicy.globalRules'),
      phrase('settings/runtime', 'permissionPolicy.showInChatInput'),
    ],
    load: () => import('./pages/ai/PermissionsSettingsPage'),
  }),
  definePage({
    id: 'development.editor',
    categoryId: 'development',
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
    load: () => import('./pages/development/EditorSettingsPage'),
  }),
  definePage({
    id: 'development.terminal',
    categoryId: 'development',
    labelKey: 'navigation.pages.terminal.label',
    descriptionKey: 'navigation.pages.terminal.description',
    keywords: ['terminal', 'shell', 'pwsh', 'powershell', 'panel'],
    namespaces: ['settings', 'settings/application'],
    searchPhrases: [
      phrase('settings/application', 'terminal.sections.terminal'),
      phrase('settings/application', 'terminal.controls.description'),
    ],
    load: () => import('./pages/development/TerminalSettingsPage'),
  }),
  definePage({
    id: 'development.workspace',
    categoryId: 'development',
    labelKey: 'navigation.pages.workspaceGit.label',
    descriptionKey: 'navigation.pages.workspaceGit.description',
    keywords: ['workspace', 'git', 'worktree', 'isolation', 'branch'],
    namespaces: ['settings', 'worktrees', 'settings/runtime', 'settings/quick-actions'],
    searchPhrases: [],
    sections: [
      {
        id: 'worktrees',
        labelKey: 'navigation.sections.worktrees',
        keywords: ['worktree', 'isolation', 'parallel', 'branch'],
        searchPhrases: [phrase('worktrees', 'settings.title'), phrase('worktrees', 'settings.description'), phrase('worktrees', 'management.title')],
      },
      {
        id: 'workspace-search',
        labelKey: 'navigation.sections.workspace-search',
        keywords: ['workspace search', 'files', 'index'],
        searchPhrases: [phrase('settings/runtime', 'features.workspaceSearch.title')],
      },
      {
        id: 'git',
        labelKey: 'navigation.sections.git',
        keywords: ['git', 'commit', 'co-author', 'coauthor', 'attribution', 'github'],
        searchPhrases: [phrase('settings/quick-actions', 'commitAttribution.title'), phrase('settings/quick-actions', 'commitAttribution.label')],
      },
    ],
    load: () => import('./pages/development/WorkspaceGitSettingsPage'),
  }),
  definePage({
    id: 'tools.web-search',
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
    load: () => import('./pages/tools/WebSearchSettingsPage'),
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
    load: () => import('./pages/tools/DeviceControlSettingsPage'),
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
    load: () => import('./pages/tools/McpSettingsPage'),
  }),
  definePage({
    id: 'tools.external-agents',
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
    load: () => import('./pages/tools/ExternalAgentsSettingsPage'),
  }),
  definePage({
    id: 'tools.automation',
    categoryId: 'tools',
    labelKey: 'navigation.pages.automation.label',
    descriptionKey: 'navigation.pages.automation.description',
    keywords: ['automation', 'quick action', 'hook', 'lifecycle', 'command'],
    namespaces: ['settings', 'settings/quick-actions', 'settings/hooks'],
    searchPhrases: [],
    sections: [
      {
        id: 'quick-actions',
        labelKey: 'navigation.sections.quick-actions',
        keywords: ['quick action', 'commit', 'pull request', 'post coding'],
        searchPhrases: [
          phrase('settings/quick-actions', 'page.title'),
          phrase('settings/quick-actions', 'page.subtitle'),
        ],
      },
      {
        id: 'hooks',
        labelKey: 'navigation.sections.hooks',
        keywords: ['hook', 'hooks', 'lifecycle', 'command'],
        searchPhrases: [phrase('settings/hooks', 'title'), phrase('settings/hooks', 'activation.title')],
      },
    ],
    load: () => import('./pages/tools/AutomationSettingsPage'),
  }),
  definePage({
    id: 'data.usage',
    categoryId: 'data',
    labelKey: 'navigation.pages.usage.label',
    descriptionKey: 'navigation.pages.usage.description',
    keywords: ['usage', 'token', 'cost', 'statistics', 'request', 'cache', 'history'],
    namespaces: ['settings/usage'],
    searchPhrases: [phrase('settings/usage', 'title'), phrase('settings/usage', 'subtitle')],
    load: () => import('./pages/data/UsageStatisticsSettingsPage'),
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
    load: () => import('./pages/data/ArchivedSessionsSettingsPage'),
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
      phrase('settings/application', 'logging.sections.level'),
      phrase('settings/application', 'logging.diagnostics.label'),
    ],
    load: () => import('./pages/data/DiagnosticsSettingsPage'),
  }),
] as const;

export interface SettingsCategory {
  id: SettingsCategoryId;
  labelKey: string;
  pages: readonly SettingsPageManifest[];
}

const CATEGORY_ORDER: readonly SettingsCategoryId[] = ['application', 'ai', 'development', 'tools', 'data'];

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
  const { i18nService } = await import('@/infrastructure/i18n/core/I18nService');
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
