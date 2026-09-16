import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import {
  ConversationUiPlanTool,
  ConversationUiQuestionAnswer,
  ConversationUiToolStatus
} from '../state/ConversationUiModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ToolFileReference, ToolFileReferenceResolver } from '../policy/ToolFileReferenceResolver';
import { ActivityGroupPolicy, ActivityRowPlan, ActivityThinkingPart } from '../policy/ActivityGroupPolicy';
import { ToolCollapseGroup, ToolCollapsePolicy } from '../policy/ToolCollapsePolicy';
import { ToolStatusPresentationPolicy } from '../policy/ToolStatusPresentationPolicy';
import { PlanToolPolicy } from '../policy/PlanToolPolicy';
import {
  CARD,
  FILE_LINK,
  INK,
  LINE,
  MUTED,
  SHADOW_SUBTLE,
  SOFT,
  STATUS_DANGER,
  STATUS_SUCCESS,
  TRANSPARENT,
} from './Theme';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGlyph } from './ToolGlyphs';
import { ToolConfirmationPanel, ToolQuestionAnswerPanel } from './ToolInteractionPanels';

interface TodoPreviewItem {
  content?: string;
}

interface ToolInputSummaryPayload {
  todos?: TodoPreviewItem[];
  content?: string;
  command?: string;
  cmd?: string;
  pattern?: string;
  regex?: string;
  query?: string;
  search_term?: string;
  needle?: string;
  path?: string;
  file_path?: string;
  filePath?: string;
  url?: string;
  prompt?: string;
  question?: string;
  description?: string;
  title?: string;
  task?: string;
}

interface ToolRenderEntry {
  type: string;
  key: string;
  tool?: ConversationUiToolStatus;
  thinking?: ActivityThinkingPart;
  tools: ConversationUiToolStatus[];
  readCount: number;
  searchCount: number;
  commandCount: number;
  otherCount: number;
}

@ComponentV2
export struct ToolStatusList {
  @Param interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  @Param tools: ConversationUiToolStatus[] = [];
  /** Reasoning that ran between these tools; folded away with them. */
  @Param thinkingParts: ActivityThinkingPart[] = [];
  /** Explicit invalidation signal for replacement snapshots from the relay. */
  @Param renderRevision: number = 0;
  @Param isBusy: boolean = false;
  @Event onApproveTool: (toolId: string, updatedInput?: Object) => void =
    (_toolId: string, _updatedInput?: Object) => {};
  @Event onRejectTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onCancelTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => void =
    (_toolId: string, _answers: ConversationUiQuestionAnswer) => {};
  @Event onOpenFilePreview: (path: string, label: string) => void =
    (_path: string, _label: string) => {};
  @Event onBuildPlan: (path: string, name: string) => void = (_path: string, _name: string) => {};
  @Local expanded: boolean = false;
  @Local expandedToolKey: string = '';
  @Local editingApprovalKey: string = '';

  build() {
    Column({ space: 4 }) {
      ForEach(this.toolRenderEntries(this.renderRevision), (entry: ToolRenderEntry, index: number) => {
        if (entry.type === 'summary') {
          this.CollapsedToolSummary(entry)
        } else if (entry.thinking) {
          this.ThinkingRow(entry.thinking)
        } else if (entry.tool) {
          if (PlanToolPolicy.isPlanTool(entry.tool)) {
            this.PlanCard(entry.tool)
          } else {
            this.ToolRow(entry.tool, index)
          }
        }
      }, (entry: ToolRenderEntry) => entry.key)
    }
    .width('100%')
  }

  @Builder
  PlanCard(tool: ConversationUiToolStatus) {
    Column({ space: 12 }) {
      Row({ space: 10 }) {
        Stack({ alignContent: Alignment.Center }) {
          ToolGlyph({ kind: 'document', color: INK })
        }
        .width(32)
        .height(32)
        .backgroundColor(SOFT)
        .borderRadius(9)
        Column({ space: 2 }) {
          Text(this.planDescriptor(tool).name)
            .fontSize(MobileDesignTypography.bodyMedium.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.planSubtitle(tool))
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(MUTED)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      Row({ space: 8 }) {
        Text(RemoteI18n.t('chat.planView'))
          .fontSize(MobileDesignTypography.labelMedium.size)
          .fontColor(this.planDescriptor(tool).file_path.length > 0 ? INK : MUTED)
          .textAlign(TextAlign.Center)
          .height(36)
          .layoutWeight(1)
          .padding({ left: 12, right: 12 })
          .backgroundColor(SOFT)
          .borderRadius(18)
          .border({ width: 1, color: LINE })
          .enabled(this.planDescriptor(tool).file_path.length > 0)
          .onClick(() => {
            const plan = this.planDescriptor(tool);
            if (plan.file_path.length > 0) {
              this.onOpenFilePreview(plan.file_path, plan.name);
            }
          })
        Text(RemoteI18n.t('chat.planBuild'))
          .fontSize(MobileDesignTypography.labelMedium.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.canStartPlanBuild(tool) ? CARD : MUTED)
          .textAlign(TextAlign.Center)
          .height(36)
          .layoutWeight(1)
          .padding({ left: 12, right: 12 })
          .backgroundColor(this.canStartPlanBuild(tool) ? INK : SOFT)
          .borderRadius(18)
          .border({ width: 1, color: this.canStartPlanBuild(tool) ? INK : LINE })
          .enabled(this.canStartPlanBuild(tool))
          .onClick(() => {
            const plan = this.planDescriptor(tool);
            if (this.canStartPlanBuild(tool)) {
              this.onBuildPlan(plan.file_path, plan.name);
            }
          })
      }
      .width('100%')
    }
    .width('100%')
    .padding(14)
    .backgroundColor(CARD)
    .borderRadius(18)
    .border({ width: 1, color: LINE })
    .shadow({ radius: 12, color: SHADOW_SUBTLE, offsetY: 4 })
  }

  @Builder
  CollapsedToolSummary(entry: ToolRenderEntry) {
    Row({ space: 8 }) {
      this.SummaryTypeBadge(entry)
      Text(this.collapsedSummaryTitle(entry))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      this.ChevronIcon(this.expanded ? 'up' : 'down')
    }
    .width('100%')
    .height(28)
    .alignItems(VerticalAlign.Center)
    .padding({ left: 0, right: 0 })
    .onClick(() => {
      this.expanded = !this.expanded;
    })
  }

  @Builder
  ThinkingRow(part: ActivityThinkingPart) {
    ThinkingBlock({
      text: part.text,
      status: part.status,
      keepExpandedWhenDone: false,
      streaming: part.streaming,
      streamKey: part.streamKey
    })
  }

  @Builder
  ToolRow(tool: ConversationUiToolStatus, index: number) {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        this.ToolStatusIcon(tool)
        Text(this.toolLineLabel(tool))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(this.hasToolError(tool) ? STATUS_DANGER :
            (this.toolFilePath(tool).length > 0 ? FILE_LINK : MUTED))
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .onClick(() => {
            if (this.toolFilePath(tool).length > 0) {
              this.openToolFile(tool);
            } else {
              this.toggleToolExpanded(tool, index);
            }
          })
        this.TrailingChevron(tool, index)
      }
      .width('100%')
      .height(28)
      .alignItems(VerticalAlign.Center)

      if (this.canExpandTool(tool) && this.expandedToolKey === this.toolKey(tool, index)) {
        if (this.toolInputPreview(tool).length > 0) {
          this.ToolDetail(this.operationLabel(tool), this.toolInputPreview(tool), false)
        }
        if (this.toolResultPreview(tool).length > 0) {
          this.ToolDetail(this.hasToolError(tool) ? RemoteI18n.t('chat.error') : RemoteI18n.t('chat.output'), this.toolResultPreview(tool), this.hasToolError(tool))
        }
      }

      if (this.isPendingConfirmation(tool) && !this.interactionMailbox.ownsToolInteraction(tool.id || '')) {
        if (this.hasEditableToolInput(tool)) {
          Row() {
            Blank()
            Button(RemoteI18n.t(this.editingApprovalKey === this.toolKey(tool, index) ? 'chat.hideApprovalInput' : 'chat.editApprovalInput'))
              .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
              .backgroundColor(SOFT).height(32).padding({ left: 8, right: 8 })
              .enabled(!this.isBusy)
              .onClick(() => { this.editingApprovalKey = this.editingApprovalKey === this.toolKey(tool, index) ? '' : this.toolKey(tool, index); })
          }.width('100%')
        }
        ToolConfirmationPanel({
          toolId: tool.permission_request_id ? `permission:${tool.permission_request_id}` : tool.id || '',
          defaultInputText: this.defaultToolInputText(tool),
          hasEditableInput: this.hasEditableToolInput(tool) && this.editingApprovalKey === this.toolKey(tool, index),
          isBusy: this.isBusy,
          onApproveTool: this.onApproveTool,
          onRejectTool: this.onRejectTool
        })
      }
      if (this.isQuestionTool(tool) && !this.interactionMailbox.ownsToolInteraction(tool.id || '')) {
        ToolQuestionAnswerPanel({
          toolId: tool.id || '',
          questionsJson: this.questionInputJson(tool),
          isBusy: this.isBusy,
          onAnswerQuestion: this.onAnswerQuestion
        })
      }
      if ((this.isRunningTool(tool) || this.isQuestionTool(tool)) &&
        !(this.isQuestionTool(tool) && this.interactionMailbox.ownsToolInteraction(tool.id || ''))) {
        Row() {
          Blank()
          Text(RemoteI18n.t('chat.cancelTool'))
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontColor(INK)
            .textAlign(TextAlign.Center)
            .height(32)
            .padding({ left: 14, right: 14 })
            .backgroundColor(SOFT)
            .borderRadius(16)
            .border({ width: 1, color: LINE })
            .onClick(() => {
              this.onCancelTool(tool.id || '');
            })
        }
        .width('100%')
        .padding({ left: 30 })
      }
    }
    .width('100%')
    .padding({
      left: this.toolRowHorizontalPadding(tool, index),
      right: this.toolRowHorizontalPadding(tool, index),
      top: this.toolRowVerticalPadding(tool, index),
      bottom: this.toolRowVerticalPadding(tool, index)
    })
    .backgroundColor(this.toolRowBg(tool, index))
    .borderRadius(this.toolRowRadius(tool, index))
    .border({ width: this.toolRowBorderWidth(tool, index), color: LINE })
  }

  @Builder
  ToolStatusIcon(tool: ConversationUiToolStatus) {
    Stack({ alignContent: Alignment.BottomEnd }) {
      this.ToolTypeBadge(tool)
      if (this.shouldShowStatusBadge(tool)) {
        this.ToolStatusBadge(tool)
      }
    }
    .width(20)
    .height(20)
  }

  @Builder
  TrailingChevron(tool: ConversationUiToolStatus, index: number) {
    if (this.canExpandTool(tool)) {
      Stack({ alignContent: Alignment.Center }) {
        this.ChevronIcon(this.expandedToolKey === this.toolKey(tool, index) ? 'down' : 'right')
      }
      .width(32)
      .height(28)
      .onClick(() => {
        this.toggleToolExpanded(tool, index);
      })
    } else {
      Text('')
        .width(14)
        .height(14)
    }
  }

  @Builder
  SummaryTypeBadge(entry: ToolRenderEntry) {
    Stack({ alignContent: Alignment.Center }) {
      this.SummaryTypeSymbol(entry)
    }
    .width(18)
    .height(18)
    .backgroundColor(this.summaryTypeBg(entry))
    .borderRadius(5)
    .border({ width: 1, color: TRANSPARENT })
  }

  @Builder
  ToolTypeBadge(tool: ConversationUiToolStatus) {
    Stack({ alignContent: Alignment.Center }) {
      this.ToolTypeSymbol(tool)
    }
    .width(18)
    .height(18)
    .backgroundColor(this.toolTypeBg(tool))
    .borderRadius(5)
    .border({ width: 1, color: this.toolTypeBorderColor(tool) })
  }

  @Builder
  SummaryTypeSymbol(entry: ToolRenderEntry) {
    ToolGlyph({ kind: this.summaryGlyphKind(entry), color: this.summaryTypeColor(entry) })
  }

  @Builder
  ToolTypeSymbol(tool: ConversationUiToolStatus) {
    ToolGlyph({ kind: this.toolGlyphKind(tool), color: this.toolTypeColor(tool) })
  }

  @Builder
  ToolStatusBadge(tool: ConversationUiToolStatus) {
    Text(this.toolStatusIcon(tool))
      .width(10)
      .height(10)
      .fontSize(MobileDesignTypography.labelSmall.size)
      .fontWeight(FontWeight.Bold)
      .fontColor(CARD)
      .textAlign(TextAlign.Center)
      .backgroundColor(this.toolStatusColor(tool))
      .borderRadius(5)
      .border({ width: 1, color: CARD })
  }

  @Builder
  ChevronIcon(direction: string) {
    ToolGlyph({ kind: `chevron_${direction}`, color: MUTED })
  }

  @Builder
  ToolDetail(label: string, value: string, isError: boolean) {
    Column({ space: 4 }) {
      Text(label)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(MUTED)
      Text(value)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .fontColor(isError ? STATUS_DANGER : MUTED)
        .width('100%')
        .maxLines(5)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%')
    .padding({ left: 30, top: 2 })
  }

  private displayStatus(status: string): string {
    const normalized = (status || '').toLowerCase();
    if (normalized === 'running' || normalized === 'active') {
      return RemoteI18n.t('common.running');
    }
    if (normalized === 'pending_confirmation' || normalized === 'needs_confirmation') {
      return RemoteI18n.t('chat.pendingConfirmation');
    }
    if (normalized === 'completed' || normalized === 'done' || normalized === 'sent') {
      return RemoteI18n.t('common.done');
    }
    if (normalized === 'failed' || normalized === 'error') {
      return RemoteI18n.t('common.failed');
    }
    if (normalized === 'cancelled' || normalized === 'canceled') {
      return RemoteI18n.t('chat.cancelled');
    }
    return status || RemoteI18n.t('common.waiting');
  }

  private isEmphasizedToolRow(tool: ConversationUiToolStatus, index: number): boolean {
    return this.expandedToolKey === this.toolKey(tool, index) ||
      this.hasToolError(tool) ||
      this.isPendingConfirmation(tool) ||
      this.isQuestionTool(tool) ||
      this.isRunningTool(tool);
  }

  private toolRowBg(tool: ConversationUiToolStatus, index: number): ResourceColor {
    if (this.isEmphasizedToolRow(tool, index)) {
      return SOFT;
    }
    return TRANSPARENT;
  }

  private toolRowBorderWidth(tool: ConversationUiToolStatus, index: number): number {
    return this.isEmphasizedToolRow(tool, index) ? 1 : 0;
  }

  private toolRowRadius(tool: ConversationUiToolStatus, index: number): number {
    return this.isEmphasizedToolRow(tool, index) ? 14 : 8;
  }

  private toolRowVerticalPadding(tool: ConversationUiToolStatus, index: number): number {
    return this.isEmphasizedToolRow(tool, index) ? 6 : 0;
  }

  private toolRowHorizontalPadding(tool: ConversationUiToolStatus, index: number): number {
    return this.isEmphasizedToolRow(tool, index) ? 10 : 0;
  }

  private toolRenderEntries(_renderRevision: number): ToolRenderEntry[] {
    const groups = this.expanded ?
      ToolCollapsePolicy.expandedGroups(this.tools) :
      ToolCollapsePolicy.collapsedGroups(this.tools);
    const parts = ActivityGroupPolicy.mergeThinkingParts(this.thinkingParts);
    // Without a summary row there is nothing to expand, so the reasoning has to
    // stay on screen or it would be lost.
    const showThinking = this.expanded || !ActivityGroupPolicy.hasSummaryRow(groups);
    const entries: ToolRenderEntry[] = [];
    ActivityGroupPolicy.weaveRows(groups, parts, showThinking).forEach((row: ActivityRowPlan) => {
      if (row.kind === 'thinking') {
        entries.push(this.thinkingEntry(parts[row.index], row.index));
        return;
      }
      entries.push(this.entryFromGroup(groups[row.index]));
    });
    return entries;
  }

  private thinkingEntry(part: ActivityThinkingPart, index: number): ToolRenderEntry {
    return {
      type: 'thinking',
      key: `thinking-${index}-${part.beforeToolIndex}-${part.streamKey}`,
      thinking: part,
      tools: [],
      readCount: 0,
      searchCount: 0,
      commandCount: 0,
      otherCount: 0
    };
  }

  private entryFromGroup(group: ToolCollapseGroup): ToolRenderEntry {
    if (group.type === 'summary') {
      const stats = this.collapsedToolStats(group.tools);
      return {
        type: 'summary',
        key: `summary-${group.startIndex}-${group.tools.length}-${stats.readCount}-${stats.searchCount}-${stats.commandCount}-${stats.otherCount}`,
        tools: group.tools,
        readCount: stats.readCount,
        searchCount: stats.searchCount,
        commandCount: stats.commandCount,
        otherCount: stats.otherCount
      };
    }
    const tool = group.tools[0];
    return this.toolEntry(tool, group.startIndex);
  }

  private toolEntry(tool: ConversationUiToolStatus, index: number): ToolRenderEntry {
    return {
      type: 'tool',
      key: this.toolKey(tool, index),
      tool,
      tools: [],
      readCount: 0,
      searchCount: 0,
      commandCount: 0,
      otherCount: 0
    };
  }

  private collapsedToolStats(tools: ConversationUiToolStatus[]): ToolRenderEntry {
    let readCount = 0;
    let searchCount = 0;
    let commandCount = 0;
    let otherCount = 0;
    tools.forEach((tool: ConversationUiToolStatus) => {
      const kind = this.exploreToolKind(tool);
      if (kind === 'read') {
        readCount += 1;
      } else if (kind === 'search') {
        searchCount += 1;
      } else if (this.isCommandTool(tool)) {
        commandCount += 1;
      } else {
        otherCount += 1;
      }
    });
    return {
      type: 'summary',
      key: '',
      tools,
      readCount,
      searchCount,
      commandCount,
      otherCount
    };
  }

  private exploreToolKind(tool: ConversationUiToolStatus): string {
    const raw = tool.name || '';
    const normalized = this.normalizedToolName(tool);
    if (raw === 'Read' || normalized === 'read' || normalized === 'read_file' ||
      raw === 'LS' || normalized === 'ls' || normalized === 'list_directory') {
      return 'read';
    }
    if (raw === 'Grep' || raw === 'Glob' || raw === 'WebSearch' ||
      normalized === 'grep' || normalized === 'glob' || normalized === 'websearch' ||
      normalized === 'web_search' || normalized === 'semanticsearch' || normalized === 'semantic_search') {
      return 'search';
    }
    return '';
  }

  private collapsedSummaryTitle(entry: ToolRenderEntry): string {
    return RemoteI18n.f('chat.toolsRan', `${entry.tools.length}`);
  }

  private normalizedToolName(tool: ConversationUiToolStatus): string {
    return ToolStatusPresentationPolicy.normalizedName(tool);
  }

  private summaryGlyphKind(entry: ToolRenderEntry): string {
    if (entry.searchCount > 0 && entry.readCount === 0) return 'search';
    if (entry.readCount > 0 && entry.searchCount === 0) return 'document';
    return 'stack';
  }

  private toolGlyphKind(tool: ConversationUiToolStatus): string {
    if (this.isQuestionLikeTool(tool)) return 'question';
    if (this.isTodoTool(tool)) return 'todo';
    if (this.isTaskTool(tool)) return 'task';
    if (this.isGitTool(tool)) return 'git';
    if (this.isDeleteTool(tool)) return 'delete';
    if (this.isDiffTool(tool)) return 'diff';
    if (this.isPatchTool(tool)) return 'patch';
    if (this.isFileCreateTool(tool)) return 'create';
    if (this.isFileMutationTool(tool)) return 'mutate';
    if (this.isFileReadTool(tool)) return this.isDirectoryListTool(tool) ? 'folder' : 'document';
    if (this.isSearchTool(tool)) return 'search';
    if (this.isWebTool(tool)) return 'web';
    if (this.isCommandTool(tool)) return 'command';
    return 'tool';
  }

  private isQuestionLikeTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isQuestionLike(tool);
  }

  private isTodoTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isTodo(tool);
  }

  private isTaskTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isTask(tool);
  }

  private isDirectoryListTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isDirectoryList(tool);
  }

  private isFileReadTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isFileRead(tool);
  }

  private isFileMutationTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isFileMutation(tool);
  }

  private isCommandTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isCommand(tool);
  }

  private isGitTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isGit(tool);
  }

  private isWebTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isWeb(tool);
  }

  private isDiffTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isDiff(tool);
  }

  private isDeleteTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isDelete(tool);
  }

  private isFileCreateTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isFileCreate(tool);
  }

  private isPatchTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isPatch(tool);
  }

  private isSearchTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isSearch(tool);
  }

  private operationLabel(tool: ConversationUiToolStatus): string {
    const raw = tool.name || 'Tool';
    const normalized = this.normalizedToolName(tool);
    if (raw === 'TodoWrite' || normalized === 'todo_write' || normalized === 'todowrite') {
      return RemoteI18n.t('chat.toolOpTodoWrite');
    }
    if (raw === 'Task' || normalized === 'task') {
      return RemoteI18n.t('chat.toolOpTask');
    }
    if (this.isFileReadTool(tool)) {
      return RemoteI18n.t('chat.toolOpRead');
    }
    if (raw === 'Write' || raw === 'Create' || normalized === 'write' || normalized === 'write_file' ||
      normalized === 'create_file') {
      return RemoteI18n.t('chat.toolOpWrite');
    }
    if (raw === 'Delete' || normalized === 'delete' || normalized === 'delete_file') {
      return RemoteI18n.t('chat.toolOpDelete');
    }
    if (raw === 'GetFileDiff' || normalized === 'get_file_diff' || normalized === 'getfilediff') {
      return RemoteI18n.t('chat.toolOpDiff');
    }
    if (this.isFileMutationTool(tool)) {
      return RemoteI18n.t('chat.toolOpEdit');
    }
    if (this.isCommandTool(tool)) {
      return RemoteI18n.t('chat.toolOpCommand');
    }
    if (raw === 'WebSearch' || normalized === 'websearch' || normalized === 'web_search') {
      return RemoteI18n.t('chat.toolOpWebSearch');
    }
    if (this.isWebTool(tool)) {
      return RemoteI18n.t('chat.toolOpWebFetch');
    }
    if (this.isSearchTool(tool)) {
      return RemoteI18n.t('chat.toolOpSearch');
    }
    if (raw === 'AskUserQuestion') {
      return RemoteI18n.t('chat.toolOpAskUser');
    }
    return raw;
  }

  private summaryLabel(tool: ConversationUiToolStatus): string {
    const parsed = this.toolInputPayload(tool);
    const fromPayload = this.summaryFromPayload(tool, parsed);
    if (fromPayload.length > 0) {
      return this.compactText(fromPayload, 46);
    }

    const preview = this.toolInputPreview(tool);
    if (preview.length > 0 && !this.looksLikeJson(preview)) {
      return this.compactText(preview, 46);
    }
    return tool.name || 'Tool';
  }

  private toolInputPayload(tool: ConversationUiToolStatus): ToolInputSummaryPayload {
    if (tool.tool_input) {
      try {
        return JSON.parse(JSON.stringify(tool.tool_input)) as ToolInputSummaryPayload;
      } catch (_err) {
      }
    }
    const preview = tool.input_preview || '';
    if (preview.trim().length > 0) {
      try {
        return JSON.parse(preview) as ToolInputSummaryPayload;
      } catch (_err) {
      }
    }
    return {};
  }

  private summaryFromPayload(tool: ConversationUiToolStatus, payload: ToolInputSummaryPayload): string {
    const name = tool.name || '';
    if ((name === 'TodoWrite' || this.normalizedToolName(tool) === 'todowrite') &&
      payload.todos && payload.todos.length > 0) {
      return payload.todos[0].content || RemoteI18n.t('chat.toolTodoFallback');
    }

    if (name === 'Task') {
      return ToolStatusPresentationPolicy.taskTitle(tool) || RemoteI18n.t('chat.toolTaskFallback');
    }

    const path = payload.file_path || payload.filePath || payload.path || '';
    if (path.length > 0) {
      return this.lastPathSegment(path);
    }

    return payload.description ||
      payload.command ||
      payload.cmd ||
      payload.pattern ||
      payload.regex ||
      payload.query ||
      payload.search_term ||
      payload.needle ||
      payload.title ||
      payload.question ||
      payload.prompt ||
      payload.content ||
      payload.url ||
      '';
  }

  private lastPathSegment(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  private looksLikeJson(value: string): boolean {
    const text = value.trim();
    return text.indexOf('{') === 0 || text.indexOf('[') === 0;
  }

  private compactText(value: string, limit: number): string {
    const text = value.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) {
      return text;
    }
    return `${text.slice(0, limit)}...`;
  }

  private toolLineLabel(tool: ConversationUiToolStatus): string {
    if (this.isRunningTool(tool)) {
      return `${RemoteI18n.t('chat.toolRunning')} “${this.compactText(this.operationTarget(tool), 24)}”`;
    }
    if (this.hasToolError(tool)) {
      return `${RemoteI18n.f('chat.toolFailed', this.operationLabel(tool))} · ` +
        `${this.compactText(this.operationTarget(tool), 24)}`;
    }
    if (this.isPendingConfirmation(tool) || this.isQuestionTool(tool)) {
      return `${this.displayStatus(tool.status || 'pending')} · ${this.operationLabel(tool)}`;
    }
    if (this.isCompletedTool(tool) || this.isCancelledTool(tool)) {
      return `${this.operationLabel(tool)} · ${this.compactText(this.operationTarget(tool), 28)}`;
    }
    return `${this.displayStatus(tool.status || 'pending')} · ${this.operationLabel(tool)}`;
  }

  private operationTarget(tool: ConversationUiToolStatus): string {
    const summary = this.summaryLabel(tool);
    if (summary.length > 0 && summary !== tool.name) {
      return summary;
    }
    return this.operationLabel(tool);
  }

  private toolFileReference(tool: ConversationUiToolStatus): ToolFileReference | undefined {
    return ToolFileReferenceResolver.resolve(tool.name || '', tool.tool_input, tool.input_preview || '');
  }

  private toolFilePath(tool: ConversationUiToolStatus): string {
    return this.toolFileReference(tool)?.path || '';
  }

  private openToolFile(tool: ConversationUiToolStatus): void {
    const reference = this.toolFileReference(tool);
    if (reference) {
      this.onOpenFilePreview(reference.path, reference.label);
    }
  }

  private toggleToolExpanded(tool: ConversationUiToolStatus, index: number): void {
    if (!this.canExpandTool(tool)) {
      return;
    }
    const key = this.toolKey(tool, index);
    this.expandedToolKey = this.expandedToolKey === key ? '' : key;
  }

  private canExpandTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.canExpand(tool);
  }

  private toolTypeColor(tool: ConversationUiToolStatus): ResourceColor {
    if (this.isDeleteTool(tool)) {
      return STATUS_DANGER;
    }
    if (this.isTodoTool(tool) || this.isFileCreateTool(tool)) {
      return STATUS_SUCCESS;
    }
    return MUTED;
  }

  private toolTypeBg(_tool: ConversationUiToolStatus): ResourceColor {
    return SOFT;
  }

  private toolTypeBorderColor(tool: ConversationUiToolStatus): ResourceColor {
    if (this.hasToolError(tool)) {
      return STATUS_DANGER;
    }
    return LINE;
  }

  private toolStatusIcon(tool: ConversationUiToolStatus): string {
    if (this.hasToolError(tool)) {
      return '!';
    }
    const normalized = (tool.status || '').toLowerCase();
    if (normalized === 'running' || normalized === 'active') {
      return '•';
    }
    if (normalized === 'pending_confirmation' || normalized === 'needs_confirmation') {
      return '?';
    }
    if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'rejected') {
      return '×';
    }
    return '•';
  }

  private toolStatusColor(tool: ConversationUiToolStatus): ResourceColor {
    if (this.hasToolError(tool)) {
      return STATUS_DANGER;
    }
    return MUTED;
  }

  private shouldShowStatusBadge(tool: ConversationUiToolStatus): boolean {
    return this.hasToolError(tool) ||
      this.isPendingConfirmation(tool) ||
      this.isQuestionTool(tool) ||
      this.isRunningTool(tool) ||
      this.isCancelledTool(tool);
  }

  private summaryTypeColor(_entry: ToolRenderEntry): ResourceColor {
    return MUTED;
  }

  private summaryTypeBg(_entry: ToolRenderEntry): ResourceColor {
    return SOFT;
  }

  private toolInputPreview(tool: ConversationUiToolStatus): string {
    return ToolStatusPresentationPolicy.inputPreview(tool);
  }

  private toolResultPreview(tool: ConversationUiToolStatus): string {
    return ToolStatusPresentationPolicy.resultPreview(tool);
  }

  private hasToolError(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.hasError(tool);
  }

  private isPendingConfirmation(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isPendingConfirmation(tool);
  }

  private hasEditableToolInput(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.hasEditableInput(tool);
  }

  private defaultToolInputText(tool: ConversationUiToolStatus): string {
    return ToolStatusPresentationPolicy.defaultInputText(tool);
  }

  private isRunningTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isRunning(tool);
  }

  private isCompletedTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isCompleted(tool);
  }

  private isCancelledTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isCancelled(tool);
  }

  private isQuestionTool(tool: ConversationUiToolStatus): boolean {
    return ToolStatusPresentationPolicy.isQuestion(tool);
  }

  private questionInputJson(tool: ConversationUiToolStatus): string {
    return ToolStatusPresentationPolicy.questionInputJson(tool);
  }

  private planDescriptor(tool: ConversationUiToolStatus): ConversationUiPlanTool {
    return PlanToolPolicy.descriptor(tool) || { file_path: '', name: 'Plan' };
  }

  private planSubtitle(tool: ConversationUiToolStatus): string {
    const plan = this.planDescriptor(tool);
    if ((plan.overview || '').trim().length > 0) {
      return plan.overview || '';
    }
    if (plan.file_path.length > 0) {
      return this.compactText(plan.file_path, 54);
    }
    return this.displayStatus(tool.status || 'pending');
  }

  private canStartPlanBuild(tool: ConversationUiToolStatus): boolean {
    return !this.isBusy && PlanToolPolicy.canBuild(tool);
  }

  private toolKey(tool: ConversationUiToolStatus, index: number): string {
    return ToolStatusPresentationPolicy.key(tool, index);
  }
}
