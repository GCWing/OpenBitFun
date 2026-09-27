import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { GoalAction, GoalRequest, ThreadGoalState } from '../../model/ThreadGoal';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { KeyboardReleaseService } from '../../services/KeyboardReleaseService';
import { INK, MUTED, PAGE_BG, TRANSPARENT, PRIMARY_ACTION, CONTENT_ON_ACTION, STATUS_DANGER, SOFT, LINE } from './Theme';

/** Composer context strip and its detail/edit flow. Host state remains authoritative. */
@ComponentV2
export struct ThreadGoalPanel {
  @Param state: ThreadGoalState = new ThreadGoalState();
  @Param sessionId: string = '';
  @Param connected: boolean = false;
  @Event onAction: (request: GoalRequest) => void = () => {};
  @Local objective: string = '';
  @Local editing: boolean = false;
  @Local clearing: boolean = false;
  @Local saving: boolean = false;

  aboutToAppear(): void { this.load(); }
  @Monitor('sessionId', 'connected')
  targetChanged(): void { this.objective = ''; this.editing = false; this.clearing = false; this.saving = false; this.load(); }
  private load(): void {
    if (this.connected && this.sessionId.length > 0) this.onAction(new GoalRequest(GoalAction.Read));
  }
  @Monitor('state')
  goalChanged(): void {
    if (!this.state.visible) { this.objective = ''; this.editing = false; this.clearing = false; }
    if (this.saving && !this.state.busy) {
      if (!this.state.failure) { this.editing = false; this.onAction(new GoalRequest(GoalAction.Close)); }
      this.saving = false;
    }
  }
  private async openGoal(): Promise<void> {
    const context = this.getUIContext().getHostContext();
    if (context) await KeyboardReleaseService.release(context);
    this.getUIContext().getFocusController().clearFocus();
    this.onAction(new GoalRequest(GoalAction.Open));
  }
  private canMutate(): boolean { return this.connected && this.state.loaded && !this.state.busy && !this.state.failure; }
  private statusKey(): string {
    const status = this.state.goal?.status || 'unknown';
    return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].indexOf(status) >= 0 ? status : 'unknown';
  }
  private edit(): void { this.objective = this.state.goal?.objective || ''; this.editing = true; }
  private close(): void { this.editing = false; this.clearing = false; this.onAction(new GoalRequest(GoalAction.Close)); }

  build() {
    Column() {
      if (this.state.sessionId === this.sessionId && this.state.goal) {
        Button() {
          Row({ space: 10 }) {
            Column({ space: 2 }) {
              Text(RemoteI18n.t(this.connected ? 'goal.' + this.statusKey() : 'goal.offline'))
                .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
              Text(this.state.goal.objective).fontSize(MobileDesignTypography.bodySmall.size).fontColor(INK)
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            SymbolGlyph($r('sys.symbol.chevron_right')).fontSize(14).fontColor([MUTED])
          }.width('100%').padding({ left: 12, right: 12, top: 10, bottom: 10 })
        }.type(ButtonType.Normal).backgroundColor(SOFT).borderRadius(14).width('100%')
          .accessibilityText(RemoteI18n.t('goal.manage'))
          .onClick(() => { void this.openGoal(); })
      }
    }.width('100%')
      .bindSheet(this.state.visible && this.state.sessionId === this.sessionId, this.GoalSheet(), {
        height: SheetSize.FIT_CONTENT, width: 420,
        backgroundColor: PAGE_BG, showClose: false, dragBar: false,
        keyboardAvoidMode: SheetKeyboardAvoidMode.TRANSLATE_AND_RESIZE,
        onDisappear: () => this.close()
      })
  }
  @Builder
  Action(label: string, action: () => void, primary: boolean = false, danger: boolean = false) {
    Button(RemoteI18n.t('goal.' + label)).type(ButtonType.Normal).height(44).borderRadius(10)
      .fontSize(MobileDesignTypography.bodyMedium.size)
      .backgroundColor(primary ? PRIMARY_ACTION : TRANSPARENT)
      .fontColor(primary ? CONTENT_ON_ACTION : danger ? STATUS_DANGER : INK)
      .border({ width: primary ? 0 : 1, color: LINE }).layoutWeight(1)
      .enabled(this.canMutate()).onClick(action)
  }
  @Builder
  GoalSheet() {
    Column({ space: 16 }) {
      Row() {
        Text(RemoteI18n.t(this.clearing ? 'goal.clearTitle' : this.editing ? 'goal.modify' : !this.state.goal ? 'goal.set' : 'goal.title'))
          .fontSize(MobileDesignTypography.titleMedium.size).fontWeight(FontWeight.Medium).fontColor(INK).layoutWeight(1)
        Button() {
          Image($r('app.media.settings_close_x')).renderMode(ImageRenderMode.Template).fillColor(MUTED).width(16).height(16)
        }.width(44).height(44).backgroundColor(TRANSPARENT).accessibilityText(RemoteI18n.t('goal.close')).onClick(() => this.close())
      }.width('100%')
      if (!this.connected) { Text(RemoteI18n.t('goal.offline')).fontColor(MUTED) }
      if (this.state.failure) {
        Text(RemoteI18n.t('goal.' + this.state.failure)).fontColor(MUTED)
        Button(RemoteI18n.t('goal.retry')).backgroundColor(SOFT).fontColor(INK)
          .enabled(this.connected && !this.state.busy).onClick(() => this.load())
      }
      if (this.state.busy) { LoadingProgress().width(20).height(20) }
      if (this.state.loaded) {
        if (this.clearing) {
          Text(RemoteI18n.t('goal.clearHint')).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(MUTED)
          Row({ space: 8 }) {
            this.Action('keep', () => { this.clearing = false; })
            this.Action('clear', () => { this.saving = true; this.onAction(new GoalRequest(GoalAction.Clear)); }, false, true)
          }.width('100%')
        } else if (!this.state.goal || this.editing) {
          Text(RemoteI18n.t('goal.hint')).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(MUTED)
          TextArea({ text: this.objective, placeholder: RemoteI18n.t('goal.objective') })
            .id('goal-objective-input').height(126).fontSize(MobileDesignTypography.bodyMedium.size)
            .fontColor(INK).backgroundColor(SOFT).borderRadius(10)
            .enabled(this.connected && !this.saving).onChange((value: string) => { this.objective = value; })
          Row({ space: 8 }) {
            Button(RemoteI18n.t('goal.cancel')).height(44).layoutWeight(1).backgroundColor(TRANSPARENT).fontColor(INK)
              .onClick(() => { if (this.state.goal) this.editing = false; else this.close(); })
            Button(RemoteI18n.t(this.state.goal ? 'goal.save' : 'goal.set')).type(ButtonType.Normal)
              .height(44).borderRadius(10).layoutWeight(1).backgroundColor(PRIMARY_ACTION).fontColor(CONTENT_ON_ACTION)
              .enabled(this.canMutate() && this.objective.trim().length > 0)
              .onClick(() => { this.saving = true; this.onAction(new GoalRequest(this.state.goal ? GoalAction.Edit : GoalAction.Start, this.objective.trim())); })
          }.width('100%')
        } else {
          Row() {
            Text(RemoteI18n.t('goal.' + this.statusKey())).fontSize(MobileDesignTypography.labelSmall.size)
              .fontColor(INK).padding({ left: 10, right: 10, top: 5, bottom: 5 }).backgroundColor(SOFT).borderRadius(16)
            Blank()
            Text(RemoteI18n.f('goal.usage', String(this.state.goal.tokensUsed || 0)))
              .fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
          }.width('100%')
          Scroll() {
            Column({ space: 6 }) {
              Text(RemoteI18n.t('goal.description')).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
              Text(this.state.goal.objective).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(INK).width('100%')
            }.alignItems(HorizontalAlign.Start).width('100%').padding(14)
          }.constraintSize({ maxHeight: 180 }).width('100%').backgroundColor(SOFT).borderRadius(10)
          Column({ space: 6 }) {
            Text(RemoteI18n.t('goal.workflow')).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
            Text(RemoteI18n.t(this.state.goal.status === 'active' ? 'goal.workflowHint' : this.state.goal.status === 'paused' ? 'goal.pausedHint' : 'goal.' + this.statusKey()))
              .fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED)
          }.width('100%').alignItems(HorizontalAlign.Start).padding(14).backgroundColor(SOFT).borderRadius(10)
          Divider().color(LINE)
          Row({ space: 8 }) {
            this.Action('modify', () => this.edit())
            if (this.state.goal.status === 'active') {
              this.Action('pause', () => this.onAction(new GoalRequest(GoalAction.Pause)))
            } else if (['paused', 'blocked', 'usageLimited'].indexOf(this.state.goal.status) >= 0) {
              this.Action('resume', () => this.onAction(new GoalRequest(GoalAction.Resume)))
            }
            this.Action('clear', () => { this.clearing = true; }, false, true)
          }.width('100%')
        }
      }
    }.alignItems(HorizontalAlign.Start).width('100%').padding({ left: 20, right: 20, top: 12, bottom: 24 })
  }
}
