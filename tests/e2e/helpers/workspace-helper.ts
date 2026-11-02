/**
 * Helper utilities for workspace operations in e2e tests.
 */

import { browser, $, $$ } from '@wdio/globals';
import * as path from 'path';

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: (command: string, args?: unknown) => Promise<unknown>;
      };
    };
  }
}

export interface WorkspaceState {
  currentWorkspacePath: string | null;
  openedWorkspacePaths: string[];
  workspaceLabels: string[];
}

export interface WorkspaceReadyOptions {
  requireWorkspaceLabel?: boolean;
}

interface FrontendNavigationMarker {
  readyState: DocumentReadyState;
  timeOrigin: number;
  traceId: string | null;
}

type StartupTraceWindow = Window & typeof globalThis & {
  __OPENBITFUN_STARTUP_TRACE__?: {
    snapshot?: () => unknown;
  };
};

type StartupTraceSnapshotLike = {
  traceId?: string;
  phases?: {
    events?: Array<{ phase?: string }>;
  };
};

async function readFrontendNavigationMarker(): Promise<FrontendNavigationMarker | null> {
  return browser.execute(() => {
    try {
      const startupTraceWindow = window as unknown as StartupTraceWindow;
      const snapshot = startupTraceWindow.__OPENBITFUN_STARTUP_TRACE__?.snapshot?.();
      const traceSnapshot = snapshot && typeof snapshot === 'object'
        ? snapshot as StartupTraceSnapshotLike
        : null;
      return {
        readyState: document.readyState,
        timeOrigin: performance.timeOrigin,
        traceId: traceSnapshot?.traceId ?? null,
      };
    } catch {
      return null;
    }
  });
}

async function waitForFrontendReload(previousMarker: FrontendNavigationMarker | null): Promise<void> {
  await browser.waitUntil(async () => {
    const marker = await readFrontendNavigationMarker();
    if (!marker || marker.readyState === 'loading') {
      return false;
    }

    if (!previousMarker) {
      return true;
    }

    return marker.timeOrigin !== previousMarker.timeOrigin ||
      (Boolean(previousMarker.traceId) && Boolean(marker.traceId) && marker.traceId !== previousMarker.traceId);
  }, {
    timeout: 15000,
    interval: 100,
    timeoutMsg: 'Frontend did not reload after bundled workspace switch',
  });
}

async function waitForPostReloadShellReady(projectName: string, workspacePath: string): Promise<void> {
  await browser.waitUntil(async () => {
    try {
      return browser.execute((expectedProjectName: string) => {
        const startupTraceWindow = window as unknown as StartupTraceWindow;
        const snapshot = startupTraceWindow.__OPENBITFUN_STARTUP_TRACE__?.snapshot?.();
        const traceSnapshot = snapshot && typeof snapshot === 'object'
          ? snapshot as StartupTraceSnapshotLike
          : null;
        const phases = traceSnapshot?.phases?.events ?? [];
        const interactiveShellReady = phases.some((event: { phase?: string }) =>
          event.phase === 'interactive_shell_ready'
        );
        const startupOverlayGone = document.getElementById('openbitfun-startup-overlay') === null;
        const labels = Array.from(document.querySelectorAll('.openbitfun-nav-panel__workspace-item-label'))
          .map(element => element.textContent?.trim() || '')
          .filter(Boolean);
        const targetWorkspaceVisible = labels.some(label => label.includes(expectedProjectName));

        return interactiveShellReady && startupOverlayGone && targetWorkspaceVisible;
      }, projectName);
    } catch {
      return false;
    }
  }, {
    timeout: 20000,
    interval: 100,
    timeoutMsg: `Frontend shell did not become ready after bundled workspace switch: ${workspacePath}`,
  });
}

/**
 * Open a workspace through the frontend state layer so the UI stays in sync.
 */
export async function openWorkspaceThroughFrontend(workspacePath: string): Promise<void> {
  const previousNavigationMarker = await readFrontendNavigationMarker().catch(() => null);
  const openedViaBundledIpc = await browser.execute(async (targetWorkspacePath: string) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      const workspace = await invoke('open_workspace', { request: { path: targetWorkspacePath } }) as {
        id?: string;
      };
      if (workspace?.id) {
        await invoke('set_active_workspace', { request: { workspaceId: workspace.id } });
      }
      return true;
    }

    const { workspaceManager } = await import('/src/infrastructure/services/business/workspaceManager.ts');
    await workspaceManager.openWorkspace(targetWorkspacePath);
    return false;
  }, workspacePath);

  if (openedViaBundledIpc) {
    const projectName = path.basename(workspacePath);
    await browser.refresh();
    await waitForFrontendReload(previousNavigationMarker);
    await waitForPostReloadShellReady(projectName, workspacePath);
  }
}

/**
 * Read the current frontend-visible workspace state.
 */
export async function getWorkspaceState(): Promise<WorkspaceState> {
  return browser.execute(async () => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      const currentWorkspace = await invoke('get_current_workspace', { request: {} }) as {
        rootPath?: string;
      } | null;
      const openedWorkspaces = await invoke('get_opened_workspaces', { request: {} }) as Array<{
        rootPath?: string;
      }>;
      const workspaceLabels = Array.from(document.querySelectorAll('.openbitfun-nav-panel__workspace-item-label'))
        .map(element => element.textContent?.trim() || '')
        .filter(Boolean);

      return {
        currentWorkspacePath: currentWorkspace?.rootPath || null,
        openedWorkspacePaths: openedWorkspaces.map(workspace => workspace.rootPath || '').filter(Boolean),
        workspaceLabels,
      };
    }

    const { globalStateAPI } = await import('/src/shared/types/global-state.ts');
    const currentWorkspace = await globalStateAPI.getCurrentWorkspace();
    const openedWorkspaces = await globalStateAPI.getOpenedWorkspaces();
    const workspaceLabels = Array.from(document.querySelectorAll('.openbitfun-nav-panel__workspace-item-label'))
      .map(element => element.textContent?.trim() || '')
      .filter(Boolean);

    return {
      currentWorkspacePath: currentWorkspace?.rootPath || null,
      openedWorkspacePaths: openedWorkspaces.map(workspace => workspace.rootPath),
      workspaceLabels,
    };
  });
}

/**
 * Wait until frontend state reflects the target workspace.
 * Most flows also require the nav DOM label; perf flows can opt out when the
 * measurement only needs an active/opened workspace and must not depend on nav
 * expansion rendering.
 */
export async function waitForWorkspaceReady(
  workspacePath: string,
  projectName: string = path.basename(workspacePath),
  timeout: number = 15000,
  options: WorkspaceReadyOptions = {},
): Promise<WorkspaceState> {
  const requireWorkspaceLabel = options.requireWorkspaceLabel ?? true;
  await browser.waitUntil(async () => {
    const state = await getWorkspaceState();
    return state.currentWorkspacePath === workspacePath
      && state.openedWorkspacePaths.includes(workspacePath)
      && (!requireWorkspaceLabel || state.workspaceLabels.some(label => label.includes(projectName)));
  }, {
    timeout,
    interval: 500,
    timeoutMsg: `Workspace did not become active in frontend state: ${workspacePath}`,
  });

  return getWorkspaceState();
}

/**
 * Open a workspace and wait until the frontend is ready to interact with it.
 */
export async function openWorkspace(
  workspacePath: string = process.env.E2E_TEST_WORKSPACE || process.cwd(),
  options: WorkspaceReadyOptions = {},
): Promise<boolean> {
  try {
    const initialState = await getWorkspaceState();
    const projectName = path.basename(workspacePath);
    const requireWorkspaceLabel = options.requireWorkspaceLabel ?? true;
    if (
      initialState.currentWorkspacePath === workspacePath
      && initialState.openedWorkspacePaths.includes(workspacePath)
      && (!requireWorkspaceLabel || initialState.workspaceLabels.some(label => label.includes(projectName)))
    ) {
      return true;
    }

    await openWorkspaceThroughFrontend(workspacePath);
    await waitForWorkspaceReady(workspacePath, projectName, 15000, options);
    return true;
  } catch (error) {
    console.error('[WorkspaceHelper] Failed to open workspace through frontend state:', error);
    return false;
  }
}

/**
 * Ensure a Code session is open for the active workspace.
 */
export async function ensureCodeSessionOpen(): Promise<void> {
  const chatInput = await $('[data-testid="chat-input-container"]');
  if (await chatInput.isExisting()) {
    return;
  }

  const selectors = [
    '[data-testid="nav-workspace-new-session-btn"]',
    '.openbitfun-nav-panel__workspace-create-main--split-left',
    '[data-testid="chat-input-send-btn"]',
  ];

  let opened = false;
  for (const selector of selectors) {
    const element = await $(selector);
    if (await element.isExisting()) {
      if (selector !== '[data-testid="chat-input-send-btn"]') {
        await element.click();
      }
      opened = true;
      break;
    }
  }

  if (!opened) {
    const fallbackButton = await $('//button[contains(normalize-space(.), "Code")]');
    await fallbackButton.click();
  }

  await browser.waitUntil(async () => {
    const input = await $('[data-testid="chat-input-container"]');
    return input.isExisting();
  }, {
    timeout: 15000,
    interval: 500,
    timeoutMsg: 'Code session did not open',
  });
}

/**
 * Checks if any workspace is currently active in the frontend.
 */
export async function isWorkspaceOpen(): Promise<boolean> {
  const state = await getWorkspaceState();
  if (state.currentWorkspacePath) {
    return true;
  }

  const chatInput = await $('[data-testid="chat-input-container"]');
  return await chatInput.isExisting();
}

export default {
  openWorkspaceThroughFrontend,
  getWorkspaceState,
  waitForWorkspaceReady,
  openWorkspace,
  ensureCodeSessionOpen,
  isWorkspaceOpen,
};
