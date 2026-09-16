import { MobileDesignTypography, MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  InteractionMailboxAction, InteractionMailboxActionType, InteractionMailboxState,
  PendingPermission, PendingQuestion
} from '../../model/InteractionMailbox';
import { ConversationUiQuestionAnswer, toRemoteQuestionAnswer } from '../state/ConversationUiModels';
import { ToolConfirmationPanel, ToolQuestionAnswerPanel } from './ToolInteractionPanels';
import { CARD, INK, LINE, MUTED, SOFT, STATUS_DANGER } from './Theme';

@ComponentV2
export struct InteractionMailboxPanel {
  @Param state: InteractionMailboxState = new InteractionMailboxState();
  @Event onAction: (action: InteractionMailboxAction) => void = (_action: InteractionMailboxAction) => {};
  @Local editingId: string = '';

  build() {
    if (this.state.requests.length > 0 || this.state.questions.length > 0 || this.state.failure.length > 0) {
      Scroll() {
        Column({ space: 12 }) {
          if (this.state.failure.length > 0) {
            Row({ space: 8 }) {
              Text(RemoteI18n.t(this.state.failure === 'load' ? 'chat.interactionLoadFailed' : 'chat.approvalFailed'))
                .fontSize(MobileDesignTypography.bodySmall.size).fontColor(STATUS_DANGER).layoutWeight(1)
              Button(RemoteI18n.t('common.retry'))
                .fontSize(MobileDesignTypography.labelMedium.size).fontColor(INK)
                .backgroundColor(SOFT).height(32).borderRadius(16)
                .border({ width: 1, color: LINE })
                .enabled(!this.state.busy)
                .onClick(() => this.onAction({ sessionId: this.state.sessionId, type: InteractionMailboxActionType.Refresh }))
            }.width('100%')
          }
          ForEach(this.state.questions, (question: PendingQuestion) => {
            ToolQuestionAnswerPanel({
              toolId: question.toolId, questionsJson: JSON.stringify(question.questions), isBusy: this.state.busy,
              onAnswerQuestion: (id: string, answers: ConversationUiQuestionAnswer): void => {
                this.onAction({ sessionId: this.state.sessionId, type: InteractionMailboxActionType.Answer,
                  id, answers: toRemoteQuestionAnswer(answers) });
              }
            })
              .onTouch((event: TouchEvent): void => {
                if (event.type === TouchType.Down) this.onAction({ sessionId: this.state.sessionId,
                  type: InteractionMailboxActionType.StartQuestion, id: question.toolId });
              })
          }, (question: PendingQuestion): string => `${this.state.sessionId}:${question.toolId}`)
          ForEach(this.state.requests, (request: PendingPermission) => {
            Column({ space: MobileDesignGeometry.approvalCardGap }) {
              Row({ space: 8 }) {
                // Rasterized from the desktop glyph with the shared warning token (same in both themes).
                Image($r('app.media.approval_shield')).width(16).height(16)
                Text(request.source?.identity || request.action || RemoteI18n.t('chat.approvalRequired'))
                  .fontSize(MobileDesignTypography.bodySmall.size).fontColor(INK)
                  .fontWeight(FontWeight.Medium).layoutWeight(1)
                Button(this.editingId === request.requestId ? RemoteI18n.t('chat.hideApprovalInput') : RemoteI18n.t('chat.editApprovalInput'))
                  .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
                  .backgroundColor(CARD).height(32).padding({ left: 8, right: 8 })
                  .enabled(!this.state.busy)
                  .onClick(() => { this.editingId = this.editingId === request.requestId ? '' : request.requestId; })
              }.width('100%')
              Column({ space: 6 }) {
                if (request.action && request.source?.identity && request.action.toLowerCase() !== request.source.identity.toLowerCase()) {
                  Text(request.action).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED)
                }
                if ((request.resources || []).length > 0) {
                  Text((request.resources || []).join('\n'))
                    .fontSize(MobileDesignTypography.labelSmall.size).fontFamily('monospace').fontColor(INK)
                    .width('100%').padding(10).backgroundColor(SOFT).borderRadius(8)
                }
              }.width('100%').alignItems(HorizontalAlign.Start)
              ToolConfirmationPanel({
                toolId: request.requestId, defaultInputText: '{}', leadingInset: 0, compactActions: true,
                hasEditableInput: this.editingId === request.requestId, isBusy: this.state.busy,
                onApproveTool: (id: string, updatedInput?: Object): void => {
                  this.onAction({ sessionId: this.state.sessionId, type: InteractionMailboxActionType.Approve, id, updatedInput });
                },
                onRejectTool: (id: string): void => {
                  this.onAction({ sessionId: this.state.sessionId, type: InteractionMailboxActionType.Reject, id });
                }
              })
            }.width('100%').padding(MobileDesignGeometry.approvalCardPadding).alignItems(HorizontalAlign.Start)
              .backgroundColor(CARD).borderRadius(MobileDesignGeometry.approvalCardRadius)
              .border({ width: 1, color: LINE })
          }, (request: PendingPermission): string => `${this.state.sessionId}:${request.requestId}`)
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 8 })
      }.width('100%').constraintSize({ maxHeight: '40%' }).scrollBar(BarState.Auto)
    }
  }
}
