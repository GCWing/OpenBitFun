import { ConversationViewState } from '../state/ConversationViewState';
import { ConversationView } from './ConversationView';
import { ConversationIntent } from '../actions/ConversationIntent';
import { ComposerPresentation } from './ComposerBar';
import { ConversationViewOptions } from './ConversationViewContract';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';

@ComponentV2
export struct ConversationViewHost {
  @Param viewState: ConversationViewState = new ConversationViewState();
  @Param activeFilePreviewPath: string = '';
  @Param activeFilePreviewLoading: boolean = false;
  @Param showSidebarButton: boolean = true;
  @Param showBackButton: boolean = true;
  @Param showSidebarRestoreButton: boolean = false;
  @Param composerPresentation: ComposerPresentation = ComposerPresentation.Compact;
  @Param composerInputId: string = 'conversation-composer-input';
  @Param hoverOperateMode: boolean = false;
  @Param fullTextSheetPlacement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.UserMessageFullText);
  @Param onRestoreSidebar: () => void = () => {};
  @Param onIntent: (intent: ConversationIntent) => void = (_intent: ConversationIntent) => {};

  build() {
    ConversationView({
      state: this.viewState,
      options: this.viewOptions(),
      onRestoreSidebar: this.onRestoreSidebar,
      onIntent: (intent: ConversationIntent) => this.dispatch(intent)
    })
  }

  private viewOptions(): ConversationViewOptions {
    const options = new ConversationViewOptions();
    options.activeFilePreviewPath = this.activeFilePreviewPath;
    options.activeFilePreviewLoading = this.activeFilePreviewLoading;
    options.showSidebarButton = this.showSidebarButton;
    options.showBackButton = this.showBackButton;
    options.showSidebarRestoreButton = this.showSidebarRestoreButton;
    options.composerPresentation = this.composerPresentation;
    options.composerInputId = this.composerInputId;
    options.hoverOperateMode = this.hoverOperateMode;
    options.fullTextSheetPlacement = this.fullTextSheetPlacement;
    return options;
  }

  private dispatch(intent: ConversationIntent): void {
    this.onIntent(intent);
  }
}
