import { MobileDesignGeometry, MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { RemoteModelConfig } from '../../model/RemoteModels';
import { RemoteModelDefaultsRole } from '../../services/RemoteModelDefaultsController';
import { WindowInsetsBinding } from '../../services/WindowSystemBarService';
import { ConversationModelPresentationPolicy } from '../policy/ConversationModelPresentationPolicy';
import { ModelPickerView, ModelRoleCandidatesPolicy } from '../policy/ModelRoleCandidatesPolicy';
import { toConversationUiModel } from '../state/ConversationUiModels';
import { DeviceModelDefaultsSheetState } from '../state/DeviceModelDefaultsSheetState';
import { SettingsSheetState } from '../state/SettingsSheetState';
import { ModelUnavailableCard } from './ModelUnavailableCard';
import { NavigationBackButton } from './NavigationBackButton';
import { SheetCloseButton } from './SheetCloseButton';
import { SHEET_HEADER_HEIGHT, SHEET_HEADER_SIDE_PADDING, SHEET_HORIZONTAL_PADDING } from './SheetLayout';
import { CARD, INK, LINE, MUTED, PAGE_BG, SOFT, TRANSPARENT } from './Theme';

/**
 * The role picker: the second level of the sheet's model settings stack, for one
 * role at a time.
 *
 * Candidates are the desktop's own catalog, filtered to what the role can
 * actually run and kept in the order the desktop reports, so the list here and
 * the list on the desktop describe the same device. The pinned row is the "no
 * model" value, which is a value: for `fast` it means "follow the primary" and
 * for the multimodal slot it means the capability is off. The primary model has
 * no such row — it is the one slot the desktop must always be able to resolve.
 *
 * Selecting does not draw the selection: it asks the controller to write and
 * leaves for the settings page, which then shows the value the desktop read
 * back. A picker that checked the row the user tapped would be promising a
 * configuration that may have been repaired while it was stored.
 */
@ComponentV2
export struct ModelRolePickerPanel {
  @Param sheetState: SettingsSheetState = new SettingsSheetState();
  @Param deviceModels: DeviceModelDefaultsSheetState = new DeviceModelDefaultsSheetState();
  @Param desktopName: string = '';
  @Param desktopId: string = '';
  @Event onClose: () => void = () => {};
  @Local insets: WindowInsetsBinding = new WindowInsetsBinding();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext();
    if (context) {
      this.insets.bind(this.getUIContext(), context);
    }
    // The picker never opens before the page that pushes it, but it can be the
    // first thing a restored sheet shows: reading here keeps that state answered.
    void this.deviceModels.ensureLoaded();
  }

  aboutToDisappear(): void {
    this.insets.unbind();
  }

  build() {
    Column({ space: 0 }) {
      this.PageHeader()
      Scroll() {
        Column({ space: 0 }) {
          // The card comes first: it is why the list below is what it is, and on a
          // device that cannot answer there is no list at all.
          if (this.view().reason) {
            this.ReasonCard()
          }
          if (this.view().reading) {
            this.ReadingCard()
          }
          if (this.view().list) {
            this.FilterLine()
            if (this.allowsUnset()) {
              this.UnsetRow()
            }
            ForEach(this.candidates(), (model: RemoteModelConfig) => {
              this.CandidateRow(model)
            }, (model: RemoteModelConfig): string => model.id)
            // Only a list the device itself answered may be explained away: after a
            // failed read it is short for a reason the card above already states.
            if (this.view().answered && this.candidates().length === 0) {
              this.NoCandidatesLine()
            }
          }
        }
        .width('100%')
        .padding({
          left: SHEET_HORIZONTAL_PADDING,
          right: SHEET_HORIZONTAL_PADDING,
          top: 12,
          bottom: this.insets.tailSpacing(34)
        })
      }
      .width('100%')
      .layoutWeight(1)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }

  /** Same header language as the page below it: back one level, close the sheet. */
  @Builder
  private PageHeader() {
    Row() {
      NavigationBackButton({
        isEnabled: !this.locked(),
        onBack: (): void => {
          this.sheetState.backFromModelPick();
        }
      })
      Column({ space: 3 }) {
        Text(RemoteI18n.t('settings.model.settingsTitle'))
          .width('100%')
          .fontSize(MobileDesignTypography.bodySmall.size)
          .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(this.roleLabel())
          .width('100%')
          .fontSize(MobileDesignTypography.headlineSmall.size)
          .lineHeight(MobileDesignTypography.headlineSmall.lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor(INK)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      SheetCloseButton({
        isEnabled: !this.locked(),
        onClose: this.onClose
      })
    }
    .width('100%')
    .height(SHEET_HEADER_HEIGHT)
    .padding({ left: SHEET_HEADER_SIDE_PADDING, right: SHEET_HEADER_SIDE_PADDING })
    .alignItems(VerticalAlign.Center)
    .border({ width: { bottom: 1 }, color: LINE })
  }

  /**
   * Why the list is as short as it is. Filtering silently is what makes a user
   * think the device lost its models, so the rule is stated above the rows
   * together with the device it applies to.
   */
  @Builder
  private FilterLine() {
    Text(RemoteI18n.f(ModelRoleCandidatesPolicy.filterKey(this.role()), this.deviceLabel()))
      .width('100%')
      .fontSize(MobileDesignTypography.labelSmall.size)
      .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
      .fontColor(MUTED)
      .padding({ left: 4, right: 4 })
      .margin({ bottom: 12 })
  }

  /**
   * The "no model" value of this role, pinned above the candidates and separated
   * from them, because it is not one of them: it is the state of having none.
   */
  @Builder
  private UnsetRow() {
    Column({ space: 0 }) {
      Row({ space: 10 }) {
        this.SelectionMark(this.pinSelected())
        Column({ space: 2 }) {
          Text(RemoteI18n.t(ModelRoleCandidatesPolicy.unsetLabelKey(this.role())))
            .width('100%')
            .fontSize(MobileDesignTypography.titleSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(RemoteI18n.t(ModelRoleCandidatesPolicy.unsetHintKey(this.role())))
            .width('100%')
            .fontSize(MobileDesignTypography.labelSmall.size)
            .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
            .fontColor(MUTED)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .constraintSize({ minHeight: MobileDesignGeometry.modelAccountRowHeight })
      .padding({ left: 10, right: 10, top: 8, bottom: 8 })
      .alignItems(VerticalAlign.Center)
      .backgroundColor(this.pinSelected() ? SOFT : TRANSPARENT)
      .borderRadius(MobileDesignGeometry.composerModelSelectorRowRadius)
      .id('device-model-pick-unset')
      .enabled(!this.locked())
      .opacity(this.locked() ? 0.6 : 1)
      .onClick(() => {
        this.select(null);
      })
      // The pinned value is a different kind of answer from a model, so the list
      // says so with a rule instead of letting it read as the first candidate.
      if (this.candidates().length > 0) {
        Divider()
          .strokeWidth(1)
          .color(LINE)
          .margin({ top: 6, bottom: 6 })
      }
    }
    .width('100%')
  }

  /** One candidate model: what it is called, what it runs on, and its capability. */
  @Builder
  private CandidateRow(model: RemoteModelConfig) {
    Row({ space: 10 }) {
      this.SelectionMark(this.candidateSelected(model.id))
      Column({ space: 2 }) {
        Row({ space: 6 }) {
          Text(this.modelLabel(model))
            .layoutWeight(1)
            .fontSize(MobileDesignTypography.titleSmall.size)
            .fontWeight(FontWeight.Medium)
            .fontColor(INK)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.showsCapabilityBadge()) {
            Text(RemoteI18n.t('settings.model.capabilityImageUnderstanding'))
              .fontSize(MobileDesignTypography.labelSmall.size)
              .fontColor(MUTED)
              .padding({ left: 6, right: 6, top: 1, bottom: 1 })
              .backgroundColor(SOFT)
              .borderRadius(4)
          }
        }
        .width('100%')
        Text(this.modelMeta(model))
          .width('100%')
          .fontSize(MobileDesignTypography.labelSmall.size)
          .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
          .fontColor(MUTED)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .constraintSize({ minHeight: MobileDesignGeometry.modelAccountRowHeight })
    .padding({ left: 10, right: 10, top: 8, bottom: 8 })
    .alignItems(VerticalAlign.Center)
    .backgroundColor(this.candidateSelected(model.id) ? SOFT : TRANSPARENT)
    .borderRadius(MobileDesignGeometry.composerModelSelectorRowRadius)
    .id(`device-model-pick-${model.id}`)
    .enabled(!this.locked())
    .opacity(this.locked() ? 0.6 : 1)
    .onClick(() => {
      this.select(model.id);
    })
  }

  /**
   * A candidate row's leading mark. The outline glyph is deliberate: every row
   * would carry a check if the filled one were used, and the selected row is
   * already told apart by its fill, so the mark only has to point at the choice
   * the role currently holds.
   */
  @Builder
  private SelectionMark(selected: boolean) {
    Stack({ alignContent: Alignment.Center }) {
      if (selected) {
        SymbolGlyph($r('sys.symbol.checkmark_circle'))
          .fontSize(16)
          .fontColor([INK])
      }
    }
    .width(20)
    .height(20)
  }

  /**
   * No model on this device can serve the role. The pinned row above already
   * says what the role is left at, so this line only states that the emptiness
   * is the device's answer rather than a failed read.
   */
  @Builder
  private NoCandidatesLine() {
    Text(RemoteI18n.t('settings.model.pickEmpty'))
      .width('100%')
      .fontSize(MobileDesignTypography.labelSmall.size)
      .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
      .fontColor(MUTED)
      .padding({ left: 10, right: 10, top: 10, bottom: 10 })
  }

  /**
   * The device stopped answering this page — the link dropped, the desktop was
   * replaced by an older one, or the read itself failed — so the picker states
   * the reason instead of a list. Without this a dropped link read as an empty
   * catalog, and the null roles of the closed gate read as the user's choices.
   */
  @Builder
  private ReasonCard() {
    ModelUnavailableCard({
      reason: this.reasonText(),
      canRetry: this.view().retry,
      busy: this.locked(),
      cardId: 'device-model-pick-unavailable',
      onRetry: (): void => {
        void this.deviceModels.retry();
      }
    })
  }

  /** Nothing has been read for this device yet, so there is nothing to list. */
  @Builder
  private ReadingCard() {
    Text(this.deviceModels.state.statusText.length > 0 ?
      this.deviceModels.state.statusText : RemoteI18n.t('status.loadingModelDefaults'))
      .width('100%')
      .fontSize(MobileDesignTypography.bodySmall.size)
      .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
      .fontColor(MUTED)
      .padding({ left: 18, right: 18, top: 16, bottom: 16 })
      .backgroundColor(CARD)
      .borderRadius(MobileDesignGeometry.settingsCardRadius)
      .id('device-model-pick-reading')
  }

  /**
   * The two labels a candidate row carries. The catalog is the protocol's own
   * shape, so it is projected through the shared presentation mapper before the
   * shared label policy reads it — one boundary, one naming rule.
   */
  private modelLabel(model: RemoteModelConfig): string {
    return ConversationModelPresentationPolicy.primaryLabel(
      toConversationUiModel(model), RemoteI18n.t('chat.model'));
  }

  private modelMeta(model: RemoteModelConfig): string {
    return ConversationModelPresentationPolicy.modelContextLabel(toConversationUiModel(model));
  }

  private role(): RemoteModelDefaultsRole {
    const role = this.sheetState.pickRole;
    if (role === 'primary' || role === 'fast' || role === 'image_understanding') {
      return role;
    }
    return 'primary';
  }

  /** The picker knows which slot it is editing; without one it must not write. */
  private hasRole(): boolean {
    return this.role() === this.sheetState.pickRole;
  }

  private allowsUnset(): boolean {
    return ModelRoleCandidatesPolicy.allowsUnset(this.role());
  }

  private showsCapabilityBadge(): boolean {
    return ModelRoleCandidatesPolicy.showsCapabilityBadge(this.role());
  }

  private candidates(): RemoteModelConfig[] {
    return ModelRoleCandidatesPolicy.candidatesForRole(this.role(), this.deviceModels.state.catalog);
  }

  /** What this frame may show, decided from the one state the page renders. */
  private view(): ModelPickerView {
    return ModelRoleCandidatesPolicy.pickerView(this.deviceModels.state);
  }

  /**
   * The reason the card carries: the controller's own sentence for a state it
   * judged, or the host's words when a read failed. The page never invents one.
   */
  private reasonText(): string {
    const error = this.deviceModels.state.error;
    return error.length > 0 ? error : RemoteI18n.t('status.remoteUnavailable');
  }

  /**
   * Whether the pinned row carries the check. A role's value is only an answer
   * while the device is answering: after the link dropped, every role reads as
   * null, and drawing that as "this is your setting" would state a choice the
   * user never made and the device never confirmed.
   */
  private pinSelected(): boolean {
    return this.view().answered &&
      ModelRoleCandidatesPolicy.isUnsetSelected(this.deviceModels.state.roles, this.role());
  }

  private candidateSelected(modelId: string): boolean {
    return this.view().answered && ModelRoleCandidatesPolicy.isCandidateSelected(
      this.deviceModels.state.roles, this.role(), modelId);
  }

  private locked(): boolean {
    return this.deviceModels.state.busy;
  }

  private roleLabel(): string {
    return RemoteI18n.t(ModelRoleCandidatesPolicy.roleLabelKey(this.role()));
  }

  private deviceLabel(): string {
    return this.desktopName.length > 0 ? this.desktopName : this.desktopId;
  }

  /**
   * Writes the role and returns to the page that shows the result. The write is
   * not awaited here: the settings page is what reports it, and it is the page
   * the user is left looking at.
   */
  private select(modelId: string | null): void {
    if (this.locked() || !this.hasRole()) {
      return;
    }
    void this.deviceModels.selectRole(this.role(), modelId);
    this.sheetState.backFromModelPick();
  }
}
