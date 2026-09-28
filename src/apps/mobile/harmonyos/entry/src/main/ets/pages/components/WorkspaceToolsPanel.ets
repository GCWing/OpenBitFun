import { RuntimeLocationPolicy } from '../policy/RuntimeLocationPolicy';
import { WorkspaceFileEditorView } from './WorkspaceFileEditorView';
import { WorkspaceTerminalView } from './WorkspaceTerminalView';
import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry, WorkspaceTerminalEntry, WorkspaceToolLocation } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, CONTENT_ON_ACTION, INK, MEDIA_BACKGROUND, MUTED, PAGE_BG, LINE, SOFT, TRANSPARENT } from './Theme';
import { SheetCloseButton } from './SheetCloseButton';

@ComponentV2
export struct WorkspaceToolsPanel {
  @Param state: WorkspaceToolsState = new WorkspaceToolsState();
  @Event onIntent: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  private filesScroller: Scroller = new Scroller();
  @Monitor('state.directory', 'state.connectionId', 'state.sort')
  private onFileLocationChanged(): void {
    this.filesScroller.scrollEdge(Edge.Top);
  }
  build() {
    Column({ space: 0 }) {
      Row({ space: 12 }) {
        Blank().layoutWeight(1)
        SheetCloseButton({ uniformGlyph: true, onClose: () => this.onIntent({ type: 'close' }) })
      }
      .width('100%')
      .height(56)
      .alignItems(VerticalAlign.Center)
      if (this.state.deviceScope) {
        Select([{ value: RemoteI18n.t('workspaceTools.runtimeLocal') }, ...this.state.locations.map((item: WorkspaceToolLocation): SelectOption => ({ value: item.name }))])
          .value(this.state.locations.find((item: WorkspaceToolLocation): boolean => item.id === this.state.connectionId)?.name || RemoteI18n.t('workspaceTools.runtimeLocal'))
          .fontColor(INK).width('100%').height(48).enabled(!this.state.busy)
          .backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(12)
          .onSelect((index: number) => this.onIntent({ type: 'open-device', connectionId: index === 0 ? '' : this.state.locations[index - 1]?.id, tab: this.state.initialTab }))
      }
      if (this.state.error.length > 0) { Text(this.state.saveConflict ? RemoteI18n.t('workspaceTools.fileConflict') : this.state.error).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size) }
      if (this.state.confirmDiscard) {
        Text(RemoteI18n.t('workspaceTools.unsaved')).fontColor(INK)
        Row({ space: 8 }) {
          Button(RemoteI18n.t('common.cancel')).onClick(() => this.onIntent({ type: 'discard-cancel' }))
          Button(RemoteI18n.t('workspaceTools.discard')).onClick(() => this.onIntent({ type: 'discard-confirm' }))
        }
      }
      Tabs({ index: this.state.initialTab }) {
        TabContent() { this.Files() }.tabBar(new SubTabBarStyle(RemoteI18n.t('workspaceTools.files')).labelStyle({ selectedColor: INK, unselectedColor: MUTED }).indicator({ color: INK }))
        TabContent() { this.Terminal() }.tabBar(new SubTabBarStyle(RemoteI18n.t('workspaceTools.terminal')).labelStyle({ selectedColor: INK, unselectedColor: MUTED }).indicator({ color: INK }))
      }.onChange((index: number) => this.onIntent({ type: 'panel', tab: index })).layoutWeight(1)
    }.padding({ left: 16, right: 16, bottom: 16 }).width('100%').height('100%').backgroundColor(PAGE_BG)
  }
  @Builder
  private Files() {
    if (this.state.editorVisible) { this.Editor() } else { this.FileDirectory() }
  }
  private sortTitle(): string {
    if (this.state.sort === 1) return RemoteI18n.t('workspaceTools.nameDesc');
    if (this.state.sort === 2) return RemoteI18n.t('workspaceTools.modifiedAsc');
    if (this.state.sort === 3) return RemoteI18n.t('workspaceTools.modifiedDesc');
    return RemoteI18n.t('workspaceTools.nameAsc');
  }
  private fileActionTitle(): string {
    if (this.state.fileAction === 'file') return RemoteI18n.t('workspaceTools.newFile');
    if (this.state.fileAction === 'folder') return RemoteI18n.t('workspaceTools.mkdir');
    if (this.state.fileAction === 'rename') return RemoteI18n.t('workspaceTools.rename');
    if (this.state.fileAction === 'upload') return RemoteI18n.t('workspaceTools.upload');
    return RemoteI18n.t('workspaceTools.confirmDelete');
  }
  @Builder
  private FileActionForm() {
    Column({ space: 16 }) {
      Row({ space: 12 }) {
        Button(RemoteI18n.t('common.cancel'))
          .fontColor(MUTED).backgroundColor(TRANSPARENT).height(40).borderRadius(8)
          .onClick(() => this.onIntent({ type: 'file-action-cancel' }))
        Text(this.fileActionTitle()).fontColor(INK).fontSize(MobileDesignTypography.titleMedium.size).fontWeight(FontWeight.Medium).layoutWeight(1).maxLines(2)
        Button(this.fileActionTitle())
          .fontColor(CONTENT_ON_ACTION).backgroundColor(INK).height(40).borderRadius(8)
          .enabled(this.state.fileAction === 'delete' || this.state.fileActionName.trim().length > 0)
          .onClick(() => this.onIntent({ type: 'file-action-submit' }))
      }.enabled(!this.state.busy).width('100%')
      if (this.state.fileAction === 'delete') {
        Text(this.state.fileActionPath).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size).maxLines(3)
      }
      else {
        TextInput({ text: this.state.fileActionName, placeholder: RemoteI18n.t('workspaceTools.fileName') })
          .fontColor(INK).backgroundColor(SOFT).borderRadius(8).height(48).enabled(!this.state.busy)
          .onChange((value: string) => this.onIntent({ type: 'file-action-name', text: value }))
          .onSubmit(() => { if (!this.state.busy && this.state.fileActionName.trim()) this.onIntent({ type: 'file-action-submit' }); })
      }
      if (this.state.error) { Text(this.state.error).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size) }
      if (this.state.busy) { LoadingProgress().width(24).height(24).color(MUTED) }
    }.padding({ left: 20, right: 20, top: 20, bottom: 24 }).width('100%').backgroundColor(CARD)
  }
  @Builder
  private FileDirectory() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button() { SymbolGlyph($r('sys.symbol.arrow_up')).fontColor([INK]).fontSize(18) }
          .width(40).height(40).padding(0).backgroundColor(TRANSPARENT).borderRadius(8).accessibilityText(RemoteI18n.t('workspaceTools.up'))
          .onClick(() => this.onIntent({ type: 'directory', path: RuntimeLocationPolicy.parent(this.state.directory) }))
        Text(this.state.directory).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
        Button() { SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontColor([MUTED]).fontSize(18) }
          .width(40).height(40).padding(0).backgroundColor(TRANSPARENT).borderRadius(8).accessibilityText(RemoteI18n.t('workspaceTools.refresh'))
          .onClick(() => this.onIntent({ type: 'directory' }))
      }.width('100%').height(48).padding({ left: 4, right: 4 }).backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(8)
      Scroll() {
        Row({ space: 8 }) {
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.doc_text')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.newFile')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.height(36).padding({ left: 10, right: 10 }).backgroundColor(SOFT).borderRadius(8)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'file' }))
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.folder')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.mkdir')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.height(36).padding({ left: 10, right: 10 }).backgroundColor(SOFT).borderRadius(8)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'folder' }))
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.doc_text_badge_arrow_up')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.upload')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.height(36).padding({ left: 10, right: 10 }).backgroundColor(SOFT).borderRadius(8)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'upload' }))
        }
      }.scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off).width('100%').height(40)
      Row({ space: 8 }) {
        Blank().layoutWeight(1)
        Select([
        { value: RemoteI18n.t('workspaceTools.nameAsc') }, { value: RemoteI18n.t('workspaceTools.nameDesc') },
        { value: RemoteI18n.t('workspaceTools.modifiedAsc') }, { value: RemoteI18n.t('workspaceTools.modifiedDesc') }
        ]).selected(this.state.sort).value(this.sortTitle()).fontColor(INK).height(36).layoutWeight(1).enabled(!this.state.busy)
          .backgroundColor(SOFT).borderRadius(18)
          .onSelect((index: number) => this.onIntent({ type: 'sort', text: String(index) }))
      }.enabled(!this.state.busy).width('100%')
      if (this.state.busy) { LoadingProgress().width(24).height(24).color(MUTED) }
      List({ scroller: this.filesScroller }) {
        ForEach(this.state.entries, (entry: WorkspaceFileEntry) => {
          ListItem() {
            Row({ space: 8 }) {
              Row({ space: 12 }) {
                SymbolGlyph(entry.isDirectory ? $r('sys.symbol.folder') : $r('sys.symbol.doc_text')).fontColor([MUTED]).fontSize(20)
                Text(entry.name).fontColor(INK).fontSize(MobileDesignTypography.bodyMedium.size).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1)
              }.layoutWeight(1).constraintSize({ minHeight: 56 }).onClick(() => this.onIntent({ type: entry.isDirectory ? 'directory' : 'read', path: entry.path }))
              Button() { this.MoreGlyph() }
                .width(40).height(40).padding(0).backgroundColor(TRANSPARENT).borderRadius(8).accessibilityText(entry.name)
                .bindMenu([
                  { value: RemoteI18n.t('workspaceTools.rename'), action: () => this.onIntent({ type: 'file-action', text: 'rename', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.delete'), action: () => this.onIntent({ type: 'file-action', text: 'delete', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.download'), enabled: !entry.isDirectory, action: () => this.onIntent({ type: 'download', path: entry.path }) }
                ])
            }.width('100%').padding({ left: 12, right: 8 }).backgroundColor(CARD)
          }
        }, (entry: WorkspaceFileEntry) => entry.path)
        if (this.state.hasMore) { ListItem() { Button(RemoteI18n.t('workspaceTools.more')).fontColor(INK).backgroundColor(TRANSPARENT).height(44).onClick(() => this.onIntent({ type: 'more' })) } }
      }.divider({ strokeWidth: 1, color: LINE }).border({ width: 1, color: LINE }).borderRadius(8).layoutWeight(1).enabled(!this.state.busy)
      if (this.state.downloadStatus) { Text(this.state.downloadStatus).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size) }
      if (this.state.uploadPending) {
        Progress({ value: this.state.uploadProgress, total: 100, type: ProgressType.Linear })
        Row({ space: 8 }) {
          Button(RemoteI18n.t('workspaceTools.resumeUpload')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'upload-resume' }))
          Button(RemoteI18n.t('workspaceTools.cancelUpload')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'upload-cancel' }))
        }.enabled(!this.state.busy)
      }
      }.padding({ top: 12 }).width('100%').height('100%')
      .bindSheet(this.state.fileAction.length > 0, this.FileActionForm(), { height: SheetSize.FIT_CONTENT, showClose: false, backgroundColor: PAGE_BG, keyboardAvoidMode: SheetKeyboardAvoidMode.TRANSLATE_AND_RESIZE,
        onWillDismiss: (action: DismissSheetAction): void => { if (!this.state.busy) { this.onIntent({ type: 'file-action-cancel' }); action.dismiss(); } } })
  }
  @Builder
  private MoreGlyph() {
    Row({ space: 3 }) {
      Circle().width(3).height(3).fill(MUTED)
      Circle().width(3).height(3).fill(MUTED)
      Circle().width(3).height(3).fill(MUTED)
    }
  }
  @Builder
  private Editor() {
    Column({ space: 12 }) {
      Row({ space: 8 }) {
        Button() { SymbolGlyph($r('sys.symbol.chevron_left')).fontColor([INK]).fontSize(18) }
          .width(40).height(40).padding(0).backgroundColor(TRANSPARENT).borderRadius(8)
          .accessibilityText(RemoteI18n.t('workspaceTools.back'))
          .onClick(() => this.onIntent({ type: 'editor-back' }))
        Column({ space: 2 }) {
          Text(this.state.selectedFile.split('/').pop() || this.state.selectedFile)
            .fontColor(INK).fontSize(MobileDesignTypography.titleSmall.size).fontWeight(FontWeight.Medium)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
          Text(this.state.selectedFile).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).width('100%')
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        if (this.state.dirty) { Text('•').fontColor(MUTED).fontSize(MobileDesignTypography.bodyLarge.size) }
      }.width('100%').height(48)
      Row({ space: 8 }) {
        Button() { SymbolGlyph($r('sys.symbol.arrow_down_to_line')).fontColor([MUTED]).fontSize(16) }
          .width(40).height(36).padding(0).backgroundColor(SOFT).borderRadius(8)
          .accessibilityText(RemoteI18n.t('workspaceTools.download')).enabled(!this.state.busy)
          .onClick(() => this.onIntent({ type: 'download' }))
        Button(RemoteI18n.t('workspaceTools.lineNumbers')).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
          .height(36).backgroundColor(SOFT).borderRadius(8).onClick(() => this.onIntent({ type: 'line-numbers' }))
        if (this.state.editing) {
          Button(RemoteI18n.t('workspaceTools.save')).fontColor(CONTENT_ON_ACTION).backgroundColor(INK).height(36).borderRadius(8)
            .enabled(!this.state.busy).onClick(() => this.onIntent({ type: 'save' }))
        } else {
          Button(RemoteI18n.t('workspaceTools.edit')).fontColor(INK).backgroundColor(SOFT).height(36).borderRadius(8)
            .onClick(() => this.onIntent({ type: 'editor-edit' }))
        }
      }.width('100%').justifyContent(FlexAlign.End)
      WorkspaceFileEditorView({ content: this.state.content, editing: this.state.editing,
        lineNumbers: this.state.lineNumbers, onIntent: this.onIntent }).layoutWeight(1)
        .border({ width: 1, color: LINE }).borderRadius(8).backgroundColor(CARD)
    }.padding({ top: 12 }).width('100%').height('100%')
  }
  private terminalOptions(): SelectOption[] {
    return this.state.terminals.map((entry: WorkspaceTerminalEntry): SelectOption => ({ value: entry.name || entry.id }));
  }
  @Builder
  private Terminal() {
    Column({ space: 12 }) {
      if (this.state.terminalId.length === 0) {
        Column({ space: 16 }) {
          Stack({ alignContent: Alignment.Center }) {
            SymbolGlyph($r('sys.symbol.rectangle_stack')).fontColor([MUTED]).fontSize(32)
          }.width(72).height(72).backgroundColor(SOFT).borderRadius(20)
          Button(RemoteI18n.t('workspaceTools.createTerminal'))
            .fontColor(CONTENT_ON_ACTION).backgroundColor(INK)
            .borderRadius(8).height(44).padding({ left: 18, right: 18 })
            .enabled(!this.state.busy)
            .onClick(() => this.onIntent({ type: 'terminal-create' }))
          if (this.state.terminals.length > 0) {
            Select(this.terminalOptions()).value(RemoteI18n.t('workspaceTools.selectTerminal')).fontColor(INK).height(44)
              .backgroundColor(SOFT).borderRadius(8)
              .onSelect((index: number) => this.onIntent({ type: 'terminal-attach', path: this.state.terminals[index]?.id }))
          }
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center).border({ width: 1, color: LINE }).borderRadius(12)
      } else {
      Row({ space: 8 }) {
        Button() { SymbolGlyph($r('sys.symbol.plus')).fontColor([INK]).fontSize(17) }
          .width(40).height(40).padding(0).backgroundColor(SOFT).borderRadius(8)
          .accessibilityText(RemoteI18n.t('workspaceTools.createTerminal'))
          .onClick(() => this.onIntent({ type: 'terminal-create' }))
        Select(this.terminalOptions()).value(this.state.terminals.find((entry: WorkspaceTerminalEntry): boolean => entry.id === this.state.terminalId)?.name || this.state.terminalId)
          .fontColor(INK).height(40).layoutWeight(1).backgroundColor(SOFT).borderRadius(8)
          .onSelect((index: number) => this.onIntent({ type: 'terminal-attach', path: this.state.terminals[index]?.id }))
      }.enabled(!this.state.busy).width('100%')
      Row() {
        WorkspaceTerminalView({ terminalId: this.state.terminalId, output: this.state.output, onIntent: this.onIntent })
      }.layoutWeight(1).width('100%').padding(10).backgroundColor(MEDIA_BACKGROUND).borderRadius(12)
      Row({ space: 8 }) {
        Scroll() {
          Row({ space: 8 }) {
            Button('Esc').fontColor(INK).backgroundColor(SOFT).borderRadius(8).height(36).onClick(() => this.onIntent({ type: 'terminal-write', text: '\u001b' }))
            Button('Tab').fontColor(INK).backgroundColor(SOFT).borderRadius(8).height(36).onClick(() => this.onIntent({ type: 'terminal-write', text: '\t' }))
            Button('Enter').fontColor(INK).backgroundColor(SOFT).borderRadius(8).height(36).onClick(() => this.onIntent({ type: 'terminal-write', text: '\r' }))
            Button('Ctrl-C').fontColor(INK).backgroundColor(SOFT).borderRadius(8).height(36).onClick(() => this.onIntent({ type: 'terminal-write', text: '\u0003' }))
          }
        }.layoutWeight(1).height(40).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        Button() { SymbolGlyph($r('sys.symbol.xmark')).fontColor([MUTED]).fontSize(16) }
          .width(40).height(36).padding(0).backgroundColor(SOFT).borderRadius(8)
          .accessibilityText(RemoteI18n.t('workspaceTools.closeTerminal'))
          .onClick(() => this.onIntent({ type: 'terminal-close' }))
      }.width('100%').enabled(this.state.terminalId.length > 0)
      }
    }.padding({ top: 8 }).width('100%').height('100%')
  }
}
