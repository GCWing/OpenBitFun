import { confirmDialogAppearanceDescriptor } from '@/infrastructure/confirm-dialog';
import { inputDialogAppearanceDescriptor } from '@/app/components/InputDialog/appearance';
import { windowControlsAppearanceDescriptor } from '@/app/components/WindowControls/appearance';
import { navigationTransitionBoundaryAppearanceDescriptor } from '@/app/navigation/NavigationTransitionBoundary/appearance';
import { markdownAppearanceDescriptor } from '@/infrastructure/markdown/appearance';
import { chatInputAppearanceDescriptor } from '@/flow_chat/components/ChatInput.appearance';
import { harnessProfileSelectorAppearanceDescriptor } from '@/flow_chat/components/HarnessProfileSelector.appearance';
import { composerVoiceInputAppearanceDescriptor } from '@/flow_chat/components/voice/ComposerVoiceInputButton.appearance';
import { sessionUsagePanelAppearanceDescriptor } from '@/flow_chat/components/usage/appearance';
import { richTextInputAppearanceDescriptor } from '@/flow_chat/components/RichTextInput.appearance';
import { modelRoundItemAppearanceDescriptor } from '@/flow_chat/components/modern/ModelRoundItem.appearance';
import { deepReviewActionBarAppearanceDescriptor } from '@/flow_chat/deep-review/action-bar/appearance';
import { deepResearchProtocolAppearanceDescriptor } from '@/flow_chat/deep-research/DeepResearchProtocolGroup.appearance';
import { modelSelectorAppearanceDescriptor } from '@/flow_chat/components/ModelSelector.appearance';
import { reasoningPresetSelectorAppearanceDescriptor } from '@/flow_chat/components/ReasoningPresetSelector.appearance';
import { acpModeSelectorAppearanceDescriptor } from '@/flow_chat/components/AcpModeSelector.appearance';
import { flowChatHeaderAppearanceDescriptor } from '@/flow_chat/components/modern/FlowChatHeader.appearance';
import { flowChatTurnRailAppearanceDescriptor } from '@/flow_chat/components/modern/FlowChatTurnRail.appearance';
import { sessionFilesBadgeAppearanceDescriptor } from '@/flow_chat/components/modern/SessionFilesBadge.appearance';
import { codeReviewToolCardAppearanceDescriptor } from '@/flow_chat/tool-cards/CodeReviewToolCard.appearance';
import { createAgentPageAppearanceDescriptor } from '@/app/scenes/agents/components/CreateAgentPage.appearance';
import { keyboardShortcutsAppearanceDescriptor } from '@/app/scenes/settings/components/KeyboardShortcutsTab.appearance';
import { taskToolDisplayAppearanceDescriptor } from '@/flow_chat/tool-cards/TaskToolDisplay.appearance';
import { applicationSettingsAppearanceDescriptor } from '@/infrastructure/config/components/ApplicationSettingsPages.appearance';
import { markdownEditorAppearanceDescriptor } from '@/tools/editor/components/MarkdownEditor.appearance';
import { planViewerAppearanceDescriptor } from '@/tools/editor/components/PlanViewer.appearance';
import { appLayoutAppearanceDescriptor } from '@/app/layout/AppLayout.appearance';
import { skillGroupPickerAppearanceDescriptor } from '@/app/scenes/agents/components/SkillGroupPicker.appearance';
import { workingCopyViewAppearanceDescriptor } from '@/app/scenes/git/views/WorkingCopyView.appearance';
import { assistantConfigPageAppearanceDescriptor } from '@/app/scenes/profile/views/AssistantConfigPage.appearance';
import { assistantDefaultsPageAppearanceDescriptor } from '@/app/scenes/profile/views/AssistantDefaultsPage.appearance';
import { taskDetailPanelAppearanceDescriptor } from '@/flow_chat/components/TaskDetailPanel/TaskDetailPanel.appearance';
import { toolbarModeAppearanceDescriptor } from '@/flow_chat/components/toolbar-mode/ToolbarMode.appearance';
import { mcpToolDisplayAppearanceDescriptor } from '@/flow_chat/tool-cards/MCPToolDisplay.appearance';
import { skillsConfigAppearanceDescriptor } from '@/infrastructure/config/components/SkillsConfig.appearance';
import { diffEditorAppearanceDescriptor } from '@/tools/editor/components/DiffEditor.appearance';
import { agentCompanionDesktopPetAppearanceDescriptor } from '@/app/components/AgentCompanionDesktopPet/AgentCompanionDesktopPet.appearance';
import { toolGroupPickerAppearanceDescriptor } from '@/app/scenes/agents/components/ToolGroupPicker.appearance';
import { inlineDiffPreviewAppearanceDescriptor } from '@/flow_chat/components/InlineDiffPreview.appearance';
import { exportImageAppearanceDescriptor } from '@/flow_chat/components/modern/ExportImageButton.appearance';
import { userMessageItemAppearanceDescriptor } from '@/flow_chat/components/modern/UserMessageItem.appearance';
import { sessionUsageReportCardAppearanceDescriptor } from '@/flow_chat/components/usage/SessionUsageReportCard.appearance';
import { sessionUsageModalAppearanceDescriptor } from '@/flow_chat/components/usage/SessionUsageModal.appearance';
import { createPlanDisplayAppearanceDescriptor } from '@/flow_chat/tool-cards/CreatePlanDisplay.appearance';
import { editorConfigAppearanceDescriptor } from '@/infrastructure/config/components/EditorConfig.appearance';
import { appearanceSettingsAppearanceDescriptor } from '@/infrastructure/config/components/AppearanceSettingsPage.appearance';
import { configAppearanceDescriptor } from '@/infrastructure/config/appearance';
import { fontPreferenceAppearanceDescriptor } from '@/infrastructure/font-preference/appearance';
import { languageSelectorAppearanceDescriptor } from '@/infrastructure/i18n/appearance';
import { peerDeviceAppearanceDescriptor } from '@/infrastructure/peer-device/appearance';
import { updateAppearanceDescriptor } from '@/infrastructure/update/appearance';
import { announcementAppearanceDescriptor } from '@/shared/announcement-system/appearance';
import { contextMenuAppearanceDescriptor } from '@/shared/context-menu-system/appearance';
import { contextListAppearanceDescriptor } from '@/shared/context-system/appearance';
import { notificationAppearanceDescriptor } from '@/shared/notification-system/appearance';
import { canvasToolAppearanceDescriptor } from '@/tools/openbitfun-canvas/appearance';
import { generativeWidgetAppearanceDescriptor } from '@/tools/generative-widget/appearance';
import { editorToolAppearanceDescriptor } from '@/tools/editor/appearance';
import { fileSystemAppearanceDescriptor } from '@/tools/file-system/appearance';
import { gitToolAppearanceDescriptor } from '@/tools/git/appearance';
import { terminalToolAppearanceDescriptor } from '@/tools/terminal/appearance';
import { workspaceToolAppearanceDescriptor } from '@/tools/workspace/appearance';
import { marketAccountControlsAppearanceDescriptor } from '@/features/market-account/appearance';
import { sshRemoteAppearanceDescriptor } from '@/features/ssh-remote/appearance';
import { workbenchAppearanceDescriptor } from '@/app/appearance';
import { welcomeAppearanceDescriptor } from '@/app/scenes/welcome/appearance';
import { shellAppearanceDescriptor } from '@/app/scenes/shell/appearance';
import { agentsAppearanceDescriptor } from '@/app/scenes/agents/appearance';
import { assistantAppearanceDescriptor } from '@/app/scenes/assistant/appearance';
import { browserAppearanceDescriptor } from '@/app/scenes/browser/appearance';
import { gitAppearanceDescriptor } from '@/app/scenes/git/appearance';
import { miniAppAppearanceDescriptor, miniAppGalleryAppearanceDescriptor } from '@/app/scenes/miniapps/appearance';
import { insightsAppearanceDescriptor } from '@/app/scenes/my-agent/appearance';
import { pagesAppearanceDescriptor } from '@/app/scenes/pages/appearance';
import { profileAppearanceDescriptor } from '@/app/scenes/profile/appearance';
import { sessionAppearanceDescriptor } from '@/app/scenes/session/appearance';
import { settingsAppearanceDescriptor } from '@/app/scenes/settings/appearance';
import { ecosystemCompatibilityAppearanceDescriptor } from '@/app/scenes/ecosystem-compatibility/appearance';
import { skillsAppearanceDescriptor } from '@/app/scenes/skills/appearance';
import { terminalAppearanceDescriptor } from '@/app/scenes/terminal/appearance';
import { aboutDialogAppearanceDescriptor } from '@/app/components/AboutDialog/appearance';
import { navPanelAppearanceDescriptor } from '@/app/components/NavPanel/appearance';
import { sessionsSectionAppearanceDescriptor } from '@/app/components/NavPanel/sections/sessions/appearance';
import { deviceOverviewAppearanceDescriptor } from '@/app/components/NavPanel/components/DeviceStatusControl.appearance';
import { sessionNavigationAppearanceDescriptor } from '@/app/components/NavPanel/components/WorkspaceSessionGroupingToggle.appearance';
import { assistantAvatarAppearanceDescriptor } from '@/app/components/AssistantAvatar/appearance';
import { harnessProfileStepAppearanceDescriptor } from '@/app/scenes/agents/components/HarnessProfileStep.appearance';
import { contentCanvasAppearanceDescriptor } from '@/app/components/panels/content-canvas/appearance';
import { filesPanelAppearanceDescriptor } from '@/app/components/panels/FilesPanel.appearance';
import { reviewPlatformAppearanceDescriptor } from '@/app/components/panels/review-platform/appearance';
import { remoteAccountPanelAppearanceDescriptor, remoteConnectDialogAppearanceDescriptor } from '@/app/components/RemoteConnectDialog/appearance';
import { scheduledJobsViewAppearanceDescriptor } from '@/app/components/scheduled-jobs/appearance';
import { localizedDateTimeFieldAppearanceDescriptor } from '@/app/components/scheduled-jobs/LocalizedDateTimeField.appearance';
import { dateTimePickerAppearanceDescriptor } from '@/app/components/scheduled-jobs/DateTimePickerPopover.appearance';
import { todosSceneAppearanceDescriptor } from '@/app/scenes/todos/appearance';
import { flexiblePanelAppearanceDescriptor } from '@/app/components/panels/base/FlexiblePanel.appearance';
import { btwSessionPanelAppearanceDescriptor } from '@/flow_chat/components/btw/BtwSessionPanel.appearance';
import { conversationExcerptAppearanceDescriptor } from '@/flow_chat/selection/ConversationExcerpt.appearance';
import { modernFlowChatAppearanceDescriptor, virtualMessageListAppearanceDescriptor } from '@/flow_chat/components/modern/appearance';
import { modelSettingsAppearanceDescriptor } from '@/infrastructure/config/components/ModelSettingsPage.appearance';
import { reasoningConfigPanelAppearanceDescriptor } from '@/infrastructure/config/components/ReasoningConfigPanel.appearance';
import { reasoningPresetEditorAppearanceDescriptor } from '@/infrastructure/config/components/ReasoningPresetEditor.appearance';
import { externalSourcesConfigAppearanceDescriptor } from '@/infrastructure/config/components/ExternalSourcesConfig.appearance';
import { acpAgentsConfigAppearanceDescriptor } from '@/infrastructure/config/components/AcpAgentsConfig.appearance';
import { runtimeSettingsAppearanceDescriptor } from '@/infrastructure/config/components/RuntimeSettingsPages.appearance';
import { sessionTitleConfigAppearanceDescriptor } from '@/infrastructure/config/components/SessionTitleConfig.appearance';
import { mcpToolsConfigAppearanceDescriptor } from '@/infrastructure/config/components/McpToolsConfig.appearance';
import { mcpServerConfigDialogAppearanceDescriptor } from '@/infrastructure/config/components/MCPServerConfigDialog.appearance';
import { externalMcpOverviewAppearanceDescriptor } from '@/infrastructure/config/components/ExternalMcpOverview.appearance';
import { voiceInputDiagnosticsAppearanceDescriptor } from '@/infrastructure/config/components/VoiceInputDiagnostics.appearance';
import { assistantCardAppearanceDescriptor } from '@/app/scenes/profile/views/AssistantCard.appearance';
import { miniAppCustomizePanelAppearanceDescriptor } from '@/app/scenes/miniapps/customization/MiniAppCustomizePanel.appearance';
import { userMessageEditComposerAppearanceDescriptor } from '@/flow_chat/components/modern/UserMessageEditComposer.appearance';
import { monacoAppearanceAdapter } from '../adapters/MonacoAppearanceAdapter';
import { xtermAppearanceAdapter } from '../adapters/XtermAppearanceAdapter';
import { mermaidAppearanceAdapter } from '../adapters/MermaidAppearanceAdapter';
import { widgetAppearanceAdapter } from '../adapters/WidgetAppearanceAdapter';
import { canvasAppearanceAdapter } from '../adapters/CanvasAppearanceAdapter';
import { themeTokenAppearanceAdapter } from '../adapters/ThemeTokenAppearanceAdapter';
import { tiptapEditorAppearanceDescriptor } from '@/tools/editor/meditor/components/TiptapEditor.appearance';
import { workspaceProjectPermissionsDialogAppearanceDescriptor } from '@/app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsDialog.appearance';
import { workspaceSessionBatchModalAppearanceDescriptor } from '@/app/components/NavPanel/sections/workspaces/WorkspaceSessionBatchModal.appearance';
import { archivedSessionsConfigAppearanceDescriptor } from '@/app/scenes/settings/components/ArchivedSessionsConfig.appearance';
import { settingsViewPageAppearanceDescriptor } from '@/app/scenes/settings/components/SettingsViewPage.appearance';
import {
  automationSettingsPageAppearanceDescriptor,
} from '@/app/scenes/settings/pages/appearance';
import { settingsNavAppearanceDescriptor } from '@/app/scenes/settings/SettingsNav.appearance';
import { backgroundCommandOutputPanelAppearanceDescriptor } from '@/flow_chat/components/background-command/BackgroundCommandOutputPanel.appearance';
import { agentCompanionPetAppearanceDescriptor } from '@/flow_chat/components/AgentCompanionPet.appearance';
import {
  chatContextPickerAppearanceDescriptor,
  legacyFileMentionPickerAppearanceDescriptor,
} from '@/flow_chat/components/ChatContextPicker.appearance';
import { sessionFileModificationsBarAppearanceDescriptor } from '@/flow_chat/components/modern/SessionFileModificationsBar.appearance';
import { conversationModeSurfaceAppearanceDescriptor } from '@/flow_chat/components/voice/ConversationModeSurface.appearance';
import { realtimeVoiceCallAppearanceDescriptor } from '@/flow_chat/components/voice/RealtimeVoiceCall.appearance';
import { editorBreadcrumbAppearanceDescriptor } from '@/tools/editor/components/EditorBreadcrumb.appearance';
import { gitBranchHistoryAppearanceDescriptor } from '@/tools/git/components/GitBranchHistoryView/GitBranchHistoryView.appearance';
import { gitDiffViewAppearanceDescriptor } from '@/tools/git/components/GitDiffView/GitDiffView.appearance';
import { gitSettingsViewAppearanceDescriptor } from '@/tools/git/components/GitSettingsView/GitSettingsView.appearance';
import { quickActionsConfigAppearanceDescriptor } from '@/infrastructure/config/components/QuickActionsConfig.appearance';
import { statusBarPopoversAppearanceDescriptor } from '@/tools/editor/components/StatusBarPopovers/StatusBarPopovers.appearance';
import { mEditorAppearanceDescriptor } from '@/tools/editor/meditor/components/MEditor.appearance';
import { globalSearchAppearanceDescriptor } from '@/app/global-search/GlobalSearchRoot.appearance';
import { workspaceRelatedPathsDialogAppearanceDescriptor } from '@/app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog.appearance';
import { floatingMiniChatAppearanceDescriptor } from '@/app/layout/FloatingMiniChat.appearance';
import { miniAppBubbleWelcomeAppearanceDescriptor } from '@/app/layout/MiniAppBubbleWelcome.appearance';
import { branchesViewAppearanceDescriptor } from '@/app/scenes/git/views/BranchesView.appearance';
import { miniAppGalleryViewAppearanceDescriptor } from '@/app/scenes/miniapps/views/MiniAppGalleryView.appearance';
import { miniAppMarketViewAppearanceDescriptor } from '@/app/scenes/miniapps/views/MiniAppMarketView.appearance';
import { miniAppSubmissionsViewAppearanceDescriptor } from '@/app/scenes/miniapps/views/MiniAppSubmissionsView.appearance';
import { shellNavAppearanceDescriptor } from '@/app/scenes/shell/ShellNav.appearance';
import { missionControlAppearanceDescriptor } from '@/app/components/panels/content-canvas/mission-control/MissionControl.appearance';
import { canvasTabAppearanceDescriptor } from '@/app/components/panels/content-canvas/tab-bar/Tab.appearance';
import { canvasTabBarAppearanceDescriptor } from '@/app/components/panels/content-canvas/tab-bar/TabBar.appearance';
import { chatInputWorkspaceStripAppearanceDescriptor } from '@/flow_chat/components/ChatInputWorkspaceStrip.appearance';
import { codePreviewAppearanceDescriptor } from '@/flow_chat/components/CodePreview.appearance';
import { exploreGroupAppearanceDescriptor } from '@/flow_chat/components/modern/ExploreGroupRenderer.appearance';
import { pendingQueuePanelAppearanceDescriptor } from '@/flow_chat/components/PendingQueuePanel.appearance';
import { subagentProjectionAppearanceDescriptor } from '@/flow_chat/components/subagent/SubagentProjectionView.appearance';
import { threadGoalDialogsAppearanceDescriptor } from '@/flow_chat/components/thread-goal/ThreadGoalDialogs.appearance';
import { welcomePanelAppearanceDescriptor } from '@/flow_chat/components/WelcomePanel.appearance';
import { generativeWidgetToolCardAppearanceDescriptor } from '@/flow_chat/tool-cards/GenerativeWidgetToolCard.appearance';
import { snapshotFullscreenDiffViewerAppearanceDescriptor } from '@/flow_chat/tool-cards/SnapshotFullscreenDiffViewer.appearance';
import { mermaidBlockAppearanceDescriptor } from '@/infrastructure/markdown/MermaidBlock.appearance';
import { defaultModelConfigAppearanceDescriptor } from '@/infrastructure/config/components/DefaultModelConfig.appearance';
import { globalPermissionRulesDialogAppearanceDescriptor } from '@/infrastructure/config/components/GlobalPermissionRulesDialog.appearance';
import { mcpResourceBrowserAppearanceDescriptor } from '@/infrastructure/config/components/MCPResourceBrowser.appearance';
import { editorStatusBarAppearanceDescriptor } from '@/tools/editor/components/EditorStatusBar.appearance';
import { imageViewerAppearanceDescriptor } from '@/tools/editor/components/ImageViewer.appearance';
import { pdfViewerAppearanceDescriptor } from '@/tools/editor/components/PdfViewer.appearance';
import { branchQuickSwitchAppearanceDescriptor } from '@/tools/git/components/BranchQuickSwitch.appearance';
import { workspaceListSectionAppearanceDescriptor } from '@/app/components/NavPanel/sections/workspaces/WorkspaceListSection.appearance';
import { workspaceItemAppearanceDescriptor } from '@/app/components/NavPanel/sections/workspaces/WorkspaceItem.appearance';
import { newProjectDialogAppearanceDescriptor } from '@/app/components/NewProjectDialog/NewProjectDialog.appearance';
import { canvasEditorAreaAppearanceDescriptor } from '@/app/components/panels/content-canvas/editor-area/EditorArea.appearance';
import { canvasEditorGroupAppearanceDescriptor } from '@/app/components/panels/content-canvas/editor-area/EditorGroup.appearance';
import { canvasThumbnailAppearanceDescriptor } from '@/app/components/panels/content-canvas/mission-control/ThumbnailCard.appearance';
import { canvasTabOverflowAppearanceDescriptor } from '@/app/components/panels/content-canvas/tab-bar/TabOverflowMenu.appearance';
import { browserPanelAppearanceDescriptor } from '@/app/scenes/browser/BrowserPanel.appearance';
import { browserPreviewAppearanceDescriptor } from '@/app/scenes/browser/BrowserPreview.appearance';
import { nurseryGalleryAppearanceDescriptor } from '@/app/scenes/profile/views/NurseryGallery.appearance';
import { gitGraphViewAppearanceDescriptor } from '@/app/scenes/git/views/GraphView.appearance';
import { navBarAppearanceDescriptor } from '@/app/components/NavBar/NavBar.appearance';
import { splashScreenAppearanceDescriptor } from '@/app/components/SplashScreen/SplashScreen.appearance';
import { chatPaneAppearanceDescriptor } from '@/app/scenes/session/ChatPane.appearance';
import { auxPaneAppearanceDescriptor } from '@/app/scenes/session/AuxPane.appearance';
import { bottomTerminalPaneAppearanceDescriptor } from '@/app/scenes/session/BottomTerminalPane.appearance';
import { scheduledJobsModalAppearanceDescriptor } from '@/app/components/scheduled-jobs/ScheduledJobsModal.appearance';
import { sceneBarAppearanceDescriptor } from '@/app/components/SceneBar/SceneBar.appearance';
import { panelHeaderAppearanceDescriptor } from '@/app/components/panels/base/PanelHeader.appearance';
import { terminalEditModalAppearanceDescriptor } from '@/app/components/panels/TerminalEditModal.appearance';
import { galleryLayoutAppearanceDescriptor } from '@/app/components/GalleryLayout/GalleryLayout.appearance';
import { skillCardAppearanceDescriptor } from '@/app/scenes/skills/components/SkillCard.appearance';
import { miniAppCardAppearanceDescriptor } from '@/app/scenes/miniapps/components/MiniAppCard.appearance';
import { miniAppDetailModalAppearanceDescriptor } from '@/app/scenes/miniapps/components/MiniAppDetailModal.appearance';
import { agentCardAppearanceDescriptor } from '@/app/scenes/agents/components/AgentCard.appearance';
import { coreAgentCardAppearanceDescriptor } from '@/app/scenes/agents/components/CoreAgentCard.appearance';
import { agentCapabilityTooltipAppearanceDescriptor } from '@/app/scenes/agents/components/AgentCapabilityTooltip.appearance';
import { agentCapabilityOptionAppearanceDescriptor } from '@/app/scenes/agents/components/AgentCapabilityOption.appearance';
import { gitNavAppearanceDescriptor } from '@/app/scenes/git/GitNav.appearance';
import { fileViewerNavAppearanceDescriptor } from '@/app/scenes/file-viewer/FileViewerNav.appearance';
import { assistantQuickInputAppearanceDescriptor } from '@/app/scenes/profile/views/AssistantQuickInput.appearance';
import { galleryDetailModalAppearanceDescriptor } from '@/app/components/GalleryLayout/GalleryDetailModal.appearance';
import { mcpInteractionDialogAppearanceDescriptor } from '@/app/components/MCPInteractionDialog/MCPInteractionDialog.appearance';
import { remoteConnectDisclaimerAppearanceDescriptor } from '@/app/components/RemoteConnectDialog/RemoteConnectDisclaimer.appearance';
import { diffFullscreenViewerAppearanceDescriptor } from '@/app/components/panels/DiffFullscreenViewer.appearance';
import { notificationButtonAppearanceDescriptor } from '@/app/components/TitleBar/NotificationButton.appearance';
import { deepReviewConsentDialogAppearanceDescriptor } from '@/flow_chat/components/DeepReviewConsentDialog.appearance';
import { flowToolCardAppearanceDescriptor } from '@/flow_chat/components/FlowToolCard.appearance';
import { flowTextBlockAppearanceDescriptor } from '@/flow_chat/components/FlowTextBlock.appearance';
import { chatInputApprovalBandAppearanceDescriptor } from '@/flow_chat/components/ChatInputApprovalBand.appearance';
import { canvasToolCardAppearanceDescriptor } from '@/flow_chat/tool-cards/CanvasToolCard.appearance';
import { computerUseToolCardAppearanceDescriptor } from '@/flow_chat/tool-cards/ComputerUseToolCard.appearance';
import { openBitFunControlToolCardAppearanceDescriptor } from '@/flow_chat/tool-cards/OpenBitFunControlToolCard.appearance';
import { miniAppToolDisplayAppearanceDescriptor } from '@/flow_chat/tool-cards/MiniAppToolDisplay.appearance';
import { modelThinkingDisplayAppearanceDescriptor } from '@/flow_chat/tool-cards/ModelThinkingDisplay.appearance';
import { toolTimeoutIndicatorAppearanceDescriptor } from '@/flow_chat/tool-cards/ToolTimeoutIndicator.appearance';
import { acpPermissionActionsAppearanceDescriptor } from '@/flow_chat/tool-cards/AcpPermissionActions.appearance';
import { acpPlanPanelAppearanceDescriptor } from '@/flow_chat/components/AcpPlanPanel.appearance';
import { backgroundCommandInputDialogAppearanceDescriptor } from '@/flow_chat/components/background-command/BackgroundCommandInputDialog.appearance';
import { chatEmptyStateAppearanceDescriptor } from '@/flow_chat/components/ChatEmptyState.appearance';
import { copyOutputButtonAppearanceDescriptor } from '@/flow_chat/components/CopyOutputButton.appearance';
import { copyableTextPreviewAppearanceDescriptor } from '@/flow_chat/components/CopyableTextPreview.appearance';
import { currentSessionTitleAppearanceDescriptor } from '@/flow_chat/components/CurrentSessionTitle.appearance';
import { sessionTitleNumberAppearanceDescriptor } from '@/flow_chat/components/SessionTitleNumber.appearance';
import { coworkExampleCardsAppearanceDescriptor } from '@/flow_chat/components/CoworkExampleCards.appearance';
import { imageAnalysisCardAppearanceDescriptor } from '@/flow_chat/components/ImageAnalysisCard.appearance';
import { scrollToBottomButtonAppearanceDescriptor } from '@/flow_chat/components/ScrollToBottomButton.appearance';
import { scrollToLatestBarAppearanceDescriptor } from '@/flow_chat/components/ScrollToLatestBar.appearance';
import { scrollToTurnHeaderButtonAppearanceDescriptor } from '@/flow_chat/components/ScrollToTurnHeaderButton.appearance';
import { tokenUsageIndicatorAppearanceDescriptor } from '@/flow_chat/components/TokenUsageIndicator.appearance';
import { toolApprovalBarAppearanceDescriptor } from '@/flow_chat/components/ToolApprovalBar.appearance';
import { smartRecommendationsAppearanceDescriptor } from '@/flow_chat/components/smart-recommendations/SmartRecommendations.appearance';
import { sessionRuntimeStatusEntryAppearanceDescriptor } from '@/flow_chat/components/usage/SessionRuntimeStatusEntry.appearance';
import { runtimeStatusSlotAppearanceDescriptor } from '@/flow_chat/components/modern/RuntimeStatusSlot.appearance';
import { sessionMenuAppearanceDescriptor } from '@/flow_chat/components/session-menu/SessionMenu.appearance';
import { subagentAvatarAppearanceDescriptor } from '@/flow_chat/subagent-identity/SubagentAvatar.appearance';
import {
  dispatchInstallDialogAppearanceDescriptor,
  dispatchResultDialogAppearanceDescriptor,
  dispatchTargetPickerAppearanceDescriptor,
} from '@/features/dispatch/appearance';
import { voiceInputConfigAppearanceDescriptor } from '@/infrastructure/config/components/VoiceInputConfig.appearance';
import { worktreeSettingsAppearanceDescriptor } from '@/infrastructure/config/components/WorktreeSettingsPage.appearance';
import { usageStatisticsConfigAppearanceDescriptor } from '@/infrastructure/config/components/UsageStatisticsConfig.appearance';
import { turnCompletionNoticeAppearanceDescriptor } from '@/flow_chat/components/modern/TurnCompletionNoticeItem.appearance';
import { turnFailureNoticeAppearanceDescriptor } from '@/flow_chat/components/modern/TurnFailureNoticeItem.appearance';
import { virtualItemAppearanceDescriptor } from '@/flow_chat/components/modern/VirtualItemRenderer.appearance';
import { AppearanceRegistry } from './AppearanceRegistry';

export function createDefaultAppearanceRegistry(): AppearanceRegistry {
  return new AppearanceRegistry()
    .registerComponent(confirmDialogAppearanceDescriptor)
    .registerComponent(inputDialogAppearanceDescriptor)
    .registerComponent(windowControlsAppearanceDescriptor)
    .registerComponent(navigationTransitionBoundaryAppearanceDescriptor)
    .registerComponent(markdownAppearanceDescriptor)
    .registerComponent(chatInputAppearanceDescriptor)
    .registerComponent(harnessProfileSelectorAppearanceDescriptor)
    .registerComponent(composerVoiceInputAppearanceDescriptor)
    .registerComponent(sessionUsagePanelAppearanceDescriptor)
    .registerComponent(richTextInputAppearanceDescriptor)
    .registerComponent(modelRoundItemAppearanceDescriptor)
    .registerComponent(deepReviewActionBarAppearanceDescriptor)
    .registerComponent(deepResearchProtocolAppearanceDescriptor)
    .registerComponent(modelSelectorAppearanceDescriptor)
    .registerComponent(reasoningPresetSelectorAppearanceDescriptor)
    .registerComponent(acpModeSelectorAppearanceDescriptor)
    .registerComponent(flowChatHeaderAppearanceDescriptor)
    .registerComponent(flowChatTurnRailAppearanceDescriptor)
    .registerComponent(sessionFilesBadgeAppearanceDescriptor)
    .registerComponent(codeReviewToolCardAppearanceDescriptor)
    .registerComponent(createAgentPageAppearanceDescriptor)
    .registerComponent(keyboardShortcutsAppearanceDescriptor)
    .registerComponent(taskToolDisplayAppearanceDescriptor)
    .registerComponent(applicationSettingsAppearanceDescriptor)
    .registerComponent(markdownEditorAppearanceDescriptor)
    .registerComponent(planViewerAppearanceDescriptor)
    .registerComponent(appLayoutAppearanceDescriptor)
    .registerComponent(skillGroupPickerAppearanceDescriptor)
    .registerComponent(workingCopyViewAppearanceDescriptor)
    .registerComponent(assistantConfigPageAppearanceDescriptor)
    .registerComponent(assistantDefaultsPageAppearanceDescriptor)
    .registerComponent(taskDetailPanelAppearanceDescriptor)
    .registerComponent(toolbarModeAppearanceDescriptor)
    .registerComponent(mcpToolDisplayAppearanceDescriptor)
    .registerComponent(skillsConfigAppearanceDescriptor)
    .registerComponent(diffEditorAppearanceDescriptor)
    .registerComponent(agentCompanionDesktopPetAppearanceDescriptor)
    .registerComponent(toolGroupPickerAppearanceDescriptor)
    .registerComponent(inlineDiffPreviewAppearanceDescriptor)
    .registerComponent(exportImageAppearanceDescriptor)
    .registerComponent(userMessageItemAppearanceDescriptor)
    .registerComponent(sessionUsageReportCardAppearanceDescriptor)
    .registerComponent(sessionUsageModalAppearanceDescriptor)
    .registerComponent(createPlanDisplayAppearanceDescriptor)
    .registerComponent(editorConfigAppearanceDescriptor)
    .registerComponent(appearanceSettingsAppearanceDescriptor)
    .registerComponent(configAppearanceDescriptor)
    .registerComponent(fontPreferenceAppearanceDescriptor)
    .registerComponent(languageSelectorAppearanceDescriptor)
    .registerComponent(peerDeviceAppearanceDescriptor)
    .registerComponent(updateAppearanceDescriptor)
    .registerComponent(assistantAvatarAppearanceDescriptor)
    .registerComponent(deviceOverviewAppearanceDescriptor)
    .registerComponent(sessionNavigationAppearanceDescriptor)
    .registerComponent(harnessProfileStepAppearanceDescriptor)
    .registerComponent(subagentAvatarAppearanceDescriptor)
    .registerComponent(announcementAppearanceDescriptor)
    .registerComponent(contextMenuAppearanceDescriptor)
    .registerComponent(contextListAppearanceDescriptor)
    .registerComponent(notificationAppearanceDescriptor)
    .registerComponent(canvasToolAppearanceDescriptor)
    .registerComponent(generativeWidgetAppearanceDescriptor)
    .registerComponent(editorToolAppearanceDescriptor)
    .registerComponent(fileSystemAppearanceDescriptor)
    .registerComponent(gitToolAppearanceDescriptor)
    .registerComponent(terminalToolAppearanceDescriptor)
    .registerComponent(workspaceToolAppearanceDescriptor)
    .registerComponent(gitGraphViewAppearanceDescriptor)
    .registerComponent(navBarAppearanceDescriptor)
    .registerComponent(splashScreenAppearanceDescriptor)
    .registerComponent(chatPaneAppearanceDescriptor)
    .registerComponent(auxPaneAppearanceDescriptor)
    .registerComponent(bottomTerminalPaneAppearanceDescriptor)
    .registerComponent(scheduledJobsModalAppearanceDescriptor)
    .registerComponent(sceneBarAppearanceDescriptor)
    .registerComponent(panelHeaderAppearanceDescriptor)
    .registerComponent(terminalEditModalAppearanceDescriptor)
    .registerComponent(galleryLayoutAppearanceDescriptor)
    .registerComponent(skillCardAppearanceDescriptor)
    .registerComponent(miniAppCardAppearanceDescriptor)
    .registerComponent(miniAppDetailModalAppearanceDescriptor)
    .registerComponent(agentCardAppearanceDescriptor)
    .registerComponent(coreAgentCardAppearanceDescriptor)
    .registerComponent(agentCapabilityTooltipAppearanceDescriptor)
    .registerComponent(agentCapabilityOptionAppearanceDescriptor)
    .registerComponent(gitNavAppearanceDescriptor)
    .registerComponent(fileViewerNavAppearanceDescriptor)
    .registerComponent(assistantQuickInputAppearanceDescriptor)
    .registerComponent(galleryDetailModalAppearanceDescriptor)
    .registerComponent(mcpInteractionDialogAppearanceDescriptor)
    .registerComponent(remoteConnectDisclaimerAppearanceDescriptor)
    .registerComponent(diffFullscreenViewerAppearanceDescriptor)
    .registerComponent(notificationButtonAppearanceDescriptor)
    .registerComponent(marketAccountControlsAppearanceDescriptor)
    .registerComponent(sshRemoteAppearanceDescriptor)
    .registerComponent(aboutDialogAppearanceDescriptor)
    .registerComponent(navPanelAppearanceDescriptor)
    .registerComponent(sessionsSectionAppearanceDescriptor)
    .registerComponent(contentCanvasAppearanceDescriptor)
    .registerComponent(filesPanelAppearanceDescriptor)
    .registerComponent(reviewPlatformAppearanceDescriptor)
    .registerComponent(remoteConnectDialogAppearanceDescriptor)
    .registerComponent(remoteAccountPanelAppearanceDescriptor)
    .registerComponent(scheduledJobsViewAppearanceDescriptor)
    .registerComponent(localizedDateTimeFieldAppearanceDescriptor)
    .registerComponent(dateTimePickerAppearanceDescriptor)
    .registerComponent(flexiblePanelAppearanceDescriptor)
    .registerComponent(btwSessionPanelAppearanceDescriptor)
    .registerComponent(conversationExcerptAppearanceDescriptor)
    .registerComponent(modernFlowChatAppearanceDescriptor)
    .registerComponent(virtualMessageListAppearanceDescriptor)
    .registerComponent(modelSettingsAppearanceDescriptor)
    .registerComponent(reasoningConfigPanelAppearanceDescriptor)
    .registerComponent(reasoningPresetEditorAppearanceDescriptor)
    .registerComponent(externalSourcesConfigAppearanceDescriptor)
    .registerComponent(acpAgentsConfigAppearanceDescriptor)
    .registerComponent(runtimeSettingsAppearanceDescriptor)
    .registerComponent(sessionTitleConfigAppearanceDescriptor)
    .registerComponent(mcpToolsConfigAppearanceDescriptor)
    .registerComponent(mcpServerConfigDialogAppearanceDescriptor)
    .registerComponent(externalMcpOverviewAppearanceDescriptor)
    .registerComponent(voiceInputDiagnosticsAppearanceDescriptor)
    .registerComponent(assistantCardAppearanceDescriptor)
    .registerComponent(miniAppCustomizePanelAppearanceDescriptor)
    .registerComponent(userMessageEditComposerAppearanceDescriptor)
    .registerComponent(tiptapEditorAppearanceDescriptor)
    .registerComponent(workspaceProjectPermissionsDialogAppearanceDescriptor)
    .registerComponent(workspaceSessionBatchModalAppearanceDescriptor)
    .registerComponent(archivedSessionsConfigAppearanceDescriptor)
    .registerComponent(usageStatisticsConfigAppearanceDescriptor)
    .registerComponent(settingsNavAppearanceDescriptor)
    .registerComponent(settingsViewPageAppearanceDescriptor)
    .registerComponent(automationSettingsPageAppearanceDescriptor)
    .registerComponent(backgroundCommandOutputPanelAppearanceDescriptor)
    .registerComponent(agentCompanionPetAppearanceDescriptor)
    .registerComponent(chatContextPickerAppearanceDescriptor)
    .registerComponent(legacyFileMentionPickerAppearanceDescriptor)
    .registerComponent(sessionFileModificationsBarAppearanceDescriptor)
    .registerComponent(conversationModeSurfaceAppearanceDescriptor)
    .registerComponent(realtimeVoiceCallAppearanceDescriptor)
    .registerComponent(editorBreadcrumbAppearanceDescriptor)
    .registerComponent(gitBranchHistoryAppearanceDescriptor)
    .registerComponent(gitDiffViewAppearanceDescriptor)
    .registerComponent(gitSettingsViewAppearanceDescriptor)
    .registerComponent(quickActionsConfigAppearanceDescriptor)
    .registerComponent(statusBarPopoversAppearanceDescriptor)
    .registerComponent(mEditorAppearanceDescriptor)
    .registerComponent(globalSearchAppearanceDescriptor)
    .registerComponent(workspaceRelatedPathsDialogAppearanceDescriptor)
    .registerComponent(floatingMiniChatAppearanceDescriptor)
    .registerComponent(miniAppBubbleWelcomeAppearanceDescriptor)
    .registerComponent(branchesViewAppearanceDescriptor)
    .registerComponent(miniAppGalleryViewAppearanceDescriptor)
    .registerComponent(miniAppMarketViewAppearanceDescriptor)
    .registerComponent(miniAppSubmissionsViewAppearanceDescriptor)
    .registerComponent(shellNavAppearanceDescriptor)
    .registerComponent(missionControlAppearanceDescriptor)
    .registerComponent(canvasTabAppearanceDescriptor)
    .registerComponent(canvasTabBarAppearanceDescriptor)
    .registerComponent(chatInputWorkspaceStripAppearanceDescriptor)
    .registerComponent(codePreviewAppearanceDescriptor)
    .registerComponent(exploreGroupAppearanceDescriptor)
    .registerComponent(pendingQueuePanelAppearanceDescriptor)
    .registerComponent(subagentProjectionAppearanceDescriptor)
    .registerComponent(threadGoalDialogsAppearanceDescriptor)
    .registerComponent(welcomePanelAppearanceDescriptor)
    .registerComponent(generativeWidgetToolCardAppearanceDescriptor)
    .registerComponent(snapshotFullscreenDiffViewerAppearanceDescriptor)
    .registerComponent(mermaidBlockAppearanceDescriptor)
    .registerComponent(defaultModelConfigAppearanceDescriptor)
    .registerComponent(globalPermissionRulesDialogAppearanceDescriptor)
    .registerComponent(mcpResourceBrowserAppearanceDescriptor)
    .registerComponent(editorStatusBarAppearanceDescriptor)
    .registerComponent(imageViewerAppearanceDescriptor)
    .registerComponent(pdfViewerAppearanceDescriptor)
    .registerComponent(branchQuickSwitchAppearanceDescriptor)
    .registerComponent(workspaceListSectionAppearanceDescriptor)
    .registerComponent(workspaceItemAppearanceDescriptor)
    .registerComponent(newProjectDialogAppearanceDescriptor)
    .registerComponent(canvasEditorAreaAppearanceDescriptor)
    .registerComponent(canvasEditorGroupAppearanceDescriptor)
    .registerComponent(canvasThumbnailAppearanceDescriptor)
    .registerComponent(canvasTabOverflowAppearanceDescriptor)
    .registerComponent(browserPanelAppearanceDescriptor)
    .registerComponent(browserPreviewAppearanceDescriptor)
    .registerComponent(nurseryGalleryAppearanceDescriptor)
    .registerComponent(deepReviewConsentDialogAppearanceDescriptor)
    .registerComponent(flowToolCardAppearanceDescriptor)
    .registerComponent(flowTextBlockAppearanceDescriptor)
    .registerComponent(chatInputApprovalBandAppearanceDescriptor)
    .registerComponent(canvasToolCardAppearanceDescriptor)
    .registerComponent(computerUseToolCardAppearanceDescriptor)
    .registerComponent(openBitFunControlToolCardAppearanceDescriptor)
    .registerComponent(miniAppToolDisplayAppearanceDescriptor)
    .registerComponent(modelThinkingDisplayAppearanceDescriptor)
    .registerComponent(toolTimeoutIndicatorAppearanceDescriptor)
    .registerComponent(acpPermissionActionsAppearanceDescriptor)
    .registerComponent(acpPlanPanelAppearanceDescriptor)
    .registerComponent(backgroundCommandInputDialogAppearanceDescriptor)
    .registerComponent(chatEmptyStateAppearanceDescriptor)
    .registerComponent(copyOutputButtonAppearanceDescriptor)
    .registerComponent(copyableTextPreviewAppearanceDescriptor)
    .registerComponent(currentSessionTitleAppearanceDescriptor)
    .registerComponent(sessionTitleNumberAppearanceDescriptor)
    .registerComponent(coworkExampleCardsAppearanceDescriptor)
    .registerComponent(imageAnalysisCardAppearanceDescriptor)
    .registerComponent(scrollToBottomButtonAppearanceDescriptor)
    .registerComponent(scrollToLatestBarAppearanceDescriptor)
    .registerComponent(scrollToTurnHeaderButtonAppearanceDescriptor)
    .registerComponent(tokenUsageIndicatorAppearanceDescriptor)
    .registerComponent(toolApprovalBarAppearanceDescriptor)
    .registerComponent(smartRecommendationsAppearanceDescriptor)
    .registerComponent(sessionRuntimeStatusEntryAppearanceDescriptor)
    .registerComponent(runtimeStatusSlotAppearanceDescriptor)
    .registerComponent(sessionMenuAppearanceDescriptor)
    .registerComponent(dispatchInstallDialogAppearanceDescriptor)
    .registerComponent(dispatchResultDialogAppearanceDescriptor)
    .registerComponent(dispatchTargetPickerAppearanceDescriptor)
    .registerComponent(voiceInputConfigAppearanceDescriptor)
    .registerComponent(worktreeSettingsAppearanceDescriptor)
    .registerComponent(turnCompletionNoticeAppearanceDescriptor)
    .registerComponent(turnFailureNoticeAppearanceDescriptor)
    .registerComponent(virtualItemAppearanceDescriptor)
    .registerScene(workbenchAppearanceDescriptor)
    .registerScene(welcomeAppearanceDescriptor)
    .registerScene(shellAppearanceDescriptor)
    .registerScene(agentsAppearanceDescriptor)
    .registerScene(assistantAppearanceDescriptor)
    .registerScene(browserAppearanceDescriptor)
    .registerScene(gitAppearanceDescriptor)
    .registerScene(miniAppGalleryAppearanceDescriptor)
    .registerScene(miniAppAppearanceDescriptor)
    .registerScene(insightsAppearanceDescriptor)
    .registerScene(pagesAppearanceDescriptor)
    .registerScene(profileAppearanceDescriptor)
    .registerScene(sessionAppearanceDescriptor)
    .registerScene(settingsAppearanceDescriptor)
    .registerScene(ecosystemCompatibilityAppearanceDescriptor)
    .registerScene(skillsAppearanceDescriptor)
    .registerScene(terminalAppearanceDescriptor)
    .registerScene(todosSceneAppearanceDescriptor)
    .registerRenderer(themeTokenAppearanceAdapter)
    .registerRenderer(monacoAppearanceAdapter)
    .registerRenderer(xtermAppearanceAdapter)
    .registerRenderer(mermaidAppearanceAdapter)
    .registerRenderer(widgetAppearanceAdapter)
    .registerRenderer(canvasAppearanceAdapter)
    .freeze();
}
