import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeReviewToolCard } from './CodeReviewToolCard';
import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import type { ReviewTeamManifestMember, ReviewTeamRunManifest } from '@/shared/services/reviewTeamService';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const flowState = vi.hoisted(() => ({
  current: {
    sessions: new Map<string, unknown>(),
    activeSessionId: null,
  },
  listeners: new Set<(state: { sessions: Map<string, unknown>; activeSessionId: string | null }) => void>(),
}));

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

vi.mock('@openbitfun/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  Icon: ({ name }: { name: string }) => <span data-openbitfun-component="icon" data-openbitfun-name={name} />,
  OverflowText: ({ children, behavior: _behavior, marqueeActive: _marqueeActive, ...props }: any) => <span {...props}>{children}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./CodeReviewReportExportActions', () => ({
  CodeReviewReportExportActions: () => null,
}));

vi.mock('../store/FlowChatStore', () => ({
  flowChatStore: {
    getState: () => flowState.current,
    subscribe: (listener: (state: typeof flowState.current) => void) => {
      flowState.listeners.add(listener);
      return () => flowState.listeners.delete(listener);
    },
  },
  FlowChatStore: {
    getInstance: () => ({
      getState: () => flowState.current,
      subscribe: (listener: (state: typeof flowState.current) => void) => {
        flowState.listeners.add(listener);
        return () => flowState.listeners.delete(listener);
      },
    }),
  },
}));

function buildManifestMember(
  subagentId: string,
  displayName: string,
  source: ReviewTeamManifestMember['source'],
  reason?: ReviewTeamManifestMember['reason'],
): ReviewTeamManifestMember {
  return {
    subagentId,
    displayName,
    roleName: displayName,
    model: 'fast-model',
    configuredModel: 'fast-model',
    defaultModelSlot: 'fast',
    strategyLevel: 'normal',
    strategySource: 'team',
    strategyDirective: 'Review the target.',
    locked: source === 'core',
    source,
    subagentSource: source === 'extra' ? 'user' : 'builtin',
    ...(reason ? { reason } : {}),
  };
}

function buildManifest(): ReviewTeamRunManifest {
  return {
    reviewMode: 'deep',
    workspacePath: 'C:/repo/project',
    policySource: 'default-review-team-config',
    target: {
      source: 'session_files',
      resolution: 'resolved',
      tags: ['frontend'],
      files: ['src/App.tsx'],
      warnings: [],
    },
    strategyLevel: 'normal',
    strategyRecommendation: {
      strategyLevel: 'deep',
      score: 24,
      rationale: 'Large/high-risk change (8 files, 900 lines; 2 security-sensitive files, 3 workspace areas). Deep review recommended.',
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
    tokenBudget: {
      mode: 'balanced',
      estimatedReviewerCalls: 3,
      maxReviewerCalls: 4,
      maxExtraReviewers: 1,
      largeDiffSummaryFirst: false,
      skippedReviewerIds: ['CustomInvalid'],
      warnings: [],
    },
    coreReviewers: [
      buildManifestMember('ReviewBusinessLogic', 'Logic reviewer', 'core'),
    ],
    qualityGateReviewer: buildManifestMember('ReviewJudge', 'Quality inspector', 'core'),
    enabledExtraReviewers: [
      buildManifestMember('CustomSecurity', 'Custom security reviewer', 'extra'),
    ],
    skippedReviewers: [
      buildManifestMember('ReviewFrontend', 'Frontend reviewer', 'core', 'not_applicable'),
      buildManifestMember('CustomInvalid', 'Custom invalid reviewer', 'extra', 'invalid_tooling'),
    ],
  };
}

function notifyFlowState(): void {
  for (const listener of flowState.listeners) {
    listener(flowState.current);
  }
}

describe('CodeReviewToolCard', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);

    flowState.current = {
      sessions: new Map<string, unknown>([
        ['review-session', { id: 'review-session', deepReviewRunManifest: buildManifest() }],
      ]),
      activeSessionId: 'review-session',
    };
    flowState.listeners.clear();
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('summarizes deep review coverage without exposing the run manifest', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        input: {},
      },
      toolResult: {
        success: true,
        result: {
          review_mode: 'deep',
          summary: {
            overall_assessment: 'No validated issues.',
            risk_level: 'low',
            recommended_action: 'approve',
          },
          issues: [],
          reviewers: [],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });
    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).toContain('Review status');
    expect(container.textContent).toContain('Review scope tailored');
    expect(container.textContent).toContain('Token budget limited review coverage');
    expect(container.textContent).toContain(
      'Optional review work not run: 2 (applicability, configuration, or budget).',
    );
    expect(container.textContent).toContain('Optional review work not run due to token budget: 1.');
    expect(container.textContent).not.toContain('Coverage and cost');
    expect(container.textContent).not.toContain('Target');
    expect(container.textContent).not.toContain('Budget');
    expect(container.textContent).not.toContain('Estimated review work items');
    expect(container.textContent).not.toContain('Recommended strategy');
    expect(container.textContent).not.toContain('Frontend reviewer');
    expect(container.textContent).not.toContain('Not applicable to this target');
    expect(container.textContent).not.toContain('Custom invalid reviewer');
    expect(container.textContent).not.toContain('Configuration issue');
    expect(container.textContent).not.toContain('Large/high-risk change');
  });

  it('updates coverage reliability when session metadata arrives after render', () => {
    flowState.current = {
      sessions: new Map<string, unknown>([
        ['review-session', { id: 'review-session' }],
      ]),
      activeSessionId: 'review-session',
    };

    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        input: {},
      },
      toolResult: {
        success: true,
        result: {
          review_mode: 'deep',
          summary: {
            overall_assessment: 'No validated issues.',
            risk_level: 'low',
            recommended_action: 'approve',
          },
          issues: [],
          reviewers: [],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });
    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).not.toContain('Review scope tailored');

    act(() => {
      flowState.current = {
        sessions: new Map<string, unknown>([
          ['review-session', { id: 'review-session', deepReviewRunManifest: buildManifest() }],
        ]),
        activeSessionId: 'review-session',
      };
      notifyFlowState();
    });

    expect(container.textContent).toContain('Review scope tailored');
    expect(container.textContent).toContain('Token budget limited review coverage');
    expect(container.textContent).not.toContain('Coverage and cost');
  });

  it('renders compact reliability status when a reviewer returned partial evidence', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        input: {},
      },
      toolResult: {
        success: true,
        result: {
          review_mode: 'deep',
          summary: {
            overall_assessment: 'Review completed with reduced confidence.',
            risk_level: 'medium',
            recommended_action: 'request_changes',
          },
          issues: [],
          reviewers: [
            {
              name: 'Security Reviewer',
              specialty: 'security',
              status: 'partial_timeout',
              summary: 'Timed out after producing partial evidence.',
              partial_output: 'Found likely token logging in src/auth.ts before timeout.',
            },
          ],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });
    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).toContain('Review status');
    expect(container.textContent).toContain('Review returned partial result');
    expect(container.textContent).toContain('1 review result is partial; confidence is limited.');
  });

  it('renders limited-scope reliability status from structured report signals', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        input: {},
      },
      toolResult: {
        success: true,
        result: {
          review_mode: 'deep',
          summary: {
            overall_assessment: 'High-risk pass completed.',
            risk_level: 'low',
            recommended_action: 'approve',
          },
          issues: [],
          reviewers: [],
          evidence_status: 'limited',
          reliability_signals: [
            {
              kind: 'reduced_scope',
              severity: 'info',
              source: 'manifest',
              detail: 'High-risk-only pass; changed files remain visible.',
            },
          ],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });

    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).toContain('Limited review scope');
    expect(container.textContent).toContain('High-risk-only pass; changed files remain visible.');
    expect(container.textContent).toContain('Evidence status');
    expect(container.textContent).toContain('limited');
    expect(container.textContent).toContain('Target evidence limited');
  });

  it('maps internal reviewer source ids before rendering issues', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-1',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: {
        id: 'call-1',
        input: {},
      },
      toolResult: {
        success: true,
        result: {
          review_mode: 'deep',
          summary: {
            overall_assessment: 'Security issue found.',
            risk_level: 'high',
            recommended_action: 'request_changes',
          },
          issues: [{
            severity: 'high',
            certainty: 'likely',
            title: 'Token leak',
            description: 'A token is logged.',
            source_reviewer: 'ReviewSecurity',
          }],
          reviewers: [],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });

    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });
    const issuesSectionButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.review-report-section [data-openbitfun-component="disclosure"] button[aria-expanded]'),
    ).find((button) => button.textContent?.includes('Issues'));
    expect(issuesSectionButton).toBeTruthy();
    act(() => {
      issuesSectionButton!.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).toContain('Security coverage');
    expect(container.textContent).not.toContain('ReviewSecurity');
  });

  it('does not invent risk or recommendation for an incomplete historical summary', () => {
    const toolItem: FlowToolItem = {
      id: 'tool-incomplete-summary',
      type: 'tool',
      timestamp: Date.now(),
      toolName: 'submit_code_review',
      status: 'completed',
      toolCall: { id: 'call-incomplete-summary', input: {} },
      toolResult: {
        success: true,
        result: {
          review_mode: 'standard',
          summary: { overall_assessment: 'Historical report' },
          issues: [],
          reviewers: [],
        },
      },
    };
    const config: ToolCardConfig = {
      toolName: 'submit_code_review',
      displayName: 'Code Review',
      icon: 'REVIEW',
      requiresConfirmation: false,
      resultDisplayType: 'detailed',
    };

    act(() => {
      root.render(
        <CodeReviewToolCard
          toolItem={toolItem}
          config={config}
          sessionId="review-session"
        />,
      );
    });
    act(() => {
      container.querySelector('[data-openbitfun-part="affordanceButton"]')?.dispatchEvent(
        new window.Event('click', { bubbles: true }),
      );
    });

    expect(container.textContent).not.toContain('Risk Level');
    expect(container.textContent).not.toContain('Recommended Action');
    expect(container.textContent).not.toContain('Request Changes');
  });
});
