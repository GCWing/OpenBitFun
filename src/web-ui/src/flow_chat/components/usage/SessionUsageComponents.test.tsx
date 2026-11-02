import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import type { SessionUsageReport } from '@/infrastructure/api/service-api/SessionAPI';
import { AppearanceCompiler } from '@/infrastructure/appearance/compiler/AppearanceCompiler';
import { AppearanceRegistry } from '@/infrastructure/appearance/registry/AppearanceRegistry';
import { appearancePackageValidator } from '@/infrastructure/appearance/schema/AppearancePackageValidator';
import { APPEARANCE_SCHEMA_VERSION, type AppearancePackage } from '@/infrastructure/appearance/types';
import enFlowChat from '@/locales/en-US/flow-chat.json';
import zhCnFlowChat from '@/locales/zh-CN/flow-chat.json';
import zhTwFlowChat from '@/locales/zh-TW/flow-chat.json';
import { SessionRuntimeStatusEntry } from './SessionRuntimeStatusEntry';
import { SessionUsagePanel } from './SessionUsagePanel';
import { sessionUsagePanelAppearanceDescriptor } from './appearance';
import { SessionUsageReportCard } from './SessionUsageReportCard';
import { USAGE_EXPORT_REDACT_PATHS_STORAGE_KEY } from './usageReportUtils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const promptPreviewMocks = vi.hoisted(() => ({ open: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('../../services/openSessionContextPreview', () => ({ openSessionContextPreview: promptPreviewMocks.open }));
vi.mock('@/shared/notification-system', () => ({
  notificationService: { warning: promptPreviewMocks.warning, error: promptPreviewMocks.error },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'usage.title': 'Session Usage',
        'usage.tokens.title': 'Token usage',
        'usage.tokens.cacheHit': 'KV Cache hits',
        'usage.tokens.uncachedInput': 'Input (uncached)',
        'usage.tokens.hitRate': 'Cache hit rate {{value}}',
        'usage.tokens.hitRateDetail': 'Cache hit rate {{rate}} ({{cached}} / {{input}} input tokens)',
        'usage.tokens.cacheHitDetail': '(cache hit {{rate}})',
        'usage.tokens.minimumRate': '≥{{rate}}',
        'usage.tokens.recordedCacheHits': 'Recorded cache hits',
        'usage.tokens.remainingInput': 'Remaining input',
        'usage.tokens.inputShareDetail': '{{tokens}} / {{input}} input tokens ({{share}} of input)',
        'usage.tokens.partialCacheHelp': 'The chart shows recorded cache hits; remaining input includes unreported usage. The hit percentage is a lower bound over all input tokens.',
        'usage.tokens.cacheUnavailable': '(cache unavailable)',
        'usage.context.unavailable': 'No context breakdown recorded',
        'usage.context.label': 'Context',
        'usage.context.utilization': 'Context usage',
        'usage.context.unused': 'Unused',
        'usage.context.capacityUnavailable': 'Context capacity was not reported. Only recorded usage by category is shown.',
        'usage.context.exceedsCapacity': 'Estimated context usage exceeds the reported capacity. Only recorded usage by category is shown.',
        'usage.context.usageOfCapacity': '{{used}} / {{size}}',
        'usage.context.approximateTokens': '~{{value}}',
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
        'usage.panel.report': 'Context Usage Report',
        'usage.panel.workspace': 'Project',
        'usage.panel.totalTokens': 'Total tokens',
        'usage.panel.totalUsage': 'Total usage',
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
    promptPreviewMocks.open.mockReset();
    promptPreviewMocks.warning.mockReset();
    promptPreviewMocks.error.mockReset();
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

  it.each([
    { isLoading: true },
    { error: 'Host offline' },
    { markdown: '# Legacy report' },
    { report: usageReport() },
  ])('publishes the localized title for existing tabs in every report state: %j', props => {
    const onTitleChange = vi.fn();
    render(<SessionUsagePanel {...props} onTitleChange={onTitleChange} />);
    expect(onTitleChange).toHaveBeenCalledExactlyOnceWith('Context Usage Report');
  });

  it.each([undefined, null])('distinguishes a new session from missing telemetry with a %s file count', changedFiles => {
    const report = usageReport({
      scope: { kind: 'entire_session', turnCount: 0, includesSubagents: false },
      tokens: { source: 'unavailable', cacheCoverage: 'unavailable' },
      models: [{ modelId: 'unknown_model', callCount: 0 }],
      tools: [], files: { scope: 'unavailable', files: [] },
      errors: { totalErrors: 0, toolErrors: 0, modelErrors: 0, examples: [] },
      compression: { compactionCount: 0, manualCompactionCount: 0, automaticCompactionCount: 0 },
    });
    // Rust Option serializes as null; legacy payloads may omit the field.
    Object.assign(report.files, { changedFiles });
    for (const Component of [SessionUsageReportCard, SessionUsagePanel]) {
      render(<Component report={report} />);
      expect(container.querySelector('[data-testid="session-usage-empty"]')).not.toBeNull();
      expect(container.textContent).not.toContain('Unavailable');
      render(<Component report={{ ...report, scope: { ...report.scope, turnCount: 1 } }} />);
      expect(container.querySelector('[data-testid="session-usage-empty"]')).toBeNull();
      render(<Component report={{ ...report, models: [{ modelId: 'unknown_model', callCount: 1 }] }} />);
      expect(container.querySelector('[data-testid="session-usage-empty"]')).toBeNull();
    }
  });

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

  it('renders the compact summary without removed detail links', () => {
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
    expect(container.textContent).not.toContain('View all 4');
    expect(container.textContent).toContain('ExecCommand');
    expect(container.textContent).toContain('Grep');
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).not.toContain('Read2 calls');
    expect(container.querySelectorAll('.session-usage-report-card__compact-tool-row')).toHaveLength(3);
    expect(container.querySelector('.session-usage-report-card__coverage')).toBeNull();
    expect(container.querySelector('input[aria-label="Redact paths"]')).toBeNull();
    expect(container.textContent).toContain('Usage statistics may be delayed');

    expect(container.querySelector('button[aria-label="Open Tools details"]')).toBeNull();
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

  it('keeps the report entry without links to removed detail sections', () => {
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

    expect(container.textContent).not.toContain('View all 4');
    expect(container.textContent).not.toContain('View all 5');

    expect(container.querySelector('button[aria-label="Open Tools details"]')).toBeNull();

    expect(container.querySelector('button[aria-label="Open Files details"]')).toBeNull();
    const reportButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open details"]')!;
    act(() => reportButton.click());
    expect(onOpenDetails).toHaveBeenCalledWith(report);
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

  it('keeps the card path preference in the panel without a panel redaction control', async () => {
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
    expect(redactionInputs).toHaveLength(1);
    expect(container.querySelector('.session-usage-panel input[aria-label="Redact paths"]')).toBeNull();
    expect(container.querySelector('.session-usage-panel__summary-facts dd')?.textContent).toBe('openbitfun');
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
    expect(container.querySelector('.session-usage-panel__summary-facts dd')?.textContent).toBe('openbitfun');
    expect(container.textContent).toContain('D:/workspace/openbitfun');
    expect(container.querySelector('[data-tooltip="src/private/secret.ts"]')).not.toBeNull();
    await act(async () => copy?.click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('## Session Usage: D:/workspace/openbitfun/src/private/secret.ts');
    act(() => updatedInputs[0]?.labels?.[0].click());
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

  it('uses standard report components without global coverage notices', () => {
    render(<SessionUsagePanel report={usageReport()} markdown="## Session Usage" />);

    expect(container.textContent).not.toContain('Partial data');
    expect(container.textContent).not.toContain('Some metrics were not reported');
    expect(container.querySelectorAll('[data-openbitfun-component="page-header"]')).toHaveLength(3);
    expect(container.querySelector('.session-usage-panel__explorer-heading')).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="root"]')?.getAttribute('data-openbitfun-component')).toBe('scroll-area');
    expect(container.querySelector('button[aria-label="Copy Markdown"]')).not.toBeNull();
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

  it('groups cached and uncached input under input and places token usage before context', () => {
    render(<SessionUsagePanel sessionTitle="Product video" report={usageReport({
      context: { systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow: 1000 },
      tokens: { source: 'token_usage_records', inputTokens: 80, outputTokens: 20, totalTokens: 100, cachedTokens: 60, cacheCoverage: 'available', cacheHitRate: 0.99 },
    })} />);
    expect(container.querySelector('.session-usage-panel__title')?.textContent).toBe('Product video');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.session-usage-panel__donut-label strong')?.textContent).toBe('20%');
    expect(container.querySelectorAll('.session-usage-panel__donut-segment')).toHaveLength(9);
    const contextShares = Array.from(container.querySelectorAll('.session-usage-panel__donut-segment'))
      .map(segment => Number(segment.getAttribute('stroke-dasharray')?.split(' ')[0]));
    expect(contextShares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100);
    expect(contextShares.slice(0, -1).reduce((sum, share) => sum + share, 0)).toBeCloseTo(20);
    const unused = container.querySelector('.session-usage-panel__donut-segment[data-usage-category="unused"]');
    expect(unused?.classList.contains('session-usage-panel__series--unused')).toBe(true);
    expect(unused?.getAttribute('stroke-dasharray')).toBe('80 20');
    expect(unused?.getAttribute('stroke-dashoffset')).toBe('-20');
    expect(container.querySelector('.session-usage-panel__context .session-usage-panel__legend-row[data-usage-category="unused"]')?.textContent)
      .toBe('Unused80080%');
    const tokenSection = container.querySelector('.session-usage-panel__tokens');
    const tokenShares = Array.from(tokenSection!.querySelectorAll<HTMLElement>('.session-usage-panel__bar-segment'))
      .map(segment => Number(segment.style.flexGrow));
    [0.75, 0.25, 1].forEach((share, index) => expect(tokenShares[index]).toBeCloseTo(share));
    const groups = Array.from(tokenSection!.querySelectorAll<HTMLElement>('.session-usage-panel__bar-group'));
    expect(groups.map(group => Number(group.style.flexGrow))).toEqual([0.8, 0.2]);
    expect(Array.from(groups[0].children).map(segment => segment.getAttribute('data-usage-category'))).toEqual(['cachedInput', 'uncachedInput']);
    expect(Array.from(groups[1].children).map(segment => segment.getAttribute('data-usage-category'))).toEqual(['output']);
    expect(tokenSection?.querySelector('[data-usage-category="input"] dd')?.textContent).toContain('80');
    expect(tokenSection?.textContent).toContain('Input (uncached)');
    const cacheSummary = tokenSection?.querySelector('[data-usage-cache-summary]');
    expect(cacheSummary?.textContent).toBe('(cache hit 75%)');
    expect(cacheSummary?.closest('.session-usage-panel__legend-share')?.textContent).toBe('80%(cache hit 75%)');
    expect(tokenSection?.querySelector('.session-usage-panel__token-legend [data-usage-category="input"]')?.querySelectorAll('dd')).toHaveLength(1);
    expect(cacheSummary?.closest('[data-usage-category]')?.getAttribute('data-usage-category')).toBe('input');
    expect(cacheSummary?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain('Cache hit rate 75% (60 / 80 input tokens)');
    expect(tokenSection?.querySelector('.session-usage-panel__cache-legend [data-usage-category="cachedInput"] strong')?.textContent).toBe('75%');
    expect(tokenSection?.querySelector('.session-usage-panel__cache-legend [data-usage-category="uncachedInput"] strong')?.textContent).toBe('25%');
    expect(tokenSection?.querySelector('.session-usage-panel__cache-legend [data-usage-category="cachedInput"] [data-tooltip]')?.getAttribute('data-tooltip')).toContain('60 / 80 input tokens (75% of input)');
    expect(tokenSection?.querySelector('svg')).toBeNull();
    expect(container.querySelector('.session-usage-panel__summary')).toBe(tokenSection);
  });

  it.each([0, 1000])('plots %i used tokens against the full capacity, including empty and full usage', used => {
    render(<SessionUsagePanel report={usageReport({
      context: {
        systemPrompt: 0, toolDefinitions: 0, rules: 0, skills: 0, mcpTools: 0,
        subagentDefinitions: 0, summarizedConversation: 0, conversation: used, contextWindow: 1000,
      },
    })} />);

    const segments = Array.from(container.querySelectorAll('.session-usage-panel__donut-segment'));
    expect(segments).toHaveLength(1);
    expect(segments[0].getAttribute('data-usage-category')).toBe(used === 0 ? 'unused' : 'conversation');
    expect(segments[0].getAttribute('stroke-dasharray')).toBe('100 0');
    expect(container.querySelector('.session-usage-panel__donut-label strong')?.textContent).toBe(used === 0 ? '0%' : '100%');
    expect(container.querySelector('.session-usage-panel__donut-label span')?.textContent).toBe('Context usage');
    const unusedLegend = container.querySelector('.session-usage-panel__legend-row[data-usage-category="unused"]')!;
    expect(unusedLegend.querySelector('strong')?.textContent).toBe(used === 0 ? '1K' : '0');
    expect(unusedLegend.querySelector('.session-usage-panel__legend-share')?.textContent).toBe(used === 0 ? '100%' : '0%');
  });

  it.each([undefined, 0, -1, Number.NaN, Infinity, 1000.5])('preserves recorded category details without inventing free capacity when capacity is %s', contextWindow => {
    render(<SessionUsagePanel report={usageReport({
      context: {
        systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow,
      },
    })} />);

    const contextSection = container.querySelector('.session-usage-panel__context')!;
    expect(contextSection.querySelector('.session-usage-panel__donut')).toBeNull();
    expect(contextSection.textContent).toContain('Context capacity was not reported');
    expect(contextSection.querySelectorAll('.session-usage-panel__legend-row')).toHaveLength(8);
    expect(contextSection.querySelector('[data-usage-category="conversation"] strong')?.textContent).toBe('80');
    expect(contextSection.querySelector('[data-usage-category="systemPrompt"] button')).not.toBeNull();
    expect(contextSection.querySelector('[data-usage-category="unused"]')).toBeNull();
    expect(contextSection.querySelector('.session-usage-panel__legend-share')).toBeNull();
  });

  it('explains estimates over capacity without normalizing them into a misleading capacity chart', () => {
    render(<SessionUsagePanel report={usageReport({
      context: {
        systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow: 100,
      },
    })} />);

    const contextSection = container.querySelector('.session-usage-panel__context')!;
    expect(contextSection.querySelector('.session-usage-panel__donut')).toBeNull();
    expect(contextSection.textContent).toContain('Estimated context usage exceeds the reported capacity');
    expect(contextSection.querySelector('[data-usage-category="conversation"] strong')?.textContent).toBe('80');
    expect(contextSection.querySelector('[data-usage-category="unused"]')).toBeNull();
    expect(contextSection.querySelector('.session-usage-panel__legend-share')).toBeNull();
  });

  it('does not draw invented distribution segments for missing or inconsistent token counts', () => {
    for (const tokens of [
      { totalTokens: 100, outputTokens: 20 },
      { totalTokens: 100, inputTokens: 90, outputTokens: 20 },
      { totalTokens: 100, inputTokens: Number.NaN, outputTokens: 20 },
    ]) {
      render(<SessionUsagePanel report={usageReport({
        tokens: { source: 'token_usage_records', cacheCoverage: 'unavailable', ...tokens },
      })} />);
      expect(container.querySelectorAll('.session-usage-panel__donut-segment')).toHaveLength(0);
      expect(container.querySelectorAll('.session-usage-panel__bar-segment')).toHaveLength(0);
      expect(container.querySelector('.session-usage-panel__tokens .session-usage-panel__section-help')).not.toBeNull();
    }
  });

  it.each(['systemPrompt', 'toolDefinitions', 'rules', 'skills', 'mcpTools', 'subagentDefinitions'])('loads %s only after its icon is clicked and keeps the chart focus linked', async category => {
    let finish: (result: string) => void = () => {};
    promptPreviewMocks.open.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<SessionUsagePanel workspaceId="workspace-1" report={usageReport({
      context: { systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow: 1000 },
    })} />);
    expect(promptPreviewMocks.open).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>(`.session-usage-panel__legend-row[data-usage-category="${category}"] button`)!;
    expect(button.getAttribute('data-openbitfun-component')).toBe('icon-button');
    act(() => { button.focus(); button.click(); });
    expect(button.disabled).toBe(true);
    expect(promptPreviewMocks.open).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1', reportSessionId: 'session-1', workspaceId: 'workspace-1', title: `usage.context.categories.${category}${category === 'toolDefinitions' ? '' : '.md'}`, category, emptyContent: 'usage.context.previewEmpty',
    });
    expect(container.querySelector('.session-usage-panel__donut-segment[data-usage-category="conversation"]')?.hasAttribute('data-usage-muted')).toBe(true);
    await act(async () => finish('unavailable'));
    expect(button.disabled).toBe(false);
    expect(promptPreviewMocks.warning).toHaveBeenCalledWith('usage.context.previewUnavailable');
    promptPreviewMocks.open.mockRejectedValueOnce(new Error('Host offline'));
    await act(async () => button.click());
    expect(promptPreviewMocks.error).toHaveBeenCalledWith('usage.context.previewFailed');
  });

  it.each([
    ['context', 'donut-segment', 'systemPrompt'],
    ['context', 'legend-row', 'conversation'],
    ['context', 'donut-segment', 'unused'],
    ['context', 'legend-row', 'unused'],
    ['tokens', 'bar-group', 'input'],
    ['tokens', 'legend-row', 'output'],
  ])('links %s %s hover to its legend and restores peers on leave', (section, part, category) => {
    render(<SessionUsagePanel report={usageReport({
      context: { systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow: 1000 },
      tokens: { source: 'token_usage_records', inputTokens: 80, outputTokens: 20, totalTokens: 100,
        cachedTokens: 60, cacheCoverage: 'available' },
    })} />);
    const chart = container.querySelector(`.session-usage-panel__${section}`)!;
    const target = chart.querySelector(`.session-usage-panel__${part}[data-usage-category="${category}"]`)!;
    const centerValue = container.querySelector('.session-usage-panel__donut-label strong')!;
    const centerLabel = container.querySelector('.session-usage-panel__donut-label span')!;
    expect(centerValue.textContent).toBe('20%');

    act(() => {
      target.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
    });

    for (const item of chart.querySelectorAll('[data-usage-category]')) {
      const active = item.getAttribute('data-usage-category') === category || item.getAttribute('data-usage-parent') === category;
      expect(item.hasAttribute('data-usage-muted')).toBe(!active);
      expect(item.hasAttribute('data-usage-active')).toBe(active);
    }
    const otherChart = container.querySelector(`.session-usage-panel__${section === 'context' ? 'tokens' : 'context'}`)!;
    expect(otherChart.querySelector('[data-usage-muted]')).toBeNull();
    expect(centerValue.textContent).toBe(section === 'context'
      ? category === 'systemPrompt' ? '4%' : category === 'unused' ? '80%' : '8%' : '20%');
    expect(centerLabel.textContent).toBe(section === 'context'
      ? category === 'unused' ? 'Unused' : `usage.context.categories.${category}` : 'Context usage');

    act(() => {
      target.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body }));
    });
    expect(container.querySelector('[data-usage-muted]')).toBeNull();
    expect(container.querySelector('[data-usage-active]')).toBeNull();
    expect(centerValue.textContent).toBe('20%');
    expect(centerLabel.textContent).toBe('Context usage');
  });

  it('restores the focused legend highlight after hover and clears it on blur', () => {
    render(<SessionUsagePanel report={usageReport({
      context: { systemPrompt: 40, toolDefinitions: 20, rules: 20, skills: 10, mcpTools: 10,
        subagentDefinitions: 10, summarizedConversation: 10, conversation: 80, contextWindow: 1000 },
      tokens: { source: 'token_usage_records', inputTokens: 80, outputTokens: 20, totalTokens: 100,
        cachedTokens: 60, cacheCoverage: 'available' },
    })} />);
    const inputLegend = container.querySelector<HTMLElement>('.session-usage-panel__legend-row[data-usage-category="input"]')!;
    const outputSegment = container.querySelector('.session-usage-panel__bar-segment[data-usage-category="output"]')!;
    expect(inputLegend.tabIndex).toBe(0);
    act(() => inputLegend.focus());
    expect(outputSegment.hasAttribute('data-usage-muted')).toBe(true);
    expect(inputLegend.hasAttribute('data-usage-muted')).toBe(false);
    expect(inputLegend.hasAttribute('data-usage-active')).toBe(true);

    act(() => outputSegment.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    expect(outputSegment.hasAttribute('data-usage-muted')).toBe(false);
    expect(inputLegend.hasAttribute('data-usage-muted')).toBe(true);
    expect(inputLegend.hasAttribute('data-usage-active')).toBe(false);
    act(() => outputSegment.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body })));
    expect(outputSegment.hasAttribute('data-usage-muted')).toBe(true);
    expect(inputLegend.hasAttribute('data-usage-muted')).toBe(false);
    expect(inputLegend.hasAttribute('data-usage-active')).toBe(true);
    act(() => inputLegend.blur());
    expect(container.querySelector('[data-usage-muted]')).toBeNull();
    expect(container.querySelector('[data-usage-active]')).toBeNull();

    const conversationLegend = container.querySelector<HTMLElement>('.session-usage-panel__legend-row[data-usage-category="conversation"]')!;
    const systemSegment = container.querySelector('.session-usage-panel__donut-segment[data-usage-category="systemPrompt"]')!;
    const centerValue = container.querySelector('.session-usage-panel__donut-label strong')!;
    act(() => conversationLegend.focus());
    expect(centerValue.textContent).toBe('8%');
    act(() => systemSegment.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    expect(centerValue.textContent).toBe('4%');
    act(() => systemSegment.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body })));
    expect(centerValue.textContent).toBe('8%');
    act(() => conversationLegend.blur());
    expect(centerValue.textContent).toBe('20%');
  });

  it('plots recorded cache hits with a lower bound for partial telemetry and leaves unknown cache unsplit', () => {
    for (const cacheCoverage of ['partial', 'unavailable'] as const) {
      render(<SessionUsagePanel report={usageReport({
        tokens: { source: 'token_usage_records', inputTokens: 80, outputTokens: 20, totalTokens: 100,
          cachedTokens: 60, cacheCoverage, cacheHitRate: 0.8 },
      })} />);
      expect(container.querySelector('.session-usage-panel__context')?.textContent).toContain('No context breakdown recorded');
      expect(container.querySelector('.session-usage-panel__donut')).toBeNull();
      if (cacheCoverage === 'partial') {
        const cachedSegment = container.querySelector<HTMLElement>('.session-usage-panel__bar-segment[data-usage-category="cachedInput"]');
        expect(container.querySelectorAll('.session-usage-panel__bar-segment')).toHaveLength(3);
        expect(Number(cachedSegment?.style.flexGrow)).toBeCloseTo(0.75);
        const cacheLegend = container.querySelector('.session-usage-panel__cache-legend');
        expect(cacheLegend?.textContent).toContain('Recorded cache hits75%');
        expect(cacheLegend?.textContent).toContain('Remaining input25%');
        expect(cacheLegend?.textContent).not.toContain('Input (uncached)');
      } else {
        expect(container.querySelectorAll('.session-usage-panel__bar-segment')).toHaveLength(2);
        expect(container.querySelector<HTMLElement>('.session-usage-panel__bar-segment[data-usage-category="input"]')?.style.flexGrow).toBe('1');
        expect(container.querySelector('.session-usage-panel__bar-segment[data-usage-parent="input"]')).toBeNull();
      }
      expect(container.querySelector('.session-usage-panel__tokens')?.textContent).not.toContain('Cache hit rate');
      const cacheSummary = container.querySelector<HTMLElement>('[data-usage-cache-summary]')!;
      expect(cacheSummary.textContent).toBe(cacheCoverage === 'partial' ? '(cache hit ≥75%)' : '(cache unavailable)');
      if (cacheCoverage === 'partial') {
        expect(cacheSummary.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain('lower bound over all input tokens');
      }
      expect(cacheSummary.querySelector('.session-usage-panel__swatch, [tabindex]')).toBeNull();
      act(() => cacheSummary.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
      expect(container.querySelector('.session-usage-panel__token-legend [data-usage-category="input"]')?.hasAttribute('data-usage-active')).toBe(true);
      act(() => cacheSummary.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body })));
      expect(container.querySelector('[data-usage-muted]')).toBeNull();
    }
  });

  it.each([
    { input: 80, cached: 0, rate: '≥0%' },
    { input: 80, cached: 80, rate: '100%' },
    { input: 99, cached: 60, rate: '≥60%' },
    { input: 100, cached: 58, rate: '≥58%' },
    { input: 1000, cached: 999, rate: '≥99%' },
    { input: 0, cached: 0, rate: undefined },
    { input: 80, cached: 81, rate: undefined },
    { input: 80, cached: undefined, rate: undefined },
  ])('keeps partial cache bounds conservative without inventing missing counts: $input/$cached', ({ input, cached, rate }) => {
    render(<SessionUsagePanel report={usageReport({
      tokens: { source: 'token_usage_records', inputTokens: input, outputTokens: 20, totalTokens: input + 20,
        cachedTokens: cached, cacheCoverage: 'partial', cacheHitRate: 0.95 },
    })} />);
    const summary = container.querySelector('[data-usage-cache-summary]')?.textContent;
    expect(summary).toBe(rate ? `(cache hit ${rate})` : '(cache unavailable)');
    const cacheSegments = container.querySelectorAll<HTMLElement>('.session-usage-panel__bar-segment[data-usage-parent="input"]');
    if (rate) {
      expect(Array.from(cacheSegments).reduce((sum, segment) => sum + Number(segment.style.flexGrow), 0)).toBeCloseTo(1);
    } else {
      expect(cacheSegments).toHaveLength(0);
      expect(container.querySelector('.session-usage-panel__cache-legend')).toBeNull();
    }
  });

  it('links a cache child to its parent and restores the focused input group after hover', () => {
    render(<SessionUsagePanel report={usageReport({
      tokens: { source: 'token_usage_records', inputTokens: 80, outputTokens: 20, totalTokens: 100,
        cachedTokens: 60, cacheCoverage: 'available' },
    })} />);
    const input = container.querySelector<HTMLElement>('.session-usage-panel__token-legend [data-usage-category="input"]')!;
    const cached = container.querySelector('.session-usage-panel__bar-segment[data-usage-category="cachedInput"]')!;
    const uncached = container.querySelector('.session-usage-panel__bar-segment[data-usage-category="uncachedInput"]')!;
    const cacheLegend = container.querySelector<HTMLElement>('.session-usage-panel__cache-legend [data-usage-category="cachedInput"]')!;
    act(() => input.focus());
    expect(cached.hasAttribute('data-usage-active')).toBe(true);
    expect(uncached.hasAttribute('data-usage-active')).toBe(true);
    act(() => cached.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    expect(input.hasAttribute('data-usage-active')).toBe(true);
    expect(cacheLegend.hasAttribute('data-usage-active')).toBe(true);
    expect(uncached.hasAttribute('data-usage-muted')).toBe(true);
    act(() => cached.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: dom.window.document.body })));
    expect(uncached.hasAttribute('data-usage-active')).toBe(true);
    act(() => cacheLegend.focus());
    expect(input.hasAttribute('data-usage-active')).toBe(true);
    expect(uncached.hasAttribute('data-usage-muted')).toBe(true);
    act(() => cacheLegend.blur());
    expect(container.querySelector('[data-usage-muted]')).toBeNull();
  });

  it.each([
    { input: 80, output: 20, cached: 0, segments: ['uncachedInput', 'output'], rate: '0%' },
    { input: 80, output: 20, cached: 80, segments: ['cachedInput', 'output'], rate: '100%' },
    { input: 99, output: 1, cached: 60, segments: ['cachedInput', 'uncachedInput', 'output'], rate: '61%' },
    { input: 1, output: 99, cached: 1, segments: ['cachedInput', 'output'], rate: '100%' },
    { input: 100, output: 0, cached: 60, segments: ['cachedInput', 'uncachedInput'], rate: '60%' },
    { input: 0, output: 100, cached: 0, segments: ['output'], rate: undefined },
    { input: 80, output: 20, cached: 81, segments: ['input', 'output'], rate: undefined },
    { input: 0, output: 0, cached: 0, segments: [], rate: undefined },
  ])('handles zero/full/invalid cache counts without invented segments: $input/$output/$cached', ({ input, output, cached, segments, rate }) => {
    render(<SessionUsagePanel report={usageReport({
      tokens: { source: 'token_usage_records', inputTokens: input, outputTokens: output, totalTokens: input + output,
        cachedTokens: cached, cacheCoverage: 'available' },
    })} />);
    const bars = Array.from(container.querySelectorAll<HTMLElement>('.session-usage-panel__bar-segment'));
    expect(bars.map(bar => bar.getAttribute('data-usage-category'))).toEqual(segments);
    expect(bars.every(bar => Number.isFinite(Number(bar.style.flexGrow)) && Number(bar.style.flexGrow) > 0)).toBe(true);
    for (const group of container.querySelectorAll<HTMLElement>('.session-usage-panel__bar-group')) {
      const childShare = Array.from(group.querySelectorAll<HTMLElement>('.session-usage-panel__bar-segment'))
        .reduce((sum, segment) => sum + Number(segment.style.flexGrow), 0);
      expect(childShare).toBeCloseTo(1);
      const parentShare = Number(group.style.flexGrow);
      expect(parentShare).toBeCloseTo((group.dataset.usageCategory === 'input' ? input : output) / (input + output));
    }
    const summary = container.querySelector('[data-usage-cache-summary]')?.textContent;
    if (rate) expect(summary).toBe(`(cache hit ${rate})`);
    else expect(summary).not.toContain('%');
  });

  it('shows loading and error states inside the panel', () => {
    render(<SessionUsagePanel isLoading />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Generating usage report');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    render(<SessionUsagePanel error="Host offline" />);
    expect(container.textContent).toContain('Host offline');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('preserves saved header appearance and accepts old panel destinations after removing details', () => {
    const legacyPackage: AppearancePackage = {
      schema: 'openbitfun.appearance', schemaVersion: APPEARANCE_SCHEMA_VERSION,
      id: 'test.usage-header', name: 'Usage header', version: '1.0.0', mode: 'dark',
      components: { 'session-usage-panel': { parts: {
        header: { base: { opacity: { kind: 'number', value: 0.6 } } },
      } } },
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
    for (const initialTab of ['models', 'files'] as const) {
      render(<SessionUsagePanel report={report} initialTab={initialTab} />);
      expect(container.querySelector('[role="tablist"]')).toBeNull();
      expect(container.querySelector('[role="tabpanel"]')).toBeNull();
      expect(document.querySelector(rule!.selectorText)).toBe(container.querySelector('.session-usage-panel__header'));
      expect(container.querySelector('.session-usage-panel__tokens')).not.toBeNull();
    }

    const retiredPackage: AppearancePackage = {
      ...legacyPackage,
      components: { 'session-usage-panel': { parts: {
        tab: { base: { opacity: { kind: 'number', value: 0.6 } } },
      } } },
    };
    const serializedRetired = JSON.stringify(retiredPackage);
    const validation = appearancePackageValidator.validate(retiredPackage, registry);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_PART', path: 'components.session-usage-panel.parts.tab' }),
    ]));
    expect(JSON.stringify(retiredPackage)).toBe(serializedRetired);
  });

  it('explains inferred legacy model labels on the card', () => {
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

  it('shows a report label above the left-aligned session title and omits the metadata section', () => {
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
        sessionTitle="Usage report layout"
        workspacePath="D:/workspace/openbitfun"
      />
    );

    const title = container.querySelector('.session-usage-panel__header h2');
    expect(title?.textContent).toBe('Usage report layout');
    expect(container.querySelector('.session-usage-panel__eyebrow')?.textContent).toBe('Context Usage Report');
    expect(container.querySelector('.session-usage-panel__header')?.getAttribute('data-align')).toBe('start');
    expect(container.querySelectorAll('time')).toHaveLength(0);
    expect(container.querySelector('.session-usage-panel__metadata')).toBeNull();
    expect(container.querySelector('.session-usage-panel__meta-row')).toBeNull();
    expect(container.querySelector('[data-openbitfun-product-part="metaRow"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy session ID"]')).toBeNull();
    expect(container.querySelector('.session-usage-panel__definition-list')).toBeNull();
    const cacheCoverageHelp = Array.from(container.querySelectorAll('.session-usage-panel__legend-share [data-tooltip]'))
      .find(node => node.getAttribute('data-tooltip')?.includes('Total token counts are still shown'));
    expect(cacheCoverageHelp?.textContent).toContain('unavailable');
  });

  it('summarizes the latest context separately from cumulative provider usage for a remote workspace', () => {
    render(<SessionUsagePanel report={usageReport({
      workspace: { kind: 'remote_ssh', pathLabel: '/home/dev/OpenBitFun' },
      context: {
        systemPrompt: 1_000, toolDefinitions: 1_000, rules: 1_000, skills: 100,
        mcpTools: 100, subagentDefinitions: 100, summarizedConversation: 30_000,
        conversation: 100_000, contextWindow: 256_000,
      },
    })} />);

    const facts = container.querySelector('.session-usage-panel__summary-facts')!;
    expect(Array.from(facts.querySelectorAll('dt')).map(node => node.textContent))
      .toEqual(['Project', 'Total usage', 'Context']);
    expect(Array.from(facts.querySelectorAll('dd')).map(node => node.textContent))
      .toEqual(['OpenBitFun', '1.5K', '~133.3K / 256K']);
  });

  it('keeps legacy context values unavailable and distinguishes a recorded empty context', () => {
    render(<SessionUsagePanel report={usageReport()} />);
    const factValues = () => Array.from(container.querySelectorAll('.session-usage-panel__summary-facts dd'))
      .map(node => node.textContent);
    expect(factValues()).toEqual(['openbitfun', '1.5K', 'Unavailable']);

    const emptyContext = {
      systemPrompt: 0, toolDefinitions: 0, rules: 0, skills: 0,
      mcpTools: 0, subagentDefinitions: 0, summarizedConversation: 0, conversation: 0,
    };
    render(<SessionUsagePanel report={usageReport({ context: emptyContext })} />);
    expect(factValues()).toEqual(['openbitfun', '1.5K', '~0 / Unavailable']);

    render(<SessionUsagePanel report={usageReport({
      context: { ...emptyContext, conversation: Number.NaN, contextWindow: 256_000 },
    })} />);
    expect(factValues()).toEqual(['openbitfun', '1.5K', 'Unavailable / 256K']);

    for (const context of [
      { ...emptyContext, conversation: -1, contextWindow: 0 },
      { ...emptyContext, conversation: Number.NaN, contextWindow: -1 },
      { ...emptyContext, conversation: Number.MAX_SAFE_INTEGER, systemPrompt: 1, contextWindow: Infinity },
    ]) {
      render(<SessionUsagePanel report={usageReport({ context })} />);
      expect(factValues()).toEqual(['openbitfun', '1.5K', 'Unavailable']);
    }

    render(<SessionUsagePanel report={usageReport({
      context: { ...emptyContext, contextWindow: 256_000 },
      tokens: { source: 'unavailable', cacheCoverage: 'unavailable' },
    })} />);
    expect(factValues()).toEqual(['openbitfun', 'Unavailable', '~0 / 256K']);
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
    expect(styleText).not.toContain('text-overflow: ellipsis;');
    expect(styleText).not.toContain('grid-template-columns: repeat(4, minmax(116px, 1fr));');
    expect(styleText).not.toContain('grid-template-columns: minmax(0, 1fr) auto max-content;');
    expect(styleText).not.toContain('max-width: 72%;');
    expect(styleText).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});
