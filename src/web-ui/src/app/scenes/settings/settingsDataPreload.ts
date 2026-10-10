import { configManager } from '@/infrastructure/config/services/ConfigManager';
import type { SettingsPageId } from './settingsTypes';

// Read-only configuration owned by these destinations. Runtime probes and secrets
// remain with their page owners; hovering must never start a service or a scan.
const CONFIG_PATHS: Partial<Record<SettingsPageId, readonly string[]>> = {
  'application.general': ['app.close_button_behavior', 'app.notifications.dialog_completion_notify', 'app.notifications.permission_request_notify', 'app.notifications.enable_startup_tips'],
  'application.pet': ['app.ai_experience'],
  'application.input': ['app.ai_experience', 'app.flow_chat.auto_show_selection_toolbar'],
  'ai.session-memory': ['app.flow_chat', 'app.ai_experience', 'ai.models', 'ai.task_models', 'memories'],
  'ai.execution': ['ai.agent_model_defaults.subagents.default', 'ai.models', 'ai.enable_deferred_tool_loading', 'ai.subagent_max_concurrency', 'ai.swarm_max_concurrency', 'ai.tool_execution_timeout_secs', 'ai.subagent_batch_execution_policy', 'ai.user_question_timeout_secs'],
  'ai.permissions': ['tool_permissions', 'app.flow_chat.show_permission_mode_control'],
  'development.editor': ['editor'],
  'development.workspace': ['app.ai_experience', 'app.worktrees'],
  'development.terminal': ['terminal'],
  'tools.automation': ['app.ai_experience', 'app.hooks'],
  'tools.desktop-control': ['ai.computer_use_enabled', 'ai.browser_control_preferred_browser', 'ai.browser_control_auto_connect_on_startup'],
  'data.diagnostics': ['app.logging.level', 'app.logging.include_sensitive_diagnostics'],
};

const OPTIONAL_PATHS = new Set([
  ...(CONFIG_PATHS['application.general'] ?? []),
  'app.flow_chat.auto_show_selection_toolbar',
  'app.flow_chat.show_permission_mode_control',
  'ai.user_question_timeout_secs',
  'app.worktrees',
]);

export async function preloadSettingsData(pageId: SettingsPageId): Promise<void> {
  await Promise.allSettled((CONFIG_PATHS[pageId] ?? []).map(path => {
    if (configManager.hasCachedConfig(path)) return;
    return OPTIONAL_PATHS.has(path)
      ? configManager.getOptionalConfig(path)
      : configManager.getConfig(path);
  }));
}
