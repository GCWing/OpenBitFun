import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import { globalEventBus } from '@/infrastructure/event-bus';
import enFlowChat from '@/locales/en-US/flow-chat.json';
import zhCnFlowChat from '@/locales/zh-CN/flow-chat.json';
import zhTwFlowChat from '@/locales/zh-TW/flow-chat.json';
import {
  FLOWCHAT_FOCUS_ITEM_EVENT,
  type FlowChatFocusItemRequest,
} from '../../events/flowchatNavigation';
import { flowChatStore } from '../../store/FlowChatStore';
import type { FlowChatState, Session } from '../../types/flow-chat';
import { SessionRuntimeStatusEntry } from './SessionRuntimeStatusEntry';
import { SessionUsagePanel } from './SessionUsagePanel';
import { sessionUsagePanelAppearanceDescriptor } from './appearance';
import { SessionUsageReportCard } from './SessionUsageReportCard';
import { USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY } from './usageReportUtils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const snapshotApiMocks = vi.hoisted(() => ({
  getOperationDiff: vi.fn(),
}));

const tabUtilsMocks = vi.hoisted(() => ({
  createDiffEditorTab: vi.fn(),
}));

vi.mock('@/infrastructure/api', () => ({
  snapshotAPI: {
    getOperationDiff: snapshotApiMocks.getOperationDiff,
  },
}));

vi.mock('@/shared/utils/tabUtils', () => ({
  createDiffEditorTab: tabUtilsMocks.createDiffEditorTab,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'usage.title': 'Session Usage',
        'usage.unavailable': 'Unavailable',
        'usage.redacted': 'Redacted',
        'usage.percent': '{{value}}%',
        'usage.duration.ms': '{{value}}ms',
        'usage.duration.seconds': '{{value}}s',
        'usage.duration.minutes': '{{value}}m',
        'usage.duration.minutesSeconds': '{{minutes}}m {{seconds}}s',
        'usage.duration.hours': '{{value}}h',
        'usage.duration.hoursMinutes': '{{hours}}h {{minutes}}m',
        'usage.actions.copyMarkdown': 'Copy Markdown',
        'usage.actions.copied': 'Copied',
        'usage.actions.copySessionId': 'Copy session ID',
        'usage.actions.copyWorkspacePath': 'Copy project path',
        'usage.actions.openDetails': 'Open details',
        'usage.actions.openFileDiff': 'Open diff',
        'usage.actions.openSectionDetails': 'Open {{section}} details',
        'usage.actions.jumpToTurn': 'Jump to this turn',
        'usage.actions.viewDetails': 'Details',
        'usage.actions.viewAllSection': 'View all {{count}}',
        'usage.coverage.complete': 'Complete data',
        'usage.coverage.partial': 'Partial data',
        'usage.coverage.minimal': 'Minimal data',
        'usage.coverage.partialNotice': 'Some metrics were not reported by this session or provider. Hover underlined values for the specific reason.',
        'usage.toolCategories.git': 'Git',
        'usage.toolCategories.shell': 'Shell',
        'usage.toolCategories.file': 'File',
        'usage.toolCategories.other': 'Other',
        'usage.fileScopes.snapshot_summary': 'Snapshot summary',
        'usage.fileScopes.tool_inputs_only': 'Tool inputs only',
        'usage.fileScopes.unavailable': 'Not tracked',
        'usage.accounting.approximate': 'Approximate',
        'usage.accounting.exact': 'Exact',
        'usage.accounting.unavailable': 'Unavailable',
        'usage.cacheCoverage.available': 'Reported',
        'usage.cacheCoverage.partial': 'Partially reported',
        'usage.cacheCoverage.unavailable': 'Not reported',
        'usage.status.timingNotRecorded': 'Timing not recorded',
        'usage.status.cacheNotReported': 'Cache not reported',
        'usage.status.noFileChanges': 'No file changes',
        'usage.status.notRecorded': 'Not recorded',
        'usage.status.modelNotRecorded': 'Model not recorded',
        'usage.status.p95SampleInsufficient': 'Not enough samples',
        'usage.status.legacyModel': 'Legacy model not tracked',
        'usage.status.inferredModel': '{{model}} (inferred)',
        'usage.card.heading': 'Session statistics',
        'usage.card.eyebrow': 'Local report',
        'usage.card.turns': '{{count}} turns',
        'usage.card.calls': '{{count}} calls',
        'usage.card.operations': '{{count}} ops',
        'usage.card.tokens': '{{value}} tokens',
        'usage.card.tokenUsage': 'Tokens usage',
        'usage.card.dataDelayDisclaimer': 'Usage statistics may be delayed. System records are authoritative.',
        'usage.loading.title': 'Generating usage report',
        'usage.loading.description': 'Reading session records and preparing a privacy-safe summary.',
        'usage.loading.steps.collecting': 'Reading session records',
        'usage.loading.steps.tokens': 'Summarizing token and tool activity',
        'usage.loading.steps.safety': 'Checking privacy-safe display fields',
        'usage.metrics.wall': 'Session span',
        'usage.metrics.active': 'Recorded turn time',
        'usage.metrics.modelTime': 'Model round time',
        'usage.metrics.toolTime': 'Tool call time',
        'usage.metrics.tokens': 'Tokens',
        'usage.metrics.cached': 'Cached',
        'usage.metrics.files': 'Files',
        'usage.metrics.errors': 'Errors',
        'usage.metrics.errorRate': 'Error rate',
        'usage.sections.models': 'Models',
        'usage.sections.tools': 'Tools',
        'usage.sections.files': 'Files',
        'usage.sections.slowest': 'Slowest spans',
        'usage.empty.models': 'No model metrics',
        'usage.empty.modelsDescription': 'Model rows appear after calls report token usage.',
        'usage.empty.tools': 'No tool metrics',
        'usage.empty.toolsDescription': 'Tool rows appear after the session runs tools.',
        'usage.empty.files': 'No file changes',
        'usage.empty.filesDescription': 'No file-edit records were found for this session.',
        'usage.empty.errors': 'No error examples',
        'usage.empty.errorsDescription': 'No sampled tool or model errors were recorded.',
        'usage.help.wall': 'Span from the first recorded turn start to the last recorded turn end. Idle gaps can be included.',
        'usage.help.active': 'Union of recorded turn spans that produced reportable activity. It can include orchestration or waiting inside a turn.',
        'usage.help.timeShare': 'Share of recorded turn time. Model and tool spans may overlap, so this is only an approximate indicator.',
        'usage.help.modelRoundTime': 'Recorded model-round duration from persisted runtime metadata or start/end timestamps, not pure provider streaming or throughput time. The percentage uses recorded turn time and is approximate.',
        'usage.help.toolTime': 'Recorded tool-call duration. The percentage uses recorded turn time and is approximate.',
        'usage.help.cachedTokens': 'The provider did not report cache-read token metadata for this session. Total token counts are still shown when available.',
        'usage.help.cachedTokensPartial': 'Only some calls reported cache-read token metadata, so the cached-token total covers those calls only.',
        'usage.help.legacyModel': 'Older sessions did not store per-round model names.',
        'usage.help.inferredModel': 'Inferred from the session model setting.',
        'usage.help.filesUnavailable': 'No file snapshot or file-edit tool record was found for this session.',
        'usage.help.filesNoRecordedChanges': 'OpenBitFun did not detect file changes in this session. This is expected when the agent did not edit files.',
        'usage.help.filesRemoteUnavailable': 'No remote snapshot summary was found for this session. File rows can still appear from recognized file-edit tool records.',
        'usage.help.filesNotTracked': 'No local snapshot or identifiable file-edit tool record was found for this session.',
        'usage.help.fileDiffUnavailable': 'Diff links require a snapshot-backed file row and a visible file path.',
        'usage.help.errors': 'Counts model turns that ended in error plus tool calls whose result was unsuccessful.',
        'usage.help.toolErrors': 'Tool errors count unsuccessful tool calls.',
        'usage.help.modelErrors': 'Model errors count dialog turns that ended in the error state.',
        'usage.help.errorExamples': 'Examples are grouped by safe labels only; raw provider responses, tool inputs, and command output stay out of the report.',
        'usage.help.errorExampleRow': 'Safe grouped label for an error type.',
        'usage.help.errorExampleCount': 'Number of matching errors.',
        'usage.help.slowestSpans': 'Slow spans are derived from recorded turn, model, and tool timestamps. They help identify time sinks, not exact provider latency.',
        'usage.help.slowestModelCall': 'Model call in this turn. Model: {{model}}.',
        'usage.help.slowestToolCall': 'Tool call details identify whether time was spent waiting, confirming, or executing.',
        'usage.slowest.details.input': 'Input',
        'usage.slowest.details.status': 'Status',
        'usage.slowest.details.exitCode': 'Exit code',
        'usage.slowest.details.timedOut': 'Timed out',
        'usage.slowest.details.execution': 'Execution',
        'usage.slowest.details.error': 'Error',
        'usage.status.timedOut': 'Timed out',
        'shared:statuses.failed': 'Failed',
        'shared:statuses.done': 'Done',
        'usage.meta.generatedAt': 'Generated',
        'usage.meta.sessionId': 'Session ID',
        'usage.meta.workspacePath': 'Project path',
        'usage.runtime.open': 'Generate session usage',
        'usage.runtime.button': 'Usage',
        'usage.runtime.tooltip': 'Generate a usage report in this chat',
        'usage.panel.tabsLabel': 'Usage report sections',
        'usage.panel.accounting': 'Accounting',
        'usage.panel.turnScope': 'Scope',
        'usage.panel.cacheCoverage': 'Cache reporting',
        'usage.panel.compressions': 'Compressions',
        'usage.panel.fileScope': 'File scope',
        'usage.panel.toolErrors': 'Tool errors',
        'usage.panel.modelErrors': 'Model errors',
        'usage.panel.errorScope': 'Error scope',
        'usage.privacy.title': 'Privacy-safe report',
        'usage.privacy.summary': 'Prompts, tool inputs, command outputs, and file contents are not included.',
        'usage.tabs.overview': 'Overview',
        'usage.tabs.models': 'Models',
        'usage.tabs.tools': 'Tools',
        'usage.tabs.files': 'Files',
        'usage.tabs.errors': 'Errors',
        'usage.tabs.slowest': 'Slowest',
        'usage.table.model': 'Model',
        'usage.table.tool': 'Tool',
        'usage.table.category': 'Category',
        'usage.table.calls': 'Calls',
        'usage.table.success': 'Success',
        'usage.table.errors': 'Errors',
        'usage.table.input': 'Input',
        'usage.table.output': 'Output',
        'usage.table.cached': 'Cached',
        'usage.table.duration': 'Recorded time',
        'usage.table.p95': 'P95',
        'usage.table.execution': 'Execution',
        'usage.table.toolDuration': 'Total time',
        'usage.table.toolP95Duration': 'P95 total',
        'usage.table.toolExecutionDuration': 'Execution time',
        'usage.table.file': 'File',
        'usage.table.operations': 'Ops',
        'usage.table.added': 'Added',
        'usage.table.deleted': 'Deleted',
        'usage.table.turns': 'Turns',
        'usage.table.operationIds': 'Operation IDs',
        'usage.table.actions': 'Actions',
        'usage.table.label': 'Label',
        'usage.table.count': 'Count',
        'usage.table.kind': 'Kind',
        'usage.empty.slowest': 'No slow spans',
        'usage.empty.slowestDescription': 'No timed spans were recorded.',
        'usage.slowestKinds.model': 'Model',
        'usage.slowestKinds.modelCall': 'Model call',
        'usage.slowestKinds.tool': 'Tool',
        'usage.slowestKinds.turn': 'Turn',
        'usage.slowestLabels.modelCall': 'Turn {{turn}} model call',
        'usage.slowestLabels.modelCallUnknown': 'Model call',
        'usage.slowestLabels.turn': 'Turn {{turn}}',
        'usage.slowestLabels.turnUnknown': 'Turn',
        'usage.table.rowLimitSummary': 'Showing {{visible}} of {{total}} rows',
        'usage.table.showAllRows': 'Show all {{count}} rows',
        'usage.table.showFewerRows': 'Show first {{count}} rows',
        'usage.export.redactPaths': 'Redact paths',
        'usage.export.redactPathsHelp': 'Replace workspace and file paths when copying Markdown.',
        'usage.export.redactedPath': '[redacted path]',
      };
      return interpolate(labels[key] ?? key, options);
    },
  }),
}));

vi.mock('@openbitfun/ui', async importOriginal => ({
  ...await importOriginal<typeof import('@openbitfun/ui')>(),
  IconButton: React.forwardRef<
    HTMLButtonElement,
    React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode; variant?: string; size?: string }
  >(function MockIconButton({
    children,
    icon,
    variant: _variant,
    size: _size,
    ...props
  }, ref) {
    return (
      <button ref={ref} type="button" {...props}>
        {icon}
        {children}
      </button>
    );
  }),
  Tooltip: ({ children, content }: { children: React.ReactNode; content?: React.ReactNode }) => {
    const tooltipContent = typeof content === 'string' ? content : undefined;
    let trigger = children;
    if (React.isValidElement(children)) {
      trigger = React.cloneElement(
        children as React.ReactElement<{
          ref?: React.Ref<HTMLElement>;
        }>,
        {
          ref: () => undefined,
        }
      );
    }
    return <span data-tooltip={tooltipContent}>{trigger}</span>;
  },
}));

vi.mock('@/infrastructure/markdown', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock('@openbitfun/ui/flow-chat', () => ({
  ToolProcessingDots: ({ className }: { className?: string }) => <span className={className}>...</span>,
}));

function interpolate(template: string, options?: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(options?.[key] ?? ''));
}

const USAGE_LOCALE_REQUIRED_KEYS = [
  'usage.actions.openFileDiff',
  'usage.actions.openSectionDetails',
  'usage.actions.jumpToTurn',
  'usage.actions.viewDetails',
  'usage.actions.viewAllSection',
  'usage.card.dataDelayDisclaimer',
  'usage.card.tokenUsage',
  'usage.card.tokens',
  'usage.status.modelNotRecorded',
  'usage.status.legacyModel',
  'usage.status.inferredModel',
  'usage.metrics.errorRate',
  'usage.sections.slowest',
  'usage.empty.slowest',
  'usage.empty.slowestDescription',
  'usage.help.legacyModel',
  'usage.help.inferredModel',
  'usage.help.fileDiffUnavailable',
  'usage.help.errors',
  'usage.help.toolErrors',
  'usage.help.modelErrors',
  'usage.help.errorExamples',
  'usage.help.errorExampleRow',
  'usage.help.errorExampleCount',
  'usage.help.slowestSpans',
  'usage.help.slowestModelCall',
  'usage.help.slowestToolCall',
  'usage.panel.errorScope',
  'usage.slowest.details.input',
  'usage.slowest.details.status',
  'usage.slowest.details.exitCode',
  'usage.slowest.details.timedOut',
  'usage.slowest.details.execution',
  'usage.slowest.details.error',
  'usage.status.timedOut',
  'usage.tabs.slowest',
  'usage.table.actions',
  'usage.table.kind',
  'usage.table.rowLimitSummary',
  'usage.table.showAllRows',
  'usage.table.showFewerRows',
  'usage.slowestKinds.model',
  'usage.slowestKinds.modelCall',
  'usage.slowestKinds.tool',
  'usage.slowestKinds.turn',
  'usage.slowestLabels.modelCall',
  'usage.slowestLabels.modelCallUnknown',
  'usage.slowestLabels.turn',
  'usage.slowestLabels.turnUnknown',
];

function getLocaleValue(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') {
        return undefined;
      }
      return (current as Record<string, unknown>)[part];
    }, messages);
}

describe('Session usage locale coverage', () => {
  it('keeps usage report strings available in every bundled locale', () => {
    const locales = {
      'en-US': enFlowChat,
      'zh-CN': zhCnFlowChat,
      'zh-TW': zhTwFlowChat,
    };

    for (const [locale, messages] of Object.entries(locales)) {
      const missingKeys = USAGE_LOCALE_REQUIRED_KEYS.filter((key) => {
        const value = getLocaleValue(messages, key);
        return typeof value !== 'string' || value.trim().length === 0;
      });

      expect(missingKeys, `${locale} missing usage locale keys`).toEqual([]);
    }
  });
});

function usageReport(overrides: Partial<SessionUsageReport> = {}): SessionUsageReport {
  return {
    schemaVersion: 1,
    reportId: 'usage-session-1',
    sessionId: 'session-1',
    generatedAt: Date.UTC(2026, 4, 10, 8, 0),
    workspace: {
      kind: 'local',
      pathLabel: 'D:/workspace/openbitfun',
    },
    scope: {
      kind: 'entire_session',
      turnCount: 3,
      includesSubagents: false,
    },
    coverage: {
      level: 'partial',
      available: ['workspace_identity'],
      missing: ['token_detail_breakdown'],
      notes: [],
    },
    time: {
      accounting: 'approximate',
      denominator: 'session_wall_time',
      wallTimeMs: 120_000,
      activeTurnMs: 80_000,
      modelMs: 40_000,
      toolMs: 20_000,
    },
    tokens: {
      source: 'token_usage_records',
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      cacheCoverage: 'unavailable',
    },
    models: [
      {
        modelId: 'gpt-5.4',
        callCount: 2,
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        durationMs: 40_000,
      },
    ],
    tools: [
      {
        toolName: 'secret shell command output',
        category: 'shell',
        callCount: 2,
        successCount: 1,
        errorCount: 1,
        durationMs: 20_000,
        p95DurationMs: 18_000,
        executionMs: 16_000,
        redacted: true,
      },
    ],
    files: {
      scope: 'snapshot_summary',
      changedFiles: 1,
      addedLines: 4,
      deletedLines: 2,
      files: [
        {
          pathLabel: 'secrets/raw-file-content.txt',
          operationCount: 2,
          addedLines: 4,
          deletedLines: 2,
          turnIndexes: [1],
          operationIds: ['operation-1'],
          redacted: true,
        },
      ],
    },
    compression: {
      compactionCount: 2,
      manualCompactionCount: 1,
      automaticCompactionCount: 1,
    },
    errors: {
      totalErrors: 1,
      toolErrors: 1,
      modelErrors: 0,
      examples: [
        {
          label: 'raw provider error with secret payload',
          count: 1,
          redacted: true,
        },
      ],
    },
    slowest: [],
    privacy: {
      promptContentIncluded: false,
      toolInputsIncluded: false,
      commandOutputsIncluded: false,
      fileContentsIncluded: false,
      redactedFields: ['tools', 'files', 'errors'],
    },
    ...overrides,
  };
}

function collectLeafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectLeafPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

function resolvePath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.values(value as Record<string, unknown>).flatMap(flattenStrings);
}

describe('Session usage report UI components', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    snapshotApiMocks.getOperationDiff.mockReset();
    tabUtilsMocks.createDiffEditorTab.mockReset();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(),
      },
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.unstubAllGlobals();
  });

  const render = (element: React.ReactElement) => {
    act(() => {
      root.render(element);
    });
  };

  it('renders localized partial coverage and cache unavailable without showing zero', () => {
    const onOpenDetails = vi.fn();
    const report = usageReport();

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
        onOpenDetails={onOpenDetails}
      />
    );

    const cachedMetric = Array.from(container.querySelectorAll('.session-usage-report-card__metric'))
      .find(metric => metric.textContent?.includes('Cached'));
    expect(container.textContent).toContain('Partial data');
    const partialCoverageBadge = container.querySelector('.session-usage-report-card__coverage');
    expect(partialCoverageBadge).not.toBeNull();
    expect(partialCoverageBadge?.parentElement?.getAttribute('data-tooltip')).toContain('Hover underlined values');
    expect(cachedMetric?.textContent).toContain('Cache not reported');
    expect(cachedMetric?.textContent).not.toMatch(/Cached\s*0/);
    expect(cachedMetric?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toContain('Total token counts are still shown');
    expect(cachedMetric?.querySelector('.session-usage-report-card__metric-value--help')?.hasAttribute('title'))
      .toBe(false);

    const openButton = container.querySelector('button[aria-label="Open details"]');
    expect(openButton?.textContent).toBe('Details');
    expect(openButton?.getAttribute('data-openbitfun-component')).toBe('button');
    expect(openButton?.getAttribute('data-openbitfun-variant')).toBe('outline');
    expect(container.querySelector('.session-usage-report-card__action-group')).toBeNull();
    act(() => {
      openButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDetails).toHaveBeenCalledWith(report);
  });

  it('renders the focused compact summary used by the usage modal', () => {
    const onOpenDetails = vi.fn();
    const report = usageReport({
      scope: {
        kind: 'entire_session',
        turnCount: 4,
        includesSubagents: false,
      },
      time: {
        accounting: 'approximate',
        denominator: 'session_wall_time',
        wallTimeMs: 820_000,
        activeTurnMs: 588_000,
      },
      tokens: {
        source: 'token_usage_records',
        inputTokens: 5_126_217,
        outputTokens: 270_000,
        totalTokens: 5_396_217,
        cachedTokens: 5_274_240,
        cacheCoverage: 'available',
        cacheHitRate: 0.99,
      },
      models: [{
        modelId: 'deepseek-v4-flash',
        callCount: 68,
        inputTokens: 5_126_217,
        outputTokens: 270_000,
        totalTokens: 5_396_217,
      }],
      tools: [
        { toolName: 'ExecCommand', category: 'shell', callCount: 9, successCount: 9, errorCount: 0, durationMs: 9000, redacted: false },
        { toolName: 'Grep', category: 'file', callCount: 19, successCount: 19, errorCount: 0, durationMs: 8000, redacted: false },
        { toolName: 'Edit', category: 'file', callCount: 19, successCount: 19, errorCount: 0, durationMs: 7000, redacted: false },
        { toolName: 'Read', category: 'file', callCount: 2, successCount: 2, errorCount: 0, durationMs: 1000, redacted: false },
      ],
      errors: {
        totalErrors: 3,
        toolErrors: 3,
        modelErrors: 0,
        examples: [],
      },
    });

    render(
      <SessionUsageReportCard
        compact
        report={report}
        markdown="## Session Usage"
        onOpenDetails={onOpenDetails}
      />
    );

    expect(container.querySelector('.session-usage-report-card--compact')).not.toBeNull();
    expect(container.querySelector('.session-usage-report-card__compact-token-value')?.textContent)
      .toContain('5.4M');
    expect(container.textContent).toContain('Tokens usage');
    expect(container.textContent).toContain('deepseek-v4-flash');
    expect(container.textContent).toContain('68 calls');
    expect(container.textContent).toContain('View all 4');
    expect(container.textContent).toContain('ExecCommand');
    expect(container.textContent).toContain('Grep');
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).not.toContain('Read2 calls');
    expect(container.querySelectorAll('.session-usage-report-card__compact-tool-row')).toHaveLength(3);
    expect(container.querySelector('.session-usage-report-card__coverage')).toBeNull();
    expect(container.querySelector('input[aria-label="Redact paths"]')).toBeNull();
    expect(container.textContent).toContain('Usage statistics may be delayed');

    const toolsButton = container.querySelector('button[aria-label="Open Tools details"]');
    act(() => {
      toolsButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDetails).toHaveBeenCalledWith(report, 'tools');
  });

  it('appends a hit-rate suffix to the cached cell when cache is reported', () => {
    const report = usageReport({
      tokens: {
        source: 'token_usage_records',
        inputTokens: 1500,
        outputTokens: 300,
        totalTokens: 1800,
        cachedTokens: 1200,
        cacheCoverage: 'available',
        cacheHitRate: 0.8,
      },
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
        onOpenDetails={vi.fn()}
      />
    );

    const cachedMetric = Array.from(container.querySelectorAll('.session-usage-report-card__metric'))
      .find(metric => metric.textContent?.includes('Cached'));
    // Cached number AND inline two-decimal hit rate must both appear.
    expect(cachedMetric?.textContent).toContain('1.2K');
    expect(cachedMetric?.textContent).toContain('(80.00%)');
    expect(cachedMetric?.textContent).not.toContain('Cache not reported');
  });

  it('omits the hit-rate suffix when cache coverage is unavailable', () => {
    // Even if cacheHitRate accidentally got populated, an Unavailable
    // coverage state must still fall back to "Cache not reported".
    const report = usageReport({
      tokens: {
        source: 'token_usage_records',
        inputTokens: 1500,
        outputTokens: 300,
        totalTokens: 1800,
        cacheCoverage: 'unavailable',
        cacheHitRate: 0.5,
      },
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
        onOpenDetails={vi.fn()}
      />
    );

    const cachedMetric = Array.from(container.querySelectorAll('.session-usage-report-card__metric'))
      .find(metric => metric.textContent?.includes('Cached'));
    expect(cachedMetric?.textContent).toContain('Cache not reported');
    expect(cachedMetric?.textContent).not.toContain('(50%)');
  });

  it('explains error totals on the chat card', () => {
    const report = usageReport({
      errors: {
        totalErrors: 2,
        toolErrors: 1,
        modelErrors: 1,
        examples: [
          { label: 'Write', count: 1, redacted: false },
          { label: 'Model/runtime turn errors', count: 1, redacted: false },
        ],
      },
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
      />
    );

    const errorsMetric = Array.from(container.querySelectorAll('.session-usage-report-card__metric'))
      .find(metric => metric.textContent?.includes('Errors'));
    expect(errorsMetric?.textContent).toContain('2');
    expect(errorsMetric?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toContain('tool calls whose result was unsuccessful');
  });

  it('offers section detail jumps when summary lists are truncated', () => {
    const onOpenDetails = vi.fn();
    const report = usageReport({
      tools: Array.from({ length: 4 }, (_, index) => ({
        toolName: `Tool ${index + 1}`,
        category: 'file',
        callCount: index + 1,
        successCount: index + 1,
        errorCount: 0,
        durationMs: 1000 + index,
        redacted: false,
      })),
      files: {
        scope: 'snapshot_summary',
        changedFiles: 5,
        addedLines: 18,
        deletedLines: 2,
        files: Array.from({ length: 5 }, (_, index) => ({
          pathLabel: `src/file-${index + 1}.ts`,
          operationCount: index + 1,
          addedLines: index + 1,
          deletedLines: 0,
          redacted: false,
        })),
      },
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
        onOpenDetails={onOpenDetails}
      />
    );

    expect(container.textContent).toContain('View all 4');
    expect(container.textContent).toContain('View all 5');

    const toolsButton = container.querySelector('button[aria-label="Open Tools details"]');
    act(() => {
      toolsButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDetails).toHaveBeenCalledWith(report, 'tools');

    const filesButton = container.querySelector('button[aria-label="Open Files details"]');
    act(() => {
      filesButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDetails).toHaveBeenCalledWith(report, 'files');
  });

  it('uses semantic file diff colors on the chat card summary', () => {
    render(
      <SessionUsageReportCard
        report={usageReport()}
        markdown="## Session Usage"
      />
    );

    expect(container.querySelector('.session-usage-report-card__file-stat--added')?.textContent).toBe('+4');
    expect(container.querySelector('.session-usage-report-card__file-stat--deleted')?.textContent).toBe('-2');
  });

  it('keeps chat card file names visible and labels model tokens', () => {
    dom.window.localStorage.setItem(USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY, 'false');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const longPath = 'src/features/session-usage/reports/components/very/deeply/nested/UsageReportCardFilePathThatWouldNormallyOverflow.tsx';
    const fileName = 'UsageReportCardFilePathThatWouldNormallyOverflow.tsx';
    const report = usageReport({
      models: [
        {
          modelId: 'gpt-5.4',
          callCount: 2,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          durationMs: 40_000,
        },
      ],
      files: {
        scope: 'snapshot_summary',
        changedFiles: 1,
        addedLines: 4,
        deletedLines: 2,
        files: [
          {
            pathLabel: longPath,
            operationCount: 2,
            addedLines: 4,
            deletedLines: 2,
            redacted: false,
          },
        ],
      },
    });

    let refWarnings: unknown[][] = [];
    try {
      render(
        <SessionUsageReportCard
          report={report}
          markdown="## Session Usage"
        />
      );
      refWarnings = consoleError.mock.calls.filter(([message]) =>
        String(message).includes('Function components cannot be given refs')
      );
    } finally {
      consoleError.mockRestore();
    }

    const fileNameLabel = container.querySelector('.session-usage-report-card__mini-list-file-name');
    expect(fileNameLabel?.textContent).toBe(fileName);
    expect(container.textContent).not.toContain('src/features');
    expect(container.textContent).not.toContain('/.../');
    expect(container.querySelector(`[data-tooltip="${longPath}"]`)).not.toBeNull();
    expect(container.textContent).toContain('1.5K tokens');
    expect(refWarnings).toEqual([]);
  });

  it('syncs path redaction between the chat card and detail panel', async () => {
    const report = usageReport({
      workspace: {
        kind: 'local',
        pathLabel: 'D:/workspace/openbitfun',
      },
      files: {
        scope: 'snapshot_summary',
        changedFiles: 1,
        addedLines: 4,
        deletedLines: 2,
        files: [
          {
            pathLabel: 'src/private/secret.ts',
            operationCount: 2,
            addedLines: 4,
            deletedLines: 2,
            turnIndexes: [1],
            operationIds: ['operation-1'],
            redacted: false,
          },
        ],
      },
    });

    render(
      <>
        <SessionUsageReportCard report={report} markdown="## Session Usage: D:/workspace/openbitfun/src/private/secret.ts" />
        <SessionUsagePanel
          report={report}
          markdown="## Session Usage: D:/workspace/openbitfun/src/private/secret.ts"
          sessionId="session-1"
          workspacePath="D:/workspace/openbitfun"
          initialTab="files"
        />
      </>
    );

    const redactionInputs = Array.from(container.querySelectorAll<HTMLInputElement>(
      `input[aria-label="Redact paths"]`
    ));
    expect(redactionInputs).toHaveLength(2);
    expect(redactionInputs.every(input => input.checked)).toBe(true);
    expect(redactionInputs.every(input => input.labels?.length === 1)).toBe(true);
    expect(redactionInputs.every(input => input.closest('label')?.getAttribute('data-appearance') === 'native')).toBe(true);
    expect(container.textContent).toContain('[redacted path]');
    expect(container.textContent).toContain('secret.ts');
    expect(container.textContent).not.toContain('D:/workspace/openbitfun');
    expect(container.textContent).not.toContain('src/private/secret.ts');
    expect(container.querySelector('[data-tooltip="[redacted path]/secret.ts"]')).not.toBeNull();

    const copy = container.querySelector<HTMLButtonElement>('.session-usage-report-card button[aria-label="Copy Markdown"]');
    expect(copy).not.toBeNull();
    await act(async () => copy?.click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('## Session Usage: [redacted path]/[redacted path]/secret.ts');

    const preferenceWrite = vi.spyOn(dom.window.Storage.prototype, 'setItem');
    act(() => {
      redactionInputs[0]?.labels?.[0].click();
    });
    expect(preferenceWrite).toHaveBeenCalledTimes(1);
    expect(preferenceWrite).toHaveBeenLastCalledWith(USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY, 'false');

    const updatedInputs = Array.from(container.querySelectorAll<HTMLInputElement>(
      `input[aria-label="Redact paths"]`
    ));
    expect(updatedInputs.every(input => input.checked)).toBe(false);
    expect(container.textContent).toContain('D:/workspace/openbitfun');
    expect(container.querySelector('[data-tooltip="src/private/secret.ts"]')).not.toBeNull();
    await act(async () => copy?.click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('## Session Usage: D:/workspace/openbitfun/src/private/secret.ts');
    act(() => updatedInputs[1]?.labels?.[0].click());
    expect(updatedInputs.every(input => input.checked)).toBe(true);
    expect(preferenceWrite).toHaveBeenCalledTimes(2);
    expect(preferenceWrite).toHaveBeenLastCalledWith(USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY, 'true');
    preferenceWrite.mockRestore();
  });

  it('does not append a token unit when chat card model tokens are unavailable', () => {
    const report = usageReport({
      models: [
        {
          modelId: 'legacy-model',
          callCount: 1,
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          durationMs: 12_000,
        },
      ],
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
      />
    );

    expect(container.textContent).toContain('Unavailable');
    expect(container.textContent).not.toContain('Unavailable tokens');
    expect(container.textContent).not.toContain('Unavailable Token');
  });

  it('keeps the detail coverage badge in the header action area', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" />);

    const headerActions = container.querySelector('.session-usage-panel__header-actions');
    expect(headerActions?.querySelector('.session-usage-panel__badge')?.textContent).toBe('Partial data');
    expect(container.querySelector('.session-usage-panel__title-wrap .session-usage-panel__badge')).toBeNull();
  });

  it('explains error examples on the detail panel', () => {
    const report = usageReport({
      errors: {
        totalErrors: 2,
        toolErrors: 1,
        modelErrors: 1,
        examples: [
          { label: 'Write', count: 1, redacted: false },
          { label: 'Model/runtime turn errors', count: 1, redacted: false },
        ],
      },
    });

    render(<SessionUsagePanel report={report} markdown="## Session Usage" />);

    const errorsTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Errors');
    act(() => {
      errorsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Tool errors');
    expect(container.textContent).toContain('Model errors');
    expect(container.querySelector('[data-tooltip="Safe grouped label for an error type."]')).not.toBeNull();
    expect(container.querySelector('[data-tooltip="Number of matching errors."]')).not.toBeNull();
  });

  it('shows an immediate usage loading card before report data exists', () => {
    render(
      <SessionUsageReportCard
        isLoading
        markdown="Generating..."
      />
    );

    expect(container.querySelector('.session-usage-report-card--loading')).not.toBeNull();
    expect(container.textContent).toContain('Generating usage report');
    expect(container.textContent).toContain('Reading session records');
    expect(container.textContent).not.toContain('Unknown values are not counted as zero');
  });

  it('switches panel sections and keeps raw sensitive details redacted', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" />);

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBe('Usage report sections');
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'))
      .toBe('session-usage-tab-overview');

    for (const tab of ['Models', 'Tools', 'Files', 'Errors']) {
      const tabButton = Array.from(container.querySelectorAll('[role="tab"]'))
        .find(button => button.textContent === tab);
      act(() => {
        tabButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      expect(tabButton?.getAttribute('aria-selected')).toBe('true');
      expect(container.textContent).toContain(tab);
    }

    expect(container.textContent).toContain('Redacted');
    expect(container.textContent).not.toContain('secret shell command output');
    expect(container.textContent).not.toContain('secrets/raw-file-content.txt');
    expect(container.textContent).not.toContain('raw provider error with secret payload');
  });

  it('shows model duration only when model span facts exist', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" />);

    const modelTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Recorded time');
    expect(container.textContent).toContain('40s');

    const reportWithoutModelDuration = usageReport({
      models: [
        {
          modelId: 'gpt-5.4',
          callCount: 1,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          durationMs: undefined,
        },
      ],
    });

    render(<SessionUsagePanel report={reportWithoutModelDuration} markdown="## Session Usage" />);
    const modelTabWithoutDuration = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelTabWithoutDuration?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Recorded time');
    expect(container.textContent).not.toContain('Timing not recorded');
  });

  it('hides unavailable tool execution timing and uses explicit tool timing headers', () => {
    const report = usageReport({
      tools: [
        {
          toolName: 'read_file',
          category: 'file',
          callCount: 3,
          successCount: 3,
          errorCount: 0,
          durationMs: undefined,
          p95DurationMs: undefined,
          executionMs: undefined,
          redacted: false,
        },
      ],
    });

    render(<SessionUsagePanel report={report} markdown="## Session Usage" />);

    const toolsTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Tools');
    act(() => {
      toolsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Total time');
    expect(container.textContent).toContain('P95 total');
    expect(container.textContent).not.toContain('Execution time');

    const missingValues = container.querySelectorAll('.session-usage-panel__missing-value');
    expect(missingValues).toHaveLength(2);
    expect(Array.from(missingValues).every(value => value.textContent === 'Timing not recorded')).toBe(true);
  });

  it('supports standard keyboard navigation across usage panel tabs', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" />);

    const overviewTab = container.querySelector<HTMLButtonElement>('#session-usage-tab-overview');
    act(() => {
      overviewTab?.focus();
      overviewTab?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true,
      }));
    });

    const slowestTab = container.querySelector<HTMLButtonElement>('#session-usage-tab-slowest');
    expect(slowestTab?.getAttribute('aria-selected')).toBe('true');
    expect(dom.window.document.activeElement).toBe(slowestTab);

    act(() => {
      slowestTab?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
      }));
    });

    const errorsTab = container.querySelector<HTMLButtonElement>('#session-usage-tab-errors');
    expect(errorsTab?.getAttribute('aria-selected')).toBe('true');
    expect(dom.window.document.activeElement).toBe(errorsTab);

    for (const [key, expected] of [
      ['Home', 'overview'], ['ArrowLeft', 'slowest'], ['ArrowRight', 'overview'], ['End', 'slowest'],
    ]) {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => dom.window.document.activeElement?.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(dom.window.document.activeElement?.id).toBe(`session-usage-tab-${expected}`);
      expect(container.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
      expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'))
        .toBe(`session-usage-tab-${expected}`);
    }
  });

  it('preserves initial-tab updates and saved appearance selectors on the native tabs', () => {
    const legacyPackage: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.usage-tabs', name: 'Usage tabs', version: '1.0.0', mode: 'dark',
      components: { 'session-usage-panel': { parts: { tab: { contexts: [{
        when: { facets: { tab: 'models' }, states: ['active'] },
        style: { opacity: { kind: 'number', value: 0.6 } },
      }] } } } },
    };
    const serialized = JSON.stringify(legacyPackage);
    const restored = JSON.parse(serialized) as AppearancePackage;
    const registry = new AppearanceRegistry().registerComponent(sessionUsagePanelAppearanceDescriptor);
    const snapshot = new AppearanceCompiler(registry).compile(restored, 1);
    expect(JSON.stringify(restored)).toBe(serialized);
    document.documentElement.setAttribute('data-openbitfun-appearance', snapshot.id);
    document.documentElement.setAttribute('data-openbitfun-appearance-revision', String(snapshot.revision));
    const style = document.createElement('style');
    style.textContent = snapshot.cssText;
    document.head.appendChild(style);
    const rule = Array.from(style.sheet!.cssRules).find(candidate =>
      candidate instanceof dom.window.CSSStyleRule && candidate.style.opacity === '0.6',
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();

    const report = usageReport();
    render(<SessionUsagePanel report={report} initialTab="models" />);
    const modelsTab = container.querySelector('#session-usage-tab-models');
    expect(container.querySelector('[role="tablist"]')?.getAttribute('data-openbitfun-component')).toBe('tab-group');
    expect(modelsTab?.getAttribute('data-openbitfun-part')).toBe('tab');
    expect(document.querySelector(rule!.selectorText)).toBe(modelsTab);
    render(<SessionUsagePanel report={report} initialTab="files" />);
    expect(document.querySelector(rule!.selectorText)).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('session-usage-panel-files');
    act(() => modelsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(document.querySelector(rule!.selectorText)).toBe(modelsTab);
  });

  it('follows the shared tab direction in RTL layouts', () => {
    render(<SessionUsagePanel report={usageReport()} />);
    container.querySelectorAll<HTMLElement>('[role="tab"]').forEach(tab => { tab.style.direction = 'rtl'; });
    const overviewTab = container.querySelector<HTMLButtonElement>('#session-usage-tab-overview')!;
    act(() => {
      overviewTab.focus();
      overviewTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(dom.window.document.activeElement?.id).toBe('session-usage-tab-slowest');
    expect(container.querySelector('#session-usage-tab-slowest')?.getAttribute('aria-selected')).toBe('true');
  });

  it('caps long usage tables and allows explicit expansion', () => {
    const tools = Array.from({ length: 55 }, (_, index) => ({
      toolName: `Tool ${index + 1}`,
      category: 'other' as const,
      callCount: 1,
      successCount: 1,
      errorCount: 0,
      durationMs: 1000,
      p95DurationMs: 1000,
      executionMs: 1000,
      redacted: false,
    }));

    render(<SessionUsagePanel report={usageReport({ tools })} markdown="## Session Usage" />);

    const toolsTab = Array.from(container.querySelectorAll('[role="tab"]'))
      .find(button => button.textContent === 'Tools');
    act(() => {
      toolsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(container.textContent).toContain('Showing 50 of 55 rows');
    expect(container.textContent).not.toContain('Tool 55');

    const showAll = Array.from(container.querySelectorAll('button'))
      .find(button => button.textContent === 'Show all 55 rows');
    act(() => {
      showAll?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelectorAll('tbody tr')).toHaveLength(55);
    expect(container.textContent).toContain('Tool 55');
    act(() => toolsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(55);
  });

  it('links model tool and error aggregate rows to representative transcript anchors', () => {
    const report = usageReport({
      models: [
        {
          modelId: 'gpt-5.4',
          callCount: 1,
          totalTokens: 120,
          durationMs: 12_000,
          sampleTurnId: 'turn-2',
          sampleTurnIndex: 1,
        },
      ],
      tools: [
        {
          toolName: 'write_file',
          category: 'file',
          callCount: 1,
          successCount: 1,
          errorCount: 0,
          durationMs: 2_000,
          sampleTurnId: 'turn-3',
          sampleTurnIndex: 2,
          sampleItemId: 'tool-3',
          redacted: false,
        },
      ],
      errors: {
        totalErrors: 1,
        toolErrors: 1,
        modelErrors: 0,
        examples: [
          {
            label: 'write_file',
            count: 1,
            sampleTurnId: 'turn-4',
            sampleTurnIndex: 3,
            sampleItemId: 'tool-4',
            redacted: false,
          },
        ],
      },
    });
    const focusEvents: FlowChatFocusItemRequest[] = [];
    const unsubscribe = globalEventBus.on<FlowChatFocusItemRequest>(
      FLOWCHAT_FOCUS_ITEM_EVENT,
      event => focusEvents.push(event),
    );

    render(<SessionUsagePanel report={report} markdown="## Session Usage" sessionId="session-1" />);

    const modelsTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const modelAnchor = container.querySelector<HTMLButtonElement>('.session-usage-panel__row-anchor-link');
    expect(modelAnchor?.textContent).toContain('gpt-5.4');
    act(() => {
      modelAnchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const toolsTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Tools');
    act(() => {
      toolsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const toolAnchor = container.querySelector<HTMLButtonElement>('.session-usage-panel__row-anchor-link');
    expect(toolAnchor?.textContent).toContain('write_file');
    act(() => {
      toolAnchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const errorsTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Errors');
    act(() => {
      errorsTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const errorAnchor = container.querySelector<HTMLButtonElement>('.session-usage-panel__row-anchor-link');
    expect(errorAnchor?.textContent).toContain('write_file');
    act(() => {
      errorAnchor?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(focusEvents).toEqual([
      {
        sessionId: 'session-1',
        turnId: 'turn-2',
        turnIndex: 2,
        source: 'usage-report',
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-3',
        turnIndex: 3,
        itemId: 'tool-3',
        source: 'usage-report',
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-4',
        turnIndex: 4,
        itemId: 'tool-4',
        source: 'usage-report',
      },
    ]);
    unsubscribe();
  });

  it('opens the detail panel on a requested usage tab', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" initialTab="files" />);

    const filesTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Files');
    expect(filesTab?.className).toContain('session-usage-panel__tab--active');
    expect(container.textContent).toContain('File scope');
  });

  it('explains inferred legacy model labels on the card and detail panel', () => {
    const report = usageReport({
      models: [
        {
          modelId: 'gpt-5.4',
          modelIdSource: 'inferred_session_model',
          callCount: 2,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          durationMs: 40_000,
        },
      ],
    });

    render(
      <SessionUsageReportCard
        report={report}
        markdown="## Session Usage"
      />
    );

    expect(container.textContent).toContain('gpt-5.4 (inferred)');
    expect(container.querySelector('[data-tooltip="Inferred from the session model setting."]')).not.toBeNull();

    render(<SessionUsagePanel report={report} markdown="## Session Usage" />);
    const modelTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('gpt-5.4 (inferred)');
    expect(container.querySelector('[data-tooltip="Inferred from the session model setting."]')).not.toBeNull();
  });

  it('hides legacy model round placeholders in the detail panel', () => {
    const report = usageReport({
      models: [
        {
          modelId: 'model round 0',
          callCount: 1,
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          durationMs: 12_000,
        },
      ],
    });

    render(<SessionUsagePanel report={report} markdown="## Session Usage" />);

    const modelTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Legacy model not tracked');
    expect(container.textContent).not.toContain('model round 0');
    expect(container.querySelector('[data-tooltip="Older sessions did not store per-round model names."]')).not.toBeNull();
  });

  it('renders the runtime status entry as a lightweight usage trigger', () => {
    const onOpen = vi.fn();

    render(<SessionRuntimeStatusEntry onOpen={onOpen} />);

    expect(container.querySelector('.session-runtime-status-entry')?.textContent).toContain('Usage');
    expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Generate a usage report in this chat');
    expect(container.textContent).not.toContain('1500 tokens');
    expect(container.textContent).not.toContain('tool calls');
    expect(container.textContent).not.toContain('files');
    expect(container.textContent).not.toContain('50%');
    expect(container.textContent).not.toContain('25%');

    act(() => {
      container.querySelector('button')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    render(<SessionRuntimeStatusEntry />);
    expect(container.querySelector('.session-runtime-status-entry')).toBeNull();
  });

  it('shows copyable detail metadata and explains unavailable model/file metrics', async () => {
    const report = usageReport({
      models: [
        {
          modelId: 'glm-5.1',
          callCount: 1,
          inputTokens: 421_000,
          outputTokens: 959,
          totalTokens: 421_959,
          durationMs: undefined,
        },
      ],
      files: {
        scope: 'unavailable',
        changedFiles: undefined,
        addedLines: undefined,
        deletedLines: undefined,
        files: [],
      },
    });

    render(
      <SessionUsagePanel
        report={report}
        markdown="## Session Usage"
        sessionId="session-1"
        workspacePath="D:/workspace/openbitfun"
      />
    );

    expect(container.querySelectorAll('.session-usage-panel__meta-row')).toHaveLength(3);
    const cacheCoverageHelp = Array.from(container.querySelectorAll('[data-tooltip]'))
      .find(node => node.getAttribute('data-tooltip')?.includes('Total token counts are still shown'));
    expect(cacheCoverageHelp?.textContent).toContain('Not reported');

    const sessionCopy = container.querySelector('button[aria-label="Copy session ID"]');
    await act(async () => {
      sessionCopy?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('session-1');

    const modelTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Models');
    act(() => {
      modelTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('glm-5.1');
    expect(container.textContent).not.toContain('Timing not recorded');

    const filesTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Files');
    act(() => {
      filesTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('No file changes');
    const fileUnavailableHelp = Array.from(container.querySelectorAll('[data-tooltip]'))
      .find(node => node.getAttribute('data-tooltip')?.includes('did not detect file changes'));
    expect(fileUnavailableHelp).toBeTruthy();
  });

  it('keeps file diff actions visible and exposes full paths for long file rows', () => {
    dom.window.localStorage.setItem(USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY, 'false');
    const longPath = 'src/web-ui/src/infrastructure/markdown/MarkdownRenderer.tsx';
    const report = usageReport({
      files: {
        scope: 'snapshot_summary',
        changedFiles: 1,
        addedLines: 20,
        deletedLines: 4,
        files: [
          {
            pathLabel: longPath,
            operationCount: 2,
            addedLines: 20,
            deletedLines: 4,
            turnIndexes: [1],
            operationIds: ['operation-1'],
            redacted: false,
          },
        ],
      },
    });

    render(
      <SessionUsagePanel
        report={report}
        markdown="## Session Usage"
        sessionId="session-1"
        workspacePath="D:/workspace/openbitfun"
      />
    );

    const filesTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Files');
    act(() => {
      filesTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.session-usage-panel__table--files')).not.toBeNull();
    expect(container.querySelector(`[data-tooltip="${longPath}"]`)).not.toBeNull();
    const pathCell = container.querySelector('.session-usage-panel__file-path-cell');
    expect(pathCell?.textContent).toBe('.../markdown/MarkdownRenderer.tsx');
    expect(pathCell?.textContent).not.toContain('src/web-ui/src/infrastructure');
    expect(pathCell?.textContent).not.toBe(longPath);
    expect(container.textContent).not.toContain('Operation IDs');
    expect(container.textContent).not.toContain('operation-1');
    expect(container.querySelector('.session-usage-panel__sticky-action-cell')).not.toBeNull();
    expect(container.querySelector('.session-usage-panel__table-action')).not.toBeNull();
  });

  it('opens snapshot-backed file diffs from the detail panel', async () => {
    // Snapshot IO is routed by the session's workspace ID; the path is only the operand.
    flowChatStore.setState((): FlowChatState => ({
      sessions: new Map([['session-1', {
        sessionId: 'session-1',
        title: 'Session 1',
        dialogTurns: [],
        status: 'idle',
        config: { agentType: 'Standard' },
        createdAt: 1,
        lastActiveAt: 1,
        error: null,
        sessionKind: 'normal',
        workspaceId: 'workspace-1',
        workspacePath: 'D:/workspace/openbitfun',
      } as Session]]),
      activeSessionId: 'session-1',
    }));
    snapshotApiMocks.getOperationDiff.mockResolvedValue({
      filePath: 'D:/workspace/openbitfun/src/main.rs',
      originalContent: 'before',
      modifiedContent: 'after',
      anchorLine: 42,
    });
    const report = usageReport({
      files: {
        scope: 'snapshot_summary',
        changedFiles: 1,
        addedLines: 2,
        deletedLines: 1,
        files: [
          {
            pathLabel: 'src/main.rs',
            operationCount: 1,
            addedLines: 2,
            deletedLines: 1,
            turnIndexes: [1],
            operationIds: ['operation-1'],
            redacted: false,
          },
        ],
      },
    });

    render(
      <SessionUsagePanel
        report={report}
        markdown="## Session Usage"
        sessionId="session-1"
        workspacePath="D:/workspace/openbitfun"
      />
    );

    const filesTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Files');
    act(() => {
      filesTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const openDiffButton = container.querySelector('button[aria-label="Open diff"]');
    expect(openDiffButton).not.toBeNull();

    await act(async () => {
      openDiffButton?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(snapshotApiMocks.getOperationDiff).toHaveBeenCalledWith(
      'session-1',
      'D:/workspace/openbitfun/src/main.rs',
      'operation-1',
    );
    expect(tabUtilsMocks.createDiffEditorTab).toHaveBeenCalledWith(
      'D:/workspace/openbitfun/src/main.rs',
      'main.rs',
      'before',
      'after',
      true,
      'agent',
      'D:/workspace/openbitfun',
      42,
      undefined,
      {
        titleKind: 'diff',
        duplicateKeyPrefix: 'diff',
        workspaceId: 'workspace-1',
      },
    );
    flowChatStore.setState((): FlowChatState => ({ sessions: new Map(), activeSessionId: null }));
  });

  it('shows slowest spans in the detail panel', () => {
    const report = usageReport({
      slowest: [
        {
          label: 'turn 2',
          kind: 'turn',
          durationMs: 95_000,
          redacted: false,
          turnId: 'turn-2',
          turnIndex: 2,
        },
        {
          label: 'secret shell command',
          kind: 'tool',
          durationMs: 30_000,
          redacted: true,
        },
      ],
    });

    const focusEvents: FlowChatFocusItemRequest[] = [];
    const unsubscribe = globalEventBus.on<FlowChatFocusItemRequest>(
      FLOWCHAT_FOCUS_ITEM_EVENT,
      event => focusEvents.push(event),
    );

    render(<SessionUsagePanel report={report} markdown="## Session Usage" sessionId="session-1" />);

    const slowestTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Slowest');
    act(() => {
      slowestTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Slow spans are derived from recorded turn, model, and tool timestamps');
    // Built from `turnIndex: 2`, not the report's own `label: 'turn 2'`, which
    // is hard-coded English numbered from zero.
    expect(container.textContent).toContain('Turn 3');
    expect(container.textContent).not.toContain('turn 2');
    expect(container.textContent).toContain('1m 35s');
    expect(container.textContent).toContain('Redacted');
    expect(container.textContent).not.toContain('secret shell command');

    const turnLink = container.querySelector<HTMLButtonElement>('.session-usage-panel__turn-link');
    expect(turnLink?.textContent).toBe('Turn 3');
    act(() => {
      turnLink?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(focusEvents).toEqual([
      {
        sessionId: 'session-1',
        turnId: 'turn-2',
        turnIndex: 3,
        source: 'usage-report',
      },
    ]);
    unsubscribe();
  });

  it('shows diagnostic details for slow tool spans and jumps to the exact tool item', () => {
    const report = usageReport({
      slowest: [
        {
          label: 'ExecCommand',
          kind: 'tool',
          durationMs: 95_000,
          redacted: false,
          turnId: 'turn-2',
          turnIndex: 2,
          itemId: 'tool-slow',
          inputSummary: 'curl https://api.example.test/slow',
          status: 'failed',
          exitCode: 28,
          timedOut: true,
          executionMs: 94_970,
          errorSummary: 'operation timed out',
        },
      ],
    });

    const focusEvents: FlowChatFocusItemRequest[] = [];
    const unsubscribe = globalEventBus.on<FlowChatFocusItemRequest>(
      FLOWCHAT_FOCUS_ITEM_EVENT,
      event => focusEvents.push(event),
    );

    render(<SessionUsagePanel report={report} markdown="## Session Usage" sessionId="session-1" />);

    const slowestTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Slowest');
    act(() => {
      slowestTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('ExecCommand');
    expect(container.textContent).toContain('Input');
    expect(container.textContent).toContain('curl https://api.example.test/slow');
    expect(container.textContent).toContain('Status');
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).toContain('Exit code');
    expect(container.textContent).toContain('28');
    expect(container.textContent).toContain('Timed out');
    expect(container.textContent).toContain('Execution');
    expect(container.textContent).toContain('1m 35s');
    expect(container.textContent).toContain('operation timed out');

    const toolLink = container.querySelector<HTMLButtonElement>('.session-usage-panel__turn-link');
    act(() => {
      toolLink?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(focusEvents).toEqual([
      {
        sessionId: 'session-1',
        turnId: 'turn-2',
        turnIndex: 3,
        itemId: 'tool-slow',
        source: 'usage-report',
      },
    ]);
    unsubscribe();
  });

  it('labels slow model spans by turn and jumps to that turn', () => {
    const report = usageReport({
      slowest: [
        {
          label: 'gpt-5.4',
          kind: 'model',
          durationMs: 42_000,
          redacted: false,
          turnId: 'turn-4',
          turnIndex: 4,
        },
      ],
    });

    const focusEvents: FlowChatFocusItemRequest[] = [];
    const unsubscribe = globalEventBus.on<FlowChatFocusItemRequest>(
      FLOWCHAT_FOCUS_ITEM_EVENT,
      event => focusEvents.push(event),
    );

    render(<SessionUsagePanel report={report} markdown="## Session Usage" sessionId="session-1" />);

    const slowestTab = Array.from(container.querySelectorAll('.session-usage-panel__tab'))
      .find(button => button.textContent === 'Slowest');
    act(() => {
      slowestTab?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    /*
     * The same number the jump below asks for. This test asserted `Turn 4`
     * here and `turnIndex: 5` there, four lines apart, and the disagreement
     * was the defect: the report indexes Turns from zero, every other reader
     * adds one, and only this label did not.
     */
    expect(container.textContent).toContain('Turn 5 model call');
    expect(container.textContent).toContain('Model call');
    expect(container.textContent).not.toContain('gpt-5.4');
    expect(container.querySelector('[data-tooltip="Model call in this turn. Model: gpt-5.4. Jump to this turn"]'))
      .not.toBeNull();

    const turnLink = container.querySelector<HTMLButtonElement>('.session-usage-panel__turn-link');
    act(() => {
      turnLink?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(focusEvents).toEqual([
      {
        sessionId: 'session-1',
        turnId: 'turn-4',
        turnIndex: 5,
        source: 'usage-report',
      },
    ]);
    unsubscribe();
  });
});

describe('Session usage report i18n and theme guards', () => {
  it('keeps usage locale keys aligned across English, Simplified Chinese, and Traditional Chinese', () => {
    const enUsage = enFlowChat.usage;
    const zhCnUsage = zhCnFlowChat.usage;
    const zhTwUsage = zhTwFlowChat.usage;

    for (const key of collectLeafPaths(enUsage)) {
      expect(resolvePath(zhCnUsage, key), `zh-CN missing usage.${key}`).not.toBeUndefined();
      expect(resolvePath(zhTwUsage, key), `zh-TW missing usage.${key}`).not.toBeUndefined();
    }
  });

  it('localizes the /usage command text in all flow chat locales', () => {
    const keys = [
      'usageAction',
      'usageNoSession',
      'usageCommandUsage',
      'usageBusy',
      'usageNoWorkspace',
      'usageFailed',
    ];

    for (const key of keys) {
      expect(enFlowChat.chatInput[key as keyof typeof enFlowChat.chatInput], `en-US missing chatInput.${key}`)
        .toEqual(expect.any(String));
      expect(zhCnFlowChat.chatInput[key as keyof typeof zhCnFlowChat.chatInput], `zh-CN missing chatInput.${key}`)
        .toEqual(expect.any(String));
      expect(zhTwFlowChat.chatInput[key as keyof typeof zhTwFlowChat.chatInput], `zh-TW missing chatInput.${key}`)
        .toEqual(expect.any(String));
    }
  });

  it('keeps usage copy token-only without billing or package language', () => {
    const usageCopy = [
      ...flattenStrings(enFlowChat.usage),
      ...flattenStrings(zhCnFlowChat.usage),
      ...flattenStrings(zhTwFlowChat.usage),
    ].join('\n');

    expect(usageCopy).not.toMatch(/\b(cost|price|billing|currency|invoice|package|subscription|usd|cny|rmb)\b/i);
    expect(usageCopy).not.toMatch(/[$\u00a5\u20ac]/);
  });

  it('keeps usage styles on semantic theme colors', () => {
    const usageStylePaths = [
      'src/flow_chat/components/usage/SessionUsageReportCard.scss',
      'src/flow_chat/components/usage/SessionUsagePanel.scss',
      'src/flow_chat/components/usage/SessionRuntimeStatusEntry.scss',
    ];
    const styleText = usageStylePaths
      .map(stylePath => fs.readFileSync(path.resolve(stylePath), 'utf8'))
      .join('\n');

    expect(styleText).toContain('var(--openbitfun-color-content-primary)');
    expect(styleText).toContain('width: auto;');
    expect(styleText).toContain('margin: 0.12rem 3rem');
    expect(styleText).toContain('border: 1px solid color-mix(in srgb, var(--openbitfun-color-border-default)');
    expect(styleText).toContain('grid-template-columns: repeat(3, minmax(116px, 1fr));');
    expect(styleText).toContain('width: clamp(180px, 26vw, 280px);');
    expect(styleText).toContain('max-width: 280px;');
    expect(styleText).not.toContain('text-overflow: ellipsis;');
    expect(styleText).not.toContain('grid-template-columns: repeat(4, minmax(116px, 1fr));');
    expect(styleText).not.toContain('grid-template-columns: minmax(0, 1fr) auto max-content;');
    expect(styleText).not.toContain('max-width: 72%;');
    expect(styleText).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
