import { i18nService } from '@/infrastructure/i18n';

const t = (key: string, options?: Record<string, unknown>) => i18nService.t(key, options);
export interface GlobalConfig {
  product_id: 'openbitfun';
  app: AppConfig;
  editor: EditorConfig;
  terminal: TerminalConfig;
  workspace: WorkspaceConfig;
  ai: AIConfig;
  tool_permissions: ToolPermissionConfig;
  memories: MemoriesConfig;
  schema_version: 1;
  version: string;
  last_modified: number;
}

export type PermissionEffect = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface PermissionPolicyConfig {
  preset: 'ask' | 'full_access';
  rules: PermissionRule[];
}

export interface PermissionInteractionConfig {
  auto_approve_ask: boolean;
}

export interface ToolPermissionConfig {
  policy: PermissionPolicyConfig;
  interaction: PermissionInteractionConfig;
}

export type MemoryExternalContextPolicy = 'clear_tool_results' | 'allow' | 'skip_session';

export interface MemoriesConfig {
  generate_memories: boolean;
  generate_for_btw_sessions: boolean;
  use_memories: boolean;
  external_context_policy: MemoryExternalContextPolicy;
  max_raw_memories_for_consolidation: number;
  max_unused_days: number;
  max_rollout_age_days: number;
  max_rollouts_per_startup: number;
  max_rollouts_scan_limit: number;
  min_rollout_idle_hours: number;
  phase1_max_concurrency: number;
  phase1_retry_backoff_minutes: number;
  phase1_lease_seconds: number;
  phase2_lease_seconds: number;
  phase2_success_cooldown_seconds: number;
  phase2_retry_delay_seconds: number;
  extract_model?: string | null;
  consolidation_model?: string | null;
}

export interface AppConfig {
  language: string;
  auto_update: boolean;
  telemetry: boolean;
  startup_behavior: string;
  confirm_on_exit: boolean;
  restore_windows: boolean;
  zoom_level: number;
  logging: AppLoggingConfig;
  sidebar: SidebarConfig;
  right_panel: RightPanelConfig;
  notifications: NotificationConfig;
  flow_chat?: AppFlowChatConfig;
  ai_experience: AIExperienceConfig;
  /** Controller-owned end-to-end realtime voice-call settings. */
  voice_call?: VoiceCallSettings;
  user_tool_groups?: UserToolGroupsConfig;
  user_skill_groups?: UserSkillGroupsConfig;
}

export interface UserToolGroupsConfig {
  version: number;
  groups: UserToolGroup[];
}

export interface UserToolGroup {
  id: string;
  name: string;
  toolNames: string[];
}

export interface UserSkillGroupsConfig {
  version: number;
  groups: UserSkillGroup[];
}

export interface UserSkillGroup {
  id: string;
  name: string;
  skillKeys: string[];
}

export type BackendLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'off';
export type ModelExchangeTracingMode = 'off' | 'full' | 'usage_only';

export interface ModelExchangeTracingConfig {
  mode: ModelExchangeTracingMode;
}

export interface AppLoggingConfig {
  level: BackendLogLevel;
  include_sensitive_diagnostics: boolean;
  flow_chat_diagnostics: boolean;
  model_exchange_tracing: ModelExchangeTracingConfig;
}

export interface AppFlowChatConfig {
  default_mode_strategy?: 'follow_last' | 'fixed' | null;
  default_mode_id?: string | null;
  last_mode_id?: string | null;
  show_permission_mode_control?: boolean;
}

export interface SidebarConfig {
  width: number;
  collapsed: boolean;
}

export interface RightPanelConfig {
  width: number;
  collapsed: boolean;
}

export interface NotificationConfig {
  enabled: boolean;
  position: string;
  duration: number;
  /** Whether to show a toast when a dialog turn completes while the window is not focused. */
  dialog_completion_notify: boolean;
  /** Whether to show a toast when an approval request arrives while the window is not focused. */
  permission_request_notify: boolean;
  /** Whether to show built-in tip cards on each startup. Defaults to true. */
  enable_startup_tips: boolean;
}

export interface AIExperienceConfig {
  enable_session_title_generation: boolean;

  /** Whether to enable visual mode (use Mermaid diagrams to illustrate complex logic and flows). */
  enable_visual_mode: boolean;

  /** Whether to show the desktop Agent companion. */
  enable_agent_companion: boolean;

  /** Optional Petdex-compatible companion package selected by the user. */
  agent_companion_pet?: {
    id: string;
    displayName: string;
    description?: string | null;
    source: 'preset' | 'user';
    packagePath: string;
    spritesheetPath: string;
    spritesheetMimeType: string;
  } | null;

  /** Whether to enable flashgrep-backed accelerated workspace search for local workspaces. */
  enable_workspace_search: boolean;
  /** Local speech-to-text settings for the chat composer. */
  voice_input: VoiceInputSettings;
  /** User-defined quick actions shown in the post-coding actions menu. */
  quick_actions?: Array<{ id: string; label: string; prompt: string; enabled: boolean }>;
}

export interface VoiceInputSettings {
  enabled: boolean;
  provider: string;
  model_id: string;
  default_language: string;
  max_recording_seconds: number;
  microphone_device_id: string;
}

export interface VoiceCallSettings {
  enabled: boolean;
  provider: 'volcengine';
  api_key: string;
  voice: string;
  speed: number;
  loudness: number;
  microphone_device_id: string;
}

export type ModelCapability =
  | 'text_chat'
  | 'function_calling'
  | 'image_understanding'
  | 'speech_recognition';

export type ModelCategory =
  | 'general_chat'
  | 'multimodal'
  | 'speech_recognition';

export type ReasoningCatalogBinding =
  | { source: 'auto' }
  | { source: 'models_dev'; provider: string; model: string }
  | { source: 'disabled' };

export type ReasoningPresetAction =
  | { type: 'effort'; value: string }
  | { type: 'toggle'; enabled: boolean }
  | { type: 'budget_tokens'; value: number }
  | { type: 'request_patch'; body: Record<string, unknown> };

export interface ReasoningPreset {
  id: string;
  label?: string;
  order?: number;
  disabled?: boolean;
  actions?: ReasoningPresetAction[];
}

export interface ReasoningConfig {
  catalog?: ReasoningCatalogBinding;
  default_preset?: string;
  presets?: ReasoningPreset[];
}

export type ReasoningPresetSource = 'models_dev' | 'adapter_fallback' | 'model_config';

export interface ReasoningPresetDescriptor {
  id: string;
  label: string;
  order: number;
  actions: ReasoningPresetAction[];
  source: ReasoningPresetSource;
}

export interface ReasoningCatalogProjection {
  status: 'unsupported' | 'known' | 'unknown';
  default_preset?: string;
  presets?: ReasoningPresetDescriptor[];
  unavailable_presets?: ReasoningPresetDescriptor[];
}

export interface ModelMetadata {
  category: ModelCategory;
  capabilities: ModelCapability[];
  recommendedFor?: string[];
  strengths?: string[];
}

export const CATEGORY_LABELS: Record<ModelCategory, string> = {
  general_chat: t('settings/models:category.general_chat'),
  multimodal: t('settings/models:category.multimodal'),
  speech_recognition: t('settings/models:category.speech_recognition')
};

export const CATEGORY_ICONS: Record<ModelCategory, string> = {
  general_chat: t('settings/models:categoryIcons.general_chat'),
  multimodal: t('settings/models:categoryIcons.multimodal'),
  speech_recognition: t('settings/models:categoryIcons.speech_recognition')
};

export type CustomHeadersMode = 'replace' | 'merge';
export type CustomRequestBodyMode = 'merge' | 'trim';

export interface AIModelConfig {
  id?: string;
  name: string;
  provider: string;
  api_key?: string;
  base_url: string;
  /** Computed actual request URL, derived from base_url + provider format. Stored on save. */
  request_url?: string;
  model_name: string;
  context_window?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  enabled: boolean;
  is_default?: boolean;
  custom_headers?: Record<string, string>;
  custom_headers_mode?: CustomHeadersMode;
  skip_ssl_verify?: boolean;
  custom_request_body?: string;
  custom_request_body_mode?: CustomRequestBodyMode;
  timeout?: number;
  category: ModelCategory;
  capabilities: ModelCapability[];
  recommended_for?: string[];
  metadata?: Record<string, any>;
  /** Canonical reasoning preset configuration. */
  reasoning?: ReasoningConfig;
  /** Parse `<think>...</think>` text chunks into streaming reasoning content. */
  inline_think_in_text?: boolean;
  /** Authentication source. Defaults to inline `api_key`. */
  auth?: AuthConfig;
}

/** Subscription provider for in-app OAuth auth. */
export type SubscriptionProvider = 'codex' | 'antigravity' | 'opencode' | 'grok' | 'hermes';

/** OpenCode billing/API product. Both plans reuse the same signed-in account. */
export type OpenCodePlan = 'zen' | 'go';

/** Authentication source persisted on each model entry. */
export type AuthConfig =
  | { type: 'api_key' }
  | {
      type: 'subscription';
      provider: SubscriptionProvider;
      /** Absent on legacy OpenCode configs, which continue to use Zen. */
      plan?: OpenCodePlan;
    };

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  username?: string;
  password?: string;
}

export interface DefaultModelsConfig {
  primary?: string | null;
  fast?: string | null;
  image_understanding?: string | null;
  speech_recognition?: string | null;
}

export type SubagentModelSelection =
  | { kind: 'fixed'; model_id: string }
  | { kind: 'inherit' };

export type TaskModelSelection =
  | { kind: 'fixed'; model_id: string }
  | { kind: 'inherit' };

export interface TaskModelsConfig {
  session_title: TaskModelSelection;
  git_commit: TaskModelSelection;
}

export interface AgentModelDefaultsConfig {
  mode: string;
  subagents: {
    default: SubagentModelSelection;
    builtin: Record<string, SubagentModelSelection>;
    fork: SubagentModelSelection;
  };
}

export interface AIConfig {
  models: AIModelConfig[];
  default_models: DefaultModelsConfig;
  agent_model_defaults: AgentModelDefaultsConfig;
  task_models: TaskModelsConfig;
  agent_profiles: Record<string, StoredAgentProfileConfigItem>;
  proxy: ProxyConfig;
  request_timeout: number;
  max_retries: number;
  temperature: number;
  max_tokens: number;
  streaming: boolean;
  auto_save_conversations: boolean;
  conversation_history_limit: number;
  stream_idle_timeout_secs?: number | null;
  stream_ttft_timeout_secs?: number | null;
  tool_execution_timeout_secs?: number | null;
  /** Seconds until first interaction; null or zero disables timeout. Default: 180. */
  user_question_timeout_secs?: number | null;
  allow_tool_json_repair?: boolean;
  subagent_batch_execution_policy?: 'safe_only' | 'force_parallel' | 'serial';
  computer_use_enabled?: boolean;
  browser_control_preferred_browser?: string;
  browser_control_auto_connect_on_startup?: boolean;
}

export interface StoredAgentProfileConfigItem {
  profile_id: string;
  added_tools: string[];
  removed_tools: string[];
  disabled_user_skills?: string[];
  enabled_user_skills?: string[];
  subagent_overrides?: ParentSubagentOverrideConfig;
  tool_permission_rules?: PermissionRule[];
}

export interface AgentProfileConfigItem {
  profile_id: string;
  enabled_tools: string[];
  default_tools: string[];
  disabled_user_skills?: string[];
  enabled_user_skills?: string[];
}

export type AgentSubagentOverrideState = 'enabled' | 'disabled';
export type ParentSubagentOverrideConfig = Record<string, AgentSubagentOverrideState>;

export type SkillLevel = 'user' | 'project';

export interface SkillInfo {
  /** The external origin of an explicitly installed native copy. */
  importOrigin?: {
    schemaVersion: number; importId: string; sourceKey: string; sourcePath: string;
    sourceId: string; sourceLabel: string; sourceSlot: string; fingerprint: string;
  } | null;
  key: string;
  name: string;
  description: string;
  path: string;
  /** Relative Markdown entry; legacy directory bundles use SKILL.md. */
  entryFile?: string;
  level: SkillLevel;
  sourceSlot: string;
  /** Provider-neutral ecosystem identity shared by related discovery slots. */
  sourceId?: string;
  /** Stable product name supplied by the skill source definition. */
  sourceLabel?: string;
  /** Repository recorded by the installer; absent for legacy or untracked skills. */
  installationSource?: string | null;
  dirName: string;
  isBuiltin: boolean;
  groupKey?: string | null;
  /** True when this skill is shadowed by a higher-priority skill with the same name. */
  isShadowed?: boolean;
  /** Key of the skill that shadows this one (if any). */
  shadowedByKey?: string | null;
  /** False when the skill should stay out of user-facing invocation pickers. */
  allowUserInvocation?: boolean;
  /** Optional usage hint displayed by invocation pickers. */
  argumentHint?: string | null;
}

export interface ModeSkillInfo extends SkillInfo {
  /** True when this skill is enabled before any mode-specific override is applied. */
  defaultEnabled: boolean;
  /** False when this user-level skill is disabled for every agent profile. */
  globallyEnabled: boolean;
  /** True when this skill remains enabled after all mode-specific overrides are applied. */
  effectiveEnabled: boolean;
  /** Backward-compatible inverse of `effectiveEnabled`. */
  disabledByMode: boolean;
  /** True when this skill is the one actually selected at runtime after disable + priority resolution. */
  selectedForRuntime: boolean;
  /** The most specific rule that decided the effective state. */
  stateReason:
    | 'project_default_enabled'
    | 'disabled_by_project_override'
    | 'custom_user_default_enabled'
    | 'builtin_policy_enabled'
    | 'builtin_policy_disabled'
    | 'enabled_by_user_override'
    | 'disabled_by_user_override';
}

export interface GlobalSkillSettings {
  globallyDisabledUserSkillKeys: string[];
  globallyDisabledProjectSkillKeys?: string[];
  directSkillManagementVersion?: number;
}

export interface SkillScanDiagnostic {
  path: string;
  sourceId: string;
  message: string;
}

export interface SkillScanReport<T = SkillInfo> {
  /** Negotiated host support for durable external copies and identity-checked undo. */
  importOperationsVersion?: number;
  skills: T[];
  diagnostics: SkillScanDiagnostic[];
  /** False when an older host returns the legacy array instead of diagnostics. */
  diagnosticsAvailable: boolean;
}

export interface SkillMarketItem {
  id: string;
  name: string;
  description: string;
  source: string;
  installs: number;
  url: string;
  installId: string;
}

export interface SkillMarketDownloadResult {
  package: string;
  level: SkillLevel;
  installedSkills: string[];
  output: string;
}

export interface SkillImportPreview {
  fingerprint: string;
  fileCount: number;
  name: string;
  description: string;
}

export interface SkillValidationResult {
  importPreview?: SkillImportPreview;
  valid: boolean;
  name?: string;
  description?: string;
  error?: string;
}

export interface EditorConfig {
  font_size: number;
  font_family: string;
  font_weight?: 'normal' | 'bold';
  line_height: number;
  tab_size: number;
  insert_spaces: boolean;
  /** Absent on older hosts that cannot persist this setting. */
  detect_indentation?: boolean;
  word_wrap: string;
  line_numbers: string;
  minimap: MinimapConfig;
  auto_save: string;
  auto_save_delay: number;
  format_on_save: boolean;
  format_on_paste: boolean;
  trim_auto_whitespace: boolean;
  cursor_style?: string;
  cursor_blinking?: string;
  render_whitespace?: string;
  render_line_highlight?: string;
  smooth_scrolling?: boolean;
  scroll_beyond_last_line?: boolean;
  semantic_highlighting?: boolean;
  bracket_pair_colorization?: boolean;
}

export interface MinimapConfig {
  enabled: boolean;
  side?: string;
  size?: string;
}

export interface TerminalConfig {
  default_shell: string;
  terminal_panel_position?: TerminalPanelPosition;
  font_size: number;
  font_family: string;
  cursor_style: string;
  cursor_blink: boolean;
  scrollback_lines: number;
  transparency: number;
  bell_style: string;
  copy_on_select: boolean;
  paste_on_right_click: boolean;
  confirm_on_exit: boolean;
  startup_command: string;
  env_vars: Record<string, string>;
}

export type TerminalPanelPosition = 'right' | 'bottom';

export interface WorkspaceConfig {
  recent_workspaces: string[];
  max_recent_workspaces: number;
  auto_open_last_workspace: boolean;
  workspace_settings: Record<string, any>;
  exclude_patterns: string[];
  include_patterns: string[];
  file_associations: Record<string, string>;
  search_exclude_patterns: string[];
}

export interface IConfigManager {
  getConfig<T = any>(path?: string): Promise<T>;
  getOptionalConfig<T = any>(path: string): Promise<T | undefined>;
  getConfigs(paths: string[]): Promise<Record<string, unknown>>;
  setConfig<T = any>(path: string, value: T): Promise<void>;
  resetConfig(path?: string): Promise<void>;
  validateConfig(): Promise<ConfigValidationResult>;
  exportConfig(): Promise<ConfigExport>;
  importConfig(config: ConfigExport): Promise<void>;
  updateConfig<T>(path: string, update: (current: T) => T): Promise<T>;
  onConfigChange(callback: (path: string, oldValue: any, newValue: any) => void): () => void;
  refreshCache(): Promise<void>;
  clearCache(): void;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
  diagnostics?: ConfigDiagnostic[];
}

export interface ConfigDiagnostic {
  path: string;
  message: string;
  code: string;
  severity: 'error' | 'warning';
  recoverability: 'none' | 'auto_fix' | 'model_disabled' | 'defaults_used';
}

export interface ConfigValidationError {
  path: string;
  message: string;
  code: string;
}

export interface ConfigValidationWarning {
  path: string;
  message: string;
  code: string;
}

export interface ConfigExport {
  product_id: 'openbitfun';
  format_version: 1;
  config: GlobalConfig;
  export_timestamp: string;
  version: string;
}

export interface ConfigChangeEvent {
  path: string;
  old_value: any;
  new_value: any;
  timestamp: number;
}

export interface UseConfigReturn<T = any> {
  data: T | null;
  loading: boolean;
  error: string | null;
  setConfig: (value: T) => Promise<void>;
  resetConfig: () => Promise<void>;
  refreshConfig: () => Promise<void>;
}

export type ConfigPath =
  | 'app'
  | 'app.language'
  | 'app.auto_update'
  | 'app.telemetry'
  | 'app.flow_chat'
  | 'app.flow_chat.default_mode_strategy'
  | 'app.flow_chat.default_mode_id'
  | 'app.flow_chat.last_mode_id'
  | 'app.flow_chat.show_permission_mode_control'
  | 'app.sidebar'
  | 'app.sidebar.width'
  | 'app.sidebar.collapsed'
  | 'editor'
  | 'editor.font_size'
  | 'terminal'
  | 'terminal.default_shell'
  | 'terminal.terminal_panel_position'
  | 'workspace'
  | 'ai'
  | 'ai.default_model'
  | 'ai.models'
  | 'agents'
  | string;

export interface ConfigPanelProps {
  section?: keyof GlobalConfig;
  onClose?: () => void;
  onSave?: (config: Partial<GlobalConfig>) => void;
  readOnly?: boolean;
}

export interface RuntimeLoggingInfo {
  effectiveLevel: BackendLogLevel;
  sessionLogDir: string;
  earlyStartupLogPath: string;
  nativeStartupTracePath: string;
  appLogPath: string;
  aiLogPath: string;
  flashgrepLogPath: string;
  webviewLogPath: string;
  flowChatLogPath: string;
  previousUnexpectedExit?: UnexpectedExitInfo | null;
}

export interface UnexpectedExitInfo {
  detected: boolean;
  startedAt?: string;
  sessionLogDir?: string;
  crashReportPath?: string;
  category?: 'crash' | 'unclean_shutdown';
  notifyOnStartup?: boolean;
  reason: string;
}

export interface DiagnosticsBundleInfo {
  bundlePath: string;
}

export interface DefaultModels {
  primary: string | null;
  fast: string | null;
  image_understanding?: string | null;
  speech_recognition?: string | null;
}

export type OptionalCapabilityModels = Record<string, never>;
