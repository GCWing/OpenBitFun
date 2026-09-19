import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { shouldScheduleDeferredStartupSystems } from './deferredStartupGate';
import { STARTUP_OVERLAY_HIDDEN_EVENT } from './startupSignals';

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8').replace(/\r\n?/g, '\n');
}

function dynamicImportSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(/import\(\s*(['"])(.*?)\1\s*\)/g),
    match => match[2]
  );
}

function staticImportSpecifiers(source: string): string[] {
  return Array.from(
    source.matchAll(/from\s+(['"])(.*?)\1/g),
    match => match[2]
  );
}

describe('startup performance contract', () => {
  it('creates native glass with a transparent background instead of repainting it after load', () => {
    const source = readSource('../../../../apps/desktop/src/appearance.rs');
    const mainWindow = source.slice(source.indexOf('pub fn create_main_window('), source.indexOf('fn show_main_window_for_startup('));

    expect(mainWindow).toContain('.transparent(true)');
    expect(mainWindow).toContain('.background_color(tauri::window::Color(0, 0, 0, 0))');
    expect(mainWindow).toContain('tauri::window::Effect::Acrylic');
    // The Windows host fill ignores alpha during repaint. Changing its color
    // after page load can cover the native material even with transparent CSS.
    expect(mainWindow).not.toContain('.set_background_color(');
  });

  it('waits for the startup document before revealing the transparent native window', () => {
    const source = readSource('../../../../apps/desktop/src/appearance.rs');
    const mainWindow = source.slice(source.indexOf('pub fn create_main_window('), source.indexOf('fn show_main_window_for_startup('));

    expect(mainWindow).toContain('.visible(false)');
    expect(mainWindow).toMatch(/PageLoadEvent::Finished\)\s*\{\s*let _ = startup_page_ready.send\(true\)/);
    const wait = mainWindow.indexOf('startup_page_ready_rx.wait_for(');
    expect(wait).toBeGreaterThan(-1);
    expect(mainWindow.indexOf('show_main_window_for_startup(')).toBeGreaterThan(wait);
    // Failed navigation must not leave an invisible application indefinitely.
    expect(mainWindow).toContain('tokio::time::timeout(');
  });

  it('keeps the pre-React startup fallback vector-only', () => {
    const source = readSource('../../../index.html');

    expect(source).toContain('<link rel="icon" type="image/png" href="/brand/openbitfun-app-icon.png" />');
    expect(source).not.toContain('rel="preload" as="image"');
    expect(source).toContain('class="openbitfun-preload__logo"');
    expect(source).toContain("url('/brand/openbitfun-mark.svg')");
    expect(source).not.toContain('src="/brand/openbitfun-mark-dark-128.png"');
    expect(source).not.toContain('src="/brand/openbitfun-mark-light-128.png"');
    expect(source).not.toContain('Loading workspace...');
    expect(source).not.toContain('openbitfun-preload__spinner');
    expect(source).not.toContain('aria-live="polite"');

    expect(source.indexOf('<script type="module" src="/src/main.tsx"></script>')).toBeLessThan(
      source.indexOf('class="openbitfun-preload__logo"'),
    );
  });

  it('keeps the startup mark as a reusable transparent vector asset', () => {
    const asset = readSource('../../../public/brand/openbitfun-mark.svg');

    expect(asset).toContain('viewBox="0 0 120 120"');
    expect(asset).toContain('fill="none"');
    expect(asset).toContain('stroke="currentColor"');
    expect(asset.match(/<path\b/g)).toHaveLength(15);
    expect(asset).not.toContain('<rect');
  });

  it('uses semantic startup tones and the reference mark geometry', () => {
    const source = readSource('../../../index.html');
    const componentStyles = readSource('../components/SplashScreen/SplashScreen.scss');

    for (const styles of [source, componentStyles]) {
      expect(styles).toContain('width: 120px;');
      expect(styles).not.toContain('width: 144px;');
      expect(styles).toContain('background-color: var(--openbitfun-color-content-on-light);');
      expect(styles).toContain('background-color: var(--openbitfun-color-content-on-dark);');
      expect(styles).toContain('color: var(--openbitfun-color-content-secondary);');
      expect(styles).not.toContain('var(--openbitfun-color-content-on-dark) 80%, transparent');
      expect(styles).toContain('var(--openbitfun-color-content-on-dark) 60%, transparent');
      expect(styles).toContain('font-size: var(--openbitfun-type-label-md-font-size);');
    }
  });

  it('keeps the startup overlay exit short enough for a fast visual handoff', () => {
    const source = readSource('../../../index.html');
    const appSource = readSource('../App.tsx');

    expect(appSource).toContain('const MIN_SPLASH_MS = 650;');
    expect(source).toContain('animation: openbitfun-startup-overlay-exit 0.24s ease-in-out both;');
  });

  it('keeps editor and tool infrastructure out of the first startup module', () => {
    const source = readSource('../../main.tsx');

    expect(source).not.toMatch(/import\s+['"]monaco-editor\/min\/vs\/editor\/editor\.main\.css['"]/);
    expect(source).not.toMatch(/from\s+['"]@monaco-editor\/react['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/tools\/initializeTools['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/shared\/context-menu-system['"]/);

    expect(source).toContain("import('./tools/initializeTools')");
    expect(source).toContain("import('./shared/context-menu-system')");
  });

  it('keeps the required i18n provider off an async startup waterfall', () => {
    const source = readSource('../../main.tsx');

    expect(source).toContain(
      'import { I18nProvider } from "./infrastructure/i18n/providers/I18nProvider"'
    );
    expect(source).not.toMatch(/import\(['"]\.\/infrastructure\/i18n['"]\)/);
    expect(source).toContain("step: 'load_i18n_provider'");
    expect(source).toContain("mode: 'static'");
  });

  it('does not block first React render on frontend log-level config reads', () => {
    const mainSource = readSource('../../main.tsx');
    const loggerSource = readSource('../../shared/utils/logger.ts');
    const appearanceSource = readSource('../../../../apps/desktop/src/appearance.rs');

    expect(mainSource).not.toContain("before_render_step', 'initialize_frontend_log_level_sync'");
    expect(mainSource).not.toContain('before_render_step", "initialize_frontend_log_level_sync"');
    expect(mainSource).toContain('initializeFrontendLogLevelSync');
    expect(mainSource).toContain('installFrontendLogLevelConfigWatcher');
    expect(loggerSource).toContain('__OPENBITFUN_BOOTSTRAP_LOG_LEVEL__');
    expect(appearanceSource).toContain('__OPENBITFUN_BOOTSTRAP_LOG_LEVEL__');
  });

  it('keeps startup keybindings on the bootstrap path instead of a first-window IPC', () => {
    const configManagerSource = readSource('../../infrastructure/config/services/ConfigManager.ts');
    const appearanceSource = readSource('../../../../apps/desktop/src/appearance.rs');

    expect(appearanceSource).toContain('__OPENBITFUN_BOOTSTRAP_KEYBINDINGS__');
    expect(appearanceSource).toContain('keybindings: global_config.app.keybindings');
    expect(appearanceSource).toContain('MAX_BOOTSTRAP_KEYBINDINGS_JSON_BYTES');
    expect(appearanceSource).toContain('.filter(|json| json.len() <= MAX_BOOTSTRAP_KEYBINDINGS_JSON_BYTES)');
    expect(configManagerSource).toContain('consumeBootstrapOptionalConfig');
    expect(configManagerSource).toContain('__OPENBITFUN_BOOTSTRAP_KEYBINDINGS__');
    expect(configManagerSource).toContain("path !== 'app.keybindings'");
    expect(configManagerSource).toContain('delete globalThis.__OPENBITFUN_BOOTSTRAP_KEYBINDINGS__');
  });

  it('keeps workspace startup state on the bootstrap path with command fallback', () => {
    const globalStateSource = readSource('../../shared/types/global-state.ts');
    const desktopAppearanceSource = readSource('../../../../apps/desktop/src/appearance.rs');
    const desktopLibSource = readSource('../../../../apps/desktop/src/lib.rs');
    const desktopCommandsSource = readSource('../../../../apps/desktop/src/api/commands.rs');

    expect(desktopAppearanceSource).toContain('__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__');
    expect(desktopAppearanceSource).toContain('MAX_BOOTSTRAP_WORKSPACE_STATE_JSON_BYTES');
    expect(desktopLibSource).toContain('prepare_workspace_startup_bootstrap_snapshot');
    expect(desktopLibSource).toContain('tokio::task::block_in_place');
    expect(desktopLibSource).not.toContain('tauri::async_runtime::block_on(prepare_workspace_startup_bootstrap_snapshot');
    expect(desktopCommandsSource).toContain('initialize_workspace_startup_state_impl');
    expect(globalStateSource).toContain('consumeBootstrapWorkspaceStartupStateSnapshot');
    expect(globalStateSource).toContain('__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__');
    expect(globalStateSource).toContain(
      'delete globalThis.__OPENBITFUN_BOOTSTRAP_WORKSPACE_STARTUP_STATE__'
    );
  });

  it('keeps startup resource timing as bounded E2E-only report data', () => {
    const perfSpecSource = readSource(
      '../../../../../tests/e2e/specs/performance/startup-session-perf.spec.ts'
    );
    const resourceTimingSource = readSource(
      '../../../../../tests/e2e/helpers/performance-resource-timing.ts'
    );

    expect(perfSpecSource).toContain('readStartupResourceTimingSummary');
    expect(perfSpecSource).toContain('resourceTiming');
    expect(resourceTimingSource).toContain('sanitizeResourceTimingName');
    expect(resourceTimingSource).toContain('MAX_RESOURCE_TIMING_ENTRIES');
    expect(resourceTimingSource).not.toContain('console.log');
    expect(resourceTimingSource).not.toContain('createLogger');
  });

  it('initializes the appearance runtime before the first React render', () => {
    const mainSource = readSource('../../main.tsx');
    const appearanceServiceSource = readSource(
      '../../infrastructure/appearance/runtime/AppearanceService.ts',
    );

    expect(mainSource).toContain("before_render_step', 'appearance_initialize'");
    expect(mainSource).toContain('await appearanceService.initialize()');
    expect(mainSource).not.toContain('themeService');
    expect(appearanceServiceSource).toContain('selectedAppearanceId');
    expect(appearanceServiceSource).toContain('getSystemAppearanceId()');
    expect(appearanceServiceSource).not.toContain('themes.current');
  });

  it('centers the first main window and persists geometry before close handling', () => {
    const desktopAppearanceSource = readSource('../../../../apps/desktop/src/appearance.rs');
    const desktopLibSource = readSource('../../../../apps/desktop/src/lib.rs');
    const toolbarModeProviderSource = readSource(
      '../../flow_chat/components/toolbar-mode/ToolbarModeProvider.tsx'
    );
    const windowEventStart = desktopLibSource.indexOf('.on_window_event({');
    const invokeHandlerStart = desktopLibSource.indexOf('.invoke_handler(', windowEventStart);
    const windowEventSource = desktopLibSource.slice(windowEventStart, invokeHandlerStart);

    const mainWindowSizeStart = desktopAppearanceSource.indexOf('.inner_size(');
    const mainWindowCenter = desktopAppearanceSource.indexOf('.center()', mainWindowSizeStart);
    const mainWindowSizeSource = desktopAppearanceSource.slice(mainWindowSizeStart, mainWindowCenter);
    expect(mainWindowSizeStart).toBeGreaterThanOrEqual(0);
    expect(mainWindowCenter).toBeGreaterThan(mainWindowSizeStart);
    expect(mainWindowSizeSource).toContain('crate::MAIN_WINDOW_DEFAULT_WIDTH');
    expect(mainWindowSizeSource).toContain('crate::MAIN_WINDOW_DEFAULT_HEIGHT');
    expect(desktopLibSource).toContain('MAIN_WINDOW_DEFAULT_WIDTH: f64 = 1200.0');
    expect(desktopLibSource).toContain('MAIN_WINDOW_DEFAULT_HEIGHT: f64 = 800.0');
    expect(desktopAppearanceSource).not.toContain('windows_maximize_show_wait_action');
    expect(desktopLibSource).toContain('.manage(window_state_support::MainWindowState::default())');
    expect(desktopLibSource).not.toContain('tauri_plugin_window_state::Builder');
    expect(desktopLibSource).toContain('window_state_support::restore(window)');
    expect(desktopLibSource).toContain('window_state_support::save(app, reason)');
    expect(desktopLibSource).toContain('MAIN_WINDOW_USES_TRANSIENT_GEOMETRY');
    expect(toolbarModeProviderSource).not.toContain(
      "import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI'"
    );
    expect(toolbarModeProviderSource).toContain(
      "await import('@/infrastructure/api/service-api/SystemAPI')"
    );
    expect(toolbarModeProviderSource).toContain('win.innerSize()');
    expect(toolbarModeProviderSource).not.toContain('win.outerSize(),');
    expect(windowEventStart).toBeGreaterThan(-1);
    expect(invokeHandlerStart).toBeGreaterThan(windowEventStart);
    expect(windowEventSource).toContain('matches!(event, tauri::WindowEvent::CloseRequested { .. })');
    expect(windowEventSource).toContain(
      'save_main_window_state(window.app_handle(), "close_requested")'
    );
    expect(toolbarModeProviderSource).toContain(
      'setMainWindowTransientGeometry(true)'
    );
    expect(toolbarModeProviderSource).toContain(
      'setMainWindowTransientGeometry(false)'
    );
    expect(
      toolbarModeProviderSource.indexOf('setMainWindowTransientGeometry(true)')
    ).toBeLessThan(
      toolbarModeProviderSource.indexOf('win.setSize(new PhysicalSize(geometry.width')
    );
  });

  it('keeps system tray creation out of the synchronous Tauri setup path', () => {
    const desktopLibSource = readSource('../../../../apps/desktop/src/lib.rs');
    const traySource = readSource('../../../../apps/desktop/src/tray.rs');
    const appSource = readSource('../App.tsx');

    expect(desktopLibSource).not.toContain('crate::tray::setup_tray(app, &startup_trace)');
    expect(desktopLibSource).not.toContain('Failed to set up system tray');
    expect(traySource).toContain('const TRAY_TRACE_CATEGORY: &str = "native_background";');
    expect(traySource).not.toContain('record_elapsed_step("native_setup", "setup_tray.');
    expect(appSource).toContain('initializeTrayAfterStartup');
  });

  it('does not turn tray initialization failure into a close-to-tray behavior change', () => {
    const systemApiSource = readSource('../../../../apps/desktop/src/api/system_api.rs');
    const minimizeStart = systemApiSource.indexOf('pub async fn minimize_to_tray');
    const initializeTrayStart = systemApiSource.indexOf('pub async fn initialize_tray_after_startup');
    const minimizeSource = systemApiSource.slice(minimizeStart, initializeTrayStart);

    expect(minimizeSource).toContain('crate::tray::setup_tray(&app, &startup_trace)');
    expect(minimizeSource).toContain('Failed to initialize tray before minimizing');
    expect(minimizeSource).toContain('window.hide()');
    expect(minimizeSource).not.toContain('setup_tray(&app, &startup_trace).map_err');
  });

  it('starts non-critical work after the startup overlay handoff', () => {
    const source = readSource('../../main.tsx');

    expect(STARTUP_OVERLAY_HIDDEN_EVENT).toBe('openbitfun:startup-overlay-hidden');
    expect(source).toContain('STARTUP_OVERLAY_HIDDEN_EVENT');
    expect(source).not.toContain("signalName: 'openbitfun:interactive-shell-ready'");
    expect(source).not.toContain("signalName: 'openbitfun:main-window-shown'");
    expect(source).toContain('fallbackTimeoutMs: 10000');
  });

  it('starts deferred app systems only after the startup overlay has handed off', () => {
    const source = readSource('../App.tsx');

    expect(shouldScheduleDeferredStartupSystems({
      interactiveShellReady: true,
      startupOverlayVisible: true,
    })).toBe(false);
    expect(shouldScheduleDeferredStartupSystems({
      interactiveShellReady: true,
      startupOverlayVisible: false,
    })).toBe(true);
    expect(source).toContain('shouldScheduleDeferredStartupSystems({ interactiveShellReady, startupOverlayVisible })');
    expect(source).toContain('window.dispatchEvent(new CustomEvent(STARTUP_OVERLAY_HIDDEN_EVENT))');
    expect(source).toContain('}, [interactiveShellReady, startupOverlayVisible]);');
  });

  it('keeps ACP requirement probing out of the startup background path', () => {
    const source = readSource('./deferredStartupSystems.ts');

    expect(source).not.toContain('probeClientRequirements');
    expect(source).not.toContain('probe_acp_client_requirements');
    expect(source).not.toContain('acp_client_requirements');
  });

  it('does not initialize AI from the root app component', () => {
    const source = readSource('../App.tsx');

    expect(source).not.toMatch(/from\s+['"]\.\.\/infrastructure['"]/);
    expect(source).not.toMatch(/useAIInitialization/);
    expect(source).not.toMatch(/useCurrentModelConfig/);
    expect(source).not.toMatch(/from\s+['"]@\/infrastructure\/config\/services\/AIExperienceConfigService['"]/);
    expect(source).toContain('openbitfun:interactive-shell-ready');
    expect(source).toContain('STARTUP_OVERLAY_HIDDEN_EVENT');
  });

  it('keeps the heavy app layout out of the root startup module', () => {
    const source = readSource('../App.tsx');

    expect(source).not.toMatch(/import\s+AppLayout\s+from\s+['"]\.\/layout\/AppLayout['"]/);
    expect(source).toContain("import('./layout/AppLayout')");
    expect(source).toContain('app_layout_ready');
    expect(source).toContain('!appLayoutReady');
  });

  it('recovers development module load failures without trapping the error boundary behind the startup overlay', () => {
    const source = readSource('../App.tsx');

    expect(source).toContain('retryStartupAfterModuleLoadFailure(error)');
    expect(source).toContain("startupTrace.markPhase('app_layout_import_reload_requested')");
    expect(source).toMatch(/void hideStartupOverlay\(\);\s+throw error;/);
  });

  it('keeps non-default shell surfaces out of the startup import path', () => {
    const appSource = readSource('../App.tsx');
    const appLayoutSource = readSource('../layout/AppLayout.tsx');
    const footerSource = readSource('../components/NavPanel/components/PersistentFooterActions.tsx');
    const chatPaneSource = readSource('../scenes/session/ChatPane.tsx');
    const chatInputSource = readSource('../../flow_chat/components/ChatInput.tsx');
    const toolbarModeProviderSource = readSource(
      '../../flow_chat/components/toolbar-mode/ToolbarModeProvider.tsx'
    );

    expect(appSource).not.toContain("from '../flow_chat/components/toolbar-mode'");
    expect(appSource).toContain(
      "from '../flow_chat/components/toolbar-mode/ToolbarModeProvider'"
    );
    expect(appLayoutSource).not.toContain(
      "from '../../flow_chat/components/toolbar-mode'"
    );
    expect(appLayoutSource).not.toContain("import { FloatingMiniChat } from './FloatingMiniChat'");
    expect(appLayoutSource).toContain(
      "import('../../flow_chat/components/toolbar-mode/ToolbarMode')"
    );
    expect(appLayoutSource).toContain("import('./FloatingMiniChat')");
    expect(appLayoutSource).not.toContain("import { AboutDialog }");
    expect(appLayoutSource).not.toContain("from '../../tools/workspace'");
    expect(appLayoutSource).toContain("import('../components/AboutDialog')");
    expect(appLayoutSource).toContain("import('../../tools/workspace/components/WorkspaceManager')");
    expect(appLayoutSource).toContain("import { FlowChatManager }");
    expect(appLayoutSource).not.toContain("import('../../flow_chat/services/FlowChatManager')");
    expect(footerSource).not.toContain("import { AboutDialog }");
    expect(footerSource).not.toContain("import('../../AboutDialog')");
    expect(footerSource).toContain("new Event('nav:show-about')");
    expect(appLayoutSource).toContain("window.addEventListener('nav:show-about', handleShowAbout)");
    expect(appLayoutSource).not.toContain('useUpdateInstallStore');
    const aboutSource = readSource('../components/AboutDialog/AboutDialog.tsx');
    expect(aboutSource).not.toContain('AppUpdatePanel');
    expect(aboutSource).not.toContain('useUpdateInstallStore');
    expect(chatPaneSource).not.toContain("from '../../../flow_chat'");
    expect(chatPaneSource).toContain(
      "from '../../../flow_chat/components/modern/ModernFlowChatContainer'"
    );
    expect(chatPaneSource).toContain("from '../../../flow_chat/components/ChatInput'");
    expect(chatInputSource).not.toContain("from '@/flow_chat'");
    expect(chatInputSource).toContain("from '@/flow_chat/services/FlowChatManager'");
    expect(toolbarModeProviderSource).toContain("await import('./ToolbarMode')");
    expect(toolbarModeProviderSource.indexOf("await import('./ToolbarMode')")).toBeLessThan(
      toolbarModeProviderSource.indexOf('setIsToolbarMode(true)')
    );
  });

  it('keeps restored historical tail content out of enter animations', () => {
    const source = readSource('../../flow_chat/components/modern/ModernFlowChatContainer.scss');

    expect(source).toContain('[data-history-state="ready"][data-is-partial="true"]');
    expect(source).toContain('.user-message-item');
    expect(source).toContain('.model-round-item');
    expect(source).toContain('animation: none');
  });

  it('releases interactive shell readiness without waiting for an extra AppLayout state commit', () => {
    const source = readSource('../App.tsx');

    expect(source).toContain('workspaceLoadingRef.current');
    expect(source).toContain('appLayoutReadyRef.current');
    expect(source).toContain('interactiveShellReadyFrameRef.current');
    expect(source).toContain('markInteractiveShellReadyIfReady');
    expect(source).toContain('releaseInteractiveShellReadyIfReady');
    expect(source).toContain('useLayoutEffect');
    expect(source).toContain('requestAnimationFrame');
    expect(source).toContain('interactive_shell_ready_after_paint_scheduled');
    expect(source).toContain("markInteractiveShellReadyIfReady('app-layout-ready')");
    expect(source).toContain("markInteractiveShellReadyIfReady('workspace-or-layout-state')");
  });

  it('loads Monaco styling and loader config only through editor initialization', () => {
    const source = readSource('../../tools/editor/services/MonacoInitManager.ts');

    expect(source).toContain("import('monaco-editor/min/vs/editor/editor.main.css')");
    expect(source).toContain('loader.config');
    expect(source).toContain('MonacoEnvironment');
  });

  it('keeps editor panel implementations lazy from the session shell', () => {
    const source = readSource('../components/panels/base/FlexiblePanel.tsx');

    expect(source).not.toMatch(/from\s+['"]@\/tools\/editor['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/tools\/git\/components\/GitDiffEditor\/GitDiffEditor['"]/);
    expect(source).toContain("import('@/tools/editor/components/CodeEditor')");
    expect(source).toContain("import('@/tools/editor/components/DiffEditor')");
    expect(source).toContain("import('@/tools/git/components/GitDiffEditor/GitDiffEditor')");
    expect(source).toContain('renderLazyEditor(');
  });

  it('keeps terminal xterm runtime out of session startup until terminal output is rendered', () => {
    const sessionSceneSource = readSource('../scenes/session/SessionScene.tsx');
    const flexiblePanelSource = readSource('../components/panels/base/FlexiblePanel.tsx');
    const execProcessToolCardSource = readSource('../../flow_chat/tool-cards/ExecProcessToolCardView.tsx');
    const backgroundCommandOutputPanelSource = readSource(
      '../../flow_chat/components/background-command/BackgroundCommandOutputPanel.tsx'
    );
    const lazyTerminalOutputSource = readSource('../../tools/terminal/components/LazyTerminalOutputRenderer.tsx');

    expect(sessionSceneSource).not.toMatch(/from\s+['"]@\/tools\/terminal['"]/);
    expect(sessionSceneSource).toContain(
      "from '@/tools/terminal/services/terminalPanelPreferenceService'"
    );
    expect(flexiblePanelSource).not.toContain("import('@/tools/terminal')");
    expect(flexiblePanelSource).toContain(
      "import('@/tools/terminal/components/ConnectedTerminal')"
    );
    expect(execProcessToolCardSource).toContain(
      "from '@/tools/terminal/components/LazyTerminalOutputRenderer'"
    );
    expect(backgroundCommandOutputPanelSource).not.toMatch(/from\s+['"]@\/tools\/terminal\/components['"]/);
    expect(backgroundCommandOutputPanelSource).toContain(
      "React.lazy(() => import('./BackgroundTerminalProjection'))"
    );
    expect(backgroundCommandOutputPanelSource).toContain("await import('./backgroundTerminalReplay')");
    expect(backgroundCommandOutputPanelSource).not.toMatch(/from\s+['"]@xterm\//);
    expect(backgroundCommandOutputPanelSource).not.toMatch(/import\s+\{[^}]*BackgroundTerminalReplay[^}]*\}\s+from/);
    expect(lazyTerminalOutputSource).toContain("import('./TerminalOutputRenderer')");
  });

  it('keeps settings pages lazy by active page', () => {
    const sceneSource = readSource('../scenes/settings/SettingsScene.tsx');
    const registrySource = readSource('../scenes/settings/settingsRegistry.ts');
    const viewPageSources = [
      readSource('../scenes/settings/pages/AutomationSettingsPage.tsx'),
    ];
    const lazyPanelSpecifiers = [
      '../../../infrastructure/config/components/ModelSettingsPage',
      '../../../infrastructure/config/components/ApplicationSettingsPages',
      '../../../infrastructure/config/components/AppearanceSettingsPage',
      '../../../infrastructure/config/components/MemorySettingsPage',
      '../../../infrastructure/config/components/RuntimeSettingsPages',
      '../../../infrastructure/config/components/WorktreeSettingsPage',
      '../../../infrastructure/config/components/UsageStatisticsConfig',
      '../../../infrastructure/config/components/McpToolsConfig',
      '../../../infrastructure/config/components/VoiceInputConfig',
      './components/ArchivedSessionsConfig',
      './components/KeyboardShortcutsTab',
      './pages/EditorSettingsPage',
      './pages/ExecutionSettingsPage',
      './pages/AutomationSettingsPage',
      './pages/AcpSettingsPage',
    ];
    const sceneImports = staticImportSpecifiers(sceneSource);
    const registryImports = staticImportSpecifiers(registrySource);
    const lazyViewSpecifiers = [
      '@/infrastructure/config/components/QuickActionsConfig',
      '@/infrastructure/config/components/HooksConfig',
    ];
    const viewDynamicImports = viewPageSources.flatMap(dynamicImportSpecifiers);
    const viewStaticImports = viewPageSources.flatMap(staticImportSpecifiers);

    expect(sceneImports).toContain('./settingsRegistry');
    expect(sceneSource).toContain('<Suspense');
    expect(dynamicImportSpecifiers(registrySource)).toEqual(
      expect.arrayContaining(lazyPanelSpecifiers)
    );
    for (const panelSpecifier of lazyPanelSpecifiers) {
      expect(sceneImports).not.toContain(panelSpecifier);
      expect(registryImports).not.toContain(panelSpecifier);
    }
    expect(viewDynamicImports).toEqual(expect.arrayContaining(lazyViewSpecifiers));
    for (const viewSpecifier of lazyViewSpecifiers) {
      expect(viewStaticImports).not.toContain(viewSpecifier);
    }
    expect(registrySource).toContain('component: lazy(definition.load)');
    expect(registrySource).toContain("id: 'application.general'");
  });

  it('keeps ACP settings lazy while discovery stays inline in the ecosystem header', () => {
    const sceneSource = readSource(
      '../scenes/ecosystem-compatibility/EcosystemCompatibilityScene.tsx'
    );
    const ownerSpecifier = '@/infrastructure/config/components/AcpAgentsConfig';

    expect(dynamicImportSpecifiers(sceneSource)).toContain(ownerSpecifier);
    expect(staticImportSpecifiers(sceneSource)).not.toContain(ownerSpecifier);
    expect(staticImportSpecifiers(sceneSource)).toContain('./ExternalDiscoveryToggle');
  });

  it('keeps tool-card metadata separate from heavy card implementations', () => {
    const registrySource = readSource('../../flow_chat/tool-cards/index.ts');
    const metadataSource = readSource('../../flow_chat/tool-cards/toolCardMetadata.ts');
    const flowToolCardSource = readSource('../../flow_chat/components/FlowToolCard.tsx');
    const modelRoundItemSource = readSource('../../flow_chat/components/modern/ModelRoundItem.tsx');
    const flowStoreSource = readSource('../../flow_chat/store/modernFlowChatStore.ts');
    const keyboardShortcutsSource = readSource('../scenes/settings/components/KeyboardShortcutsTab.tsx');

    expect(metadataSource).toContain('TOOL_CARD_CONFIGS');
    expect(metadataSource).toContain('isCollapsibleTool');
    expect(metadataSource).not.toMatch(/from\s+['"]\.\/FileOperationToolCard['"]/);

    expect(registrySource).not.toContain('export const TOOL_CARD_CONFIGS');
    expect(registrySource).toContain("from './toolCardMetadata'");
    expect(flowToolCardSource).toContain("from '../tool-cards/toolCardMetadata'");
    expect(flowToolCardSource).toContain("from '../tool-cards'");
    expect(modelRoundItemSource).toContain("from '../../tool-cards/toolCardMetadata'");
    expect(modelRoundItemSource).not.toMatch(/from\s+['"]\.\.\/\.\.\/tool-cards['"]/);
    expect(flowStoreSource).toContain("from '../tool-cards/toolCardMetadata'");
    expect(flowStoreSource).not.toMatch(/from\s+['"]\.\.\/tool-cards['"]/);
    expect(keyboardShortcutsSource).not.toMatch(/from\s+['"]@\/infrastructure\/config['"]/);
    expect(keyboardShortcutsSource).toContain(
      "from '@/infrastructure/config/services/ConfigManager'"
    );
  });

  it('keeps appearance startup from importing the Monaco runtime', () => {
    const source = readSource('../../infrastructure/appearance/adapters/MonacoAppearanceAdapter.ts');

    expect(source).not.toMatch(/import\s+\*\s+as\s+monaco\s+from\s+['"]monaco-editor['"]/);
    expect(source).toMatch(/import\s+type\s+\*\s+as\s+Monaco\s+from\s+['"]monaco-editor['"]/);
    expect(source).toContain('attachMonaco');
  });

  it('does not import Monaco runtime from shared edit-target services', () => {
    const source = readSource('../../tools/editor/services/ActiveEditTargetService.ts');

    expect(source).not.toMatch(/import\s+\*\s+as\s+monaco\s+from\s+['"]monaco-editor['"]/);
    expect(source).toMatch(/import\s+type\s+\*\s+as\s+monaco\s+from\s+['"]monaco-editor['"]/);
  });

  it('prewarms editor runtime only after the shell is interactive and visible', () => {
    const source = readSource('../App.tsx');

    expect(source).toContain('interactiveShellReady');
    expect(source).toContain('startupOverlayVisible');
    expect(source).toContain("import('@/tools/editor/services/MonacoStartupWarmup')");
    expect(source).toContain('scheduleMonacoStartupWarmup()');
  });

  it('does not let startup visibility retries reopen a user-hidden main window', () => {
    const source = readSource('../App.tsx');

    expect(source).toContain('userCloseRequestedRef');
    expect(source).toContain("listen('openbitfun_main_window_close_requested'");
    expect(source).toContain('user-close-requested');
    expect(source).toContain('startup-complete');
    expect(source).toContain('startup-watchdog');
  });

  it('does not remount the historical message list when full hydration prepends older turns', () => {
    const source = readSource('../../flow_chat/components/modern/VirtualMessageList.tsx');

    expect(source).not.toContain('firstVirtualItemTurnId');
    expect(source).not.toMatch(/key=\{`\$\{activeSession\?\.sessionId[^`]+firstVirtualItemTurnId/);
  });

  it('keeps read-only thread goal access metadata-only for unloaded sessions', () => {
    const source = readSource('../../../../apps/desktop/src/api/agentic_api.rs');
    const getStart = source.indexOf('pub async fn get_session_thread_goal');
    const clearStart = source.indexOf('pub async fn clear_session_thread_goal');
    const getSource = source.slice(getStart, clearStart);

    expect(getStart).toBeGreaterThan(-1);
    expect(clearStart).toBeGreaterThan(getStart);
    expect(getSource).toContain('resolve_thread_goal_storage_path');
    expect(getSource).not.toContain('ensure_session_for_thread_goal');
    expect(getSource).not.toContain('restore_session');
  });

  it('defers passive historical thread-goal refresh without delaying explicit goal entry', () => {
    const source = readSource('../../flow_chat/hooks/useThreadGoalController.ts');
    const passiveRefreshEffectStart = source.indexOf('if (session?.isHistorical)');
    const openGoalEntryStart = source.indexOf('const openGoalEntry = useCallback');

    expect(passiveRefreshEffectStart).toBeGreaterThan(-1);
    expect(source).toContain('HISTORICAL_THREAD_GOAL_REFRESH_DELAY_MS');
    expect(source).toContain('globalThis.setTimeout(() => {');
    expect(source).toContain('globalThis.clearTimeout(timeoutId)');
    expect(openGoalEntryStart).toBeGreaterThan(passiveRefreshEffectStart);
    expect(source.slice(openGoalEntryStart)).toContain('await fetchSessionThreadGoal(session)');
  });

  it('uses the history open intent as a strict before-hydrate activation gate without adding a second paint wait', () => {
    const source = readSource('../../app/components/NavPanel/sections/sessions/SessionsSection.tsx');
    const sessionModuleSource = readSource('../../flow_chat/services/flow-chat-manager/SessionModule.ts');
    const intentSource = readSource('../../flow_chat/services/sessionOpenIntent.ts');
    const dispatchResultStart = source.indexOf("type HistoryOpenIntentDispatchResult = 'none' | 'dispatched' | 'already-pending'");
    const duplicateIntentStart = source.indexOf("return 'already-pending'");
    const switchStart = source.indexOf('const handleSwitch = useCallback');
    const pointerDownStart = source.indexOf('const handleSessionOpenPointerDown = useCallback');
    const beforeHydrateStart = sessionModuleSource.indexOf("activation: 'before-hydrate'");
    const hydrateBeforeSwitchStart = sessionModuleSource.indexOf('if (shouldHydrateBeforeSwitch)');

    expect(dispatchResultStart).toBeGreaterThan(-1);
    expect(duplicateIntentStart).toBeGreaterThan(dispatchResultStart);
    expect(source).toContain("historyOpenIntentDispatch !== 'none'");
    expect(source).not.toContain('if (historyOpenIntentDispatched)');
    expect(pointerDownStart).toBeGreaterThan(switchStart);
    expect(source.slice(pointerDownStart)).toContain("dispatchHistoryOpenIntentForSession(session, 'pointerdown')");
    expect(intentSource).toContain('RECENT_HISTORY_OPEN_INTENT_MS');
    expect(intentSource).toContain('HISTORY_SESSION_OPEN_TRANSITION_MAX_MS');
    expect(intentSource).toContain('subscribeHistorySessionOpenTransition');
    expect(sessionModuleSource).toContain('consumeRecentHistorySessionOpenIntent(sessionId)');
    expect(beforeHydrateStart).toBeGreaterThan(-1);
    expect(hydrateBeforeSwitchStart).toBeGreaterThan(-1);
    expect(beforeHydrateStart).toBeLessThan(hydrateBeforeSwitchStart);
    expect(sessionModuleSource).toContain("shouldHydrateBeforeSwitch ? 'after-hydrate' : 'immediate'");
  });

  it('keeps passive chat Git refresh out of the history open transition window', () => {
    const chatInputSource = readSource('../../flow_chat/components/ChatInput.tsx');
    const fileCardSource = readSource('../../flow_chat/tool-cards/FileOperationToolCard.tsx');
    const workspaceItemSource = readSource('../../app/components/NavPanel/sections/workspaces/WorkspaceItem.tsx');

    expect(chatInputSource).toContain('useSyncExternalStore');
    expect(chatInputSource).toContain('getHistorySessionOpenTransitionSnapshot');
    expect(chatInputSource).toContain('deferChatStripPassiveGitRefresh');
    expect(chatInputSource).toContain('historySessionOpenTransition !== null');
    expect(fileCardSource).not.toContain('useGitState');
    expect(workspaceItemSource).toContain('getHistorySessionOpenTransitionSnapshot');
    expect(workspaceItemSource).toContain('suppressWorkspaceGitRefreshOnMountDuringSessionTransition');
    expect(workspaceItemSource).toContain('subscribeHistorySessionOpenTransition');
    expect(workspaceItemSource).toContain('WORKSPACE_GIT_PENDING_CANCEL_SOURCES');
    expect(workspaceItemSource).toContain('cancelPendingRefresh');
    expect(workspaceItemSource).toContain('historySessionOpenTransition !== null');
  });

  it('keeps non-active workspace session metadata out of the first startup window', () => {
    const source = readSource('../../app/components/NavPanel/sections/sessions/SessionsSection.tsx');

    expect(source).toContain('isActiveWorkspace = true');
    expect(source).not.toContain('isActiveWorkspace: _isActiveWorkspace');
    expect(source).toContain('getInitialSessionMetadataLoadMode');
    expect(source).toContain("loadMode === 'immediate'");
    expect(source).toContain("loadMode === 'after-startup-paint'");
    expect(source).toContain('scheduleAfterStartupSignal');
    expect(source).toContain('scheduleAfterStartupPaint');
    expect(source).toContain('hasStartupOverlayHandedOff');
    expect(source).toContain('SESSION_METADATA_DEFERRED_SIGNAL');
    expect(source).toContain('sessions_nav_initial_active');
    expect(source).toContain('sessions_nav_initial_deferred');
    expect(source).toContain('data-session-nav-toggle-action');
  });

  it('keeps Git diff editor from importing the broad editor barrel', () => {
    const source = readSource('../../tools/git/components/GitDiffEditor/GitDiffEditor.tsx');

    expect(source).not.toMatch(/from\s+['"]@\/tools\/editor['"]/);
    expect(source).toContain("from '@/tools/editor/components/DiffEditor'");
  });

  it('uses narrow context-menu imports from startup-visible modules', () => {
    const sources = [
      '../../app/scenes/shell/ShellNav.tsx',
      '../../infrastructure/markdown/MarkdownRenderer.tsx',
      '../../flow_chat/tool-cards/GenerativeWidgetToolCard.tsx',
      '../../tools/file-system/components/FileSearchResults.tsx',
      '../../tools/generative-widget/useGenerativeWidgetPromptMenu.ts',
      '../../shared/notification-system/providers/NotificationContextMenuProvider.ts',
    ].map(readSource);

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+['"]@\/shared\/context-menu-system['"]/);
    }
  });

  it('keeps markdown content rendering off the components i18n subscription path', () => {
    const source = readSource('../../infrastructure/markdown/MarkdownRenderer.tsx');
    const mathSource = readSource('../../infrastructure/markdown/MarkdownMathRenderer.tsx');

    expect(source).not.toContain("useI18n('components')");
    expect(source).not.toContain('useI18n("components")');
    expect(source).toContain("import { i18nService } from '@/infrastructure/i18n'");
    expect(source).not.toContain("from 'remark-math'");
    expect(source).not.toContain("from 'rehype-katex'");
    expect(source).not.toContain("import 'katex/dist/katex.min.css'");
    expect(source).toContain("import('./MarkdownMathRenderer')");
    expect(mathSource).toContain("from 'remark-math'");
    expect(mathSource).toContain("from 'rehype-katex'");
    expect(mathSource).toContain("import 'katex/dist/katex.min.css'");
  });

  it('avoids the infrastructure barrel from startup-visible modules', () => {
    const sources = [
      '../../app/layout/AppLayout.tsx',
      '../../app/hooks/useDialogCompletionNotify.ts',
      '../../infrastructure/update/DailyAppUpdateGate.tsx',
      '../../flow_chat/components/ChatInput.tsx',
      '../../tools/git/services/GitEventService.ts',
    ].map(readSource);

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+['"]@\/infrastructure['"]/);
      expect(source).not.toMatch(/from\s+['"]\.\.\/\.\.\/\.\.\/infrastructure['"]/);
    }

    expect(sources[0]).not.toMatch(/from\s+['"]@\/infrastructure\/config['"]/);
    expect(sources[0]).toContain("from '@/infrastructure/config/services/ConfigManager'");
  });

  it('avoids the broad flow-chat barrel from startup-visible shell modules', () => {
    const sources = [
      '../App.tsx',
      '../../app/layout/AppLayout.tsx',
    ].map(readSource);

    for (const source of sources) {
      expect(source).not.toMatch(/from\s+['"]\.\.\/flow_chat['"]/);
      expect(source).not.toMatch(/from\s+['"]\.\.\/\.\.\/flow_chat['"]/);
      expect(source).not.toMatch(/from\s+['"]@\/flow_chat['"]/);
    }
  });

  it('keeps on-demand workspace utility dialogs out of startup-visible chunks', () => {
    const appLayoutSource = readSource('../../app/layout/AppLayout.tsx');
    const workspaceItemSource = readSource('../../app/components/NavPanel/sections/workspaces/WorkspaceItem.tsx');
    const sessionsSectionSource = readSource('../../app/components/NavPanel/sections/sessions/SessionsSection.tsx');
    const footerActionsSource = readSource('../../app/components/NavPanel/components/PersistentFooterActions.tsx');
    const newProjectDialogSource = readSource('../../app/components/NewProjectDialog/NewProjectDialog.tsx');
    const relatedPathsDialogSource = readSource(
      '../../app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog.tsx'
    );

    expect(appLayoutSource).not.toMatch(/import\s+\{\s*open\s*\}\s+from\s+['"]@tauri-apps\/plugin-dialog['"]/);
    expect(appLayoutSource).not.toMatch(/import\s+\{\s*NewProjectDialog\s*\}\s+from/);
    expect(appLayoutSource).toContain('const NewProjectDialog = lazy');
    expect(appLayoutSource).toContain("import('../components/NewProjectDialog')");
    expect(appLayoutSource).toContain('<RetainedMountBoundary present={showNewProjectDialog}>');

    expect(workspaceItemSource).not.toMatch(/import\s+WorkspaceRelatedPathsDialog\s+from/);
    expect(workspaceItemSource).not.toMatch(/import\s+WorkspaceSessionBatchModal\s+from/);
    expect(workspaceItemSource).not.toMatch(/import\s+ScheduledJobsModal\s+from/);
    expect(workspaceItemSource).toContain("lazy(() => import('./WorkspaceRelatedPathsDialog'))");
    expect(workspaceItemSource).toContain("lazy(() => import('./WorkspaceSessionBatchModal'))");
    expect(workspaceItemSource).toContain("lazy(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'))");
    expect(workspaceItemSource).toContain('<RetainedMountBoundary present={relatedPathsDialogOpen}>');
    expect(workspaceItemSource).toContain('<RetainedMountBoundary present={sessionBatchModalOpen}>');
    expect(workspaceItemSource).toContain('<RetainedMountBoundary present={scheduledJobsModalOpen}>');

    expect(sessionsSectionSource).not.toMatch(/import\s+ScheduledJobsModal\s+from/);
    expect(sessionsSectionSource).toContain("lazy(() => import('@/app/components/scheduled-jobs/ScheduledJobsModal'))");
    expect(sessionsSectionSource).toContain('<RetainedMountBoundary present={scheduledJobsSession != null}>');

    expect(footerActionsSource).not.toMatch(/import\s+\{\s*RemoteConnectDialog\s*\}\s+from/);
    expect(footerActionsSource).toContain("lazy(() => import('../../RemoteConnectDialog'))");
    expect(footerActionsSource).toContain('<RetainedMountBoundary present={showRemoteConnect}>');

    expect(newProjectDialogSource).not.toMatch(/from\s+['"]@tauri-apps\/plugin-dialog['"]/);
    expect(newProjectDialogSource).not.toContain("await import('@tauri-apps/plugin-dialog')");
    expect(newProjectDialogSource).toContain('@/infrastructure/peer-device/pickWorkspaceDirectory');
    expect(relatedPathsDialogSource).not.toMatch(/from\s+['"]@tauri-apps\/plugin-dialog['"]/);
    expect(relatedPathsDialogSource).not.toContain("await import('@tauri-apps/plugin-dialog')");
    expect(relatedPathsDialogSource).toContain('@/infrastructure/peer-device/pickWorkspaceDirectory');
  });

  it('keeps startup session metadata paging on the narrow SessionAPI entrypoint', () => {
    const source = readSource('../../flow_chat/store/FlowChatStore.ts');
    const imports = dynamicImportSpecifiers(source);

    expect(source).toContain("import('@/infrastructure/api/service-api/SessionAPI')");
    expect(imports).not.toContain('@/infrastructure/api');
  });

  it('keeps historical session restore on the narrow AgentAPI entrypoint', () => {
    const source = readSource('../../flow_chat/store/FlowChatStore.ts');
    const imports = dynamicImportSpecifiers(source);
    const staticImports = staticImportSpecifiers(source);
    const agentApiDynamicImports = imports.filter(specifier => specifier.endsWith('/AgentAPI'));
    const agentApiStaticImports = staticImports.filter(specifier => specifier.endsWith('/AgentAPI'));

    expect(agentApiStaticImports).toEqual(['@/infrastructure/api/service-api/AgentAPI']);
    expect(agentApiDynamicImports.length).toBeGreaterThan(0);
    expect(new Set(agentApiDynamicImports)).toEqual(
      new Set(['@/infrastructure/api/service-api/AgentAPI'])
    );
    expect(staticImports).not.toContain('@/infrastructure/api');
    expect(imports).not.toContain('@/infrastructure/api');
  });

  it('keeps session interaction hot paths off the broad API barrel', () => {
    const hotPathSources = [
      '../../flow_chat/hooks/useFlowChat.ts',
      '../../flow_chat/components/modern/ModernFlowChatContainer.tsx',
      '../../flow_chat/components/modern/useFlowChatSync.ts',
      '../../flow_chat/components/ChatInput.tsx',
      '../../flow_chat/services/flow-chat-manager/PersistenceModule.ts',
      '../../flow_chat/state-machine/SessionStateMachine.ts',
    ].map(readSource);

    for (const source of hotPathSources) {
      expect(staticImportSpecifiers(source)).not.toContain('@/infrastructure/api');
      expect(dynamicImportSpecifiers(source)).not.toContain('@/infrastructure/api');
    }
  });

  it('keeps Agent companion startup bridge imports lazy in App', () => {
    const source = readSource('../App.tsx');
    const mainSource = readSource('../../main.tsx');
    const petSource = readSource('../components/AgentCompanionDesktopPet/AgentCompanionDesktopPet.tsx');

    expect(source).not.toMatch(/from\s+['"]@\/flow_chat\/utils\/agentCompanionActivity['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/flow_chat\/services\/AgentCompanionActivityBridge['"]/);
    expect(source).not.toMatch(/from\s+['"]\.\/services\/openAgentCompanionSession['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/infrastructure\/config\/services\/AgentCompanionWindowService['"]/);
    expect(source).toContain("import('@/flow_chat/utils/agentCompanionActivity')");
    expect(source).toContain("import('@/flow_chat/services/AgentCompanionActivityBridge')");
    expect(source).toContain("import('./services/openAgentCompanionSession')");
    expect(staticImportSpecifiers(mainSource)).toContain(
      './app/components/AgentCompanionDesktopPet/AgentCompanionDesktopPet'
    );
    expect(dynamicImportSpecifiers(mainSource)).not.toContain(
      './app/components/AgentCompanionDesktopPet/AgentCompanionDesktopPet'
    );
    expect(source).toContain("listen(\n        'agent-companion://ready'");
    expect(source).toContain("emit('agent-companion://settings-updated', settings)");
    expect(source).toContain('emitAgentCompanionActivity(buildAgentCompanionActivity())');
    expect(petSource).toContain("listen<AIExperienceSettings>('agent-companion://settings-updated'");
    expect(petSource).toContain("listen<AgentCompanionActivityPayload>('agent-companion://activity-updated'");
    expect(petSource).toContain("emit('agent-companion://ready')");
    expect(petSource).toContain("getCurrentWindow().hide()");
  });

  it('cancels stale Agent companion startup sync when settings change', () => {
    const source = readSource('../App.tsx');
    const changeListenerIndex = source.indexOf('removeSettingsListener = aiExperienceConfigService.addChangeListener');

    expect(source).toContain('const cancelPendingAgentCompanionStartupSync = () => {');
    expect(source).toContain('startupSyncHandle?.cancel();');
    expect(source).toContain('version !== syncVersion');
    expect(source).toContain("syncAgentCompanionSettings(null, 'startup_idle')");
    expect(source).toContain("getSettingsAsync({ forceRefresh: true })");
    expect(changeListenerIndex).toBeGreaterThan(-1);
    expect(source.slice(changeListenerIndex)).toContain("syncAgentCompanionSettings(settings, 'settings_change')");
  });
});
