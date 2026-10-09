export type ProductActionIcon =
  | 'message-circle'
  | 'folder'
  | 'plus'
  | 'globe'
  | 'terminal'
  | 'files'
  | 'users'
  | 'book-open'
  | 'blocks'
  | 'check-square'
  | 'chart'
  | 'gear'
  | 'keyboard'
  | 'network';

export type ProductActionId =
  | 'session.new'
  | 'project.open'
  | 'project.new'
  | 'surface.browser.open'
  | 'surface.terminal.open'
  | 'surface.files.open'
  | 'surface.agents.open'
  | 'surface.skills.open'
  | 'surface.ecosystemCompatibility.open'
  | 'surface.miniapps.open'
  | 'surface.todos.open'
  | 'surface.insights.open'
  | 'settings.open'
  | 'settings.shortcuts.open';

export interface ProductActionDefinition {
  id: ProductActionId;
  labelKey: string;
  descriptionKey: string;
  aliases: readonly string[];
  icon: ProductActionIcon;
  defaultPriority: number;
  requiresWorkspace?: boolean;
}

export const PRODUCT_ACTION_CATALOG: readonly ProductActionDefinition[] = [
  {
    id: 'session.new',
    labelKey: 'nav.search.actions.newSession',
    descriptionKey: 'nav.search.actionDescriptions.newSession',
    aliases: ['new session', 'new chat', 'create session', 'conversation'],
    icon: 'message-circle',
    defaultPriority: 100,
  },
  {
    id: 'surface.browser.open',
    labelKey: 'nav.search.actions.openBrowser',
    descriptionKey: 'nav.search.actionDescriptions.openBrowser',
    aliases: ['browser', 'web', 'url'],
    icon: 'globe',
    defaultPriority: 96,
  },
  {
    id: 'surface.terminal.open',
    labelKey: 'nav.search.actions.openTerminal',
    descriptionKey: 'nav.search.actionDescriptions.openTerminal',
    aliases: ['terminal', 'shell', 'console', 'command line'],
    icon: 'terminal',
    defaultPriority: 94,
  },
  {
    id: 'project.open',
    labelKey: 'nav.search.actions.openProject',
    descriptionKey: 'nav.search.actionDescriptions.openProject',
    aliases: ['open project', 'open folder', 'workspace'],
    icon: 'folder',
    defaultPriority: 92,
  },
  {
    id: 'project.new',
    labelKey: 'nav.search.actions.newProject',
    descriptionKey: 'nav.search.actionDescriptions.newProject',
    aliases: ['new project', 'create project'],
    icon: 'plus',
    defaultPriority: 88,
  },
  {
    id: 'surface.files.open',
    labelKey: 'nav.search.actions.openFiles',
    descriptionKey: 'nav.search.actionDescriptions.openFiles',
    aliases: ['files', 'explorer', 'project files'],
    icon: 'files',
    defaultPriority: 86,
    requiresWorkspace: true,
  },
  {
    id: 'surface.agents.open',
    labelKey: 'nav.search.actions.openAgents',
    descriptionKey: 'nav.search.actionDescriptions.openAgents',
    aliases: ['agents', 'agent'],
    icon: 'users',
    defaultPriority: 82,
  },
  {
    id: 'surface.skills.open',
    labelKey: 'nav.search.actions.openSkills',
    descriptionKey: 'nav.search.actionDescriptions.openSkills',
    aliases: ['skills', 'skill'],
    icon: 'book-open',
    defaultPriority: 80,
  },
  {
    id: 'surface.miniapps.open',
    labelKey: 'nav.search.actions.openMiniApps',
    descriptionKey: 'nav.search.actionDescriptions.openMiniApps',
    aliases: ['mini apps', 'apps', 'applications'],
    icon: 'blocks',
    defaultPriority: 78,
  },
  {
    id: 'surface.todos.open',
    labelKey: 'nav.search.actions.openTodos',
    descriptionKey: 'nav.search.actionDescriptions.openTodos',
    aliases: ['todos', 'tasks', 'checklist'],
    icon: 'check-square',
    defaultPriority: 74,
  },
  {
    id: 'surface.insights.open',
    labelKey: 'nav.search.actions.openInsights',
    descriptionKey: 'nav.search.actionDescriptions.openInsights',
    aliases: ['insights', 'analytics', 'usage'],
    icon: 'chart',
    defaultPriority: 72,
  },
  {
    id: 'settings.open',
    labelKey: 'nav.search.actions.openSettings',
    descriptionKey: 'nav.search.actionDescriptions.openSettings',
    aliases: ['settings', 'preferences', 'configuration'],
    icon: 'gear',
    defaultPriority: 70,
  },
  {
    id: 'settings.shortcuts.open',
    labelKey: 'nav.search.actions.openKeyboardShortcuts',
    descriptionKey: 'nav.search.actionDescriptions.openKeyboardShortcuts',
    aliases: ['keyboard', 'shortcuts', 'hotkeys', 'keybindings'],
    icon: 'keyboard',
    defaultPriority: 60,
  },
  {
    id: 'surface.ecosystemCompatibility.open',
    labelKey: 'nav.search.actions.openIntegrations',
    descriptionKey: 'nav.search.actionDescriptions.openIntegrations',
    aliases: ['ecosystem compatibility', 'external connections', 'integrations', 'external ai apps', 'opencode', 'claude code', 'codex'],
    icon: 'network',
    defaultPriority: 58,
  },
];
