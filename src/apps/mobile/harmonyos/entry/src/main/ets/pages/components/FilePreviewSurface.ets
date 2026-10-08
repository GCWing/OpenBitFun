import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import {
  CodeSyntaxHighlightCache,
  CodeSyntaxHighlighter,
  CodeSyntaxToken,
  CodeSyntaxTokenKind
} from '../../services/CodeSyntaxHighlighter';
import { RemoteUiState } from '../../services/RemoteUiState';
import {
  FilePreviewPhase,
  FilePreviewRendererKind,
  FilePreviewState
} from '../state/FilePreviewState';
import { MarkdownContent } from './MarkdownContent';
import { NavigationBackButton } from './NavigationBackButton';
import {
  CARD,
  CODE_COMMENT,
  CODE_CONSTANT,
  CODE_FUNCTION,
  CODE_KEYWORD,
  CODE_LINE_NUMBER,
  CODE_NUMBER,
  CODE_PROPERTY,
  CODE_STRING,
  CODE_TARGET_BG,
  CODE_TYPE,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  SOFT,
  TRANSPARENT,
} from './Theme';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';

@ComponentV2
export struct FilePreviewSurface {
  private readonly textScroller: Scroller = new Scroller();
  private readonly markdownScroller: Scroller = new Scroller();
  private readonly syntaxHighlightCache: CodeSyntaxHighlightCache = new CodeSyntaxHighlightCache();
  private restoreScrollTimerId: number = 0;
  /**
   * The surface's own bottom edge, in vp. The preview scrollers run to the
   * screen edge — content rolls under the navigation indicator while it is
   * moving — and their tail padding is what rests the last line above the bar.
   */
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();
  @Local imageOriginalSizeTarget: string = '';
  @Param state: FilePreviewState = new FilePreviewState();
  @Param remoteAvailable: boolean = true;
  @Param downloadPath: string = '';
  @Param downloadedPath: string = '';
  @Param downloadStatus: string = '';
  @Param previewExpanded: boolean = false;
  @Param canToggleExpanded: boolean = false;
  @Event onClose: () => void = () => {};
  @Event onRefresh: () => void = () => {};
  @Event onDownload: (path: string) => void = (_path: string) => {};
  @Event onOpenLink: (reference: string, label: string) => void = (_reference: string, _label: string) => {};
  @Event onToggleExpanded: () => void = () => {};

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
  }

  aboutToDisappear(): void {
    this.insets.unbind();
    this.clearRestoreScrollTimer();
  }

  build() {
    Column() {
      this.Header()
      this.DownloadStatus()
      this.Body()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  @Builder
  Header() {
    Row({ space: 10 }) {
      NavigationBackButton({
        controlSize: 44,
        onBack: (): void => {
          this.onClose();
        }
      })

      Column({ space: 2 }) {
        Text(this.state.fileName || this.state.target.displayName || RemoteI18n.t('filePreview.title'))
          .fontSize(MobileDesignTypography.bodyLarge.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.headerDetail())
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.isImageReady()) {
        Stack({ alignContent: Alignment.Center }) {
          Text('1:1')
            .fontSize(MobileDesignTypography.labelSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.isImageOriginalSize() ? CODE_FUNCTION : INK)
        }
        .width(44)
        .height(44)
        .accessibilityText(RemoteI18n.t(
          this.isImageOriginalSize() ? 'filePreview.fitImage' : 'filePreview.actualImageSize'
        ))
        .onClick(() => {
          this.toggleImageSize();
        })
      }

      if (this.canToggleExpanded) {
        Stack({ alignContent: Alignment.Center }) {
          SymbolGlyph(this.previewExpanded ?
            $r('sys.symbol.arrow_down_right_and_arrow_up_left') :
            $r('sys.symbol.arrow_up_left_and_arrow_down_right'))
            .fontSize(20)
            .fontColor([INK])
        }
        .width(44)
        .height(44)
        .accessibilityText(RemoteI18n.t(
          this.previewExpanded ? 'filePreview.restoreSize' : 'filePreview.expand'
        ))
        .onClick(() => {
          this.onToggleExpanded();
        })
      }

      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.arrow_clockwise'))
          .fontSize(20)
          .fontColor([this.canUseRemoteAction() ? INK : MUTED])
      }
      .width(44)
      .height(44)
      .accessibilityText(RemoteI18n.t('common.refresh'))
      .opacity(this.canUseRemoteAction() ? 1 : 0.45)
      .onClick(() => {
        if (this.canUseRemoteAction()) {
          this.onRefresh();
        }
      })

      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph($r('sys.symbol.arrow_down_to_line'))
          .fontSize(20)
          .fontColor([this.canDownload() ? INK : MUTED])
      }
      .width(44)
      .height(44)
      .accessibilityText(RemoteI18n.t('chat.download'))
      .opacity(this.canDownload() ? 1 : 0.45)
      .onClick(() => {
        if (this.canDownload()) {
          this.onDownload(this.state.target.rawReference || this.state.target.remotePath);
        }
      })
    }
    .width('100%')
    .height(68 + this.insets.top)
    // The header band is the surface's top edge in both hosts — the compact
    // full-page overlay and the wide preview pane — so it carries the status bar
    // strip itself: the band's fill still reaches the top of the window and the
    // back control and title sit below the clock and the indicators. It spans
    // the window horizontally, so it carries the side strips the same way: on a
    // rotated device the back control is what the camera cutout would cover.
    .padding({
      left: this.insets.leftPadding(8),
      right: this.insets.rightPadding(8),
      top: 8 + this.insets.top,
      bottom: 8
    })
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: 1 }, color: LINE })
    .backgroundColor(PAGE_BG)
  }

  @Builder
  Body() {
    if (this.state.phase === FilePreviewPhase.Loading && !this.remoteAvailable) {
      this.OfflineLoadingState()
    } else if (this.state.phase === FilePreviewPhase.Loading) {
      this.LoadingState()
    } else if (this.state.phase === FilePreviewPhase.Error) {
      this.ErrorState()
    } else if (this.state.phase === FilePreviewPhase.Unsupported) {
      this.UnsupportedState()
    } else if (this.state.phase === FilePreviewPhase.Ready &&
      this.state.rendererKind === FilePreviewRendererKind.Image) {
      this.ImagePreview()
    } else if (this.state.phase === FilePreviewPhase.Ready &&
      this.state.rendererKind === FilePreviewRendererKind.Markdown) {
      this.MarkdownPreview()
    } else if (this.state.phase === FilePreviewPhase.Ready) {
      this.TextPreview()
    } else {
      this.EmptyState()
    }
  }

  @Builder
  DownloadStatus() {
    if (this.downloadStatus.length > 0 && this.downloadMatchesTarget()) {
      Row() {
        Text(this.downloadStatus)
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 8, bottom: 8 })
      .backgroundColor(SOFT)
      .border({ width: { bottom: 1 }, color: LINE })
    }
  }

  @Builder
  LoadingState() {
    Column({ space: 12 }) {
      LoadingProgress()
        .width(28)
        .height(28)
        .color(MUTED)
      Text(RemoteI18n.t('filePreview.loading'))
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(MUTED)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  OfflineLoadingState() {
    Column({ space: 10 }) {
      Text(RemoteI18n.t('filePreview.loadFailed'))
        .fontSize(MobileDesignTypography.titleMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text(RemoteI18n.t('filePreview.offline'))
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 32, right: 32 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  ErrorState() {
    Column({ space: 12 }) {
      Text(RemoteI18n.t('filePreview.loadFailed'))
        .fontSize(MobileDesignTypography.titleMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text(this.state.errorText)
        .fontSize(MobileDesignTypography.bodySmall.size)
        .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .maxLines(4)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.state.errorRetryable) {
        Button(RemoteI18n.t('common.retry'))
          .height(42)
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .fontColor(CARD)
          .backgroundColor(INK)
          .borderRadius(21)
          .enabled(this.remoteAvailable)
          .opacity(this.remoteAvailable ? 1 : 0.45)
          .onClick(() => {
            this.onRefresh();
          })
      }
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 32, right: 32 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  UnsupportedState() {
    Column({ space: 10 }) {
      SymbolGlyph($r('sys.symbol.doc'))
        .fontSize(38)
        .fontColor([MUTED])
      Text(RemoteI18n.t('filePreview.unsupported'))
        .fontSize(MobileDesignTypography.titleMedium.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
      Text(this.metadataDetail())
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
      Button(RemoteI18n.t('chat.download'))
        .height(42)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .fontColor(CARD)
        .backgroundColor(INK)
        .borderRadius(21)
        .enabled(this.remoteAvailable)
        .opacity(this.remoteAvailable ? 1 : 0.45)
        .onClick(() => {
          this.onDownload(this.state.target.rawReference || this.state.target.remotePath);
        })
    }
    .width('100%')
    .layoutWeight(1)
    .padding({ left: 32, right: 32 })
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  @Builder
  TextPreview() {
    Column() {
      if (this.state.truncated) {
        Text(RemoteI18n.f('filePreview.truncated', RemoteUiState.formatBytes(this.state.loadedBytes)))
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .padding({ left: 14, right: 14, top: 7, bottom: 7 })
          .backgroundColor(SOFT)
          .border({ width: { bottom: 1 }, color: LINE })
      }
      Scroll(this.textScroller) {
        Text() {
          ForEach(this.syntaxTokens(), (token: CodeSyntaxToken) => {
            Span(token.text)
              .fontColor(this.syntaxTokenColor(token.kind))
              .textBackgroundStyle({
                color: this.isTargetLine(token.lineNumber) ? CODE_TARGET_BG : TRANSPARENT
              })
          }, (token: CodeSyntaxToken) => token.id)
        }
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontColor(INK)
          .fontFamily('monospace')
          .textSelectable(TextSelectableMode.SELECTABLE_UNFOCUSABLE)
          .padding({ left: 12, right: 12, top: 14, bottom: this.insets.tailSpacing(24) })
          .constraintSize({ minWidth: '100%' })
      }
      .scrollable(ScrollDirection.FREE)
      .scrollBar(BarState.Auto)
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.TopStart)
      .onAppear(() => {
        this.restoreTextScroll();
      })
      .onDidScroll((xOffset: number, yOffset: number, _scrollState: ScrollState) => {
        this.state.recordScroll(xOffset, yOffset);
      })
    }
    .layoutWeight(1)
    .width('100%')
    .backgroundColor(SOFT)
  }

  @Builder
  MarkdownPreview() {
    Scroll(this.markdownScroller) {
      MarkdownContent({
        text: this.state.textContent,
        onCopyText: (_text: string) => {},
        onOpenLink: (reference: string, label: string) => {
          this.onOpenLink(reference, label);
        }
      })
        .width('100%')
        .padding({ left: 16, right: 16, top: 16, bottom: this.insets.tailSpacing(28) })
    }
    .scrollable(ScrollDirection.Vertical)
    .scrollBar(BarState.Auto)
    .layoutWeight(1)
    .width('100%')
    .align(Alignment.TopStart)
    .onAppear(() => {
      this.restoreMarkdownScroll();
    })
    .onDidScroll((xOffset: number, yOffset: number, _scrollState: ScrollState) => {
      this.state.recordScroll(xOffset, yOffset);
    })
  }

  @Builder
  ImagePreview() {
    Stack({ alignContent: Alignment.Center }) {
      Image(`data:${this.state.mimeType};base64,${this.state.contentBase64}`)
        .width('100%')
        .height('100%')
        .objectFit(this.isImageOriginalSize() ? ImageFit.None : ImageFit.Contain)
        .onClick(() => {
          this.toggleImageSize();
        })
        .onError((_error: ImageError) => {
          this.imageOriginalSizeTarget = '';
          this.state.phase = FilePreviewPhase.Error;
          this.state.errorText = RemoteI18n.t('filePreview.imageDecodeFailed');
          this.state.errorRetryable = true;
        })
    }
    .layoutWeight(1)
    .width('100%')
    .padding(18)
    .backgroundColor(SOFT)
  }

  @Builder
  EmptyState() {
    Column() {
    }
    .layoutWeight(1)
    .width('100%')
  }

  private canUseRemoteAction(): boolean {
    return this.remoteAvailable && this.state.visible && this.state.phase !== FilePreviewPhase.Loading &&
      (this.state.phase !== FilePreviewPhase.Error || this.state.errorRetryable) &&
      this.state.target.isValid();
  }

  private canDownload(): boolean {
    return this.remoteAvailable && this.state.visible && !this.isDownloadingTarget() && this.state.target.isValid();
  }

  private isDownloadingTarget(): boolean {
    return this.downloadPath.length > 0 && this.downloadMatchesTarget() && this.downloadedPath.length === 0;
  }

  private downloadMatchesTarget(): boolean {
    const target = this.state.target.rawReference || this.state.target.remotePath;
    return target.length > 0 && (target === this.downloadPath || target === this.downloadedPath);
  }

  private isImageReady(): boolean {
    return this.state.phase === FilePreviewPhase.Ready &&
      this.state.rendererKind === FilePreviewRendererKind.Image;
  }

  private isImageOriginalSize(): boolean {
    return this.imageOriginalSizeTarget.length > 0 &&
      this.imageOriginalSizeTarget === this.state.target.remotePath;
  }

  private toggleImageSize(): void {
    this.imageOriginalSizeTarget = this.isImageOriginalSize() ? '' : this.state.target.remotePath;
  }

  private headerDetail(): string {
    if (!this.remoteAvailable) {
      return RemoteI18n.t('filePreview.offline');
    }
    if (this.state.phase === FilePreviewPhase.Loading) {
      return RemoteI18n.t('filePreview.loading');
    }
    return this.metadataDetail();
  }

  private metadataDetail(): string {
    const size = this.state.fileSize > 0 ? RemoteUiState.formatBytes(this.state.fileSize) : '';
    if (this.state.mimeType.length > 0 && size.length > 0) {
      return `${this.state.mimeType} · ${size}`;
    }
    return this.state.mimeType || size || this.state.target.remotePath;
  }

  private syntaxTokens(): CodeSyntaxToken[] {
    return this.syntaxHighlightCache.tokensFor(
      this.state.textContent,
      this.state.fileName || this.state.target.remotePath
    );
  }

  private syntaxTokenColor(kind: CodeSyntaxTokenKind): ResourceColor {
    if (kind === CodeSyntaxTokenKind.LineNumber) {
      return CODE_LINE_NUMBER;
    }
    if (kind === CodeSyntaxTokenKind.Keyword) {
      return CODE_KEYWORD;
    }
    if (kind === CodeSyntaxTokenKind.String) {
      return CODE_STRING;
    }
    if (kind === CodeSyntaxTokenKind.Number) {
      return CODE_NUMBER;
    }
    if (kind === CodeSyntaxTokenKind.Comment) {
      return CODE_COMMENT;
    }
    if (kind === CodeSyntaxTokenKind.Function) {
      return CODE_FUNCTION;
    }
    if (kind === CodeSyntaxTokenKind.Type) {
      return CODE_TYPE;
    }
    if (kind === CodeSyntaxTokenKind.Constant) {
      return CODE_CONSTANT;
    }
    if (kind === CodeSyntaxTokenKind.Property) {
      return CODE_PROPERTY;
    }
    return INK;
  }

  private isTargetLine(lineNumber: number): boolean {
    if (lineNumber <= 0 || this.state.target.lineStart <= 0) {
      return false;
    }
    const end = this.state.target.lineEnd > 0 ? this.state.target.lineEnd : this.state.target.lineStart;
    return lineNumber >= this.state.target.lineStart && lineNumber <= end;
  }

  private restoreTextScroll(): void {
    this.clearRestoreScrollTimer();
    this.restoreScrollTimerId = setTimeout(() => {
      this.restoreScrollTimerId = 0;
      const xOffset = this.state.initialScrollX();
      const yOffset = this.state.initialScrollY();
      this.textScroller.scrollTo({ xOffset, yOffset, animation: false });
      this.state.recordScroll(xOffset, yOffset);
    }, 30);
  }

  private restoreMarkdownScroll(): void {
    this.clearRestoreScrollTimer();
    this.restoreScrollTimerId = setTimeout(() => {
      this.restoreScrollTimerId = 0;
      const xOffset = this.state.initialScrollX();
      const yOffset = this.state.hasRecordedScroll ? this.state.initialScrollY() : 0;
      this.markdownScroller.scrollTo({ xOffset, yOffset, animation: false });
      this.state.recordScroll(xOffset, yOffset);
    }, 30);
  }

  private clearRestoreScrollTimer(): void {
    if (this.restoreScrollTimerId !== 0) {
      clearTimeout(this.restoreScrollTimerId);
      this.restoreScrollTimerId = 0;
    }
  }
}
