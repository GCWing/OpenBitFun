import {
  RemoteSessionUsageReport,
  RemoteUsageModelRow,
  RemoteUsageToolRow
} from '../../model/RemoteModels';

/**
 * Projects the session usage report into the sheet's rows.
 *
 * The report is mirrored from the desktop contract and every field of it is
 * optional, so this policy renders exactly the metrics the payload carries and
 * omits the rest: an unmeasured number must not be drawn as zero, and a row the
 * host never sent has nothing to explain. Both spellings of each metric are
 * accepted, because the payload travels between two independently built versions.
 */

export class UsageReportRow {
  readonly labelKey: string;
  readonly value: string;
  /** Set when the value is a catalog word rather than a formatted number. */
  readonly valueKey: string;

  constructor(labelKey: string, value: string, valueKey: string = '') {
    this.labelKey = labelKey;
    this.value = value;
    this.valueKey = valueKey;
  }
}

export class UsageReportSection {
  readonly id: string;
  readonly titleKey: string;
  readonly rows: UsageReportRow[];

  constructor(id: string, titleKey: string, rows: UsageReportRow[]) {
    this.id = id;
    this.titleKey = titleKey;
    this.rows = rows;
  }
}

export class UsageReportPresentation {
  readonly sections: UsageReportSection[];
  /** Coverage below `complete`: the sheet says so instead of implying totals. */
  readonly partial: boolean;
  readonly isEmpty: boolean;

  constructor(sections: UsageReportSection[], partial: boolean) {
    this.sections = sections;
    this.partial = partial;
    this.isEmpty = sections.length === 0;
  }
}

export class UsageReportPresentationPolicy {
  static readonly partialNoteKey: string = 'usage.partialNote';
  static readonly yesKey: string = 'usage.yes';
  static readonly noKey: string = 'usage.no';

  static present(report?: RemoteSessionUsageReport): UsageReportPresentation {
    if (!report) {
      return new UsageReportPresentation([], false);
    }
    const sections: UsageReportSection[] = [];
    const overview = UsageReportPresentationPolicy.overviewRows(report);
    if (overview.length > 0) {
      sections.push(new UsageReportSection('overview', 'usage.sectionOverview', overview));
    }
    const time = UsageReportPresentationPolicy.timeRows(report);
    if (time.length > 0) {
      sections.push(new UsageReportSection('time', 'usage.sectionTime', time));
    }
    const tokens = UsageReportPresentationPolicy.tokenRows(report);
    if (tokens.length > 0) {
      sections.push(new UsageReportSection('tokens', 'usage.sectionTokens', tokens));
    }
    const models = UsageReportPresentationPolicy.modelRows(report);
    if (models.length > 0) {
      sections.push(new UsageReportSection('models', 'usage.sectionModels', models));
    }
    const tools = UsageReportPresentationPolicy.toolRows(report);
    if (tools.length > 0) {
      sections.push(new UsageReportSection('tools', 'usage.sectionTools', tools));
    }
    const files = UsageReportPresentationPolicy.fileRows(report);
    if (files.length > 0) {
      sections.push(new UsageReportSection('files', 'usage.sectionFiles', files));
    }
    const compression = UsageReportPresentationPolicy.compressionRows(report);
    if (compression.length > 0) {
      sections.push(new UsageReportSection('compression', 'usage.sectionCompression', compression));
    }
    const errors = UsageReportPresentationPolicy.errorRows(report);
    if (errors.length > 0) {
      sections.push(new UsageReportSection('errors', 'usage.sectionErrors', errors));
    }
    return new UsageReportPresentation(sections, UsageReportPresentationPolicy.isPartial(report));
  }

  static isPartial(report: RemoteSessionUsageReport): boolean {
    const level = UsageReportPresentationPolicy.text(report.coverage?.level).toLowerCase();
    return level.length > 0 && level !== 'complete';
  }

  private static overviewRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.scopeTurns', UsageReportPresentationPolicy.number(report.scope?.turn_count, report.scope?.turnCount));
    const includesSubagents = report.scope?.includes_subagents ?? report.scope?.includesSubagents;
    if (includesSubagents !== undefined) {
      rows.push(new UsageReportRow(
        'usage.scopeSubagents',
        '',
        includesSubagents ? UsageReportPresentationPolicy.yesKey : UsageReportPresentationPolicy.noKey));
    }
    UsageReportPresentationPolicy.pushText(rows, 'usage.coverageLevel', report.coverage?.level);
    const missing = report.coverage?.missing;
    if (missing && missing.length > 0) {
      rows.push(new UsageReportRow('usage.coverageMissing', missing.join(', ')));
    }
    UsageReportPresentationPolicy.pushText(rows, 'usage.workspace', report.workspace?.path_label ?? report.workspace?.pathLabel);
    return rows;
  }

  private static timeRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushDuration(rows, 'usage.timeSpan', report.time?.wall_time_ms, report.time?.wallTimeMs);
    UsageReportPresentationPolicy.pushDuration(
      rows, 'usage.timeTurns', report.time?.active_turn_ms, report.time?.activeTurnMs);
    UsageReportPresentationPolicy.pushDuration(rows, 'usage.timeModel', report.time?.model_ms, report.time?.modelMs);
    UsageReportPresentationPolicy.pushDuration(rows, 'usage.timeTools', report.time?.tool_ms, report.time?.toolMs);
    return rows;
  }

  private static tokenRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushTokens(
      rows, 'usage.tokensInput', report.tokens?.input_tokens, report.tokens?.inputTokens);
    UsageReportPresentationPolicy.pushTokens(
      rows, 'usage.tokensOutput', report.tokens?.output_tokens, report.tokens?.outputTokens);
    UsageReportPresentationPolicy.pushTokens(
      rows, 'usage.tokensTotal', report.tokens?.total_tokens, report.tokens?.totalTokens);
    UsageReportPresentationPolicy.pushTokens(
      rows, 'usage.tokensCached', report.tokens?.cached_tokens, report.tokens?.cachedTokens);
    return rows;
  }

  private static modelRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const models = report.models;
    if (!models || models.length === 0) {
      return [];
    }
    return models.map((model: RemoteUsageModelRow): UsageReportRow => {
      const name = UsageReportPresentationPolicy.text(model.model_id ?? model.modelId);
      const calls = UsageReportPresentationPolicy.number(model.call_count, model.callCount);
      const tokens = UsageReportPresentationPolicy.number(model.total_tokens, model.totalTokens);
      const parts: string[] = [];
      if (calls !== undefined) {
        parts.push(`${calls}`);
      }
      if (tokens !== undefined) {
        parts.push(UsageReportPresentationPolicy.tokenText(tokens));
      }
      return new UsageReportRow('usage.modelRow', `${name} · ${parts.join(' · ')}`);
    });
  }

  private static toolRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const tools = report.tools;
    if (!tools || tools.length === 0) {
      return [];
    }
    return tools.map((tool: RemoteUsageToolRow): UsageReportRow => {
      const name = UsageReportPresentationPolicy.text(tool.tool_name ?? tool.toolName);
      const calls = UsageReportPresentationPolicy.number(tool.call_count, tool.callCount);
      const errors = UsageReportPresentationPolicy.number(tool.error_count, tool.errorCount);
      const parts: string[] = [];
      if (calls !== undefined) {
        parts.push(`${calls}`);
      }
      if (errors !== undefined) {
        parts.push(`${errors}`);
      }
      return new UsageReportRow('usage.toolRow', `${name} · ${parts.join(' · ')}`);
    });
  }

  private static fileRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.filesChanged', UsageReportPresentationPolicy.number(report.files?.changed_files, report.files?.changedFiles));
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.filesAdded', UsageReportPresentationPolicy.number(report.files?.added_lines, report.files?.addedLines));
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.filesDeleted', UsageReportPresentationPolicy.number(report.files?.deleted_lines, report.files?.deletedLines));
    return rows;
  }

  private static compressionRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.compactionCount',
      UsageReportPresentationPolicy.number(report.compression?.compaction_count, report.compression?.compactionCount));
    UsageReportPresentationPolicy.pushTokens(
      rows, 'usage.compactionSaved', report.compression?.saved_tokens, report.compression?.savedTokens);
    return rows;
  }

  private static errorRows(report: RemoteSessionUsageReport): UsageReportRow[] {
    const rows: UsageReportRow[] = [];
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.errorsTotal', UsageReportPresentationPolicy.number(report.errors?.total_errors, report.errors?.totalErrors));
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.errorsTools', UsageReportPresentationPolicy.number(report.errors?.tool_errors, report.errors?.toolErrors));
    UsageReportPresentationPolicy.pushNumber(
      rows, 'usage.errorsModels', UsageReportPresentationPolicy.number(report.errors?.model_errors, report.errors?.modelErrors));
    return rows;
  }

  private static pushText(rows: UsageReportRow[], labelKey: string, value?: string): void {
    const text = UsageReportPresentationPolicy.text(value);
    if (text.length > 0) {
      rows.push(new UsageReportRow(labelKey, text));
    }
  }

  private static pushNumber(rows: UsageReportRow[], labelKey: string, value?: number): void {
    if (value === undefined) {
      return;
    }
    rows.push(new UsageReportRow(labelKey, `${value}`));
  }

  private static pushTokens(rows: UsageReportRow[], labelKey: string, camel?: number, snake?: number): void {
    const value = UsageReportPresentationPolicy.number(camel, snake);
    if (value === undefined) {
      return;
    }
    rows.push(new UsageReportRow(labelKey, UsageReportPresentationPolicy.tokenText(value)));
  }

  private static pushDuration(rows: UsageReportRow[], labelKey: string, camel?: number, snake?: number): void {
    const value = UsageReportPresentationPolicy.number(camel, snake);
    if (value === undefined) {
      return;
    }
    rows.push(new UsageReportRow(labelKey, UsageReportPresentationPolicy.durationText(value)));
  }

  private static number(first?: number, second?: number): number | undefined {
    if (first !== undefined) {
      return first;
    }
    return second;
  }

  private static text(value?: string): string {
    return value === undefined ? '' : value;
  }

  /** Token counts read in the same compact units the desktop report uses. */
  static tokenText(value: number): string {
    if (value < 1000) {
      return `${value}`;
    }
    if (value < 1000000) {
      return `${UsageReportPresentationPolicy.rounded(value / 1000)}K`;
    }
    if (value < 1000000000) {
      return `${UsageReportPresentationPolicy.rounded(value / 1000000)}M`;
    }
    return `${UsageReportPresentationPolicy.rounded(value / 1000000000)}B`;
  }

  static durationText(value: number): string {
    if (value < 1000) {
      return `${value}ms`;
    }
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    if (minutes < 60) {
      return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
  }

  private static rounded(value: number): string {
    const scaled = Math.round(value * 100) / 100;
    const whole = Math.floor(scaled);
    const fraction = Math.round((scaled - whole) * 100);
    if (fraction === 0) {
      return `${whole}`;
    }
    if (fraction % 10 === 0) {
      return `${whole}.${fraction / 10}`;
    }
    return `${whole}.${fraction < 10 ? '0' : ''}${fraction}`;
  }
}
