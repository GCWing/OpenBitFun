import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { ConversationUiImage, ConversationUiMessage, ConversationUiMessageItem, ConversationUiQuestionAnswer, ConversationUiToolStatus } from '../state/ConversationUiModels';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ActivityGroupPolicy, ActivityThinkingPart } from '../policy/ActivityGroupPolicy';
import { ChatMessageStructurePolicy, StructuredRenderGroup } from '../policy/ChatMessageStructurePolicy';
import { AssistantProcessLayoutPolicy } from '../policy/AssistantProcessLayoutPolicy';
import { ConversationMessageRenderPolicy } from '../policy/ConversationMessageRenderPolicy';
import { ThinkingPresentationPolicy } from '../policy/ThinkingPresentationPolicy';
import { ACCENT, INK, LINE, STATUS_DANGER } from './Theme';
import { MessageBodyMarkdown, MessageFileCards, MessageImageGallery, MessageMarkdown } from './ChatMessageContent';
import { ChatMessageRetryAction, ChatTypingDots, ChatUserMessageBubble } from './ChatMessageChrome';
import { SubagentTaskCard } from './SubagentTaskCard';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolStatusList } from './ToolStatusList';
import { MessageFileReference, MessageFileReferenceProjectionCache } from '../policy/MessageFileReferenceProjector';

class MessageTextBuilderParams {
  text: string = '';
  active: boolean = false;
  streamKey: string = '';
  renderRevision: number = 0;
}

@ReusableV2
@ComponentV2
export struct ChatUserMessageRow {
  @Param item: ConversationUiMessage = {
    id: '',
    role: 'user',
    text: '',
    status: '',
    detail: ''
  };
  @Param showRetryAction: boolean = false;
  @Event onRetryMessage: (text: string) => void = (_text: string) => {};

  build() {
    ChatUserMessageBubble({
      item: this.item,
      showRetryAction: this.showRetryAction,
      onRetryMessage: this.onRetryMessage
    })
  }
}

@ReusableV2
@ComponentV2
export struct ChatMessageBubble {
  @Param interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  @Param item: ConversationUiMessage = {
    id: '',
    role: 'assistant',
    text: '',
    status: '',
    detail: ''
  };
  @Param renderRevision: number = 0;
  @Param isStreaming: boolean = false;
  @Param isFinalizing: boolean = false;
  @Param showRetryAction: boolean = false;
  @Param isBusy: boolean = false;
  @Param downloadingFilePath: string = '';
  @Param downloadedFilePath: string = '';
  @Param fileDownloadStatus: string = '';
  @Param activeFilePreviewPath: string = '';
  @Param activeFilePreviewLoading: boolean = false;
  @Event onApproveTool: (toolId: string, updatedInput?: Object) => void =
    (_toolId: string, _updatedInput?: Object) => {};
  @Event onRejectTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onCancelTool: (toolId: string) => void = (_toolId: string) => {};
  @Event onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => void =
    (_toolId: string, _answers: ConversationUiQuestionAnswer) => {};
  @Event onCopyMessage: (text: string) => void = (_text: string) => {};
  @Event onRetryMessage: (text: string) => void = (_text: string) => {};
  @Event onOpenFilePreview: (path: string, label: string) => void = (_path: string, _label: string) => {};
  @Event onBuildPlan: (path: string, name: string) => void = (_path: string, _name: string) => {};
  @Event onDownloadFile: (path: string) => void = (_path: string) => {};
  private readonly fileReferenceCache: MessageFileReferenceProjectionCache =
    new MessageFileReferenceProjectionCache();

  build() {
    this.AssistantBubble()
  }

  @Builder
  AssistantBubble() {
    Row() {
      Column({ space: 10 }) {
        if (this.shouldRenderFinalOnly(this.item)) {
          this.FinalContent()
        } else {
          this.ProcessContent()
        }
        if (this.item.images && this.item.images.length > 0) {
          this.MessageImages(this.item.images)
        }
        if (this.isFailedAssistant(this.item) && (this.item.error || '').trim().length > 0) {
          this.AssistantFailure(
            this.item.error || '',
            this.showRetryAction ? (this.item.detail || '') : ''
          )
        } else if (this.item.status === 'failed' && this.showRetryAction &&
          (this.item.detail || '').trim().length > 0) {
          ChatMessageRetryAction({
            assistant: true,
            retryText: this.item.detail || '',
            onRetry: this.onRetryMessage
          })
        }
      }
      .layoutWeight(1)
      .padding({ right: 2 })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ top: 2, bottom: 2 })
  }

  @Builder
  AssistantFailure(errorText: string, retryText: string) {
    Column({ space: 6 }) {
      Text(RemoteI18n.t('chat.responseFailed'))
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(STATUS_DANGER)
      Text(errorText.trim())
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(INK)
      if (retryText.trim().length > 0) {
        Text(RemoteI18n.t('common.retry'))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(ACCENT)
          .height(28)
          .padding({ right: 10 })
          .onClick(() => this.onRetryMessage(retryText))
      }
    }
    .width('100%')
    .padding({ left: 12, top: 2, bottom: 2 })
    .border({ width: { left: 2 }, color: STATUS_DANGER })
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  FinalContent() {
    this.MessageText({
      text: this.finalMessageText(this.item),
      active: false,
      streamKey: `${this.item.id}-final`,
      renderRevision: this.renderRevision
    })
    if (this.fileReferences(this.finalMessageText(this.item)).length > 0) {
      this.FileCards(this.finalMessageText(this.item))
    }
  }

  @Builder
  ProcessContent() {
    if (this.leadingThinkingText(this.item).length > 0) {
      this.Thinking(
        this.leadingThinkingText(this.item),
        this.leadingThinkingStatus(this.item),
        `${this.item.id}-thinking`,
        ThinkingPresentationPolicy.isRunning(this.leadingThinkingStatus(this.item))
      )
    }
    if (this.shouldRenderStructuredItems(this.item)) {
      // Read the observed message here. Passing its plain items array through
      // an @Builder parameter freezes the first tool-only snapshot on current
      // ArkUI builds, even though the retained message row itself keeps
      // receiving revisions.
      ForEach([
        this.structuredRenderKey(this.structuredProcessItems(this.item.items || []))
      ], (_frameKey: string) => {
        Column({ space: 10 }) {
          ForEach(
            this.structuredGroups(this.structuredProcessItems(this.item.items || []), 'item'),
            (group: StructuredRenderGroup) => {
              this.StructuredGroup(group, this.shouldOmitStructuredThinking(this.item))
            },
            (group: StructuredRenderGroup) => group.key
          )
        }
        .width('100%')
      }, (frameKey: string) => frameKey)
      if (this.uncoveredTools(this.item).length > 0) {
        this.Tools(this.uncoveredTools(this.item))
      }
      if (this.trailingStructuredText(this.item).length > 0) {
        // Keep the growing answer outside the keyed structured ForEach. The
        // latter intentionally rebuilds entries whose content hash changes,
        // which turns a streamed answer into a sequence of static snapshots.
        MessageBodyMarkdown({
          text: this.trailingStructuredText(this.item),
          renderRevision: this.renderRevision,
          active: this.isStreamingAssistant(),
          streamKey: `${this.item.id}-trailing-body`,
          onCopyText: this.onCopyMessage,
          onOpenLink: this.onOpenFilePreview
        })
        if (this.fileReferences(this.trailingStructuredText(this.item)).length > 0) {
          this.FileCards(this.trailingStructuredText(this.item))
        }
      }
    } else {
      if (this.item.tools && this.item.tools.length > 0) {
        this.Tools(this.item.tools)
      }
      if (this.shouldShowTypingDots(this.item)) {
        ChatTypingDots()
      }
      if (this.item.role !== 'user' && this.visibleMessageText(this.item).length > 0 &&
        this.visibleMessageText(this.item) !== this.item.thinking) {
        MessageBodyMarkdown({
          text: this.item.text,
          renderRevision: this.renderRevision,
          active: this.isStreamingAssistant(),
          streamKey: `${this.item.id}-body`,
          onCopyText: this.onCopyMessage,
          onOpenLink: this.onOpenFilePreview
        })
        if (this.fileReferences(this.visibleMessageText(this.item)).length > 0) {
          this.FileCards(this.visibleMessageText(this.item))
        }
      }
    }
    if (this.pinnedThinkingText(this.item).length > 0) {
      this.Thinking(
        this.pinnedThinkingText(this.item),
        this.item.status,
        `${this.item.id}-pinned-thinking`,
        this.isStreamingAssistant()
      )
    }
  }

  @Builder
  StructuredGroup(group: StructuredRenderGroup, omitActiveThinking: boolean = false) {
    if (group.type === 'activity_group') {
      this.ActivityGroup(group, omitActiveThinking)
    } else if (group.type === 'tool_group') {
      this.Tools(group.tools)
      if (group.items.length > 0) {
        ForEach(group.items, (entry: ConversationUiMessageItem, index: number) => {
          this.StructuredItem(
            entry,
            `${group.path}-adjacent-${index}`,
            group.itemStatuses[index] || '',
            group.itemStreaming[index] || false,
            group.itemChildActiveScopes[index] || false
          )
        }, (entry: ConversationUiMessageItem, index: number) => {
          return ChatMessageStructurePolicy.structuredItemKey(entry, `${group.path}-adjacent-${index}`);
        })
      }
    } else if (group.items.length > 0) {
      if (!omitActiveThinking || !this.isThinkingEntry(group.items[0])) {
        this.StructuredItem(
          group.items[0],
          group.path,
          group.itemStatuses[0] || '',
          group.itemStreaming[0] || false,
          group.itemChildActiveScopes[0] || false
        )
      }
    }
  }

  @Builder
  ActivityGroup(group: StructuredRenderGroup, omitActiveThinking: boolean = false) {
    Column({ space: 6 }) {
      if (this.activityGroupTools(group).length > 0) {
        // Reasoning and the tools it drove are one stretch of work, so they fold
        // behind a single summary row instead of stacking two cards.
        this.Tools(
          this.activityGroupTools(group),
          omitActiveThinking ? [] : this.activityThinkingParts(group)
        )
      } else if (!omitActiveThinking &&
        ActivityGroupPolicy.thinkingHeaderCount(this.activityThinkingCount(group)) > 0 &&
        (this.activityThinkingText(group).length > 0 || this.activityThinkingStreaming(group))) {
        this.Thinking(
          this.activityThinkingText(group),
          this.activityThinkingStatus(group),
          `${this.item.id}-${group.path}-activity-thinking`,
          this.activityThinkingStreaming(group)
        )
      }
    }
    .width('100%')
  }

  @Builder
  StructuredItem(
    entry: ConversationUiMessageItem,
    path: string,
    statusOverride: string = '',
    streaming: boolean = false,
    childActiveScope: boolean = false
  ) {
    if (this.isSubagentEntry(entry)) {
      this.SubagentGroup(entry, path, childActiveScope)
    } else {
      if (this.isUserSteeringEntry(entry)) {
        ChatUserMessageBubble({
          item: this.steeringMessage(entry, path),
          showRetryAction: false
        })
      } else if (this.isThinkingEntry(entry)) {
        this.Thinking(
          entry.content || '',
          statusOverride || this.item.status,
          `${this.item.id}-${path}-thinking`,
          streaming
        )
      } else if (this.isTextEntry(entry)) {
        this.MessageText({
          text: entry.content || '',
          active: streaming,
          streamKey: `${this.item.id}-${path}-text`,
          renderRevision: this.renderRevision
        })
        if (this.fileReferences(entry.content || '').length > 0) {
          this.FileCards(entry.content || '')
        }
      } else if (entry.tool) {
        this.Tools([entry.tool])
      }
      if (entry.subItems && entry.subItems.length > 0) {
        this.ChildItems(entry.subItems, path, childActiveScope)
      }
    }
  }

  @Builder
  SubagentGroup(entry: ConversationUiMessageItem, _path: string, activeScope: boolean = false) {
    SubagentTaskCard({
      interactionMailbox: this.interactionMailbox,
      title: this.subagentTitle(entry),
      status: entry.tool?.status || (activeScope ? 'running' : 'completed'),
      items: entry.subItems || [],
      renderRevision: this.renderRevision,
      onApproveTool: this.onApproveTool,
      onRejectTool: this.onRejectTool,
      onCancelTool: this.onCancelTool,
      onAnswerQuestion: this.onAnswerQuestion,
      onOpenFilePreview: this.onOpenFilePreview,
      onBuildPlan: this.onBuildPlan
    })
  }

  @Builder
  ChildItems(items: ConversationUiMessageItem[], parentPath: string, activeScope: boolean = false) {
    Column({ space: 8 }) {
      ForEach(this.structuredGroups(items, parentPath, activeScope), (group: StructuredRenderGroup) => {
        this.StructuredGroup(group)
      }, (group: StructuredRenderGroup) => group.key)
    }
    .width('100%')
    .padding({ left: 12 })
    .border({ width: { left: 1 }, color: LINE })
  }

  @Builder
  Thinking(text: string, status: string, streamKey: string = '', streaming: boolean = false) {
    ThinkingBlock({
      text,
      status,
      keepExpandedWhenDone: false,
      streaming,
      streamKey
    })
  }

  @Builder
  Tools(tools: ConversationUiToolStatus[], thinkingParts: ActivityThinkingPart[] = []) {
    ToolStatusList({
      interactionMailbox: this.interactionMailbox,
      tools,
      thinkingParts,
      renderRevision: this.renderRevision,
      isBusy: this.isBusy,
      onApproveTool: (toolId: string, updatedInput?: Object) => {
        this.onApproveTool(toolId, updatedInput);
      },
      onRejectTool: (toolId: string) => {
        this.onRejectTool(toolId);
      },
      onCancelTool: (toolId: string) => {
        this.onCancelTool(toolId);
      },
      onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => {
        this.onAnswerQuestion(toolId, answers);
      },
      onOpenFilePreview: (path: string, label: string) => {
        this.onOpenFilePreview(path, label);
      },
      onBuildPlan: (path: string, name: string) => {
        this.onBuildPlan(path, name);
      }
    })
  }

  @Builder
  MessageImages(images: ConversationUiImage[]) {
    MessageImageGallery({ images })
  }

  @Builder
  MessageText($$: MessageTextBuilderParams) {
    MessageMarkdown({
      text: $$.text,
      renderRevision: $$.renderRevision,
      active: $$.active,
      streamKey: $$.streamKey,
      onCopyText: this.onCopyMessage,
      onOpenLink: this.onOpenFilePreview
    })
  }

  @Builder
  FileCards(text: string) {
    MessageFileCards({
      text,
      downloadingFilePath: this.downloadingFilePath,
      downloadedFilePath: this.downloadedFilePath,
      fileDownloadStatus: this.fileDownloadStatus,
      activeFilePreviewPath: this.activeFilePreviewPath,
      activeFilePreviewLoading: this.activeFilePreviewLoading,
      onPreview: this.onOpenFilePreview,
      onDownload: this.onDownloadFile
    })
  }

  private fileReferences(text: string): MessageFileReference[] {
    return this.fileReferenceCache.referencesFor(text);
  }

  private visibleMessageText(item: ConversationUiMessage): string {
    return ConversationMessageRenderPolicy.visibleText(item.text);
  }

  private shouldShowTypingDots(item: ConversationUiMessage): boolean {
    if (item.role === 'user' || (item.status || '').toLowerCase() !== 'active') {
      return false;
    }
    return this.visibleMessageText(item).length === 0 &&
      (!item.thinking || item.thinking.trim().length === 0) &&
      (!item.tools || item.tools.length === 0);
  }

  private isStreamingAssistant(): boolean {
    return this.item.role !== 'user' &&
      (this.isStreaming || (this.item.status || '').toLowerCase() === 'active');
  }

  private shouldRenderStructuredItems(item: ConversationUiMessage): boolean {
    if (item.role === 'user' || !item.items || item.items.length === 0) {
      return false;
    }
    return ChatMessageStructurePolicy.requiresStructuredRendering(item.items);
  }

  private uncoveredTools(item: ConversationUiMessage): ConversationUiToolStatus[] {
    return this.toolsNotCoveredByItems(item.tools || [], item.items || []);
  }

  private structuredProcessItems(items: ConversationUiMessageItem[]): ConversationUiMessageItem[] {
    return ChatMessageStructurePolicy.withoutTrailingTopLevelText(items);
  }

  private trailingStructuredText(item: ConversationUiMessage): string {
    return ChatMessageStructurePolicy.trailingTopLevelText(item.items || []);
  }

  private shouldPinThinkingToBottom(item: ConversationUiMessage): boolean {
    return AssistantProcessLayoutPolicy.pinsThinkingAfterTools() &&
      this.isStreamingAssistant() &&
      this.currentThinkingText(item).length > 0;
  }

  private pinnedThinkingText(item: ConversationUiMessage): string {
    if (!this.shouldPinThinkingToBottom(item)) {
      return '';
    }
    return this.currentThinkingText(item);
  }

  private leadingThinkingText(item: ConversationUiMessage): string {
    if (this.shouldPinThinkingToBottom(item)) {
      return '';
    }
    if (this.lastThinkingText(item.items || []).length > 0) {
      return '';
    }
    return (item.thinking || '').trim();
  }

  private leadingThinkingStatus(item: ConversationUiMessage): string {
    return ThinkingPresentationPolicy.liveThinkingStatus(
      item.status,
      this.hasLaterProcessOutput(item)
    );
  }

  private hasLaterProcessOutput(item: ConversationUiMessage): boolean {
    if (item.tools && item.tools.length > 0) {
      return true;
    }
    const visible = this.visibleMessageText(item);
    if (visible.length > 0 && visible !== (item.thinking || '').trim()) {
      return true;
    }
    return this.hasToolOrTextItems(item.items || []);
  }

  private hasToolOrTextItems(items: ConversationUiMessageItem[]): boolean {
    return items.some((entry: ConversationUiMessageItem) => {
      if (entry.tool || this.isTextEntry(entry)) {
        return true;
      }
      return !!entry.subItems && this.hasToolOrTextItems(entry.subItems);
    });
  }

  private shouldOmitStructuredThinking(_item: ConversationUiMessage): boolean {
    return AssistantProcessLayoutPolicy.omitsInFlowThinkingWhileStreaming();
  }

  private currentThinkingText(item: ConversationUiMessage): string {
    const structured = this.lastThinkingText(item.items || []);
    if (structured.length > 0) {
      return structured;
    }
    return (item.thinking || '').trim();
  }

  private lastThinkingText(items: ConversationUiMessageItem[]): string {
    for (let index = items.length - 1; index >= 0; index--) {
      const entry = items[index];
      if (this.isThinkingEntry(entry)) {
        return (entry.content || '').trim();
      }
      if (!this.isSubagentEntry(entry) && entry.subItems) {
        const childText = this.lastThinkingText(entry.subItems);
        if (childText.length > 0) {
          return childText;
        }
      }
    }
    return '';
  }

  private shouldRenderFinalOnly(item: ConversationUiMessage): boolean {
    if (item.role === 'user') {
      return false;
    }
    if (this.shouldRenderStructuredItems(item)) {
      return false;
    }
    if (!this.isFinishedAssistant(item)) {
      return false;
    }
    return this.finalMessageText(item).length > 0;
  }

  private isFinishedAssistant(item: ConversationUiMessage): boolean {
    const status = (item.status || '').toLowerCase();
    return status === 'done' ||
      status === 'completed' ||
      status === 'success' ||
      status === 'sent' ||
      status.length === 0;
  }

  private isFailedAssistant(item: ConversationUiMessage): boolean {
    return item.role !== 'user' && (item.status || '').toLowerCase() === 'failed';
  }

  private finalMessageText(item: ConversationUiMessage): string {
    const structuredText = this.lastTopLevelText(item.items || []);
    if (structuredText.length > 0) {
      return structuredText;
    }
    const visible = this.visibleMessageText(item);
    if (visible.length > 0 && visible !== (item.thinking || '').trim()) {
      return visible;
    }
    return '';
  }

  private lastTopLevelText(items: ConversationUiMessageItem[]): string {
    for (let index = items.length - 1; index >= 0; index--) {
      if (this.isMainTextEntry(items[index])) {
        const text = (items[index].content || '').trim();
        if (text.length > 0) {
          return text;
        }
      }
    }
    return '';
  }

  private hasVisibleProcessAttention(item: ConversationUiMessage): boolean {
    return ChatMessageStructurePolicy.hasAttentionTools(item.tools || []) ||
      ChatMessageStructurePolicy.hasAttentionItems(item.items || []);
  }

  private structuredGroups(
    items: ConversationUiMessageItem[],
    prefix: string,
    activeScope: boolean = this.isStreamingAssistant()
  ): StructuredRenderGroup[] {
    return ChatMessageStructurePolicy.structuredGroups(
      items,
      prefix,
      activeScope,
      this.item.status || 'active'
    );
  }

  private structuredRenderKey(items: ConversationUiMessageItem[]): string {
    return ChatMessageStructurePolicy.structuredRenderKey(
      items,
      'item',
      this.isStreamingAssistant(),
      this.item.status || 'active'
    );
  }

  private activityGroupTools(group: StructuredRenderGroup): ConversationUiToolStatus[] {
    return ChatMessageStructurePolicy.activityGroupTools(group);
  }

  private activityThinkingParts(group: StructuredRenderGroup): ActivityThinkingPart[] {
    return ChatMessageStructurePolicy.activityThinkingParts(group, this.item.id);
  }

  private activityThinkingCount(group: StructuredRenderGroup): number {
    return ChatMessageStructurePolicy.activityThinkingCount(group);
  }

  private activityThinkingText(group: StructuredRenderGroup): string {
    return ChatMessageStructurePolicy.activityThinkingText(group);
  }

  private activityThinkingStatus(group: StructuredRenderGroup): string {
    return ChatMessageStructurePolicy.activityThinkingStatus(group);
  }

  private activityThinkingStreaming(group: StructuredRenderGroup): boolean {
    return ChatMessageStructurePolicy.activityThinkingStreaming(group);
  }

  private toolsNotCoveredByItems(
    tools: ConversationUiToolStatus[],
    items: ConversationUiMessageItem[]
  ): ConversationUiToolStatus[] {
    return ChatMessageStructurePolicy.toolsNotCoveredByItems(tools, items);
  }

  private isRenderableStructuredEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isRenderableStructuredEntry(entry);
  }

  private isThinkingEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isThinkingEntry(entry);
  }

  private isUserSteeringEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isUserSteeringEntry(entry);
  }

  private steeringMessage(entry: ConversationUiMessageItem, path: string): ConversationUiMessage {
    return {
      id: entry.steering_id || `${this.item.id}-${path}-steering`,
      role: 'user',
      text: entry.content || '',
      status: 'sent',
      detail: '',
      images: entry.images
    };
  }

  private isTextEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isTextEntry(entry);
  }

  private isMainTextEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isTextEntry(entry);
  }

  private isSubagentEntry(entry: ConversationUiMessageItem): boolean {
    return ChatMessageStructurePolicy.isSubagentEntry(entry);
  }

  private subagentTitle(entry: ConversationUiMessageItem): string {
    const title = ChatMessageStructurePolicy.subagentTitle(entry);
    return title.length > 0 ? title : RemoteI18n.t('chat.toolTaskFallback');
  }

  private isRunningTool(tool: ConversationUiToolStatus): boolean {
    return (tool.status || '').toLowerCase() === 'running' || (tool.status || '').toLowerCase() === 'active';
  }

}
