import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionFilesBadge } from './SessionFilesBadge';
import { prepareReviewLaunchFromSessionFiles } from '../../services/ReviewService';
import { notificationService } from '../../../shared/notification-system';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  files: [] as Array<{ filePath: string; sessionId: string }>,
  getSessionFileDiffStats: vi.fn(),
  getOperationDiff: vi.fn(),
  flowState: {
    sessions: new Map<string, unknown>(),
  },
  flowListeners: new Set<() => void>(),
  settingsListeners: new Set<(settings: { quick_actions: unknown[] }) => void>(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const messages: Record<string, string> = {
        'sessionFilesBadge.actionsButton': 'Actions',
        'sessionFilesBadge.actionsMenuHint': 'Quick actions',
        'sessionFilesBadge.reviewModeStandard': 'Review',
        'sessionFilesBadge.reviewModeDeep': 'Review: Strict',
      };
      if (key === 'sessionFilesBadge.filesSummaryCount') {
        return `${String(options?.count ?? 0)} files`;
      }
      if (messages[key]) {
        return messages[key];
      }
      return typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    },
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../tools/snapshot_system/hooks/useSnapshotState', () => ({
  useSnapshotState: () => ({
    files: mocks.files,
  }),
}));

vi.mock('../../../shared/utils/tabUtils', () => ({
  createDiffEditorTab: vi.fn(),
}));

vi.mock('../../../infrastructure/api', () => ({
  snapshotAPI: {
    getSessionFileDiffStats: mocks.getSessionFileDiffStats,
    getOperationDiff: mocks.getOperationDiff,
  },
}));

vi.mock('../../../infrastructure/contexts/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    currentWorkspace: { id: 'workspace-1', workspaceKind: 'local', rootPath: 'D:/workspace/project' },
  }),
}));

// The session-driver registry pulls in the local driver and its runtime
// services; this badge only needs the session's workspace ID from it.
vi.mock('../../session-drivers/sessionFileNavigation', () => ({
  sessionWorkspaceId: (sessionId: string | undefined) => (sessionId === 'session-1' ? 'workspace-1' : undefined),
}));

vi.mock('../../../shared/notification-system', () => ({
  notificationService: {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../services/ReviewService', () => ({
  prepareReviewLaunchFromSessionFiles: vi.fn(),
  launchPreparedReviewSession: vi.fn(),
}));

vi.mock('@/infrastructure/runtime', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('../DeepReviewConsentDialog', () => ({
  useDeepReviewConsent: () => ({
    confirmDeepReviewLaunch: vi.fn(),
    deepReviewConsentDialog: null,
  }),
}));

vi.mock('../../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => mocks.flowState,
    subscribe: (listener: () => void) => {
      mocks.flowListeners.add(listener);
      return () => mocks.flowListeners.delete(listener);
    },
  },
}));

vi.mock('../../hooks/useSessionReviewActivity', () => ({
  useSessionReviewActivity: () => null,
}));

vi.mock('../../hooks/useSessionStateMachine', () => ({
  useSessionStateMachine: () => null,
}));

vi.mock('@/infrastructure/config/services/AIExperienceConfigService', () => ({
  DEFAULT_QUICK_ACTIONS: [{ id: 'fixture-default', label: 'Default fixture action', prompt: 'fixture', enabled: true }],
  aiExperienceConfigService: {
    getSettings: () => ({ quick_actions: [] }),
    addChangeListener: (listener: (settings: { quick_actions: unknown[] }) => void) => {
      mocks.settingsListeners.add(listener);
      return () => mocks.settingsListeners.delete(listener);
    },
  },
}));

vi.mock('@/infrastructure/config/services/quickActionLocalization', () => ({
  resolveQuickActionText: vi.fn(),
}));

vi.mock('../../utils/deepReviewCapacityGuard', () => ({
  deriveDeepReviewSessionConcurrencyGuard: vi.fn(),
}));

describe('SessionFilesBadge', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLDivElement', dom.window.HTMLDivElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

    mocks.files = [
      { filePath: 'src/current-session.ts', sessionId: 'session-1' },
      { filePath: 'src/stale-session.ts', sessionId: 'session-1' },
    ];
    mocks.flowState.sessions = new Map<string, unknown>([
      ['session-1', {
        sessionId: 'session-1',
        dialogTurns: [],
      }],
    ]);
    mocks.flowListeners.clear();
    mocks.settingsListeners.clear();
    mocks.getSessionFileDiffStats.mockReset();
    mocks.getSessionFileDiffStats.mockResolvedValue({
      linesAdded: 1,
      linesRemoved: 0,
      changeKind: 'modify',
    });
    mocks.getOperationDiff.mockReset();
    vi.mocked(prepareReviewLaunchFromSessionFiles).mockReset();
    vi.mocked(notificationService.error).mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    dom.window.document.querySelector('[data-openbitfun-overlay-host="true"]')?.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('removes cached stats when the current session file list shrinks', async () => {
    await act(async () => {
      root.render(<SessionFilesBadge sessionId="session-1" />);
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    const toggle = container.querySelector('.session-files-badge__button') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelector('[data-openbitfun-name="chevron-down"]')).not.toBeNull();

    await act(async () => {
      toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(toggle?.querySelector('[data-openbitfun-name="chevron-up"]')).not.toBeNull();

    const filesPopover = dom.window.document.querySelector<HTMLElement>('.session-files-badge__popover');
    expect(filesPopover?.parentElement?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(filesPopover?.style.visibility).toBe('visible');
    expect(dom.window.document.body.textContent).toContain('2 files');

    mocks.files = [
      { filePath: 'src/current-session.ts', sessionId: 'session-1' },
    ];

    await act(async () => {
      root.render(<SessionFilesBadge sessionId="session-1" />);
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    expect(dom.window.document.body.textContent).toContain('1 files');
    expect(dom.window.document.body.textContent).not.toContain('stale-session.ts');
  });

  it('presents one adaptive Review action instead of asking users to choose a depth', async () => {
    await act(async () => {
      root.render(<SessionFilesBadge sessionId="session-1" />);
    });

    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    const actionsButton = container.querySelector('.session-files-badge__review-btn') as HTMLButtonElement | null;
    expect(actionsButton).not.toBeNull();
    expect(actionsButton?.dataset.size).toBe('xs');
    expect(actionsButton?.querySelector('[data-openbitfun-name="commit"]')).not.toBeNull();
    expect(actionsButton?.textContent).toBe('');

    await act(async () => {
      actionsButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const reviewPopover = dom.window.document.querySelector<HTMLElement>('.session-files-badge__review-menu-popover');
    expect(reviewPopover?.parentElement?.getAttribute('data-openbitfun-overlay-host')).toBe('true');
    expect(reviewPopover?.style.visibility).toBe('visible');
    expect(dom.window.document.body.textContent).toContain('Review');
    expect(dom.window.document.body.textContent).not.toContain('Review: Strict');
    expect(dom.window.document.body.textContent).not.toContain('Deep review');
    // The persisted [] means the user removed all quick actions.
    expect(dom.window.document.body.textContent).not.toContain('Default fixture action');
  });

  it('shows a localized error when Review cannot be prepared', async () => {
    vi.mocked(prepareReviewLaunchFromSessionFiles).mockRejectedValueOnce(
      new Error('review policy unavailable'),
    );
    await act(async () => {
      root.render(<SessionFilesBadge sessionId="session-1" />);
    });
    await act(async () => {
      vi.advanceTimersByTime(350);
      await Promise.resolve();
    });

    const actionsButton = container.querySelector('.session-files-badge__review-btn') as HTMLButtonElement;
    await act(async () => {
      actionsButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const reviewButton = dom.window.document.querySelector('[role="menuitem"]') as HTMLButtonElement;
    await act(async () => {
      reviewButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(notificationService.error).toHaveBeenCalledWith(
      expect.stringContaining('review policy unavailable'),
      expect.objectContaining({ duration: 5000 }),
    );
  });
});
