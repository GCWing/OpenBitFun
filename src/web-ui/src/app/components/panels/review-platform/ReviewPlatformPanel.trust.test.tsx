import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPlatformPanel } from './ReviewPlatformPanel';
import { resetGitTrustDecisions } from '@/shared/services/gitTrustService';
import { TauriCommandError } from '@/infrastructure/api/errors/TauriCommandError';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), context: vi.fn(), confirm: vi.fn(), trust: vi.fn(),
  state: { sessions: new Map(), activeSessionId: null },
}));
vi.mock('@/infrastructure/api', () => ({
  reviewPlatformAPI: { getWorkspaceSnapshot: mocks.snapshot, getWorkspaceContext: mocks.context },
  systemAPI: {},
  gitAPI: { trustRepository: mocks.trust, getRepositoryTrust: vi.fn() },
}));
vi.mock('@/infrastructure/confirm-dialog', () => ({ confirmWarning: mocks.confirm }));
vi.mock('@/infrastructure/i18n', () => ({
  i18nService: { t: (key: string) => key },
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/shared/notification-system', () => ({
  notificationService: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/flow_chat/store/FlowChatStore', () => ({
  flowChatStore: { getState: () => mocks.state, subscribe: () => () => {} },
}));
vi.mock('@/flow_chat/components/DeepReviewConsentDialog', () => ({
  useDeepReviewConsent: () => ({ confirmDeepReviewLaunch: vi.fn(), deepReviewConsentDialog: null }),
}));
vi.mock('@/flow_chat/services/ReviewService', () => ({
  launchPreparedReviewSession: vi.fn(), prepareReviewLaunchFromPullRequest: vi.fn(),
}));
vi.mock('@/flow_chat/services/sessionActivation', () => ({ openMainSession: vi.fn() }));
vi.mock('@/flow_chat/services/btwSessionPane', () => ({ openBtwSessionInAuxPane: vi.fn() }));
vi.mock('@/shared/services/ide-control', () => ({ quickActions: {} }));
vi.mock('@/shared/stores/contextStore', () => ({ useContextStore: {} }));
vi.mock('@/infrastructure/markdown', () => ({ MarkdownRenderer: () => null }));

let dom: { window: Window & typeof globalThis };
let root: Root;
let container: HTMLDivElement;
const workspaceId = 'workspace-review-trust-test';
const workspacePath = '/workspace/review-trust-test';
const error = new TauriCommandError('Command failed', {
  command: 'review_platform_get_workspace_snapshot',
  originalError: `git_repository_untrusted: ${workspacePath}`,
});

beforeEach(async () => {
  const { JSDOM } = await import('jsdom');
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.resetAllMocks();
  resetGitTrustDecisions();
  mocks.snapshot.mockRejectedValue(error);
  mocks.context.mockRejectedValue(error);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

describe('Review platform trust interaction', () => {
  it.each([false, true])('does not prompt during automatic loading (detailOnly=%s)', async (detailOnly) => {
    await act(async () => root.render(<ReviewPlatformPanel workspaceId={workspaceId} workspacePath={workspacePath} detailOnly={detailOnly} />));
    expect(detailOnly ? mocks.context : mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(detailOnly ? mocks.context : mocks.snapshot).toHaveBeenCalledWith(
      { workspaceId, repositoryPath: workspacePath },
      ...(detailOnly ? [null] : [null, 1, 10, 'all']),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.trust).not.toHaveBeenCalled();
    expect(container.textContent).toContain('panels/git:trust.required');
    expect(container.textContent).not.toContain('git_repository_untrusted:');
  });

  it.each([true, false])('asks on Retry and replays only after approval (approved=%s)', async (approved) => {
    mocks.confirm.mockResolvedValue(approved);
    mocks.trust.mockResolvedValue({ state: 'trusted', repositoryPath: workspacePath });
    await act(async () => root.render(<ReviewPlatformPanel workspaceId={workspaceId} workspacePath={workspacePath} />));
    const retry = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry');
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.trust).toHaveBeenCalledTimes(approved ? 1 : 0);
    if (approved) {
      // Trust is granted to the workspace by ID; the path only names the repository inside it.
      expect(mocks.trust).toHaveBeenCalledWith({ workspaceId, repositoryPath: workspacePath });
    }
    expect(mocks.snapshot).toHaveBeenCalledTimes(approved ? 3 : 2);
    expect(container.textContent).toContain('panels/git:trust.required');
  });
});
