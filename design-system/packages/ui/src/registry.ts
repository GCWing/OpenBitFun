import { actionItemMeta } from "./components/ActionItem/ActionItem.meta";
import { actionCardMeta } from "./components/ActionCard/ActionCard.meta";
import { activityItemMeta } from "./components/ActivityItem/ActivityItem.meta";
import { alertMeta } from "./components/Alert/Alert.meta";
import { avatarMeta } from "./components/Avatar/Avatar.meta";
import { buttonMeta } from "./components/Button/Button.meta";
import { checkboxMeta } from "./components/Checkbox/Checkbox.meta";
import { cardMeta } from "./components/Card/Card.meta";
import { composerMeta } from "./components/Composer/Composer.meta";
import { comboboxMeta } from "./components/Combobox/Combobox.meta";
import { confirmDialogMeta } from "./components/ConfirmDialog/ConfirmDialog.meta";
import { disclosureMeta } from "./components/Disclosure/Disclosure.meta";
import { emptyMeta } from "./components/Empty/Empty.meta";
import { fieldMeta } from "./components/Field/Field.meta";
import { fieldGroupMeta } from "./components/FieldGroup/FieldGroup.meta";
import { iconMeta } from "./components/Icon/Icon.meta";
import { iconButtonMeta } from "./components/IconButton/IconButton.meta";
import { thinkingIndicatorMeta } from "./components/ThinkingIndicator/ThinkingIndicator.meta";
import { inputMeta } from "./components/Input/Input.meta";
import { keyHintMeta } from "./components/KeyHint/KeyHint.meta";
import { launcherButtonMeta } from "./components/LauncherButton/LauncherButton.meta";
import { listboxMeta } from "./components/Listbox/Listbox.meta";
import { menuMeta } from "./components/Menu/Menu.meta";
import { dialogMeta, sheetMeta } from "./components/Dialog/Dialog.meta";
import { multiSelectMeta } from "./components/MultiSelect/MultiSelect.meta";
import { navigationPanelMeta } from "./components/NavigationPanel/NavigationPanel.meta";
import { numberInputMeta } from "./components/NumberInput/NumberInput.meta";
import { numberBadgeMeta } from "./components/NumberBadge/NumberBadge.meta";
import { pageHeaderMeta } from "./components/PageHeader/PageHeader.meta";
import { radioMeta } from "./components/Radio/Radio.meta";
import { rollingTextMeta } from "./components/RollingText/RollingText.meta";
import { shimmerTextMeta } from "./components/ShimmerText/ShimmerText.meta";
import { scrollAreaMeta } from "./components/ScrollArea/ScrollArea.meta";
import { splitViewMeta } from "./components/SplitView/SplitView.meta";
import { searchFieldMeta } from "./components/SearchField/SearchField.meta";
import { segmentedControlMeta } from "./components/SegmentedControl/SegmentedControl.meta";
import { selectMeta } from "./components/Select/Select.meta";
import { statusPillMeta } from "./components/StatusPill/StatusPill.meta";
import { loadingStateMeta, spinnerMeta } from "./components/Spinner/Spinner.meta";
import { switchMeta } from "./components/Switch/Switch.meta";
import { textareaMeta } from "./components/Textarea/Textarea.meta";
import { tabGroupMeta } from "./components/TabGroup/TabGroup.meta";
import { toolbarMeta } from "./components/Toolbar/Toolbar.meta";
import { tooltipMeta } from "./components/Tooltip/Tooltip.meta";
import { voiceCallPanelMeta } from "./components/VoiceCallPanel/VoiceCallPanel.meta";
import { voiceParticleLogoMeta } from "./brand/VoiceParticleLogo/VoiceParticleLogo.meta";
import { mobileIconButtonMeta } from "./mobile/MobileIconButton/MobileIconButton.meta";
import { mobileActionSheetMeta } from "./mobile/MobileActionSheet/MobileActionSheet.meta";
import { mobileBadgeMeta } from "./mobile/MobileBadge/MobileBadge.meta";
import { mobileBannerMeta } from "./mobile/MobileBanner/MobileBanner.meta";
import { mobileButtonMeta } from "./mobile/MobileButton/MobileButton.meta";
import { mobileCardMeta } from "./mobile/MobileCard/MobileCard.meta";
import { mobileChoiceSheetMeta } from "./mobile/MobileChoiceSheet/MobileChoiceSheet.meta";
import { mobileConfirmSheetMeta } from "./mobile/MobileConfirmSheet/MobileConfirmSheet.meta";
import { mobileComposerMeta } from "./mobile/MobileComposer/MobileComposer.meta";
import { mobileDisclosureMeta } from "./mobile/MobileDisclosure/MobileDisclosure.meta";
import { mobileFloatingActionsMeta } from "./mobile/MobileFloatingActions/MobileFloatingActions.meta";
import { mobileFileButtonMeta } from "./mobile/MobileFileButton/MobileFileButton.meta";
import { mobileListRowMeta } from "./mobile/MobileListRow/MobileListRow.meta";
import { mobileLinkMeta } from "./mobile/MobileLink/MobileLink.meta";
import { mobileMessageMeta } from "./mobile/MobileMessage/MobileMessage.meta";
import { mobilePageHeaderMeta } from "./mobile/MobilePageHeader/MobilePageHeader.meta";
import { mobileSectionMeta } from "./mobile/MobileSection/MobileSection.meta";
import { mobileScrimMeta } from "./mobile/MobileScrim/MobileScrim.meta";
import { mobileSegmentedControlMeta } from "./mobile/MobileSegmentedControl/MobileSegmentedControl.meta";
import { mobileSheetMeta } from "./mobile/MobileSheet/MobileSheet.meta";
import { mobileStatusMeta } from "./mobile/MobileStatus/MobileStatus.meta";
import { mobileTextFieldMeta } from "./mobile/MobileTextField/MobileTextField.meta";
import { mobileTextareaMeta } from "./mobile/MobileTextarea/MobileTextarea.meta";
import { askUserMeta } from "./flow-chat/ask-user/AskUser.meta";
import { chatComposerMeta } from "./flow-chat/composer/ChatComposer.meta";
import { thinkingBlockMeta, flowGroupMeta, exploreGroupMeta, contextLoadGroupMeta, flowChatRuntimeStatusMeta } from "./flow-chat/conversation/ConversationBlocks.meta";
import { ambientToolCardMeta } from "./flow-chat/tool-cards/AmbientToolCard.meta";
import { controlHubToolCardMeta, listModelsToolCardMeta } from "./flow-chat/tool-cards/RuntimeToolCards.meta";
import { semanticToolCardMetas } from "./flow-chat/tool-cards/SemanticToolCards.meta";
import { commandToolCardMeta } from "./flow-chat/tool-cards/CommandToolCard.meta";
import { toolRelationRowMeta } from './flow-chat/tool-cards/ToolRelationRow.meta';
import { contextCompressionToolCardMeta } from "./flow-chat/tool-cards/ContextCompressionToolCard.meta";
import { fileOperationToolCardMeta } from "./flow-chat/tool-cards/FileOperationToolCard.meta";
import { prominentToolCardMeta } from "./flow-chat/tool-cards/ProminentToolCard.meta";
import {
  agentControlToolCardMeta,
  fileDiffToolCardMeta,
  gitToolCardMeta,
  pageDeployToolCardMeta,
  pagePublishToolCardMeta,
  reviewSummaryToolCardMeta,
} from "./flow-chat/tool-cards/ProminentToolCards.meta";
import { readFileToolCardMeta } from "./flow-chat/tool-cards/ReadFileToolCard.meta";
import {
  agentWaitToolCardMeta,
  cronToolCardMeta,
  defaultToolCardMeta,
  directoryListToolCardMeta,
  getToolSpecToolCardMeta,
  globSearchToolCardMeta,
  grepSearchToolCardMeta,
  runCodeToolCardMeta,
  sessionControlToolCardMeta,
  sessionMessageToolCardMeta,
  skillToolCardMeta,
  terminalControlToolCardMeta,
  todoToolCardMeta,
  viewImageToolCardMeta,
  webFetchToolCardMeta,
  webSearchToolCardMeta,
} from "./flow-chat/tool-cards/StandardToolCards.meta";
import { openBitFunSolidMarkMeta, openBitFunAppIconMeta, openBitFunMarkMeta, openBitFunBrandMotionMeta, subagentHatchMeta } from "./brand/brand.meta";
import type { ComponentMeta } from "./registry.types";

export type {
  ComponentMaturity,
  ComponentMeta,
  ComponentPropMeta,
} from "./registry.types";

export const componentRegistry = [
  ...semanticToolCardMetas,
  actionCardMeta,
  actionItemMeta,
  activityItemMeta,
  alertMeta,
  agentControlToolCardMeta,
  agentWaitToolCardMeta,
  ambientToolCardMeta,
  askUserMeta,
  avatarMeta,
  buttonMeta,
  cardMeta,
  checkboxMeta,
  chatComposerMeta,
  thinkingBlockMeta,
  flowGroupMeta,
  exploreGroupMeta,
  contextLoadGroupMeta,
  flowChatRuntimeStatusMeta,
  commandToolCardMeta,
  toolRelationRowMeta,
  composerMeta,
  comboboxMeta,
  confirmDialogMeta,
  contextCompressionToolCardMeta,
  controlHubToolCardMeta,
  cronToolCardMeta,
  defaultToolCardMeta,
  disclosureMeta,
  emptyMeta,
  directoryListToolCardMeta,
  fieldMeta,
  fieldGroupMeta,
  fileDiffToolCardMeta,
  fileOperationToolCardMeta,
  getToolSpecToolCardMeta,
  gitToolCardMeta,
  globSearchToolCardMeta,
  grepSearchToolCardMeta,
  iconMeta,
  iconButtonMeta,
  thinkingIndicatorMeta,
  inputMeta,
  keyHintMeta,
  launcherButtonMeta,
  listboxMeta,
  listModelsToolCardMeta,
  loadingStateMeta,
  menuMeta,
  mobileActionSheetMeta,
  mobileBadgeMeta,
  mobileBannerMeta,
  mobileButtonMeta,
  mobileCardMeta,
  mobileChoiceSheetMeta,
  mobileConfirmSheetMeta,
  mobileComposerMeta,
  mobileDisclosureMeta,
  mobileFileButtonMeta,
  mobileFloatingActionsMeta,
  mobileIconButtonMeta,
  mobileLinkMeta,
  mobileListRowMeta,
  mobileMessageMeta,
  mobilePageHeaderMeta,
  mobileScrimMeta,
  mobileSectionMeta,
  mobileSegmentedControlMeta,
  mobileSheetMeta,
  mobileStatusMeta,
  mobileTextFieldMeta,
  mobileTextareaMeta,
  dialogMeta,
  multiSelectMeta,
  navigationPanelMeta,
  numberInputMeta,
  numberBadgeMeta,
  pageDeployToolCardMeta,
  pageHeaderMeta,
  radioMeta,
  pagePublishToolCardMeta,
  prominentToolCardMeta,
  readFileToolCardMeta,
  reviewSummaryToolCardMeta,
  rollingTextMeta,
  shimmerTextMeta,
  runCodeToolCardMeta,
  scrollAreaMeta,
  splitViewMeta,
  searchFieldMeta,
  segmentedControlMeta,
  selectMeta,
  sheetMeta,
  sessionControlToolCardMeta,
  sessionMessageToolCardMeta,
  skillToolCardMeta,
  statusPillMeta,
  spinnerMeta,
  switchMeta,
  tabGroupMeta,
  textareaMeta,
  terminalControlToolCardMeta,
  todoToolCardMeta,
  toolbarMeta,
  tooltipMeta,
  voiceCallPanelMeta,
  openBitFunSolidMarkMeta,
  openBitFunAppIconMeta,
  openBitFunMarkMeta,
  openBitFunBrandMotionMeta,
  subagentHatchMeta,
  voiceParticleLogoMeta,
  viewImageToolCardMeta,
  webFetchToolCardMeta,
  webSearchToolCardMeta,
] as const satisfies readonly ComponentMeta[];
