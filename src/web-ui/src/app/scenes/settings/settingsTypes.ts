export type SettingsCategoryId =
  | 'application'
  | 'ai'
  | 'development'
  | 'tools'
  | 'data';

export type SettingsPageId =
  | 'application.general'
  | 'application.appearance'
  | 'application.pet'
  | 'application.input'
  | 'ai.models'
  | 'ai.session-memory'
  | 'ai.execution'
  | 'ai.permissions'
  | 'development.editor'
  | 'development.terminal'
  | 'development.workspace'
  | 'tools.desktop-control'
  | 'tools.automation'
  | 'tools.web-search'
  | 'tools.mcp'
  | 'tools.external-agents'
  | 'data.usage'
  | 'data.archived'
  | 'data.diagnostics';

export type SettingsViewId =
  | 'local'
  | 'ssh'
  | 'json';

/** Anchors in a single settings page, not nested pages or tab panels. */
export type SettingsSectionId =
  | 'text-selection'
  | 'pet'
  | 'voice-call'
  | 'voice'
  | 'shortcuts'
  | 'session'
  | 'memory'
  | 'workspace-search'
  | 'worktrees'
  | 'git'
  | 'quick-actions'
  | 'hooks';

export interface SettingsDestination {
  pageId: SettingsPageId;
  viewId?: SettingsViewId;
  sectionId?: SettingsSectionId;
}

export interface SettingsPageProps {
  isActive?: boolean;
  viewId?: SettingsViewId;
  sectionId?: SettingsSectionId;
  navigationRequestId: number;
}
