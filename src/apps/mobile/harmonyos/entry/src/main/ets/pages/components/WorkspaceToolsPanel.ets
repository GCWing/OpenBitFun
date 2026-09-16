import { RuntimeLocationPolicy } from '../policy/RuntimeLocationPolicy';
import { WorkspaceFileEditorView } from './WorkspaceFileEditorView';
import { WorkspaceTerminalView } from './WorkspaceTerminalView';
import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry, WorkspaceTerminalEntry, WorkspaceToolLocation } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { INK, MUTED, PAGE_BG, LINE } from './Theme';

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
    Column({ space: 8 }) {
      Row() {
        Text(RemoteI18n.t('workspaceTools.title')).fontSize(MobileDesignTypography.bodyLarge.size).fontColor(INK).layoutWeight(1)
        Button(RemoteI18n.t('common.close')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'close' }))
      }
      if (this.state.deviceScope) {
        Select([{ value: RemoteI18n.t('workspaceTools.runtimeLocal') }, ...this.state.locations.map((item: WorkspaceToolLocation): SelectOption => ({ value: item.name }))])
          .value(this.state.locations.find((item: WorkspaceToolLocation): boolean => item.id === this.state.connectionId)?.name || RemoteI18n.t('workspaceTools.runtimeLocal'))
          .fontColor(INK).width('100%').enabled(!this.state.busy)
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
    }.padding(16).width('100%').height('100%').backgroundColor(PAGE_BG)
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
        Button(RemoteI18n.t('common.cancel')).fontColor(INK).backgroundColor(PAGE_BG).height(44)
          .onClick(() => this.onIntent({ type: 'file-action-cancel' }))
        Text(this.fileActionTitle()).fontColor(INK).fontSize(MobileDesignTypography.bodyLarge.size).layoutWeight(1).maxLines(2)
        Button(this.fileActionTitle()).fontColor(PAGE_BG).backgroundColor(INK).height(44)
          .enabled(this.state.fileAction === 'delete' || this.state.fileActionName.trim().length > 0)
          .onClick(() => this.onIntent({ type: 'file-action-submit' }))
      }.enabled(!this.state.busy).width('100%')
      if (this.state.fileAction === 'delete') { Text(this.state.fileActionPath).fontColor(MUTED) }
      else {
        TextInput({ text: this.state.fileActionName, placeholder: RemoteI18n.t('workspaceTools.fileName') }).fontColor(INK).enabled(!this.state.busy)
          .onChange((value: string) => this.onIntent({ type: 'file-action-name', text: value }))
          .onSubmit(() => { if (!this.state.busy && this.state.fileActionName.trim()) this.onIntent({ type: 'file-action-submit' }); })
      }
      if (this.state.error) { Text(this.state.error).fontColor(MUTED) }
      if (this.state.busy) { LoadingProgress().width(24).height(24).color(MUTED) }
    }.padding(24).width('100%')
  }
  @Builder
  private FileDirectory() {
    Column({ space: 8 }) {
      Text(this.state.directory).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size).maxLines(2).width('100%').textAlign(TextAlign.Start)
      Row({ space: 4 }) {
        Button() { SymbolGlyph($r('sys.symbol.arrow_up')).fontColor([INK]).fontSize(20) }
          .width(44).height(44).backgroundColor(PAGE_BG).accessibilityText(RemoteI18n.t('workspaceTools.up'))
          .onClick(() => this.onIntent({ type: 'directory', path: RuntimeLocationPolicy.parent(this.state.directory) }))
        Button() { SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontColor([INK]).fontSize(20) }
          .width(44).height(44).backgroundColor(PAGE_BG).accessibilityText(RemoteI18n.t('workspaceTools.refresh'))
          .onClick(() => this.onIntent({ type: 'directory' }))
        Select([
        { value: RemoteI18n.t('workspaceTools.nameAsc') }, { value: RemoteI18n.t('workspaceTools.nameDesc') },
        { value: RemoteI18n.t('workspaceTools.modifiedAsc') }, { value: RemoteI18n.t('workspaceTools.modifiedDesc') }
      ]).selected(this.state.sort).value(this.sortTitle()).fontColor(INK).layoutWeight(1).enabled(!this.state.busy)
        .onSelect((index: number) => this.onIntent({ type: 'sort', text: String(index) }))
        Button() { SymbolGlyph($r('sys.symbol.plus')).fontColor([INK]).fontSize(20) }
          .width(44).height(44).backgroundColor(PAGE_BG).bindMenu([
            { value: RemoteI18n.t('workspaceTools.newFile'), action: () => this.onIntent({ type: 'file-action', text: 'file' }) },
            { value: RemoteI18n.t('workspaceTools.mkdir'), action: () => this.onIntent({ type: 'file-action', text: 'folder' }) },
            { value: RemoteI18n.t('workspaceTools.upload'), action: () => this.onIntent({ type: 'file-action', text: 'upload' }) }
          ])
      }.enabled(!this.state.busy).width('100%')
      if (this.state.busy) { LoadingProgress().width(24).height(24).color(MUTED) }
      List({ scroller: this.filesScroller }) {
        ForEach(this.state.entries, (entry: WorkspaceFileEntry) => {
          ListItem() {
            Row({ space: 8 }) {
              Row({ space: 12 }) {
                SymbolGlyph(entry.isDirectory ? $r('sys.symbol.folder') : $r('sys.symbol.doc')).fontColor([MUTED]).fontSize(22)
                Text(entry.name).fontColor(INK).fontSize(MobileDesignTypography.bodyMedium.size).maxLines(2).layoutWeight(1)
              }.layoutWeight(1).constraintSize({ minHeight: 52 }).onClick(() => this.onIntent({ type: entry.isDirectory ? 'directory' : 'read', path: entry.path }))
              Button() { Text('⋯').fontColor(MUTED).fontSize(MobileDesignTypography.headlineSmall.size) }
                .width(44).height(44).backgroundColor(PAGE_BG).bindMenu([
                  { value: RemoteI18n.t('workspaceTools.rename'), action: () => this.onIntent({ type: 'file-action', text: 'rename', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.delete'), action: () => this.onIntent({ type: 'file-action', text: 'delete', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.download'), enabled: !entry.isDirectory, action: () => this.onIntent({ type: 'download', path: entry.path }) }
                ])
            }.width('100%')
          }
        }, (entry: WorkspaceFileEntry) => entry.path)
        if (this.state.hasMore) { ListItem() { Button(RemoteI18n.t('workspaceTools.more')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'more' })) } }
      }.divider({ strokeWidth: 1, color: LINE }).layoutWeight(1).enabled(!this.state.busy)
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
  private Editor() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button(RemoteI18n.t('workspaceTools.back')).onClick(() => this.onIntent({ type: 'editor-back' }))
        Text(this.state.selectedFile).fontColor(MUTED).layoutWeight(1).maxLines(2)
      }
      Row({ space: 8 }) {
        Button(RemoteI18n.t('workspaceTools.download')).enabled(!this.state.busy).onClick(() => this.onIntent({ type: 'download' }))
        Button(RemoteI18n.t('workspaceTools.lineNumbers')).onClick(() => this.onIntent({ type: 'line-numbers' }))
        if (this.state.editing) {
          Button(RemoteI18n.t('workspaceTools.save')).enabled(!this.state.busy).onClick(() => this.onIntent({ type: 'save' }))
        } else {
          Button(RemoteI18n.t('workspaceTools.edit')).onClick(() => this.onIntent({ type: 'editor-edit' }))
        }
        if (this.state.dirty) { Text(RemoteI18n.t('workspaceTools.unsaved')).fontColor(MUTED) }
      }
      WorkspaceFileEditorView({ content: this.state.content, editing: this.state.editing,
        lineNumbers: this.state.lineNumbers, onIntent: this.onIntent }).layoutWeight(1)
    }.padding({ top: 8 }).width('100%').height('100%')
  }
  private terminalOptions(): SelectOption[] {
    return this.state.terminals.map((entry: WorkspaceTerminalEntry): SelectOption => ({ value: entry.name || entry.id }));
  }
  @Builder
  private Terminal() {
    Column({ space: 8 }) {
      if (this.state.terminalId.length === 0) {
        Column() {
          Button(RemoteI18n.t('workspaceTools.createTerminal'))
            .fontColor(INK).backgroundColor(PAGE_BG)
            .border({ width: 1, color: LINE }).borderRadius(10).height(44)
            .enabled(!this.state.busy)
            .onClick(() => this.onIntent({ type: 'terminal-create' }))
          if (this.state.terminals.length > 0) {
            Select(this.terminalOptions()).value(RemoteI18n.t('workspaceTools.selectTerminal')).fontColor(INK)
              .onSelect((index: number) => this.onIntent({ type: 'terminal-attach', path: this.state.terminals[index]?.id }))
          }
        }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center)
      } else {
      Row({ space: 8 }) {
        Button(RemoteI18n.t('workspaceTools.createTerminal')).fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-create' }))
        Select(this.terminalOptions()).onSelect((index: number) => this.onIntent({ type: 'terminal-attach', path: this.state.terminals[index]?.id }))
      }.enabled(!this.state.busy)
      WorkspaceTerminalView({ terminalId: this.state.terminalId, output: this.state.output, onIntent: this.onIntent }).layoutWeight(1)
      Row({ space: 8 }) {
        Scroll() {
          Row({ space: 8 }) {
            Button('Esc').fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-write', text: '\u001b' }))
            Button('Tab').fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-write', text: '\t' }))
            Button('Enter').fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-write', text: '\r' }))
            Button('Ctrl-C').fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-write', text: '\u0003' }))
          }
        }.layoutWeight(1).height(48).scrollable(ScrollDirection.Horizontal).scrollBar(BarState.Off)
        Button(RemoteI18n.t('workspaceTools.closeTerminal')).fontColor(INK).backgroundColor(PAGE_BG).border({ width: 1, color: LINE }).borderRadius(10).height(44).onClick(() => this.onIntent({ type: 'terminal-close' }))
      }.width('100%').enabled(this.state.terminalId.length > 0)
      }
    }.padding({ top: 8 }).width('100%').height('100%')
  }
}
