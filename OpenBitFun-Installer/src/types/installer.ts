import type { AppLanguage } from '../i18n/languages';

/** Installation step identifiers */
export type InstallStep = 'lang' | 'options' | 'model' | 'progress' | 'theme' | 'uninstall';

export interface LaunchContext {
  mode: 'install' | 'uninstall';
  previewOnly?: boolean;
  uninstallPath: string | null;
  appLanguage?: AppLanguage | null;
}

export interface InstallPathValidation {
  installPath: string;
}

/** Matches `get_existing_installation` / `ExistingInstallationResponse` (camelCase). */
export interface ExistingInstallation {
  detected: boolean;
  installLocation: string | null;
  displayVersion: string | null;
  uninstallString: string | null;
  mainBinaryPresent: boolean;
  source: string | null;
}

export type ThemeId =
  | 'openbitfun-dark'
  | 'openbitfun-light'
  | 'openbitfun-midnight'
  | 'openbitfun-china-style'
  | 'openbitfun-china-night'
  | 'openbitfun-cyber'
  | 'openbitfun-slate'
  | 'openbitfun-tokyo-night';

/** Matches main app `themes.current` when following OS appearance. */
export const SYSTEM_THEME_ID = 'system' as const;

export type ThemePreferenceId = ThemeId | typeof SYSTEM_THEME_ID;

export interface ModelConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  format: 'openai' | 'anthropic' | 'gemini' | 'responses';
  configName?: string;
  customRequestBody?: string;
  skipSslVerify?: boolean;
  customHeaders?: Record<string, string>;
  customHeadersMode?: 'merge' | 'replace';
  /** Aligns with main app model capabilities when testing image input. */
  capabilities?: string[];
  /** Aligns with main app model category (e.g. multimodal). */
  category?: string;
}

/** Matches backend `ConnectionTestMessageCode` (camelCase JSON). */
export type ConnectionTestMessageCode =
  | 'toolCallsNotDetected'
  | 'imageInputCheckFailed'
  | 'tlsOrCertificateIssue'
  | 'proxyIssue'
  | 'networkIssue';

export interface ConnectionTestResult {
  success: boolean;
  responseTimeMs: number;
  modelResponse?: string;
  messageCode?: ConnectionTestMessageCode;
  errorDetails?: string;
}

/** Remote model id from installer list_models command (settings-aligned shape). */
export interface RemoteModelInfo {
  id: string;
  displayName?: string;
}

/** Installation options sent to the Rust backend */
export interface InstallOptions {
  allUsers?: boolean;
  installPath: string;
  desktopShortcut: boolean;
  startMenu: boolean;
  launchAfterInstall: boolean;
  appLanguage: AppLanguage;
  themePreference: ThemePreferenceId;
  modelConfig: ModelConfig | null;
}

/** Progress update received from the backend */
export interface InstallProgress {
  step: string;
  percent: number;
  message: string;
}

/** Disk space information */
export interface DiskSpaceInfo {
  total: number;
  available: number;
  required: number;
  sufficient: boolean;
}

/** Default installation options */
export const DEFAULT_OPTIONS: InstallOptions = {
  installPath: '',
  desktopShortcut: true,
  startMenu: true,
  launchAfterInstall: true,
  appLanguage: 'zh-CN',
  themePreference: SYSTEM_THEME_ID,
  modelConfig: null,
};
