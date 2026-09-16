import { InteractionMailboxPanel } from './InteractionMailboxPanel';
import { InteractionMailboxAction } from '../../model/InteractionMailbox';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { KeyboardAvoidMode } from '@kit.ArkUI';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ChatTimelineItem, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ConnectionStatusPresenter } from '../../services/ConnectionStatusPresenter';
import { RemoteLogger } from '../../services/RemoteLogger';
import { ChatComposerCapabilities } from '../state/ChatComposerCapabilities';
import { ChatSurface } from '../state/ChatSurface';
import { ConversationViewState } from '../state/ConversationViewState';
import { ConversationIntent, ConversationIntents, ConversationIntentType } from '../actions/ConversationIntent';
import { ChatTimeline } from './ChatTimeline';
import { ConversationLoadingState } from './ConversationLoadingState';
import {
  ConversationViewContract,
  ConversationViewOptions
} from './ConversationViewContract';
import {
  ConversationUiModelCatalog,
  ConversationUiQuestionAnswer,
  ConversationUiSelectedImage,
  ConversationUiSession
} from '../state/ConversationUiModels';
import { ComposerBar, ComposerPresentation } from './ComposerBar';
import { ConversationHeader } from './ConversationHeader';
import { ConversationHeaderPolicy, ConversationHeaderPresentation } from '../policy/ConversationHeaderPolicy';
import {
  CARD,
  INK,
  LINE,
  MUTED,
  PAGE_BG,
  SHADOW_SUBTLE,
  SOFT,
  STATUS_DANGER,
  STATUS_SUCCESS,
  TRANSPARENT,
} from './Theme';

@ComponentV2
export struct ConversationView {
  @Param state: ConversationViewState = new ConversationViewState();
  @Param options: ConversationViewOptions = new ConversationViewOptions();
  @Event onIntent: (intent: ConversationIntent) => void = (_intent: ConversationIntent) => {};
  @Event onRestoreSidebar: () => void = () => {};
  @Local showHeaderActions: boolean = false;
  private previousKeyboardAvoidMode: KeyboardAvoidMode = KeyboardAvoidMode.OFFSET;

  aboutToAppear(): void {
    RemoteLogger.info(`conversation view mounted surface=${this.surface}`);
    this.previousKeyboardAvoidMode = this.getUIContext().getKeyboardAvoidMode();
    this.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
  }

  aboutToDisappear(): void {
    RemoteLogger.info('conversation view disposed');
    this.getUIContext().setKeyboardAvoidMode(this.previousKeyboardAvoidMode);
  }

  build() {
    Stack() {
      Column() {
        this.Header()
        this.Mailbox()
        if (this.hoverOperateMode) {
          this.HoverBody()
        } else {
          this.StandardBody()
        }
      }
      .width('100%').height('100%').backgroundColor(PAGE_BG)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  @Builder
  private StandardBody() {
    Column() {
      this.ConversationBody()
      this.Composer()
    }
    .layoutWeight(1)
    .width('100%')
  }

  @Builder
  private HoverBody() {
    FolderStack() {
      Column() {
        this.ConversationBody()
      }
      .width('100%')
      .height('100%')
      .padding({ bottom: 12 })
      Column() {
        this.Composer()
      }
      .width('100%')
    }
    .alignContent(Alignment.Bottom)
    .layoutWeight(1)
    .width('100%')
    .enableAnimation(true)
    .autoHalfFold(true)
  }

  @Builder
  private Mailbox() {
    if (this.surface === ChatSurface.Remote && this.state.interactionMailbox.sessionId === this.state.activeSession.sessionId) {
      InteractionMailboxPanel({ state: this.state.interactionMailbox,
        onAction: (action: InteractionMailboxAction): void => this.onIntent(ConversationIntents.mailbox(action)) })
    }
  }

  @Builder
  private ConversationBody() {
    if (this.shouldCenterInlineStatus()) {
      this.CenteredInlineStatus()
    } else {
      // Keep the list subtree alive while a slow transcript is loading. The
      // former top-level conditional destroyed and rebuilt ChatTimeline every
      // time the 140 ms loading gate opened, losing its scroll state and making
      // rapid session switches visibly flash.
      Stack() {
        Column() {
          this.MessageList()
        }
        .width('100%')
        .height('100%')
        if (this.isLoadingConversation) {
          ConversationLoadingState({
            maxContentWidth: this.composerPresentation === ComposerPresentation.Floating ? 760 : 0
          })
            .width('100%')
            .height('100%')
            .backgroundColor(PAGE_BG)
        }
      }
      .layoutWeight(1)
      .width('100%')
    }
    if (this.inlineStatusText.length > 0 && !this.shouldCenterInlineStatus()) {
      Text(this.inlineStatusText)
        .fontSize(MobileDesignTypography.labelSmall.size).lineHeight(MobileDesignTypography.labelSmall.lineHeight).fontColor(MUTED).width('100%')
        .padding({ left: 20, right: 20, bottom: 8 })
    }
  }

  @Builder
  Header() {
    ConversationHeader({
      title: this.headerTitle(),
      subtitle: this.headerSubtitle(),
      titleFallback: this.headerFallback(),
      allowRename: this.headerAllowRename(),
      showActions: this.headerShowActions(),
      showSidebarButton: this.showSidebarButton,
      showBackButton: this.showBackButton,
      showSidebarRestoreButton: this.showSidebarRestoreButton,
      showActionsMenu: this.showHeaderActions,
      actionsMenu: () => {
        this.HeaderActionsPopover();
      },
      onOpenSidebar: () => {
        this.onOpenSidebar();
      },
      onRestoreSidebar: () => {
        this.onRestoreSidebar();
      },
      onBack: () => {
        this.onBack();
      },
      onOpenActions: () => {
        this.showHeaderActions = !this.showHeaderActions;
      },
      onActionsMenuStateChange: (visible: boolean) => {
        this.showHeaderActions = visible;
      },
      onRenameSession: (title: string) => {
        this.onRenameSession(title);
      }
    })
  }

  @Builder
  MessageList() {
    ChatTimeline({
      interactionMailbox: this.state.interactionMailbox,
      surface: this.surface,
      timelineItems: this.visibleTimelineItems(),
      timelineRevision: this.timelineRevision,
      hasMoreMessages: this.hasMoreMessages,
      historyLoading: this.state.historyLoading,
      historyFailed: this.state.historyFailed,
      isBusy: this.isBusy || this.isLoadingConversation,
      connectionState: this.connectionState,
      statusText: this.statusText,
      downloadingFilePath: this.downloadingFilePath,
      downloadedFilePath: this.downloadedFilePath,
      fileDownloadStatus: this.fileDownloadStatus,
      activeFilePreviewPath: this.activeFilePreviewPath,
      activeFilePreviewLoading: this.activeFilePreviewLoading,
      maxContentWidth: this.composerPresentation === ComposerPresentation.Floating ? 760 : 0,
      onLoadOlder: () => {
        this.onLoadOlder();
      },
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
      onCopyMessage: (text: string) => {
        this.onCopyMessage(text);
      },
      onRetryMessage: (text: string) => {
        this.onRetryMessage(text);
      },
      onOpenFilePreview: (path: string, label: string) => {
        this.onOpenFilePreview(path, label);
      },
      onBuildPlan: (path: string, name: string) => {
        this.onBuildPlan(path, name);
      },
      onDownloadFile: (path: string) => {
        this.onDownloadFile(path);
      }
    })
  }

  @Builder
  CenteredInlineStatus() {
    Stack({ alignContent: Alignment.Center }) {
      Text(this.inlineStatusText)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
        .fontColor(MUTED)
        .textAlign(TextAlign.Center)
        .maxLines(2)
    }
    .layoutWeight(1)
    .width('100%')
    .height('100%')
    .padding({ left: 32, right: 32, bottom: 48 })
  }

  @Builder
  Composer() {
    Column() {
      ComposerBar({
      presentation: this.composerPresentation,
      capabilities: this.composerCapabilities,
      inputId: this.composerInputId,
      chatInput: this.chatInput,
      selectedImages: this.selectedImages,
      isBusy: this.isBusy,
      canStop: this.canStop,
      connectionState: this.connectionState,
      isVoiceListening: this.isVoiceListening,
      modelCatalog: this.modelCatalog,
      selectedModelId: this.selectedModelId,
      onPickImages: () => {
        this.onPickImages();
      },
      onRemoveImage: (imageId: string) => {
        this.onRemoveImage(imageId);
      },
      onSend: () => {
        this.onSend();
      },
      onStop: () => {
        this.onStop();
      },
      onVoiceInput: () => {
        this.onVoiceInput();
      },
      onSelectModel: (modelId: string) => {
        this.onSelectModel(modelId);
      },
      onChatInputChange: (value: string) => {
        this.onChatInputChange(value);
      }
      })
    }
    .width('100%')
  }

  @Builder
  HeaderActionsPopover() {
    Column() {
      this.HeaderActionsContent()
    }
    .width(292)
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .backgroundColor(CARD)
    .border({ width: 0.5, color: LINE })
    .borderRadius(16)
    .shadow({ radius: 18, color: SHADOW_SUBTLE, offsetY: 7 })
    .transition(TransitionEffect.translate({ x: 8, y: -8 })
      .combine(TransitionEffect.opacity(0))
      .animation({ duration: 180, curve: Curve.EaseOut }))
  }

  @Builder
  HeaderActionsContent() {
    Text(RemoteI18n.t('chat.sessionSection'))
      .fontSize(MobileDesignTypography.bodySmall.size).fontWeight(FontWeight.Medium).fontColor(MUTED)
      .width('100%').height(28).padding({ left: 8 })
    if (this.surface === ChatSurface.General) {
      this.RemoteStyleMenuItem('remote_actions_check',
        this.isSessionPinned ? RemoteI18n.t('chat.unpin') : RemoteI18n.t('chat.pin'),
        () => this.onTogglePinSession(), this.isSessionPinned)
    }
    this.RemoteStyleMenuItem('remote_actions_cloud', RemoteI18n.t('chat.uploadedFiles'),
      () => this.onShowUploadedFiles())
    if (this.surface === ChatSurface.General) {
      Divider().strokeWidth(1).color(LINE).margin({ top: 8, bottom: 8 })
      this.RemoteStyleMenuItem('remote_actions_folder', RemoteI18n.t('sidebar.archive'),
        () => this.onArchiveSession())
      this.RemoteStyleMenuItem('remote_actions_settings', RemoteI18n.t('common.delete'),
        () => this.onDeleteSession())
    } else if (this.canStop) {
      Divider().strokeWidth(1).color(LINE).margin({ top: 8, bottom: 8 })
      this.RemoteStyleMenuItem('remote_actions_settings', RemoteI18n.t('chat.stop'), () => this.onStop())
    }
  }

  @Builder
  RemoteStyleMenuItem(icon: string, label: string, action: () => void, selected: boolean = false) {
    Row({ space: 10 }) {
      this.MenuIcon(icon)
      Text(label)
        .fontSize(MobileDesignTypography.titleSmall.size).fontColor(INK).layoutWeight(1)
        .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
    }
    .width('100%').height(48)
    .padding({ left: 8, right: 8 })
    .borderRadius(10)
    .backgroundColor(selected ? SOFT : TRANSPARENT)
    .onClick(() => {
      action()
      this.showHeaderActions = false
    })
  }

  @Builder
  MenuIcon(icon: string) {
    if (icon === 'remote_actions_link') {
      SymbolGlyph($r('sys.symbol.link')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_check') {
      SymbolGlyph($r('sys.symbol.checkmark_circle')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_folder') {
      SymbolGlyph($r('sys.symbol.folder')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else if (icon === 'remote_actions_cloud') {
      SymbolGlyph($r('sys.symbol.cloud')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    } else {
      SymbolGlyph($r('sys.symbol.gearshape')).fontSize(20).fontColor([MUTED]).width(23).height(23)
    }
  }

  private shouldCenterInlineStatus(): boolean {
    return this.inlineStatusText.length > 0 &&
      !this.isBusy &&
      !ConversationViewContract.hasRealTimelineItem(this.timelineItems);
  }

  private visibleTimelineItems(): ObservableChatTimelineItem[] {
    return ConversationViewContract.visibleTimelineItems(this.timelineItems);
  }

  private statusLine(): string {
    if (this.canStop && this.connectionState === 'connected') {
      return RemoteI18n.t('chat.executing');
    }
    return ConnectionStatusPresenter.detail(this.connectionState, this.statusText, '', '');
  }

  private headerTitle(): string {
    return this.headerPresentation().title;
  }

  private headerSubtitle(): string {
    return this.headerPresentation().subtitle;
  }

  private headerFallback(): string {
    return RemoteI18n.t(this.headerPresentation().fallbackKey);
  }

  private headerAllowRename(): boolean {
    return this.headerPresentation().allowRename;
  }

  private headerShowActions(): boolean {
    return this.headerPresentation().showActions;
  }

  private headerPresentation(): ConversationHeaderPresentation {
    return ConversationHeaderPolicy.present(
      this.surface,
      this.activeSession.title,
      this.desktopName,
      this.workspaceBranch,
      ConversationViewContract.hasRealTimelineItem(this.timelineItems)
    );
  }

  private connectionColor(): ResourceColor {
    const tone = ConnectionStatusPresenter.tone(this.connectionState);
    if (tone === 'ok') {
      return STATUS_SUCCESS;
    }
    if (tone === 'error') {
      return STATUS_DANGER;
    }
    return MUTED;
  }

  private get surface(): ChatSurface { return this.state.surface; }
  private get activeSession(): ConversationUiSession { return this.state.activeSession; }
  private get desktopName(): string { return this.state.desktopName; }
  private get workspaceBranch(): string { return this.state.workspaceBranch; }
  private get statusText(): string { return this.state.statusText; }
  private get inlineStatusText(): string { return this.state.inlineStatusText; }
  private get connectionState(): string { return this.state.connectionState; }
  private get composerCapabilities(): ChatComposerCapabilities { return this.state.composerCapabilities; }
  private get isBusy(): boolean { return this.state.isBusy; }
  private get isLoadingConversation(): boolean { return this.state.isLoadingConversation; }
  private get canStop(): boolean { return this.state.canStop; }
  private get hasMoreMessages(): boolean { return this.state.hasMoreMessages; }
  private get timelineItems(): ObservableChatTimelineItem[] { return this.state.timelineItems; }
  private get timelineRevision(): number { return this.state.timelineRevision; }
  private get modelCatalog(): ConversationUiModelCatalog { return this.state.modelCatalog; }
  private get selectedModelId(): string { return this.state.selectedModelId; }
  private get downloadingFilePath(): string { return this.state.downloadingFilePath; }
  private get downloadedFilePath(): string { return this.state.downloadedFilePath; }
  private get fileDownloadStatus(): string { return this.state.fileDownloadStatus; }
  private get selectedImages(): ConversationUiSelectedImage[] { return this.state.selectedImages; }
  private get isVoiceListening(): boolean { return this.state.isVoiceListening; }
  private get chatInput(): string { return this.state.chatInput; }
  private get isSessionPinned(): boolean { return this.state.isSessionPinned; }
  private get activeFilePreviewPath(): string { return this.options.activeFilePreviewPath; }
  private get activeFilePreviewLoading(): boolean { return this.options.activeFilePreviewLoading; }
  private get showSidebarButton(): boolean { return this.options.showSidebarButton; }
  private get showBackButton(): boolean { return this.options.showBackButton; }
  private get showSidebarRestoreButton(): boolean { return this.options.showSidebarRestoreButton; }
  private get composerPresentation(): ComposerPresentation { return this.options.composerPresentation; }
  private get composerInputId(): string { return this.options.composerInputId; }
  private get hoverOperateMode(): boolean { return this.options.hoverOperateMode; }
  private onOpenSidebar(): void { this.dispatchSimple(ConversationIntentType.OpenSidebar); }
  private onBack(): void { this.dispatchSimple(ConversationIntentType.Back); }
  private onTogglePinSession(): void { this.dispatchSimple(ConversationIntentType.TogglePin); }
  private onArchiveSession(): void { this.dispatchSimple(ConversationIntentType.Archive); }
  private onDeleteSession(): void { this.dispatchSimple(ConversationIntentType.Delete); }
  private onShowUploadedFiles(): void { this.dispatchSimple(ConversationIntentType.ShowUploadedFiles); }
  private onStop(): void { this.dispatchSimple(ConversationIntentType.Stop); }
  private onLoadOlder(): void { this.dispatchSimple(ConversationIntentType.LoadOlder); }
  private onApproveTool(toolId: string, updatedInput?: Object): void {
    this.onIntent(ConversationIntents.approveTool(toolId, updatedInput));
  }
  private onRejectTool(toolId: string): void {
    this.onIntent(ConversationIntents.tool(ConversationIntentType.RejectTool, toolId));
  }
  private onCancelTool(toolId: string): void {
    this.onIntent(ConversationIntents.tool(ConversationIntentType.CancelTool, toolId));
  }
  private onAnswerQuestion(toolId: string, answers: ConversationUiQuestionAnswer): void {
    this.onIntent(ConversationIntents.answerQuestion(toolId, answers));
  }
  private onRenameSession(title: string): void {
    this.dispatchValue(ConversationIntentType.RenameSession, title);
  }
  private onCopyMessage(text: string): void { this.dispatchValue(ConversationIntentType.CopyMessage, text); }
  private onRetryMessage(text: string): void { this.dispatchValue(ConversationIntentType.RetryMessage, text); }
  private onOpenFilePreview(path: string, label: string): void {
    this.onIntent(ConversationIntents.openFilePreview(path, label));
  }
  private onBuildPlan(path: string, name: string): void {
    this.onIntent(ConversationIntents.buildPlan(path, name));
  }
  private onSelectModel(modelId: string): void { this.dispatchValue(ConversationIntentType.SelectModel, modelId); }
  private onPickImages(): void { this.dispatchSimple(ConversationIntentType.PickImages); }
  private onRemoveImage(imageId: string): void { this.dispatchValue(ConversationIntentType.RemoveImage, imageId); }
  private onDownloadFile(path: string): void { this.dispatchValue(ConversationIntentType.DownloadFile, path); }
  private onSend(): void { this.dispatchSimple(ConversationIntentType.Send); }
  private onVoiceInput(): void { this.dispatchSimple(ConversationIntentType.VoiceInput); }
  private onChatInputChange(value: string): void {
    this.dispatchValue(ConversationIntentType.ChatInputChanged, value);
  }

  private dispatchSimple(type: ConversationIntentType): void {
    this.onIntent(ConversationIntents.simple(type));
  }

  private dispatchValue(type: ConversationIntentType, value: string): void {
    this.onIntent(ConversationIntents.value(type, value));
  }
}
