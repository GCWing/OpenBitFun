import { RuntimeLocationPolicy } from '../policy/RuntimeLocationPolicy';
import { AdaptiveSheetOptions } from './AdaptiveSheetOptions';
import { SheetActionFooter } from './SheetActionFooter';
import { SHEET_HORIZONTAL_PADDING } from './SheetLayout';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { WorkspaceFileEditorView } from './WorkspaceFileEditorView';
import { WorkspaceTerminalView } from './WorkspaceTerminalView';
import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry, WorkspaceTerminalEntry, WorkspaceToolLocation } from '../state/WorkspaceToolsState';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { CARD, CONTENT_ON_ACTION, INK, MEDIA_BACKGROUND, MUTED, PAGE_BG, LINE, SOFT, TRANSPARENT } from './Theme';
import { ImmersiveSurfaceSupport } from './ImmersiveSurfaceSupport';
import { ImmersiveSurfaceScene } from '../policy/ImmersiveMaterialPolicy';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

@ComponentV2
export struct WorkspaceToolsPanel {
  @Param state: WorkspaceToolsState = new WorkspaceToolsState();
  @Event onIntent: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  /**
   * The placement the panel's own sheet was resolved to. The form is a sheet
   * inside this one, so it lands where the panel lands: the bottom edge of the
   * phone it has always been at, the same leaf of a foldable, and — on a wide
   * window — the middle of the screen, as a dialog of its own over the panel's.
   */
  @Param fileActionPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.WorkspaceTools);
  private filesScroller: Scroller = new Scroller();
  /**
   * The sheet's own bottom edge, in vp. The panel is a full-height sheet, so
   * its scrolling viewport runs to the screen edge and its rows roll under the
   * navigation indicator; the tail spacer and the fixed bottom controls are
   * what keep the bar clear.
   */
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  @Monitor('state.directory', 'state.connectionId', 'state.sort')
  private onFileLocationChanged(): void {
    this.filesScroller.scrollEdge(Edge.Top);
  }

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    Column({ space: 0 }) {
      if (this.state.deviceScope) {
        Select([{ value: RemoteI18n.t('workspaceTools.runtimeLocal') }, ...this.state.locations.map((item: WorkspaceToolLocation): SelectOption => ({ value: item.name }))])
          .value(this.state.locations.find((item: WorkspaceToolLocation): boolean => item.id === this.state.connectionId)?.name || RemoteI18n.t('workspaceTools.runtimeLocal'))
          .fontColor(INK).width('100%').height(54).enabled(!this.state.busy)
          .backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(16)
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
      }.barHeight(50).onChange((index: number) => this.onIntent({ type: 'panel', tab: index })).layoutWeight(1)
    }.padding({ left: 16, right: 16 }).width('100%').height('100%')
      // No fill and no close header of its own: the platform sheet carries both,
      // and its title bar is where this panel's name (and its close icon) live.
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
  /**
   * Whether the form's one action can run yet.
   *
   * The name is what the action works on, except for the delete that already
   * has its target: an empty field is nothing to create or rename, while a
   * delete is ready the moment the sheet opens on a path. A submission in
   * flight locks the action, the way it locked the row it used to sit in.
   */
  private canSubmitFileAction(): boolean {
    return !this.state.busy && (this.state.fileAction === 'delete' || this.state.fileActionName.trim().length > 0);
  }
  /**
   * The file action form's own sheet options.
   *
   * A nested sheet is a sheet like any other: the platform draws its title bar
   * and its close icon, so the form has to say what it is doing here or the bar
   * arrives nameless — which is what put the platform's close icon on top of the
   * form's own action row — and it lands where its host landed, which a wide
   * window answers with the middle of the screen. Every interactive dismissal
   * (the close icon, the scrim, the swipe down) reaches `onWillDismiss`, so the
   * action still ends the way its Cancel button did, and a submission in flight
   * still refuses to be cancelled out from under itself.
   */
  private fileActionSheetOptions(): SheetOptions {
    const options: SheetOptions = AdaptiveSheetOptions.form(
      this.fileActionPlacement,
      this.fileActionTitle()
    );
    options.onWillDismiss = (action: DismissSheetAction): void => {
      if (!this.state.busy) { this.onIntent({ type: 'file-action-cancel' }); action.dismiss(); }
    };
    return ImmersiveSurfaceSupport.sheetOptions(ImmersiveSurfaceScene.MODAL_SHEET, options);
  }
  @Builder
  private FileActionForm() {
    Column({ space: 0 }) {
      Column({ space: 16 }) {
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
      }.padding({
        left: SHEET_HORIZONTAL_PADDING,
        right: SHEET_HORIZONTAL_PADDING,
        top: 20
      }).width('100%')
      // What the form is doing is the platform title bar's line now, and the
      // close icon on that bar is how it is cancelled — the same dismissal the
      // scrim and the swipe down perform, all three of them resetting the
      // action through `onWillDismiss`. The row that carried a Cancel button, an
      // action name and a Submit button is therefore gone: an action name beside
      // the name in the title bar said it twice, a Cancel button beside a close
      // icon did too, and the Submit button is what the shared footer is.
      SheetActionFooter({
        label: this.fileActionTitle(),
        primary: true,
        isEnabled: this.canSubmitFileAction(),
        onAction: () => this.onIntent({ type: 'file-action-submit' })
      })
    }.width('100%')
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
      Row({ space: 8 }) {
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.doc_text')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.newFile')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.layoutWeight(1).height(44).padding({ left: 4, right: 4 }).backgroundColor(CARD).border({ width: 1, color: LINE }).borderRadius(13)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'file' }))
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.folder')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.mkdir')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.layoutWeight(1).height(44).padding({ left: 4, right: 4 }).backgroundColor(SOFT).borderRadius(13)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'folder' }))
        Button() {
          Row({ space: 6 }) {
            SymbolGlyph($r('sys.symbol.doc_text_badge_arrow_up')).fontColor([INK]).fontSize(16)
            Text(RemoteI18n.t('workspaceTools.upload')).fontColor(INK).fontSize(MobileDesignTypography.labelSmall.size)
          }
        }.layoutWeight(1).height(44).padding({ left: 4, right: 4 }).backgroundColor(SOFT).borderRadius(13)
          .onClick(() => this.onIntent({ type: 'file-action', text: 'upload' }))
      }.width('100%').height(44)
      Row({ space: 8 }) {
        Row({ space: 6 }) {
          Text(RemoteI18n.t('workspaceTools.files')).fontColor(INK).fontSize(MobileDesignTypography.bodySmall.size).fontWeight(FontWeight.Medium)
          Text(String(this.state.entries.length)).fontColor(MUTED).fontSize(MobileDesignTypography.labelSmall.size)
        }.layoutWeight(1).alignItems(VerticalAlign.Center)
        Select([
        { value: RemoteI18n.t('workspaceTools.nameAsc') }, { value: RemoteI18n.t('workspaceTools.nameDesc') },
        { value: RemoteI18n.t('workspaceTools.modifiedAsc') }, { value: RemoteI18n.t('workspaceTools.modifiedDesc') }
        ]).selected(this.state.sort).value(this.sortTitle()).fontColor(MUTED).height(34).width(132).enabled(!this.state.busy)
          .backgroundColor(SOFT).borderRadius(17)
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
                // `menuOptions` answers `undefined` on every device that cannot
                // render a material, so this call passes exactly what the
                // two-argument form omits: the SDK declares that overload as
                // `bindMenu(content: Array<MenuElement> | CustomBuilder,
                // options?: MenuOptions): T` (`ets/component/
                // common.d.ts`, line 21466 in the 6.0.1 SDK; the `isShow`
                // overload at line 21480 is equally optional), where
                // `options?` is optional, so an explicit `undefined` and the
                // omission are the
                // same call. The fallback path below API 26 is the only one that
                // reaches that form, and it is unverified on hardware.
                .bindMenu([
                  { value: RemoteI18n.t('workspaceTools.rename'), action: () => this.onIntent({ type: 'file-action', text: 'rename', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.delete'), action: () => this.onIntent({ type: 'file-action', text: 'delete', path: entry.path }) },
                  { value: RemoteI18n.t('workspaceTools.download'), enabled: !entry.isDirectory, action: () => this.onIntent({ type: 'download', path: entry.path }) }
                ], ImmersiveSurfaceSupport.menuOptions(ImmersiveSurfaceScene.FLOATING_MENU))
            }.width('100%').padding({ left: 12, right: 8 }).backgroundColor(CARD)
          }
        }, (entry: WorkspaceFileEntry) => entry.path)
        if (this.state.hasMore) { ListItem() { Button(RemoteI18n.t('workspaceTools.more')).fontColor(INK).backgroundColor(TRANSPARENT).height(44).onClick(() => this.onIntent({ type: 'more' })) } }
        // The list's tail spacer: the strip plus the panel's own breathing, so
        // the viewport can run to the screen edge — rows roll under the
        // navigation indicator while they are moving — while the last row
        // still rests above the bar.
        ListItem() {
          Column().width('100%').height(this.insets.tailSpacing(16))
        }
      }.divider({ strokeWidth: 1, color: LINE }).border({ width: 1, color: LINE }).borderRadius(8).layoutWeight(1).enabled(!this.state.busy)
      if (this.state.downloadStatus || this.state.uploadPending) {
        Column({ space: 8 }) {
          if (this.state.downloadStatus) { Text(this.state.downloadStatus).fontColor(MUTED).fontSize(MobileDesignTypography.bodySmall.size) }
          if (this.state.uploadPending) {
            Progress({ value: this.state.uploadProgress, total: 100, type: ProgressType.Linear })
            Row({ space: 8 }) {
              Button(RemoteI18n.t('workspaceTools.resumeUpload')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'upload-resume' }))
              Button(RemoteI18n.t('workspaceTools.cancelUpload')).fontColor(INK).backgroundColor(PAGE_BG).onClick(() => this.onIntent({ type: 'upload-cancel' }))
            }.enabled(!this.state.busy)
          }
        }.width('100%').margin({ bottom: this.insets.bottomPadding(16) })
      }
      }.padding({ top: 12 }).width('100%').height('100%')
      .bindSheet(this.state.fileAction.length > 0, this.FileActionForm(), this.fileActionSheetOptions())
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
      // The editor is a WebView: its scrolling and its padding live inside the
      // web renderer, so the panel cannot end it in an ArkUI tail spacer the
      // way the file list does. The card is therefore fixed content, like the
      // terminal key row: its bottom edge stops at the navigation bar's top,
      // while the sheet's own fill still reaches the screen edge below it.
      WorkspaceFileEditorView({ content: this.state.content, editing: this.state.editing,
        lineNumbers: this.state.lineNumbers, onIntent: this.onIntent }).layoutWeight(1)
        .border({ width: 1, color: LINE }).borderRadius(8).backgroundColor(CARD)
        .margin({ bottom: this.insets.bottomPadding(16) })
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
        // The key row is the tab's fixed bottom control; it keeps the strip
        // clear so the terminal above it ends above the navigation bar.
        .margin({ bottom: this.insets.bottomPadding(16) })
      }
    }.padding({ top: 8 }).width('100%').height('100%')
  }
}
