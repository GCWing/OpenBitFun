import { KeyboardReleaseService } from '../../services/KeyboardReleaseService';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { MobileDesignGeometry, MobileDesignMotion, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { ChatComposerPolicy, ComposerPrimaryAction } from '../../services/ChatComposerPolicy';
import { ChatComposerCapabilities, REMOTE_CHAT_COMPOSER_CAPABILITIES } from '../state/ChatComposerCapabilities';
import {
  ConversationUiModel,
  ConversationUiModelCatalog,
  ConversationUiSelectedImage
} from '../state/ConversationUiModels';
import { ConversationModelPresentationPolicy } from '../policy/ConversationModelPresentationPolicy';
import { TemplateIcon } from './TemplateIcon';
import {
  CARD,
  CARD_OVERLAY,
  INK,
  LINE,
  MEDIA_SCRIM,
  MUTED,
  SHADOW_SUBTLE,
  SOFT,
  STATUS_SUCCESS,
  TRANSPARENT
} from './Theme';

export enum ComposerPresentation {
  Compact = 'compact',
  Floating = 'floating'
}

const COMPOSER_ACTION_SIZE: number = MobileDesignGeometry.composerActionSize;
/** The optical primary surface is separate from its full touch target. */
const COMPOSER_PRIMARY_SURFACE_SIZE: number = 32;
const COMPOSER_SEND_TRANSITION_DURATION: number = 200;
const COMPOSER_INPUT_HEIGHT: number = MobileDesignGeometry.composerInputHeight;
const COMPOSER_EXPANDED_INPUT_HEIGHT: number = MobileDesignGeometry.composerExpandedInputHeight;
const COMPOSER_EXPANDED_INPUT_MAX_HEIGHT: number =
  MobileDesignTypography.bodyLarge.lineHeight * 4 + 18;
const COMPOSER_COLLAPSED_HEIGHT: number = MobileDesignGeometry.composerCollapsedHeight;
const COMPOSER_COMPACT_COLLAPSED_HEIGHT: number = MobileDesignGeometry.composerCollapsedHeight;
const COMPOSER_EXPANDED_ACTION_ROW_HEIGHT: number = MobileDesignGeometry.composerExpandedActionRowHeight;
const COMPOSER_EXPANDED_HEIGHT: number = MobileDesignGeometry.composerExpandedHeight;
const COMPOSER_COMPACT_HORIZONTAL_GUTTER: number = MobileDesignGeometry.contentGutter;
const COMPOSER_IMAGE_CARD_SIZE: number = 64;
const COMPOSER_IMAGE_STRIP_TOP_GAP: number = 6;
/** Strip height plus its top gap and the parent Column's 2vp row spacing. */
const COMPOSER_IMAGE_STRIP_BLOCK: number =
  COMPOSER_IMAGE_CARD_SIZE + COMPOSER_IMAGE_STRIP_TOP_GAP + 2;

@ComponentV2
export struct ComposerBar {
  @Param presentation: ComposerPresentation = ComposerPresentation.Compact;
  @Param capabilities: ChatComposerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
  @Param inputId: string = 'conversation-composer-input';
  @Param chatInput: string = '';
  @Local inputText: string = '';
  @Local inputFocused: boolean = false;
  @Local primaryActionPressed: boolean = false;
  @Local sendTransitionActive: boolean = false;
  private sendTransitionTimerId: number = -1;
  @Param selectedImages: ConversationUiSelectedImage[] = [];
  @Param isBusy: boolean = false;
  @Param canStop: boolean = false;
  @Param connectionState: string = 'connected';
  @Param isVoiceListening: boolean = false;
  @Param modelCatalog: ConversationUiModelCatalog = {
    version: 0,
    models: [],
    default_models: {}
  };
  @Param selectedModelId: string = '';
  @Local showModelSelectorPopover: boolean = false;
  @Local isPreparingModelSelectorPopover: boolean = false;
  @Local keepExpandedForModelSelection: boolean = false;
  private restoreInputFocusAfterModelSelection: boolean = false;
  private restoreInputFocusTimerId: number = -1;
  @Event onPickImages: () => void = () => {};
  @Event onRemoveImage: (imageId: string) => void = (_imageId: string) => {};
  @Event onSend: () => void = () => {};
  @Event onStop: () => void = () => {};
  @Event onVoiceInput: () => void = () => {};
  @Event onSelectModel: (modelId: string) => void = (_modelId: string) => {};
  @Event onChatInputChange: (value: string) => void = (_value: string) => {};

  aboutToAppear(): void {
    this.inputText = this.chatInput;
  }

  aboutToDisappear(): void {
    if (this.sendTransitionTimerId >= 0) {
      clearTimeout(this.sendTransitionTimerId);
      this.sendTransitionTimerId = -1;
    }
    if (this.restoreInputFocusTimerId >= 0) {
      clearTimeout(this.restoreInputFocusTimerId);
      this.restoreInputFocusTimerId = -1;
    }
  }

  @Monitor('chatInput')
  onChatInputParamChanged(): void {
    if (this.inputText !== this.chatInput) {
      this.inputText = this.chatInput;
    }
  }

  @Monitor('presentation')
  onPresentationChanged(): void {
    this.closeModelSelector();
  }

  build() {
    Column() {
      this.AdaptiveComposer()
    }
    .width('100%')
    .constraintSize({ maxWidth: this.presentation === ComposerPresentation.Floating ? 760 : 10000 })
    .alignSelf(ItemAlign.Center)
    .padding({
      left: this.presentation === ComposerPresentation.Floating
        ? 24 : MobileDesignGeometry.conversationOverlaySideInset,
      right: this.presentation === ComposerPresentation.Floating
        ? 24 : MobileDesignGeometry.conversationOverlaySideInset,
      top: 8,
      bottom: this.presentation === ComposerPresentation.Floating ? 16 : 12
    })
    .backgroundColor(TRANSPARENT)
  }

  @Builder
  AdaptiveComposer() {
    Column({ space: 2 }) {
      if (this.selectedImages.length > 0) {
        this.SelectedImageStrip()
      }
      Row({ space: this.isComposerExpanded() ? 0 : 5 }) {
        if (this.shouldShowAddButton()) {
          Row() {
            this.AddButton()
          }
          .width(this.isComposerExpanded() ? 0 : COMPOSER_ACTION_SIZE)
          .height(COMPOSER_ACTION_SIZE)
          .opacity(this.isComposerExpanded() ? 0 : 1)
          .visibility(this.isComposerExpanded() ? Visibility.None : Visibility.Visible)
          .clip(true)
        }
        this.InputField()
        Row() {
          this.PrimaryActionButton()
        }
        .width(this.isComposerExpanded() ? 0 : COMPOSER_ACTION_SIZE)
        .height(COMPOSER_ACTION_SIZE)
        .opacity(this.isComposerExpanded() ? 0 : 1)
        .visibility(this.isComposerExpanded() ? Visibility.None : Visibility.Visible)
        .clip(true)
      }
      .width('100%')
      .constraintSize({
        minHeight: this.isComposerExpanded() ? MobileDesignGeometry.composerExpandedInputRowHeight :
          this.collapsedComposerHeight(),
        maxHeight: this.isComposerExpanded() ? COMPOSER_EXPANDED_INPUT_MAX_HEIGHT :
          this.collapsedComposerHeight()
      })

      if (this.isComposerExpanded()) {
        Row({ space: 6 }) {
          if (this.shouldShowAddButton()) {
            this.AddButton()
          }
          if (this.shouldShowModelControl()) {
            this.ModelControl()
          }
          Blank()
          if (this.shouldShowSupplementalVoice()) {
            this.SupplementalVoiceButton()
          }
          this.PrimaryActionButton()
        }
        .width('100%')
        .height(COMPOSER_EXPANDED_ACTION_ROW_HEIGHT)
        .padding({ left: 2, right: 0 })
        .alignItems(VerticalAlign.Center)
        .transition(TransitionEffect.translate({ x: 0, y: 8 })
          .combine(TransitionEffect.opacity(0))
          .animation({ duration: MobileDesignMotion.quick, curve: Curve.EaseOut }))
      }
    }
    .width('100%')
    .constraintSize({ minHeight: this.composerHeight() })
    .padding({
      left: 8,
      right: 8,
      top: this.isComposerExpanded() ? 4 : 0,
      bottom: this.isComposerExpanded() ? 2 : 0
    })
    // The transcript now runs underneath the pill, so the fill is translucent
    // and the blur does the separating. The colour is the floor under it: on a
    // device that does not land the blur the pill is still opaque enough to
    // read against whatever text is passing behind it.
    .backgroundColor(CARD_OVERLAY)
    .backgroundBlurStyle(BlurStyle.Thin)
    .border({ width: this.presentation === ComposerPresentation.Compact ? 0.5 : 1, color: LINE })
    .borderRadius(this.composerRadius())
    .shadow({
      radius: this.presentation === ComposerPresentation.Floating ? 14 : 18,
      color: SHADOW_SUBTLE,
      offsetY: this.presentation === ComposerPresentation.Floating ? 4 : 6
    })
    .animation({ duration: MobileDesignMotion.structure, curve: Curve.EaseOut })
  }

  @Builder
  ModelControl() {
    Row({ space: 3 }) {
      Text(this.displaySelectedModel())
        .fontSize(MobileDesignTypography.bodySmall.size)
        .fontWeight(FontWeight.Medium)
        .fontColor(INK)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .constraintSize({ maxWidth: 192 })
      Stack({ alignContent: Alignment.Center }) {
        SymbolGlyph(this.isModelSelectorExpanded() ?
          $r('sys.symbol.chevron_up') : $r('sys.symbol.chevron_down'))
          .fontSize(13)
          .fontColor([INK])
          .opacity(0.68)
      }
      .width(16)
      .height(COMPOSER_ACTION_SIZE)
    }
    .height(COMPOSER_ACTION_SIZE)
    .constraintSize({ maxWidth: 220 })
    .padding({ left: 4, right: 4 })
    .backgroundColor(TRANSPARENT)
    .accessibilityText(`${RemoteI18n.t('chat.selectModel')} · ${this.displaySelectedModel()}`)
    .bindPopup(this.showModelSelectorPopover, {
      builder: () => {
        this.ModelSelector()
      },
      placement: Placement.Top,
      popupColor: TRANSPARENT,
      enableArrow: false,
      autoCancel: true,
      mask: false,
      targetSpace: 8,
      onStateChange: (event) => {
        if (!event.isVisible) {
          this.showModelSelectorPopover = false;
          this.restoreComposerFocusAfterModelSelection();
        }
      }
    })
    .onTouch((event: TouchEvent) => {
      if (event.type === TouchType.Down) {
        // Capture focus before the sheet/popover moves it away. Choosing a
        // model is part of the current edit, not the end of that edit.
        this.beginModelSelectionFromComposer();
      }
    })
    .onClick(() => {
      this.toggleModelSelectorPopover();
    })
  }

  @Builder
  ModelSelector() {
    Column({ space: 10 }) {
      List({ space: MobileDesignGeometry.composerModelSelectorRowGap }) {
        ForEach(this.selectorModels(), (model: ConversationUiModel) => {
          ListItem() {
            this.ModelRow(model)
          }
        }, (model: ConversationUiModel) => model.id)
      }
      .width('100%')
      .height(this.modelListHeight())
      .scrollBar(BarState.Auto)
      .edgeEffect(EdgeEffect.Spring)
      .divider(null)
    }
    .width(MobileDesignGeometry.composerModelSelectorWidth)
    .padding({ left: 10, right: 10, top: 10, bottom: 10 })
    .backgroundColor(CARD)
    .borderRadius(MobileDesignGeometry.composerModelSelectorRadius)
    .border({ width: 0.5, color: LINE })
    .shadow({
      radius: 18,
      color: SHADOW_SUBTLE,
      offsetY: 7
    })
  }

  @Builder
  ModelRow(model: ConversationUiModel) {
    Row({ space: 10 }) {
      Stack({ alignContent: Alignment.Center }) {
        if (this.isSelectedModel(model)) {
          SymbolGlyph($r('sys.symbol.checkmark_circle'))
            .fontSize(16)
            .fontColor([INK])
        }
      }
      .width(20)
      .height(20)

      Column({ space: 2 }) {
        Text(ConversationModelPresentationPolicy.primaryLabel(model, RemoteI18n.t('chat.model')))
          .fontSize(MobileDesignTypography.bodySmall.size)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
        Text(ConversationModelPresentationPolicy.secondaryLabel(model, RemoteI18n.t('chat.model')))
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .constraintSize({ minHeight: MobileDesignGeometry.composerModelSelectorRowHeight })
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .backgroundColor(this.isSelectedModel(model) ? SOFT : TRANSPARENT)
    .borderRadius(MobileDesignGeometry.composerModelSelectorRowRadius)
    .onClick(() => {
      this.closeModelSelector(true);
      this.onSelectModel(model.id);
    })
  }

  @Builder
  AddButton() {
    Stack({ alignContent: Alignment.Center }) {
      this.PlusGlyph()
    }
    .width(COMPOSER_ACTION_SIZE)
    .height(COMPOSER_ACTION_SIZE)
    .accessibilityText(RemoteI18n.t('chat.addImage'))
    .onClick(() => {
      if (this.isVoiceListening) {
        return;
      }
      // Images are the only thing a message can carry, so a menu in front of the
      // picker would be a menu of one. Straight to the album, same as local chat.
      this.onPickImages();
    })
  }

  @Builder
  InputField() {
    Row({ space: this.isVoiceListening ? 8 : 0 }) {
      if (this.isVoiceListening) {
        this.ListeningWave()
      }
      TextArea({ placeholder: this.inputPlaceholder(), text: this.inputText })
        .id(this.inputId)
        .layoutWeight(1)
        .constraintSize({
          minHeight: this.isComposerExpanded() ? COMPOSER_EXPANDED_INPUT_HEIGHT : COMPOSER_INPUT_HEIGHT,
          maxHeight: this.isComposerExpanded() ? COMPOSER_EXPANDED_INPUT_MAX_HEIGHT : COMPOSER_INPUT_HEIGHT
        })
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .lineHeight(MobileDesignTypography.bodyLarge.lineHeight)
        .fontColor(INK)
        .placeholderColor(this.isVoiceListening ? STATUS_SUCCESS : MUTED)
        .backgroundColor(TRANSPARENT)
        .borderRadius(20)
        .align(this.isComposerExpanded() ? Alignment.TopStart : Alignment.Start)
        .padding({
          left: this.isVoiceListening ? 0 : 4,
          right: 4,
          top: this.isComposerExpanded() ? 10 : 0,
          bottom: this.isComposerExpanded() ? 8 : 0
        })
        // Limit the viewport, not the editable text; keep overflow scrollable.
        .textOverflow(TextOverflow.Clip)
        .maxLines(this.isComposerExpanded() ? 4 : 1, { overflowMode: MaxLinesMode.SCROLL })
        .defaultFocus(false)
        .onFocus(() => {
          this.inputFocused = true;
          this.cancelModelSelectionEditingContinuation();
        })
        .onBlur(() => {
          this.inputFocused = false;
        })
        .onChange((value: string, previewText?: PreviewText) => {
          // The first callback value excludes IME pre-edit text. Keep that text
          // inside the native field until the IME commits it.
          if (previewText && previewText.value.length > 0) {
            return;
          }
          this.inputText = value;
          this.onChatInputChange(value);
        })
      if (this.shouldShowSupplementalVoice() && !this.isComposerExpanded()) {
        this.SupplementalVoiceButton()
      }
    }
    .layoutWeight(1)
    .constraintSize({
      minHeight: this.isComposerExpanded() ? COMPOSER_EXPANDED_INPUT_HEIGHT : COMPOSER_INPUT_HEIGHT,
      maxHeight: this.isComposerExpanded() ? COMPOSER_EXPANDED_INPUT_MAX_HEIGHT : COMPOSER_INPUT_HEIGHT
    })
    .alignItems(VerticalAlign.Center)
    .padding({ left: this.isVoiceListening ? 12 : 0, right: 0 })
    .backgroundColor(this.isVoiceListening ? SOFT : TRANSPARENT)
    .borderRadius(20)
    .border({ width: this.isVoiceListening ? 1 : 0, color: this.isVoiceListening ? STATUS_SUCCESS : TRANSPARENT })
  }

  @Builder
  PrimaryActionButton() {
    Button() {
      Stack({ alignContent: Alignment.Center }) {
        if (this.shouldShowActiveActionSurface()) {
          Stack({ alignContent: Alignment.Center }) {
            if (this.shouldShowStopGlyph()) {
              Text('')
                .width(10)
                .height(10)
                .backgroundColor(CARD)
                .borderRadius(2.5)
            } else {
              TemplateIcon({
                src: $r('app.media.gpt_composer_send_arrow'),
                iconWidth: 16,
                iconHeight: 18,
                tint: this.primaryActionForegroundColor()
              })
            }
          }
          .width(COMPOSER_PRIMARY_SURFACE_SIZE)
          .height(COMPOSER_PRIMARY_SURFACE_SIZE)
          .backgroundColor(this.activeActionSurfaceColor())
          .borderRadius(COMPOSER_PRIMARY_SURFACE_SIZE / 2)
          .animation({ duration: COMPOSER_SEND_TRANSITION_DURATION, curve: Curve.EaseOut })
        } else if (this.primaryAction() === ComposerPrimaryAction.Voice ||
          this.primaryAction() === ComposerPrimaryAction.VoiceBlocked) {
          this.MicrophoneGlyph()
        } else {
          SymbolGlyph($r('sys.symbol.arrow_up'))
            .fontSize(23)
            .fontWeight(FontWeight.Medium)
            .fontColor([this.primaryActionForegroundColor()])
            .opacity(this.primaryAction() === ComposerPrimaryAction.Send ? 1 : 0.38)
        }
      }
      .width(COMPOSER_ACTION_SIZE)
      .height(COMPOSER_ACTION_SIZE)
    }
    .width(COMPOSER_ACTION_SIZE)
    .height(COMPOSER_ACTION_SIZE)
    .padding(0)
    .type(ButtonType.Circle)
    .backgroundColor(this.inactiveActionBackgroundColor())
    .borderRadius(COMPOSER_ACTION_SIZE / 2)
    .stateEffect(false)
    .accessibilityText(RemoteI18n.t(ChatComposerPolicy.primaryActionAccessibilityKey(
      this.primaryAction(), this.isVoiceListening)))
    .onTouch((event: TouchEvent) => {
      if (!this.shouldShowActiveActionSurface()) {
        return;
      }
      if (event.type === TouchType.Down) {
        this.primaryActionPressed = true;
      } else if (event.type === TouchType.Up || event.type === TouchType.Cancel) {
        this.primaryActionPressed = false;
      }
    })
    // Driven off the same decision that drew the glyph, so the button can never
    // do something other than what it is showing.
    .onClick(() => {
      const action = this.primaryAction();
      if (action === ComposerPrimaryAction.Stop) {
        if (this.isVoiceListening) {
          this.onVoiceInput();
        } else if (this.canStop) {
          this.onStop();
        }
        return;
      }
      if (action === ComposerPrimaryAction.Send) {
        this.beginSendTransition();
        this.onSend();
        return;
      }
      if (action === ComposerPrimaryAction.Voice) {
        void this.startVoiceInput();
      }
    })
  }

  @Builder
  PlusGlyph() {
    SymbolGlyph($r('sys.symbol.plus'))
      .fontSize(22)
      .fontColor([INK])
      .opacity(this.isVoiceListening ? 0.36 : 1)
  }

  @Builder
  MicrophoneGlyph() {
    SymbolGlyph($r('sys.symbol.mic'))
      .fontSize(22)
      .fontColor([this.primaryActionForegroundColor()])
  }

  @Builder
  SupplementalVoiceButton() {
    Stack({ alignContent: Alignment.Center }) {
      SymbolGlyph($r('sys.symbol.mic'))
        .fontSize(20)
        .fontColor([INK])
    }
    .width(COMPOSER_ACTION_SIZE)
    .height(COMPOSER_ACTION_SIZE)
    .opacity(this.canUseSupplementalVoice() ? 0.72 : 0.32)
    .accessibilityText(RemoteI18n.t('chat.voiceInput'))
    .onClick(() => {
      if (this.canUseSupplementalVoice()) {
        void this.startVoiceInput();
      }
    })
  }

  @Builder
  ListeningWave() {
    Row({ space: 3 }) {
      Text('')
        .width(3)
        .height(10)
        .backgroundColor(STATUS_SUCCESS)
        .borderRadius(2)
      Text('')
        .width(3)
        .height(18)
        .backgroundColor(STATUS_SUCCESS)
        .borderRadius(2)
      Text('')
        .width(3)
        .height(24)
        .backgroundColor(STATUS_SUCCESS)
        .borderRadius(2)
      Text('')
        .width(3)
        .height(14)
        .backgroundColor(STATUS_SUCCESS)
        .borderRadius(2)
    }
    .width(22)
    .height(28)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  SelectedImageStrip() {
    Scroll() {
      Row({ space: 10 }) {
        ForEach(this.selectedImages, (image: ConversationUiSelectedImage) => {
          this.SelectedImageCard(image)
        }, (image: ConversationUiSelectedImage) => image.id)
      }
      .padding({ left: 4, right: 4 })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    // Scroll centres content that is narrower than the viewport, which parks a
    // lone thumbnail in the middle of the composer instead of at its left edge.
    .align(Alignment.Start)
    .width('100%')
    .height(COMPOSER_IMAGE_CARD_SIZE)
    .margin({ top: COMPOSER_IMAGE_STRIP_TOP_GAP })
  }

  @Builder
  SelectedImageCard(image: ConversationUiSelectedImage) {
    Stack({ alignContent: Alignment.TopEnd }) {
      Image(image.data_url)
        .width(COMPOSER_IMAGE_CARD_SIZE)
        .height(COMPOSER_IMAGE_CARD_SIZE)
        .objectFit(ImageFit.Cover)
        .borderRadius(14)
      Text('×')
        .width(COMPOSER_ACTION_SIZE)
        .height(COMPOSER_ACTION_SIZE)
        .fontSize(MobileDesignTypography.bodyLarge.size)
        .fontColor(CARD)
        .textAlign(TextAlign.Center)
        .backgroundColor(MEDIA_SCRIM)
        .borderRadius(16)
        .margin({ top: 0, right: 0 })
        .accessibilityText(RemoteI18n.t('chat.removeImage'))
        .onClick(() => {
          this.onRemoveImage(image.id);
        })
    }
    .width(COMPOSER_IMAGE_CARD_SIZE)
    .height(COMPOSER_IMAGE_CARD_SIZE)
  }

  private canUseVoice(): boolean {
    return this.capabilities.showVoiceInput &&
      ChatComposerPolicy.canUseVoice(this.inputText, this.selectedImages.length, this.isBusy);
  }

  private shouldShowSupplementalVoice(): boolean {
    return ChatComposerPolicy.shouldShowSupplementalVoice(
      this.inputText,
      this.selectedImages.length,
      this.isVoiceListening,
      this.capabilities.showVoiceInput
    );
  }

  private canUseSupplementalVoice(): boolean {
    return ChatComposerPolicy.canUseSupplementalVoice(this.isBusy);
  }

  // Dictation runs inside this app rather than in a system dialog, so listening
  // outranks the draft here in a way a running turn does not.
  private primaryAction(): ComposerPrimaryAction {
    return ChatComposerPolicy.primaryAction(
      this.inputText,
      this.selectedImages.length,
      this.isBusy,
      this.isVoiceListening,
      this.canStop,
      this.capabilities.supportsMidRunSend,
      this.capabilities.requiresRemoteConnection,
      this.connectionState,
      this.capabilities.showVoiceInput
    );
  }

  private shouldShowAddButton(): boolean {
    return ChatComposerPolicy.shouldShowAddButton(
      this.capabilities.showAddButton,
      this.capabilities.supportsAttachments
    );
  }

  // Attachments live inside the card, so the card has to grow to hold them.
  private composerHeight(): number {
    const base = this.isComposerExpanded() ? COMPOSER_EXPANDED_HEIGHT : this.collapsedComposerHeight();
    return this.selectedImages.length > 0 ? base + COMPOSER_IMAGE_STRIP_BLOCK : base;
  }

  private collapsedComposerHeight(): number {
    return this.presentation === ComposerPresentation.Compact ?
      COMPOSER_COMPACT_COLLAPSED_HEIGHT : COMPOSER_COLLAPSED_HEIGHT;
  }

  // The pill radius only reads as a pill while the card is one row tall.
  private composerRadius(): number {
    if (this.isComposerExpanded() || this.selectedImages.length > 0) {
      return MobileDesignGeometry.composerExpandedRadius;
    }
    return MobileDesignGeometry.composerCollapsedRadius;
  }

  private isComposerExpanded(): boolean {
    return ChatComposerPolicy.isExpanded(
      this.inputText,
      this.inputFocused,
      this.isModelSelectorExpanded(),
      this.keepExpandedForModelSelection
    );
  }

  private isModelSelectorExpanded(): boolean {
    return this.showModelSelectorPopover || this.isPreparingModelSelectorPopover;
  }

  private shouldShowModelControl(): boolean {
    return this.enabledModels().length > 0;
  }

  private enabledModels(): ConversationUiModel[] {
    return ConversationModelPresentationPolicy.enabledModels(this.modelCatalog);
  }

  private selectedModel(): ConversationUiModel | undefined {
    return ConversationModelPresentationPolicy.selectedModel(this.modelCatalog, this.selectedModelId);
  }

  private isSelectedModel(model: ConversationUiModel): boolean {
    const selected = this.selectedModel();
    return !!selected && selected.id === model.id;
  }

  private displaySelectedModel(): string {
    const selected = this.selectedModel();
    return selected ? ConversationModelPresentationPolicy.primaryLabel(selected, RemoteI18n.t('chat.model')) :
      RemoteI18n.t('chat.model');
  }

  private modelListHeight(): number {
    // Five rows fit comfortably above the compact composer while the keyboard
    // remains visible. Larger catalogs scroll inside the anchored menu.
    const maxVisibleRows = this.presentation === ComposerPresentation.Compact ? 5 : 7;
    const visibleRows = Math.min(this.enabledModels().length, maxVisibleRows);
    return visibleRows * MobileDesignGeometry.composerModelSelectorRowHeight +
      Math.max(0, visibleRows - 1) * MobileDesignGeometry.composerModelSelectorRowGap;
  }

  private selectorModels(): ConversationUiModel[] {
    const models = this.enabledModels();
    const selected = this.selectedModel();
    if (!selected) {
      return models;
    }
    return [selected, ...models.filter((model: ConversationUiModel) => model.id !== selected.id)];
  }

  private closeModelSelector(restoreInputFocus: boolean = false): void {
    const shouldRestore = restoreInputFocus && this.restoreInputFocusAfterModelSelection;
    this.showModelSelectorPopover = false;
    this.isPreparingModelSelectorPopover = false;
    if (shouldRestore) {
      this.restoreComposerFocusAfterModelSelection();
    } else if (!restoreInputFocus) {
      this.cancelModelSelectionEditingContinuation();
    }
  }

  private async toggleModelSelectorPopover(): Promise<void> {
    if (this.showModelSelectorPopover) {
      this.closeModelSelector(true);
      return;
    }
    if (this.isPreparingModelSelectorPopover) {
      return;
    }

    if (this.presentation === ComposerPresentation.Compact) {
      // On a phone this is an in-place upward menu, not a modal sheet. Keep the
      // IME visible so model switching does not interrupt prompt composition.
      this.showModelSelectorPopover = true;
      return;
    }

    // Keep the expanded composer and its model-control anchor mounted while the
    // IME releases the window. Opening the popup before this completes makes its
    // viewport and hit-testing inherit the keyboard-constrained layout.
    this.isPreparingModelSelectorPopover = true;
    await this.releaseComposerKeyboard();

    if (!this.isPreparingModelSelectorPopover || this.presentation !== ComposerPresentation.Floating) {
      return;
    }
    this.showModelSelectorPopover = true;
    this.isPreparingModelSelectorPopover = false;
  }

  private async releaseComposerKeyboard(): Promise<void> {
    const hostContext = this.getUIContext().getHostContext();
    if (!hostContext) {
      this.getUIContext().getFocusController().clearFocus();
      return;
    }

    try {
      await KeyboardReleaseService.release(hostContext);
    } catch (_error) {
      // A draft can keep the composer expanded without an active keyboard or
      // window event. Releasing focus still leaves the model anchor mounted.
    }
    this.getUIContext().getFocusController().clearFocus();
  }

  private beginModelSelectionFromComposer(): void {
    if (!this.inputFocused) {
      return;
    }
    this.keepExpandedForModelSelection = true;
    this.restoreInputFocusAfterModelSelection = true;
  }

  private restoreComposerFocusAfterModelSelection(): void {
    if (!this.restoreInputFocusAfterModelSelection || this.showModelSelectorPopover ||
      this.isPreparingModelSelectorPopover) {
      return;
    }
    if (this.restoreInputFocusTimerId >= 0) {
      clearTimeout(this.restoreInputFocusTimerId);
    }
    // Let the selector release its focus scope first. Retaining the expanded
    // layout during this handoff removes the collapse/re-expand jump.
    this.restoreInputFocusTimerId = setTimeout(() => {
      this.restoreInputFocusTimerId = -1;
      try {
        this.getUIContext().getFocusController().requestFocus(this.inputId);
      } catch (_error) {
        // If the route disappeared during dismissal, component teardown owns
        // the continuation and clears its timer.
      }
    }, MobileDesignMotion.structure);
  }

  private cancelModelSelectionEditingContinuation(): void {
    if (this.restoreInputFocusTimerId >= 0) {
      clearTimeout(this.restoreInputFocusTimerId);
      this.restoreInputFocusTimerId = -1;
    }
    this.restoreInputFocusAfterModelSelection = false;
    this.keepExpandedForModelSelection = false;
  }

  private async startVoiceInput(): Promise<void> {
    await this.releaseComposerKeyboard();
    this.onVoiceInput();
  }

  private inputPlaceholder(): string {
    return this.isVoiceListening ?
      RemoteI18n.t('chat.voiceListeningPlaceholder') :
      RemoteI18n.t('chat.inputPlaceholder');
  }

  private inactiveActionBackgroundColor(): ResourceColor {
    const action = this.primaryAction();
    if (action === ComposerPrimaryAction.Send || action === ComposerPrimaryAction.Stop ||
      this.sendTransitionActive) {
      return TRANSPARENT;
    }
    if (action === ComposerPrimaryAction.Voice) {
      return CARD;
    }
    if (action === ComposerPrimaryAction.SendBlocked || action === ComposerPrimaryAction.VoiceBlocked ||
      action === ComposerPrimaryAction.Idle) {
      return SOFT;
    }
    return TRANSPARENT;
  }

  private shouldShowActiveActionSurface(): boolean {
    const action = this.primaryAction();
    return this.sendTransitionActive || action === ComposerPrimaryAction.Send ||
      action === ComposerPrimaryAction.SendBlocked || action === ComposerPrimaryAction.Stop;
  }

  private shouldShowStopGlyph(): boolean {
    return this.primaryAction() === ComposerPrimaryAction.Stop;
  }

  private activeActionSurfaceColor(): ResourceColor {
    if (this.primaryAction() === ComposerPrimaryAction.SendBlocked) {
      return SOFT;
    }
    return this.primaryActionPressed || this.sendTransitionActive ? MUTED : INK;
  }

  private beginSendTransition(): void {
    this.primaryActionPressed = false;
    this.sendTransitionActive = true;
    if (this.sendTransitionTimerId >= 0) {
      clearTimeout(this.sendTransitionTimerId);
    }
    this.sendTransitionTimerId = setTimeout(() => {
      this.sendTransitionActive = false;
      this.sendTransitionTimerId = -1;
    }, COMPOSER_SEND_TRANSITION_DURATION);
  }

  private primaryActionForegroundColor(): ResourceColor {
    const action = this.primaryAction();
    if (action === ComposerPrimaryAction.Voice) {
      return INK;
    }
    if (action === ComposerPrimaryAction.Send || action === ComposerPrimaryAction.Stop) {
      return CARD;
    }
    return MUTED;
  }
}
