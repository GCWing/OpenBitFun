import { MessageQueueAction, MessageQueueItem, MessageQueueState } from '../../model/MessageQueue';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignTypography, MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { INK, LINE, MUTED, TRANSPARENT, CARD } from './Theme';

@ComponentV2
export struct MessageQueuePanel {
  @Param state: MessageQueueState = new MessageQueueState();
  @Event onAction: (action: MessageQueueAction) => void = (_action: MessageQueueAction): void => {};
  @Local expanded: boolean = true;
  @Local dragging: string = '';
  @Local dragOffset: number = 0;
  @Local before: string = '';
  @Local dragRevision: string = '';
  @Monitor('state.revisionKey', 'state.busy', 'state.failure')
  resetGesture(): void { this.dragging = ''; this.dragOffset = 0; }

  private queued(): MessageQueueItem[] { return this.state.items.filter((item: MessageQueueItem): boolean => item.status === 'queued'); }
  private canMove(item: MessageQueueItem): boolean { return this.state.supportsReorder && !this.state.busy && !this.state.failure && item.status === 'queued' && this.queued().length > 1; }
  private move(item: MessageQueueItem, delta: number): void {
    const items = this.queued();
    const index = items.findIndex((value: MessageQueueItem): boolean => value.turnId === item.turnId);
    if (!this.canMove(item) || index + delta < 0 || index + delta >= items.length) return;
    this.onAction({ sessionId: this.state.sessionId, action: 'reorder', turnId: item.turnId, beforeTurnId: delta < 0 ? items[index - 1].turnId : items[index + 2]?.turnId });
  }
  @Builder
  Actions(item: MessageQueueItem) {
    Menu() {
      MenuItem({ content: item.displayContent }).enabled(false)
      if (!this.state.supportsReorder) { MenuItem({ content: RemoteI18n.t('queue.unsupported') }).enabled(false) }
      MenuItem({ content: RemoteI18n.t('queue.moveUp') }).enabled(this.canMove(item) && this.queued()[0]?.turnId !== item.turnId).onClick((): void => this.move(item, -1))
      MenuItem({ content: RemoteI18n.t('queue.moveDown') }).enabled(this.canMove(item) && this.queued().slice(-1)[0]?.turnId !== item.turnId).onClick((): void => this.move(item, 1))
      MenuItem({ content: RemoteI18n.t('queue.remove') }).enabled(!this.state.busy && !this.state.failure && item.status !== 'steering_pending')
        .onClick((): void => this.onAction({ sessionId: this.state.sessionId, action: 'cancel', turnId: item.turnId }))
    }
  }
  @Builder
  MessageRow(item: MessageQueueItem, index: number) {
    Column() {
      Divider().color(LINE).strokeWidth(0.5).margin({ left: 8, right: 8 })
      Row({ space: 4 }) {
        if (this.state.supportsReorder) {
          Column({ space: 3 }) { ForEach([0, 1, 2], (): void => { Divider().color(MUTED).strokeWidth(1).width(14) }) }
            .width(44).height(48).justifyContent(FlexAlign.Center).accessibilityText(RemoteI18n.t('queue.reorder'))
            .gesture(PanGesture({ direction: PanDirection.Vertical, distance: 6 })
              .onActionStart((): void => { if (this.canMove(item)) { this.dragging = item.turnId; this.dragRevision = this.state.revisionKey; this.dragOffset = 0; this.before = ''; } })
              .onActionUpdate((event: GestureEvent): void => {
                if (this.dragging !== item.turnId || !this.canMove(item)) return;
                this.dragOffset = event.offsetY;
                const target = Math.max(0, Math.min(this.state.items.length - 1, index + Math.round(this.dragOffset / 49)));
                const rest = this.state.items.filter((value: MessageQueueItem): boolean => value.turnId !== item.turnId);
                this.before = rest.slice(target).find((value: MessageQueueItem): boolean => value.status === 'queued')?.turnId || '';
              })
              .onActionEnd((): void => {
                if (this.dragging === item.turnId && this.dragRevision === this.state.revisionKey && this.canMove(item) && Math.abs(this.dragOffset) > 24) this.onAction({ sessionId: this.state.sessionId, action: 'reorder', turnId: item.turnId, beforeTurnId: this.before || undefined });
                this.dragging = ''; this.dragOffset = 0;
              }).onActionCancel((): void => { this.dragging = ''; this.dragOffset = 0; }))
        }
        Column({ space: 2 }) {
          Row({ space: 6 }) {
            Text(item.displayContent).fontSize(MobileDesignTypography.bodyMedium.size).fontColor(INK).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).flexShrink(1)
            if (item.attachmentCount > 0) { Text(RemoteI18n.f('queue.attachments', `${item.attachmentCount}`)).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED).flexShrink(0) }
          }.width('100%')
          if (item.status !== 'queued') { Text(RemoteI18n.t('queue.waiting')).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED) }
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button({ type: ButtonType.Normal }) { SymbolGlyph($r('sys.symbol.arrow_up')).fontSize(16).fontColor([MUTED]) }
          .width(44).height(48).backgroundColor(TRANSPARENT).accessibilityText(RemoteI18n.t('queue.sendNow')).enabled(!this.state.busy && !this.state.failure && item.status !== 'steering_pending')
          .onClick((): void => this.onAction({ sessionId: this.state.sessionId, action: 'promote', turnId: item.turnId }))
        Button({ type: ButtonType.Normal }) { Image($r('app.media.remote_ref_more')).width(16).height(16).fillColor(MUTED).renderMode(ImageRenderMode.Template) }
          .width(44).height(48).backgroundColor(TRANSPARENT).accessibilityText(RemoteI18n.t('queue.more')).bindMenu(this.Actions(item))
      }.width('100%').height(48)
    }.width('100%').translate({ y: this.dragging === item.turnId ? this.dragOffset : 0 }).backgroundColor(this.dragging === item.turnId ? CARD : TRANSPARENT).zIndex(this.dragging === item.turnId ? 1 : 0)
  }
  build() {
    if (this.state.items.length > 0 || this.state.failure.length > 0) {
      Column() {
        Row({ space: 6 }) {
          Text(RemoteI18n.f('queue.title', `${this.state.items.length}`)).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED)
          SymbolGlyph(this.expanded ? $r('sys.symbol.chevron_down') : $r('sys.symbol.chevron_up')).fontSize(12).fontColor([MUTED])
        }.width('100%').height(40).onClick((): void => { this.expanded = !this.expanded; })
        if (this.state.failure.length > 0) {
          Row() {
            Text(RemoteI18n.t(this.state.failure === 'unsupported' ? 'queue.unsupported' : 'queue.refreshRequired')).fontSize(MobileDesignTypography.bodySmall.size).fontColor(MUTED).layoutWeight(1)
            Button(RemoteI18n.t('queue.refresh')).fontColor(INK).backgroundColor(TRANSPARENT).height(44).onClick((): void => this.onAction({ sessionId: this.state.sessionId, action: 'list' }))
          }
        }
        if (this.expanded) { Scroll() { Column() { ForEach(this.state.items, (item: MessageQueueItem, index: number): void => { this.MessageRow(item, index) }, (item: MessageQueueItem): string => item.turnId) } }.constraintSize({ maxHeight: 196 }).scrollBar(BarState.Auto) }
      }.width('100%').padding({ left: MobileDesignGeometry.contentGutter, right: MobileDesignGeometry.contentGutter })
    }
  }
}
