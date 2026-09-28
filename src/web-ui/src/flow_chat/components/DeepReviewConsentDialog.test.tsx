import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeepReviewConsent } from './DeepReviewConsentDialog';
import type { ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';

vi.mock('react-i18next', async () => {
  const { createTestI18nT } = await import('@/test/i18nTestUtils');
  return {
    initReactI18next: {
      type: '3rdParty',
      init: vi.fn(),
    },
    useTranslation: () => ({
      t: createTestI18nT('flow-chat'),
    }),
  };
});

vi.mock('@openbitfun/ui', () => ({
  Icon: () => <svg aria-hidden="true" />,
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  Dialog: ({
    'aria-label': ariaLabel,
    children,
    open,
  }: {
    'aria-label'?: string;
    children: React.ReactNode;
    open: boolean;
  }) => (open ? <div role="dialog" aria-modal="true" aria-label={ariaLabel}>{children}</div> : null),
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogClose: ({
    'aria-label': ariaLabel,
    onClick,
  }: {
    'aria-label': string;
    onClick?: () => void;
  }) => <button type="button" aria-label={ariaLabel} onClick={onClick} />,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
}));

let JSDOMCtor: (new (
  html?: string,
  options?: { pretendToBeVisual?: boolean; url?: string }
) => { window: Window & typeof globalThis }) | null = null;

try {
  const jsdom = await import('jsdom');
  JSDOMCtor = jsdom.JSDOM as typeof JSDOMCtor;
} catch {
  JSDOMCtor = null;
}

const describeWithJsdom = JSDOMCtor ? describe : describe.skip;

function Harness({
  preview,
  launchContext,
  onResult,
}: {
  preview?: ReviewTeamRunManifest;
  launchContext?: unknown;
  onResult: (confirmed: boolean) => void;
}) {
  const { confirmDeepReviewLaunch, deepReviewConsentDialog } = useDeepReviewConsent();

  return (
    <>
      <button
        onClick={async () => {
          onResult(await (confirmDeepReviewLaunch as (...args: unknown[]) => Promise<boolean>)(
            preview,
            launchContext,
          ));
        }}
      >
        Open consent
      </button>
      {deepReviewConsentDialog}
    </>
  );
}

function buildPreview(): ReviewTeamRunManifest {
  return {
    reviewMode: 'deep',
    workspacePath: '/test-fixtures/project-a',
    policySource: 'default-review-team-config',
    target: {
      source: 'session_files',
      resolution: 'resolved',
      tags: ['backend_core'],
      files: ['src/crates/assembly/core/src/service/config/types.rs'],
      warnings: [],
    },
    strategyLevel: 'normal',
    scopeProfile: {
      reviewDepth: 'risk_expanded',
      riskFocusTags: ['security', 'cross_boundary_api_contracts'],
      maxDependencyHops: 1,
      optionalReviewerPolicy: 'configured',
      allowBroadToolExploration: false,
      coverageExpectation: 'Risk-expanded pass; changed files remain visible.',
    },
    strategyRecommendation: {
      strategyLevel: 'deep',
      score: 24,
      rationale: 'Large/high-risk change (8 files, 900 lines; 2 security-sensitive files, 3 workspace areas). Strict review recommended.',
      factors: {
        fileCount: 8,
        totalLinesChanged: 900,
        lineCountSource: 'diff_stat',
        securityFileCount: 2,
        workspaceAreaCount: 3,
        contractSurfaceChanged: true,
      },
    },
    executionPolicy: {
      reviewerTimeoutSeconds: 1800,
      judgeTimeoutSeconds: 1200,
      reviewerFileSplitThreshold: 20,
      maxSameRoleInstances: 3,
    },
    concurrencyPolicy: {
      maxParallelInstances: 4,
      staggerSeconds: 0,
      maxQueueWaitSeconds: 300,
      batchExtrasSeparately: false,
      allowProviderCapacityQueue: true,
      allowBoundedAutoRetry: false,
      autoRetryElapsedGuardSeconds: 300,
    },
    tokenBudget: {
      mode: 'balanced',
      estimatedReviewerCalls: 3,
      maxReviewerCalls: 4,
      maxExtraReviewers: 1,
      maxPromptBytesPerReviewer: 96_000,
      estimatedPromptBytesPerReviewer: 16_000,
      estimatedPromptBytesTotal: 24_000,
      promptByteEstimateSource: 'manifest_heuristic',
      largeDiffSummaryFirst: false,
      skippedReviewerIds: [],
      warnings: [],
    },
    coreReviewers: [
      {
        subagentId: 'ReviewBusinessLogic',
        displayName: 'Logic reviewer',
        roleName: 'Business Logic Reviewer',
        model: 'fast',
        configuredModel: 'fast',
        defaultModelSlot: 'fast',
        strategyLevel: 'normal',
        strategySource: 'team',
        strategyDirective: 'Review logic.',
        locked: true,
        source: 'core',
        subagentSource: 'builtin',
      },
    ],
    qualityGateReviewer: {
      subagentId: 'ReviewJudge',
      displayName: 'Quality inspector',
      roleName: 'Review Quality Inspector',
      model: 'fast',
      configuredModel: 'fast',
      defaultModelSlot: 'fast',
      strategyLevel: 'normal',
      strategySource: 'team',
      strategyDirective: 'Check report quality.',
      locked: true,
      source: 'core',
      subagentSource: 'builtin',
    },
    enabledExtraReviewers: [
      {
        subagentId: 'CustomSecurity',
        displayName: 'Custom security reviewer',
        roleName: 'Additional Specialist Reviewer',
        model: 'fast',
        configuredModel: 'fast',
        defaultModelSlot: 'fast',
        strategyLevel: 'normal',
        strategySource: 'team',
        strategyDirective: 'Review security.',
        locked: false,
        source: 'extra',
        subagentSource: 'user',
      },
    ],
    skippedReviewers: [
      {
        subagentId: 'ReviewFrontend',
        displayName: 'Frontend reviewer',
        roleName: 'Frontend Reviewer',
        model: 'fast',
        configuredModel: 'fast',
        defaultModelSlot: 'fast',
        strategyLevel: 'normal',
        strategySource: 'team',
        strategyDirective: 'Review frontend.',
        locked: true,
        source: 'core',
        subagentSource: 'builtin',
        reason: 'not_applicable',
      },
      {
        subagentId: 'CustomInvalid',
        displayName: 'Custom invalid reviewer',
        roleName: 'Additional Specialist Reviewer',
        model: 'fast',
        configuredModel: 'fast',
        defaultModelSlot: 'fast',
        strategyLevel: 'normal',
        strategySource: 'team',
        strategyDirective: 'Review custom rules.',
        locked: false,
        source: 'extra',
        subagentSource: 'user',
        reason: 'invalid_tooling',
      },
    ],
  };
}

function buildPreviewWithoutSkippedReviewers(): ReviewTeamRunManifest {
  return {
    ...buildPreview(),
    skippedReviewers: [],
  };
}

describeWithJsdom('DeepReviewConsentDialog', () => {
  let dom: { window: Window & typeof globalThis };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOMCtor!('<!doctype html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });

    const { window } = dom;
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('localStorage', window.localStorage);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    dom.window.close();
    vi.unstubAllGlobals();
  });

  it('shows a compact launch summary with skipped reviewers only when needed', async () => {
    const result = vi.fn();

    await act(async () => {
      root.render(<Harness preview={buildPreview()} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Review plan');
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Review plan');
    expect(container.textContent).toContain('1 file');
    expect(container.textContent).toContain('2 optional review work items not run');
    expect(container.textContent).toContain(
      '2 optional review work items were not run. This result reflects only the completed review scope.',
    );
    expect(container.textContent).not.toContain('Estimated reviewer prompt input');
    expect(container.textContent).not.toContain('Reviewer prompt input only');
    expect(container.textContent).not.toContain('Maximum checks:');
    expect(container.textContent).not.toContain('Expected checks:');
    expect(container.textContent).not.toContain('up to 4 initial calls');
    expect(container.textContent).toContain('Run strategy: Standard');
    expect(container.textContent).not.toContain('Do not show this again');
    expect(container.textContent).not.toContain('Risk areas: Backend core');
    expect(container.textContent).toContain(
      'This review investigates the target more thoroughly and adds additional checks only when they are useful.',
    );
    expect(container.textContent).not.toContain('token');
    expect(container.textContent).not.toContain('request');
    expect(container.textContent).not.toContain('review budget');
    expect(container.textContent).not.toContain('1 extra specialist');
    expect(container.textContent).not.toContain('Review depth: Risk-expanded');
    expect(container.textContent).not.toContain('Frontend reviewer');
    expect(container.textContent).not.toContain('Not applicable to this target');
    expect(container.textContent).not.toContain('Custom invalid reviewer');
    expect(container.textContent).not.toContain('Configuration issue');
    expect(container.textContent).not.toContain('Logic reviewer');
    expect(container.textContent).not.toContain('Custom security reviewer');
  });

  it('does not expose the internal check allowance', async () => {
    const result = vi.fn();
    const basePreview = buildPreviewWithoutSkippedReviewers();
    const preview: ReviewTeamRunManifest = {
      ...basePreview,
      tokenBudget: {
        ...basePreview.tokenBudget,
        estimatedReviewerCalls: 1,
        maxReviewerCalls: 1,
      },
    };

    await act(async () => {
      root.render(<Harness preview={preview} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Maximum checks:');
    expect(container.textContent).not.toContain('1 checks');
  });

  it('uses a generic target summary when the review is not file-based', async () => {
    const result = vi.fn();
    const preview: ReviewTeamRunManifest = {
      ...buildPreview(),
      target: {
        source: 'manual_prompt',
        resolution: 'unknown',
        tags: ['unknown'],
        files: [],
        evidence: ['manual prompt'],
        warnings: [{
          code: 'target_unknown',
          message: 'Manual prompt target',
        }],
      },
      skippedReviewers: [],
    };

    await act(async () => {
      root.render(<Harness preview={preview} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Provided context');
    expect(container.textContent).not.toContain('0 files');
    expect(container.textContent).not.toContain('Risk areas:');
    expect(container.textContent).toContain(
      'This review investigates the target more thoroughly and adds additional checks only when they are useful.',
    );
  });

  it('still opens when skip preference is set but reviewers are skipped', async () => {
    localStorage.setItem('openbitfun.deepReview.skipCostConfirmation', 'true');
    const result = vi.fn();

    await act(async () => {
      root.render(<Harness preview={buildPreview()} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(result).not.toHaveBeenCalled();
  });

  it('still opens when skip preference is set but the active session is busy', async () => {
    localStorage.setItem('openbitfun.deepReview.skipCostConfirmation', 'true');
    const result = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          preview={buildPreviewWithoutSkippedReviewers()}
          launchContext={{
            sessionConcurrencyGuard: {
              activeSubagentCount: 2,
              highActivity: true,
            },
          }}
          onResult={result}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Active session is busy');
    expect(container.textContent).toContain('2 review tasks running');
    expect(result).not.toHaveBeenCalled();
  });

  it('keeps strategy selection out of the launch confirmation', async () => {
    const result = vi.fn();

    await act(async () => {
      root.render(<Harness preview={buildPreview()} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.querySelector('.deep-review-consent__strategy-option')).toBeNull();

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Start review')
        ?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(result).toHaveBeenCalledWith(true);
  });

  it('keeps the launch dialog sparse and makes the selected strategy prominent', async () => {
    const result = vi.fn();

    await act(async () => {
      root.render(<Harness preview={buildPreview()} onResult={result} />);
    });
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    });

    expect(container.querySelectorAll('.deep-review-consent__priority-grid')).toHaveLength(0);
    expect(container.querySelectorAll('.deep-review-consent__priority-point')).toHaveLength(0);
    expect(container.querySelectorAll('.deep-review-consent__strategy-heading')).toHaveLength(0);
    expect(container.textContent).not.toContain('Quick is narrower');
    expect(container.textContent).not.toContain('Risk areas: Backend core');
    expect(container.textContent).toContain(
      'This review investigates the target more thoroughly and adds additional checks only when they are useful.',
    );
    expect(container.textContent).not.toContain('1 extra specialist');
    expect(container.textContent).not.toContain('Expected cost:');
    expect(container.querySelectorAll('.deep-review-consent__strategy-selected-summary')).toHaveLength(0);
    expect(container.querySelectorAll('.deep-review-consent__strategy-current')).toHaveLength(1);
    expect(container.querySelectorAll('.deep-review-consent__strategy-option')).toHaveLength(0);
    expect(container.querySelectorAll('.deep-review-consent__strategy-option--active')).toHaveLength(0);
    expect(container.textContent).not.toContain('Team default');
    expect(container.textContent).toContain(
      'Standard review examines the selected target in more depth and adds additional checks only when useful.',
    );
    expect(container.querySelectorAll('.deep-review-consent__strategy-option-summary')).toHaveLength(0);

    const quickStrategyButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Quick'));
    expect(quickStrategyButton).toBeUndefined();
    expect(container.textContent).not.toContain('Run strategy: Quick');
    expect(container.textContent).not.toContain('Quick keeps target-matched checks');
  });
});
