import assert from "node:assert/strict";
import test from "node:test";
import { componentRegistry } from "../dist/registry.js";

test("component names remain unique", () => {
  const names = componentRegistry.map((component) => component.name);
  assert.equal(new Set(names).size, names.length);
});

test("registry exposes only the formal stable components", () => {
  assert.deepEqual(
    componentRegistry.map((component) => component.name),
    [
      "GoalToolCard", "AgentRosterToolCard", "SessionHistoryToolCard", "ImageAnalysisToolCard", "TimeToolCard",
      "McpResourceToolCard", "WorktreeToolCard", "PortForwardToolCard", "ReviewPlatformToolCard", "FrontendWorkbenchToolCard",
      "MiniAppFinalizeToolCard", "MarketplacePublishToolCard", "PlaybookToolCard",
      "ActionCard",
      "ActionItem",
      "ActivityItem",
      "Alert",
      "AgentControlToolCard",
      "AgentWaitToolCard",
      "AmbientToolCard",
      "AskUser",
      "Avatar",
      "Button",
      "Card",
      "Checkbox",
      "ChatComposer",
      "ThinkingBlock",
      "FlowGroup",
      "ExploreGroup",
      "ContextLoadGroup",
      "FlowChatRuntimeStatus",
      "CommandToolCard",
      "ToolRelationRow",
      "Composer",
      "Combobox",
      "ConfirmDialog",
      "ContextCompressionToolCard",
      "ControlHubToolCard",
      "CronToolCard",
      "DefaultToolCard",
      "Disclosure",
      "Empty",
      "DirectoryListToolCard",
      "Field",
      "FieldGroup",
      "FileDiffToolCard",
      "FileOperationToolCard",
      "GetToolSpecToolCard",
      "GitToolCard",
      "GlobSearchToolCard",
      "GrepSearchToolCard",
      "Icon",
      "IconButton",
      "ThinkingIndicator",
      "Input",
      "KeyHint",
      "LauncherButton",
      "Listbox",
      "ListModelsToolCard",
      "LoadingState",
      "Menu",
      "MobileActionSheet",
      "MobileBadge",
      "MobileBanner",
      "MobileButton",
      "MobileCard",
      "MobileChoiceSheet",
      "MobileConfirmSheet",
      "MobileComposer",
      "MobileDisclosure",
      "MobileFileButton",
      "MobileFloatingActions",
      "MobileIconButton",
      "MobileLink",
      "MobileListRow",
      "MobileMessage",
      "MobilePageHeader",
      "MobileScrim",
      "MobileSection",
      "MobileSegmentedControl",
      "MobileSheet",
      "MobileStatus",
      "MobileTextField",
      "MobileTextarea",
      "Dialog",
      "MultiSelect",
      "NavigationPanel",
      "NumberInput",
      "NumberBadge",
      "PageDeployToolCard",
      "PageHeader",
      "Radio",
      "PagePublishToolCard",
      "ProminentToolCard",
      "ReadFileToolCard",
      "ReviewSummaryToolCard",
      "RollingText",
      "ShimmerText",
      "RunCodeToolCard",
      "ScrollArea",
      "SplitView",
      "SearchField",
      "SegmentedControl",
      "Select",
      "Sheet",
      "SessionControlToolCard",
      "SessionMessageToolCard",
      "SkillToolCard",
      "StatusPill",
      "Spinner",
      "Switch",
      "TabGroup",
      "Textarea",
      "TerminalControlToolCard",
      "TodoToolCard",
      "Toolbar",
      "Tooltip",
      "VoiceCallPanel",
      "OpenBitFunSolidMark",
      "OpenBitFunAppIcon",
      "OpenBitFunMark",
      "OpenBitFunBrandMotion",
      "SubagentHatch",
      "VoiceParticleLogo",
      "ViewImageToolCard",
      "WebFetchToolCard",
      "WebSearchToolCard",
    ],
  );
  assert.equal(
    componentRegistry.every((component) => component.maturity === "stable"),
    true,
  );
});

test("every registered component declares states and owned tokens", () => {
  for (const component of componentRegistry) {
    assert.ok(component.states.length > 0, `${component.name} has no declared states.`);
    assert.ok(component.tokens.length > 0, `${component.name} has no declared tokens.`);
    assert.equal(
      component.tokens.every(
        (token) =>
          token.startsWith("border.") ||
          token.startsWith("color.") ||
          (component.name === "Button" && token.startsWith("component.button.")) ||
          (component.name === "Empty" && token.startsWith("component.empty.")) ||
          (component.name === "TabGroup" && [
            "component.button.outlineBorder",
            "component.button.outlineBorderInteractive",
            "component.button.fillBackground",
          ].includes(token)) ||
          token.startsWith("control.") ||
          token.startsWith("effect.") ||
          token.startsWith("font.") ||
          token.startsWith("letterSpacing.") ||
          token.startsWith("lineHeight.") ||
          token.startsWith("layout.") ||
          token.startsWith("motion.") ||
          token === "opacity.iconArtwork" ||
          token.startsWith("overlay.") ||
          token.startsWith("radius.") ||
          token.startsWith("scrollbar.") ||
          token.startsWith("shadow.") ||
          token.startsWith("space.") ||
          token.startsWith("type."),
      ),
      true,
      `${component.name} contains a token outside the allowed public layers.`,
    );
  }
});
