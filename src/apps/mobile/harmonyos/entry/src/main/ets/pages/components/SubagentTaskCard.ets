import { InteractionMailboxState } from '../../model/InteractionMailbox';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConversationUiMessageItem, ConversationUiQuestionAnswer } from '../state/ConversationUiModels';
import { ChatMessageStructurePolicy } from '../policy/ChatMessageStructurePolicy';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  SOFT,
  STATUS_DANGER,
  TRANSPARENT,
} from './Theme';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolStatusList } from './ToolStatusList';
import { ToolGlyph } from './ToolGlyphs';

@ComponentV2
export struct SubagentTaskCard {
  @Param interactionMailbox: InteractionMailboxState = new InteractionMailboxState();
  @Param title: string = '';
  @Param status: string = 'completed';
  @Param items: ConversationUiMessageItem[] = [];
  @Param renderRevision: number = 0;
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

  build() {
    Column() {
      Row({ space: 8 }) {
        Stack({ alignContent: Alignment.BottomEnd }) {
          Stack({ alignContent: Alignment.Center }) {
            ToolGlyph({ kind: 'task', color: this.isError() ? STATUS_DANGER : MUTED })
          }
          .width(18)
          .height(18)
          .backgroundColor(SOFT)
          .borderRadius(5)
          .border({ width: 1, color: this.isError() ? STATUS_DANGER : LINE })
          if (this.isRunning() || this.isError()) {
            Text(this.isError() ? '!' : '•')
              .width(10)
              .height(10)
              .fontSize(MobileDesignTypography.labelSmall.size)
              .fontWeight(FontWeight.Bold)
              .fontColor(CARD)
              .textAlign(TextAlign.Center)
              .backgroundColor(this.isError() ? STATUS_DANGER : MUTED)
              .borderRadius(5)
              .border({ width: 1, color: CARD })
          }
        }
        .width(20)
        .height(20)
        Text(this.title)
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontColor(this.isError() ? STATUS_DANGER : MUTED)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.statusText())
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(this.isError() ? STATUS_DANGER : MUTED)
          .maxLines(1)
        if (this.hasProcessItems()) {
          SymbolGlyph(this.expanded ? $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
            .fontSize(13)
            .fontColor([MUTED])
            .width(16)
            .height(16)
        }
      }
      .width('100%')
      .height(28)
      .alignItems(VerticalAlign.Center)
      .onClick(() => {
        if (this.hasProcessItems()) {
          this.expanded = !this.expanded;
        }
      })
      if (this.expanded && this.hasProcessItems()) {
        this.ProcessItems()
      }
    }
    .width('100%')
    .padding({
      left: this.isEmphasized() ? 10 : 0,
      right: this.isEmphasized() ? 10 : 0,
      top: this.isEmphasized() ? 6 : 0,
      bottom: this.isEmphasized() ? 6 : 0
    })
    .backgroundColor(this.isEmphasized() || this.expanded ? SOFT : TRANSPARENT)
    .borderRadius(this.isEmphasized() ? 14 : 8)
    .border({ width: this.isEmphasized() || this.expanded ? 1 : 0, color: LINE })
    .accessibilityText(`${this.title}, ${this.statusText()}`)
  }

  @Builder
  private ProcessItems() {
    Column({ space: 6 }) {
      ForEach(this.visibleProcessItems(), (entry: ConversationUiMessageItem, index: number) => {
        if (ChatMessageStructurePolicy.isThinkingEntry(entry)) {
          ThinkingBlock({
            text: entry.content || '',
            status: this.childStatus(index),
            keepExpandedWhenDone: false,
            streaming: this.childStatus(index) === 'running',
            streamKey: `${this.title}-subagent-thinking-${index}`
          })
        } else if (entry.tool) {
          ToolStatusList({
            interactionMailbox: this.interactionMailbox,
            tools: [entry.tool],
            renderRevision: this.renderRevision,
            isBusy: this.isRunning(),
            onApproveTool: this.onApproveTool,
            onRejectTool: this.onRejectTool,
            onCancelTool: this.onCancelTool,
            onAnswerQuestion: this.onAnswerQuestion,
            onOpenFilePreview: this.onOpenFilePreview,
            onBuildPlan: this.onBuildPlan
          })
        } else if ((entry.content || '').trim().length > 0) {
          Column({ space: 3 }) {
            Text(RemoteI18n.t('chat.subagentOutput'))
              .fontSize(MobileDesignTypography.labelSmall.size)
              .fontWeight(FontWeight.Medium)
              .fontColor(MUTED)
            Text(this.processTextPreview(entry.content || ''))
              .fontSize(MobileDesignTypography.bodySmall.size)
              .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
              .fontColor(INK)
              .width('100%')
              .maxLines(4)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
          }
          .width('100%')
          .alignItems(HorizontalAlign.Start)
        }
      }, (entry: ConversationUiMessageItem, index: number) =>
        ChatMessageStructurePolicy.structuredItemKey(entry, `subagent-${index}`))
    }
    .width('100%')
    .padding({ left: 14, top: 6, bottom: 4 })
    .border({ width: { left: 1 }, color: LINE })
  }

  private isRunning(): boolean {
    const normalized = this.status.toLowerCase();
    return normalized === 'running' || normalized === 'active' || normalized === 'preparing' ||
      normalized === 'pending' || normalized === 'queued';
  }

  private isError(): boolean {
    const normalized = this.status.toLowerCase();
    return normalized === 'failed' || normalized === 'error' || normalized === 'timeout' ||
      normalized === 'cancelled' || normalized === 'canceled' || normalized === 'rejected';
  }

  private statusText(): string {
    if (this.isRunning()) return RemoteI18n.t('common.running');
    return RemoteI18n.t(this.isError() ? 'common.failed' : 'common.done');
  }

  private isEmphasized(): boolean {
    return this.isRunning() || this.isError();
  }

  private visibleProcessItems(): ConversationUiMessageItem[] {
    return this.items.filter((entry: ConversationUiMessageItem) =>
      !!entry.tool || (entry.content || '').trim().length > 0 ||
        (!!entry.subItems && entry.subItems.length > 0));
  }

  private hasProcessItems(): boolean {
    return this.visibleProcessItems().length > 0;
  }

  private childStatus(index: number): string {
    return this.isRunning() && index === this.visibleProcessItems().length - 1 ? 'running' : 'done';
  }

  private processTextPreview(raw: string): string {
    const text = raw.trim();
    if (text.length <= 320) return text;
    return `${text.slice(0, 320).trim()}…`;
  }
}
