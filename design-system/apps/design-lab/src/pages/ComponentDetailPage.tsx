import { Fragment, useMemo, useState } from "react";
import { VoiceCallPreview, VoiceParticlePreview } from "../components/VoiceCallPreview";
import { Clipboard, List } from "lucide-react";
import {
  ActionCard,
  ActionItem,
  ActivityItem,
  Alert,
  Avatar,
  AvatarGroup,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  CardMedia,
  ChangeCount,
  Checkbox,
  Composer,
  Combobox,
  ComposerContextBar,
  ComposerDivider,
  ComposerToolbar,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogHeading,
  DialogTitle,
  Disclosure,
  Empty,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon,
  IconButton,
  canonicalIconNames,
  NumberBadge,
  Input,
  KeyHint,
  LauncherButton,
  Listbox,
  ListboxOption,
  LoadingState,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MultiSelect,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelFooter,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
  NavigationPanelSeparator,
  NumberInput,
  PageHeader,
  Radio,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Select,
  Sheet,
  StatusPill,
  Spinner,
  Switch,
  TabGroup,
  Textarea,
  ThemeRoot,
  Toolbar,
  ToolbarBadge,
  ToolbarGroup,
  ToolbarSeparator,
  Tooltip,
  type ColorScheme,
  type ConfirmDialogType,
  type ContrastMode,
  type DensityMode,
  type IconName,
  type IconSize,
  type IconTone,
  type ActivityItemAppearance,
  type ActionCardSize,
  type CardContentAlignment,
  type ScrollAreaOrientation,
  type ScrollbarVisibility,
  type StatusPillTone,
  type TabGroupSize,
  type ToolbarSize,
  type TokenOverrides,
} from "@openbitfun/ui";
import {
  MobileActionSheet,
  MobileBadge,
  MobileBanner,
  MobileButton,
  MobileCard,
  MobileChoiceSheet,
  MobileConfirmSheet,
  MobileComposer,
  MobileDisclosure,
  MobileFileButton,
  MobileFloatingActions,
  MobileIconButton,
  MobileLink,
  MobileListRow,
  MobileMessage,
  MobilePageHeader,
  MobileScrim,
  MobileSection,
  MobileSegmentedControl,
  MobileSheet,
  MobileStatus,
  MobileTextField,
  MobileTextarea,
} from "@openbitfun/ui/mobile";
import type { ComponentMeta } from "@openbitfun/ui/registry";
import previewImage from "../assets/design-system-hero.webp";
import { IconCompositionPreview } from "../preview/IconCompositionPreview";
import { RollingTextPreview } from "../preview/RollingTextPreview";
import { NestedMenuPattern } from "./ReferencePatterns";
import { useI18n, type MessageKey } from "../i18n";
import {
  getComponentCategoryLabel,
  getComponentDescription,
} from "../i18n/componentMetadata";
import {
  FlowChatComponentPreview,
  getFlowChatPreviewDefinition,
} from "../preview/FlowChatPreviewRegistry";

interface ComponentDetailPageProps {
  colorScheme: ColorScheme;
  component: ComponentMeta;
  contrast: ContrastMode;
  density: DensityMode;
  onBack: () => void;
  onInspectTokens: (name: string) => void;
  tokenOverrides: TokenOverrides;
}

type CopyStatus = "idle" | "copied" | "unavailable";
type InspectorTab = "properties" | "styles" | "tokens";
type PreviewIcon = "chevron" | "none";
type PreviewIconPosition = "left" | "right";
type PreviewSize = "sm" | "md" | "lg";
type FieldOrientation = "horizontal" | "vertical";
type PageHeaderAlign = "center" | "start";
type PageHeaderSize = "display" | "lg" | "md" | "sm";

const buttonVariants = ["outline", "fill", "secondary", "primary", "text"] as const;
const iconButtonVariants = ["quiet", "outline", "fill", "primary"] as const;
const iconButtonSizes = ["xs", "standard", "sm", "md", "lg"] as const;
const buttonInspectorStates = ["default", "hover", "active"] as const;
const fieldOrientations = ["vertical", "horizontal"] as const;
const pageHeaderAlignments = ["start", "center"] as const;
const cardContentAlignments = ["start", "center", "end"] as const;
const pageHeaderSizes = ["sm", "md", "lg", "display"] as const;
const scrollAreaOrientations = ["vertical", "horizontal", "both"] as const;
const activityItemAppearances = ["inline", "surface"] as const;
const actionCardSizes = ["sm", "md"] as const;
const iconSizes = ["2xs", "xs", "sm", "md", "lg"] as const;
const iconTones = ["inherit", "primary", "secondary", "muted", "disabled", "info", "success", "warning", "danger"] as const;

const optionLabelKeys: Readonly<Record<string, MessageKey>> = {
  active: "detail.option.active",
  "active-option": "detail.option.active-option",
  always: "detail.option.always",
  asking: "detail.option.asking",
  auto: "detail.option.auto",
  both: "detail.option.both",
  chevron: "detail.option.chevron",
  center: "detail.option.center",
  default: "detail.option.default",
  replacing: "detail.option.replacing",
  disabled: "detail.option.disabled",
  filled: "detail.option.filled",
  "read-only": "detail.option.read-only",
  display: "detail.option.display",
  error: "detail.option.error",
  expanded: "detail.option.expanded",
  fill: "detail.option.fill",
  "focus-visible": "detail.option.focus-visible",
  hover: "detail.option.hover",
  info: "detail.option.info",
  horizontal: "detail.option.horizontal",
  hidden: "detail.option.hidden",
  inline: "detail.option.inline",
  scrolling: "detail.option.scrolling",
  "focus-within": "detail.option.focus-within",
  "with-context": "detail.option.with-context",
  "with-center": "detail.option.with-center",
  overflow: "detail.option.overflow",
  "disabled-item": "detail.option.disabled-item",
  "selected-item": "detail.option.selected-item",
  "checked-item": "detail.option.checked-item",
  invalid: "detail.option.invalid",
  left: "detail.option.left",
  lg: "detail.option.lg",
  loading: "detail.option.loading",
  multiple: "detail.option.multiple",
  custom: "detail.option.custom",
  empty: "detail.option.empty",
  pending: "detail.option.pending",
  plain: "detail.option.plain",
  divided: "detail.option.divided",
  md: "detail.option.md",
  none: "detail.option.none",
  off: "detail.option.off",
  on: "detail.option.on",
  open: "detail.option.open",
  outline: "detail.option.outline",
  primary: "detail.option.primary",
  quiet: "detail.option.quiet",
  raised: "detail.option.raised",
  right: "detail.option.right",
  confirmation: "detail.option.confirmation",
  completed: "detail.option.completed",
  selected: "detail.option.selected",
  "selected-option": "detail.option.selected-option",
  sm: "detail.option.sm",
  start: "detail.option.start",
  surface: "detail.option.surface",
  subtle: "detail.option.subtle",
  submitting: "detail.option.submitting",
  success: "detail.option.success",
  searching: "detail.option.searching",
  text: "detail.option.text",
  media: "detail.option.media",
  unselected: "detail.option.unselected",
  vertical: "detail.option.vertical",
  warning: "detail.option.warning",
};

function InspectorSelect({
  label,
  onChange,
  options,
  translateOptions = true,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly string[];
  translateOptions?: boolean;
  value: string;
}) {
  const { t } = useI18n();

  return (
    <label className="component-inspector-select">
      <span>{label}</span>
      <select onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => (
          <option key={option} value={option}>
            {translateOptions && optionLabelKeys[option] ? t(optionLabelKeys[option]) : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function InspectorToggle({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="component-inspector-toggle">
      <span>{label}</span>
      <Switch
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

function NumberInputPreview({ state }: { state: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(8);
  return (
    <NumberInput
      aria-label={t("components.preview.inputLabel")}
      className={`component-number-input-example lab-state-${state}`}
      disabled={state === "disabled"}
      onValueChange={setValue}
      value={value}
    />
  );
}

function SearchFieldStatePreview({ state }: { state: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(state === "default" ? "" : "OpenBitFun");
  const sharedProps = {
    disabled: state === "disabled",
    invalid: state === "invalid",
    readOnly: state === "read-only",
    onValueChange: setValue,
    value,
    className: state === "hover" ? "lab-force-hover" : state === "focus-visible" ? "lab-force-focus" : undefined,
  };
  return (
    <div className="component-search-field-examples">
      {(["sm", "md", "lg"] as const).map((size) => (
        <div className="component-search-field-example" key={size}>
          <code>{size}</code>
          <SearchField
            {...sharedProps}
            size={size}
            aria-label={t("components.preview.searchLabel")}
            clearLabel={t("components.preview.searchClear")}
            leadingIcon={<Icon name="search" />}
            onClear={() => setValue("")}
            placeholder={t("components.preview.searchPlaceholder")}
            shortcut={<KeyHint icon={<Icon name="command-mac" />}>K</KeyHint>}
          />
          <SearchField
            {...sharedProps}
            size={size}
            variant="panel"
            aria-label={t("components.preview.searchLabel")}
            placeholder={t("components.preview.searchPlaceholder")}
            leadingIcon={<Icon name="search" />}
            footer={<span>{t("components.preview.searchResults")}</span>}
            trailingAction={(
              <Tooltip content={t("components.preview.close")}>
                <IconButton
                  aria-label={t("components.preview.close")}
                  disabled={sharedProps.disabled || sharedProps.readOnly}
                  icon={<Icon name="xmark" />}
                  size="xs"
                  shape="square"
                  onClick={() => setValue("")}
                  onMouseDown={(event) => event.preventDefault()}
                />
              </Tooltip>
            )}
          />
        </div>
      ))}
    </div>
  );
}

export function ComponentDetailPage({
  colorScheme,
  component,
  contrast,
  density,
  onBack,
  onInspectTokens,
  tokenOverrides,
}: ComponentDetailPageProps) {
  const { t } = useI18n();
  const stateLabel = (state: string) => optionLabelKeys[state] ? t(optionLabelKeys[state]) : state;
  const [variant, setVariant] = useState<(typeof buttonVariants)[number]>("fill");
  const [iconButtonSize, setIconButtonSize] = useState<(typeof iconButtonSizes)[number]>("xs");
  const [iconButtonShape, setIconButtonShape] = useState<"square" | "circle">("square");
  const [iconButtonVariant, setIconButtonVariant] = useState<(typeof iconButtonVariants)[number]>("quiet");
  const [iconName, setIconName] = useState<IconName>("search");
  const [numberBadgeValue, setNumberBadgeValue] = useState("18");
  const [iconSize, setIconSize] = useState<IconSize>("lg");
  const [iconTone, setIconTone] = useState<IconTone>("inherit");
  const [selectValue, setSelectValue] = useState<string>("ask");
  const [multiSelectValues, setMultiSelectValues] = useState<Array<string | number>>(["ask", "plan"]);
  const [size, setSize] = useState<PreviewSize>("md");
  const [fieldOrientation, setFieldOrientation] = useState<FieldOrientation>("horizontal");
  const [fieldShowLabelAction, setFieldShowLabelAction] = useState(false);
  const [fieldShowControlLeading, setFieldShowControlLeading] = useState(false);
  const [fieldShowControlTrailing, setFieldShowControlTrailing] = useState(false);
  const [pageHeaderAlign, setPageHeaderAlign] = useState<PageHeaderAlign>("start");
  const [cardContentAlign, setCardContentAlign] = useState<CardContentAlignment>("start");
  const [pageHeaderSize, setPageHeaderSize] = useState<PageHeaderSize>("md");
  const [scrollAreaOrientation, setScrollAreaOrientation] = useState<ScrollAreaOrientation>("vertical");
  const [activityItemAppearance, setActivityItemAppearance] = useState<ActivityItemAppearance>("surface");
  const [activityShowDetail, setActivityShowDetail] = useState(false);
  const [pageHeaderRequired, setPageHeaderRequired] = useState(false);
  const [actionItemShowMetadata, setActionItemShowMetadata] = useState(false);
  const [actionCardSize, setActionCardSize] = useState<ActionCardSize>("md");
  const [tabGroupSize, setTabGroupSize] = useState<TabGroupSize>("sm");
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize>("sm");
  const [checkboxAppearance, setCheckboxAppearance] = useState<"custom" | "native">("custom");
  const [previewState, setPreviewState] = useState(
    component.name === "Card"
      ? "raised"
      : component.name === "Disclosure"
        ? "open"
      : component.name === "Composer"
      ? "with-context"
      : component.name === "Switch"
        ? "off"
      : component.name === "StatusPill"
        ? "success"
      : component.name === "Toolbar"
        ? "with-center"
      : component.name === "TabGroup" || component.name === "SegmentedControl"
        ? "selected"
        : component.name === "ScrollArea"
          ? "auto"
        : component.name === "Tooltip"
          ? "top"
        : component.states[0] ?? "default",
  );
  const [inspectorDisabled, setInspectorDisabled] = useState(false);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [previewIcon, setPreviewIcon] = useState<PreviewIcon>("none");
  const [previewIconPosition, setPreviewIconPosition] = useState<PreviewIconPosition>("left");
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("properties");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [mobileChoiceValue, setMobileChoiceValue] = useState("standard");
  const [menuShowScrollbar, setMenuShowScrollbar] = useState(true);
  const [navigationPanelShowScrollbar, setNavigationPanelShowScrollbar] = useState(true);
  const [composerShowContext, setComposerShowContext] = useState(false);
  const [composerShowToolbar, setComposerShowToolbar] = useState(true);
  const flowChatPreview = getFlowChatPreviewDefinition(component.name);
  const isFlowChatComponent = Boolean(flowChatPreview);

  const states = useMemo(() => {
    if (flowChatPreview) {
      return component.states;
    }

    switch (component.name) {
      case "ActionCard":
        return ["default", "hover", "active", "focus-visible", "selected", "disabled"] as const;
      case "ActionItem":
        return ["default", "hover", "active", "disabled"] as const;
      case "ActivityItem":
        return ["default", "hover", "active", "focus-visible", "disabled"] as const;
      case "Button":
      case "IconButton":
        return ["default", "hover", "active", "disabled"] as const;
      case "LauncherButton":
        return ["default", "hover", "active", "focus-visible", "disabled"] as const;
      case "Composer":
        return ["default", "focus-within", "with-context", "invalid", "disabled"] as const;
      case "Combobox":
      case "Listbox":
        return component.states;
      case "ConfirmDialog":
        return ["info", "warning", "error", "success", "pending"] as const;
      case "Card":
        return ["raised", "subtle", "media"] as const;
      case "Input":
      case "SearchField":
        return ["default", "filled", "hover", "focus-visible", "read-only", "invalid", "disabled"] as const;
      case "Select":
        return ["default", "hover", "focus-visible", "open", "invalid", "disabled"] as const;
      case "Field":
      case "Icon":
      case "KeyHint":
      case "Dialog":
      case "LoadingState":
      case "Sheet":
      case "PageHeader":
        return ["default"] as const;
      case "FieldGroup":
        return ["subtle", "plain", "divided"] as const;
      case "Disclosure":
        return ["closed", "open", "hover", "focus-visible", "disabled"] as const;
      case "Menu":
        return ["default", "scrolling", "focus-within", "disabled-item", "checked-item"] as const;
      case "NavigationPanel":
        return ["default", "selected-item", "disabled-item", "scrolling"] as const;
      case "ScrollArea":
        return ["auto", "always", "hidden"] as const;
      case "StatusPill":
        return ["neutral", "info", "success", "warning", "danger"] as const;
      case "Spinner":
        return component.states;
      case "SegmentedControl":
      case "TabGroup":
        return ["selected", "unselected", "hover", "disabled"] as const;
      case "Toolbar":
        return ["default", "with-center", "overflow"] as const;
      case "Tooltip":
        return ["top", "bottom", "left", "right"] as const;
      case "Switch":
        return ["off", "on", "focus-visible", "disabled"] as const;
      default:
        return component.states;
    }
  }, [component.name, component.states, flowChatPreview]);
  const inspectorStates = component.name === "Button" || component.name === "IconButton"
    ? buttonInspectorStates
    : states;

  const codeSample = useMemo(() => {
    if (component.name === "RollingText") {
      return 'import { RollingText, TabGroup } from "@openbitfun/ui";\n\n// Keep the identity stable for title edits; change it when replacing the resource.\n<RollingText transitionKey={record.id}>{record.title}</RollingText>\n\n// TabGroup owns the text slot and composes RollingText without nested clipping.\n<TabGroup\n  aria-label="Views"\n  items={[{ value: slotId, label: record.title, labelTransitionKey: record.id }]}\n/>\n';
    }
    if (component.name === "MobileActionSheet") return `import { MobileActionSheet } from "@openbitfun/ui/mobile";\n\n<MobileActionSheet\n  actions={[\n    { id: "rename", label: "${t("components.preview.modalSave")}" },\n    { id: "delete", label: "${t("components.preview.confirmDelete")}", tone: "danger" },\n  ]}\n  cancelLabel="${t("components.preview.modalCancel")}"\n  onAction={handleAction}\n  onOpenChange={() => setOpen(false)}\n  open={open}\n  title="${t("components.preview.session")}"\n/>`;
    if (component.name === "MobileComposer") return `import { MobileComposer } from "@openbitfun/ui/mobile";\n\n<MobileComposer\n  expanded={expanded}\n  leading={<AttachButton />}\n  startActions={<ModelControls />}\n  endActions={<SendButton />}\n>\n  <textarea />\n</MobileComposer>`;
    if (component.name === "MobileChoiceSheet") return `import { MobileChoiceSheet } from "@openbitfun/ui/mobile";\n\n<MobileChoiceSheet\n  cancelLabel="${t("components.preview.modalCancel")}"\n  onOpenChange={() => setOpen(false)}\n  onSelect={setMode}\n  open={open}\n  options={[\n    { label: "${t("components.preview.modeMinimal")}", value: "minimal" },\n    { label: "${t("components.preview.modeStandard")}", value: "standard" },\n    { label: "${t("components.preview.modeUltimate")}", value: "ultimate" },\n  ]}\n  selectedValue={mode}\n  title="${t("components.preview.selectExecutionMode")}"\n/>`;
    if (component.name === "MobileConfirmSheet") return `import { MobileConfirmSheet } from "@openbitfun/ui/mobile";\n\n<MobileConfirmSheet\n  cancelLabel="${t("components.preview.modalCancel")}"\n  confirmLabel="${t("components.preview.confirmDelete")}"\n  confirmTone="danger"\n  onConfirm={handleDelete}\n  onOpenChange={() => setOpen(false)}\n  open={open}\n  title="${t("components.preview.confirmTitle")}"\n/>`;
    if (component.name === "MobileFloatingActions") return `import { MobileFloatingActions } from "@openbitfun/ui/mobile";\n\n<MobileFloatingActions\n  leading={<NewChatButton />}\n  trailing={<SettingsButton />}\n/>`;
    if (component.name === "MobileFileButton") return `import { MobileFileButton } from "@openbitfun/ui/mobile";\n\n<MobileFileButton accept="image/*" onChange={handleFile}>\n  ${t("components.preview.add")}\n</MobileFileButton>`;
    if (component.name === "MobileScrim") return `import { MobileScrim } from "@openbitfun/ui/mobile";\n\n<MobileScrim\n  aria-label="${t("components.preview.close")}"\n  onClick={closeSidebar}\n/>`;
    if (component.name === "MobileIconButton") return `import { Icon } from "@openbitfun/ui";\nimport { MobileIconButton } from "@openbitfun/ui/mobile";\n\n<MobileIconButton\n  appearance="floating"\n  aria-label="${t("components.preview.searchLabel")}"\n  icon={<Icon name="search" />}\n/>`;
    if (component.name === "MobileLink") return `import { MobileLink } from "@openbitfun/ui/mobile";\n\n<MobileLink href="https://example.com">\n  ${t("nav.docs")}\n</MobileLink>`;
    if (component.name === "MobileTextField") return `import { MobileTextField } from "@openbitfun/ui/mobile";\n\n<MobileTextField\n  aria-label="${t("components.preview.searchLabel")}"\n  placeholder="${t("components.preview.searchPlaceholder")}"\n/>`;
    if (component.name === "MobileListRow") return `import { MobileListRow } from "@openbitfun/ui/mobile";\n\n<MobileListRow\n  appearance="surface"\n  label="${t("components.preview.session")}"\n  supportingText="/workspace"\n/>`;
    if (component.name === "MobileSheet") return `import { MobileSheet } from "@openbitfun/ui/mobile";\n\n<MobileSheet\n  footer={<CancelButton />}\n  onOpenChange={() => setOpen(false)}\n  open={open}\n  title="${t("components.preview.modalTitle")}"\n>\n  <ActionList />\n</MobileSheet>`;
    if (component.name === "Textarea") return `import { Textarea } from "@openbitfun/ui";\n\n<Textarea\n  label="${t("components.preview.inputLabel")}"\n  defaultValue="${t("components.preview.fieldValue")}"\n  hint="${t("components.preview.fieldDescription")}"\n  maxLength={200}\n  rows={3}\n  showCount\n/>`;
    if (component.name === "Alert") return `import { Alert } from "@openbitfun/ui";\n\n<Alert tone="info" title="${t("components.preview.notifications")}" message="${t("components.preview.fieldDescription")}" />`;
    if (component.name === "Avatar") return 'import { Avatar } from "@openbitfun/ui";\n\n<Avatar>BF</Avatar>';
    if (component.name === "Checkbox" || component.name === "Radio") return `import { ${component.name} } from "@openbitfun/ui";\n\n<${component.name}${component.name === "Checkbox" ? ` appearance="${checkboxAppearance}"` : ""} label="${t("components.preview.notifications")}" defaultChecked />`;
    if (component.name === "NumberBadge") return `import { NumberBadge } from "@openbitfun/ui";\n\n<NumberBadge value={${JSON.stringify(numberBadgeValue)}} />;`;
    if (component.name === "NumberInput") return 'import { useState } from "react";\nimport { NumberInput } from "@openbitfun/ui";\n\nfunction Example() {\n  const [value, setValue] = useState(8);\n  return <NumberInput value={value} onValueChange={setValue} />;\n}';
    if (component.name === "Empty") return `import { Empty } from "@openbitfun/ui";\n\n<Empty title="${t("components.preview.cardTitle")}" description="${t("components.preview.cardDescription")}" />`;
    if (flowChatPreview) {
      return flowChatPreview.codeSample(t);
    }

    if (component.name === "ActionCard") {
      return `import { Icon, ActionCard } from "@openbitfun/ui";\n\n<ActionCard\n  actions={[\n    { id: "more", icon: <Icon name="more" />, label: "${t("components.preview.more")}" },\n  ]}\n  description="${t("components.preview.actionCardDescription")}"\n  leading={<Icon name="session" />}\n  size="${actionCardSize}"\n>\n  ${t("components.preview.actionCardTitle")}\n</ActionCard>`;
    }
    if (component.name === "LauncherButton") {
      return 'import { Icon, LauncherButton } from "@openbitfun/ui";\n\n<LauncherButton leadingIcon={<Icon name="mic" />}>\n  Hello\n</LauncherButton>';
    }
    if (component.name === "VoiceParticleLogo") {
      return 'import { VoiceParticleLogo } from "@openbitfun/ui";\n\n// Return live FFT byte bins from fftSize=256 analysers.\n<VoiceParticleLogo readAudio={() => ({\n  user: microphoneFrequencyData,\n  assistant: playbackFrequencyData,\n  assistantSpeaking: isAudioPlaying,\n})} />';
    }
    if (component.name === "VoiceCallPanel") {
      return 'import { VoiceCallPanel } from "@openbitfun/ui";\n\n<VoiceCallPanel\n  title="Live Call"\n  labels={{ back: "Back to chat", close: "Close", mute: "Mute",\n    unmute: "Unmute", settings: "Settings", end: "End call" }}\n  phase="live"\n  muted={muted}\n  userTranscript={userTranscript}\n  assistantTranscript={assistantTranscript}\n  readAudio={readAudio}\n  onBack={returnToChat}\n  onClose={closeWindow}\n  onToggleMute={toggleMute}\n  onOpenSettings={openVoiceSettings}\n  onEnd={endCall}\n/>';
    }
    if (component.name === "ActionItem") {
      const metadataProp = actionItemShowMetadata ? `\n  metadata="12"` : "";
      return `import { Icon, ActionItem, KeyHint } from "@openbitfun/ui";\n\n<ActionItem\n  actions={[\n    { id: "add", icon: <Icon name="plus" />, label: "${t("components.preview.add")}" },\n    { id: "more", icon: <Icon name="more" />, label: "${t("components.preview.more")}" },\n  ]}\n  leading={<Icon name="session" />}${metadataProp}\n  shortcut={<KeyHint>K</KeyHint>}\n>\n  ${t("components.preview.assistant")}\n</ActionItem>`;
    }
    if (component.name === "ActivityItem") {
      if (activityItemAppearance === "inline") {
        return `import { Icon, ActivityItem } from "@openbitfun/ui";\n\n<ActivityItem\n  appearance="inline"\n  leading={<Icon name="check-line" />}\n>\n  ${t("components.preview.activityStatus")}\n</ActivityItem>`;
      }
      const detailProp = activityShowDetail
        ? `\n  detail={<code>${t("components.preview.activityDetail")}</code>}`
        : "";
      return `import { Icon, ActivityItem, ChangeCount } from "@openbitfun/ui";\n\n<ActivityItem\n  actions={[\n    { id: "copy", icon: <Icon name="duplicate" />, label: "${t("components.preview.activityCopy")}" },\n    { id: "download", icon: <Icon name="arrow-down" />, label: "${t("components.preview.activityDownload")}" },\n    { id: "open", icon: <Icon name="arrow-up-right" />, label: "${t("components.preview.activityOpen")}" },\n  ]}\n  appearance="surface"${detailProp}\n  label="${t("components.preview.activityAction")}"\n  leading={<Icon name="terminal" />}\n  metadata={<ChangeCount additions={6} deletions={0} />}\n  onActivate={() => openActivity()}\n>\n  ${t("components.preview.activityDescription")}\n</ActivityItem>`;
    }
    if (component.name === "Button") {
      const stateProps = `${inspectorDisabled ? " disabled" : ""}${inspectorLoading ? " loading" : ""}`;
      const iconImport = previewIcon === "chevron"
        ? "\nimport { ChevronRight } from \"lucide-react\";"
        : "";
      const iconProp = previewIcon === "chevron"
        ? ` ${previewIconPosition === "left" ? "leadingIcon" : "trailingIcon"}={<Icon name="chevron-right" />}`
        : "";
      return `import { Button } from "@openbitfun/ui";${iconImport}\n\n<Button variant="${variant}" size="${size}"${stateProps}${iconProp}>\n  ${t("components.preview.session")}\n</Button>`;
    }
    if (component.name === "Card") {
      if (previewState === "media") {
        return `import { Card, CardBody, CardHeader, CardMedia } from "@openbitfun/ui";\n\n<Card appearance="neutral" clip radius="md">\n  <CardMedia>\n    <ProductArtwork />\n  </CardMedia>\n  <CardBody align="center" padding="sm">\n    <CardHeader\n      contentAlign="center"\n      title="${t("components.preview.cardMediaTitle")}"\n      description="${t("components.preview.cardMediaDescription")}"\n    />\n  </CardBody>\n</Card>`;
      }
      return `import { Card, CardBody, CardFooter, CardHeader } from "@openbitfun/ui";\n\n<Card appearance="${previewState}" gap="md" padding="md" radius="lg">\n  <CardHeader\n    contentAlign="${cardContentAlign}"\n    title="${t("components.preview.cardTitle")}"\n    description="${t("components.preview.cardDescription")}"\n  />\n  <CardBody>\n    <CommandGrid />\n  </CardBody>\n  <CardFooter align="end">\n    <Button>${t("components.preview.settings")}</Button>\n  </CardFooter>\n</Card>`;
    }
    if (component.name === "Composer") {
      const stateProps = `${previewState === "disabled" ? " disabled" : ""}${previewState === "invalid" ? " invalid" : ""}`;
      const contextProp = composerShowContext || previewState === "with-context"
        ? `\n  contextBar={<ComposerContextBar\n    leading={<><span>${t("components.preview.composerDevice")}</span><ComposerDivider /><span>${t("components.preview.composerWorkspace")}</span></>}\n    trailing={<span>${t("components.preview.composerMode")}</span>}\n  />}`
        : "";
      const toolbarProp = composerShowToolbar
        ? `\n  toolbar={<ComposerToolbar\n    leading={<IconButton aria-label="${t("components.preview.composerAdd")}" icon={<Icon name="plus" />} />}\n    trailing={<><Button variant="text">${t("components.preview.composerModel")}</Button><IconButton aria-label="${t("components.preview.composerSend")}" icon={<Icon name="arrow-up" />} variant="primary" /></>}\n  />}`
        : "";
      return `import { Button, Composer, ComposerContextBar, ComposerDivider, ComposerToolbar, IconButton } from "@openbitfun/ui";\n\n<Composer\n  aria-label="${t("components.preview.composerLabel")}"${contextProp}${toolbarProp}${stateProps}\n>\n  <textarea\n    aria-label="${t("components.preview.composerEditorLabel")}"\n    placeholder="${t("components.preview.composerPlaceholder")}"\n  />\n</Composer>`;
    }
    if (component.name === "ConfirmDialog") {
      return `import { ConfirmDialog } from "@openbitfun/ui";\n\n<ConfirmDialog\n  cancelText="${t("components.preview.modalCancel")}"\n  confirmDanger\n  confirmText="${t("components.preview.confirmDelete")}"\n  message="${t("components.preview.confirmMessage")}"\n  onConfirm={() => deleteItem()}\n  onOpenChange={() => setOpen(false)}\n  open={open}\n  preview="/workspace/project"\n  title="${t("components.preview.confirmTitle")}"\n  type="error"\n/>`;
    }
    if (component.name === "Icon") {
      return `import { Icon } from "@openbitfun/ui";\n\n<Icon name="${iconName}" size="${iconSize}" tone="${iconTone}" />`;
    }

    if (component.name === "IconButton") {
      const stateProps = `${inspectorDisabled ? " disabled" : ""}${inspectorLoading ? " loading" : ""}`;
      return `import { IconButton } from "@openbitfun/ui";\nimport { List } from "lucide-react";\n\n<IconButton\n  aria-label="${t("components.preview.listView")}"\n  icon={<List />}\n  variant="${iconButtonVariant}"\n  size="${iconButtonSize}"\n  shape="${iconButtonShape}"${stateProps}\n/>`;
    }
    if (component.name === "Field") {
      const labelAction = fieldShowLabelAction
        ? `\n  labelAction={<IconButton aria-label="${t("components.preview.fieldHelp")}" icon={<Icon name="info" />} size="xs" />}`
        : "";
      const controlLeading = fieldShowControlLeading
        ? `\n  controlLeading={<Switch aria-label="${t("components.preview.notifications")}" />}`
        : "";
      const controlTrailing = fieldShowControlTrailing
        ? `\n  controlTrailing={<IconButton aria-label="${t("components.preview.more")}" icon={<Icon name="more" />} size="xs" />}`
        : "";
      return `import { Icon, Field, IconButton, Input, Switch } from "@openbitfun/ui";\n\n<Field\n  description="${t("components.preview.fieldDescription")}"\n  label="${t("components.preview.appearance")}"${labelAction}${controlLeading}${controlTrailing}\n  orientation="${fieldOrientation}"\n  required\n>\n  <Input defaultValue="${t("components.preview.fieldValue")}" trailing={<Icon name="chevron-down" />} />\n</Field>`;
    }
    if (component.name === "Input") {
      const stateProps = previewState === "disabled"
        ? " disabled"
        : previewState === "invalid"
          ? " invalid"
          : previewState === "read-only"
            ? ' readOnly defaultValue="OpenBitFun"'
            : previewState === "default" ? "" : ' defaultValue="OpenBitFun"';
      return `import { Icon, Input } from "@openbitfun/ui";\n\n<Input\n  aria-label="${t("components.preview.inputLabel")}"\n  placeholder="${t("components.preview.inputPlaceholder")}"\n  trailing={<Icon name="eye" />}${stateProps}\n/>`;
    }
    if (component.name === "KeyHint") {
      return `import { Icon, KeyHint } from "@openbitfun/ui";\n\n<KeyHint icon={<Icon name="command-mac" />}>K</KeyHint>`;
    }
    if (component.name === "FieldGroup") {
      return `import { Icon, Field, FieldGroup, FieldRow, FormSection, Input } from "@openbitfun/ui";\n\n<FormSection\n  description="${t("components.preview.fieldDescription")}"\n  headingAs="h3"\n  leading={<Icon name="gear" />}\n  title="${t("components.preview.modalSectionTitle")}"\n>\n  <FieldGroup appearance="subtle" dividers>\n    <FieldRow>\n      <Field controlWidth="fill" label="${t("components.preview.modalProviderName")}" labelWidth="md" orientation="horizontal" required>\n        <Input defaultValue="OpenBitFun" />\n      </Field>\n    </FieldRow>\n    <FieldRow>\n      <Field controlWidth="fill" label="${t("components.preview.modalApiUrl")}" labelWidth="md" orientation="horizontal">\n        <Input defaultValue="https://api.openbitfun.com" />\n      </Field>\n    </FieldRow>\n  </FieldGroup>\n</FormSection>`;
    }
    if (component.name === "LoadingState") {
      return `import { LoadingState } from "@openbitfun/ui";\n\n<LoadingState>${t("detail.loading")}</LoadingState>`;
    }
    if (component.name === "Tooltip") {
      return `import { Tooltip } from "@openbitfun/ui";\n\n<Tooltip\n  content="${t("components.preview.tooltipContent")}"\n  placement="${previewState}"\n>\n  <Button>${t("components.preview.tooltipTrigger")}</Button>\n</Tooltip>`;
    }
    if (component.name === "Menu") {
      return `import { Icon, Menu, MenuItem, MenuSection, MenuSeparator } from "@openbitfun/ui";\n\n<Menu\n  aria-label="${t("components.preview.menuLabel")}"\n  scrollbarVisibility="${menuShowScrollbar ? "auto" : "hidden"}"\n>\n  <MenuSection title="${t("components.preview.menuSectionTitle")}">\n    <MenuItem leading={<Icon name="session" />}>${t("components.preview.menuItemOne")}</MenuItem>\n    <MenuItem leading={<Icon name="session" />}>${t("components.preview.menuItemTwo")}</MenuItem>\n  </MenuSection>\n  <MenuSeparator />\n  <MenuSection aria-label="${t("components.preview.menuMoreSection")}">\n    <MenuItem disabled>${t("components.preview.menuDisabledItem")}</MenuItem>\n  </MenuSection>\n</Menu>`;
    }
    if (component.name === "Dialog") {
      return `import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle } from "@openbitfun/ui";\n\n<Dialog onOpenChange={() => setOpen(false)} open={open} size="xl">\n  <DialogHeader>\n    <DialogHeading><DialogTitle>${t("components.preview.modalTitle")}</DialogTitle></DialogHeading>\n    <DialogClose />\n  </DialogHeader>\n  <DialogBody><ProviderConfigurationFields /></DialogBody>\n  <DialogFooter appearance="floating">\n    <Button onClick={() => setOpen(false)} variant="fill">${t("components.preview.modalCancel")}</Button>\n    <Button onClick={() => setOpen(false)} variant="primary">${t("components.preview.modalSave")}</Button>\n  </DialogFooter>\n</Dialog>`;
    }
    if (component.name === "Sheet") {
      return `import { Button, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogHeading, DialogTitle, Sheet } from "@openbitfun/ui";\n\n<Sheet onOpenChange={() => setOpen(false)} open={open} placement="right" size="lg">\n  <DialogHeader>\n    <DialogHeading><DialogTitle>${t("components.preview.modalTitle")}</DialogTitle></DialogHeading>\n    <DialogClose />\n  </DialogHeader>\n  <DialogBody><ProviderConfigurationFields /></DialogBody>\n  <DialogFooter>\n    <Button onClick={() => setOpen(false)} variant="fill">${t("components.preview.modalCancel")}</Button>\n    <Button onClick={() => setOpen(false)} variant="primary">${t("components.preview.modalSave")}</Button>\n  </DialogFooter>\n</Sheet>`;
    }
    if (component.name === "PageHeader") {
      const requiredProp = pageHeaderRequired ? "\n  required" : "";
      return `import { Icon, IconButton, PageHeader } from "@openbitfun/ui";\n\n<PageHeader\n  action={<IconButton aria-label="${t("components.preview.close")}" icon={<Icon name="xmark" />} />}\n  align="${pageHeaderAlign}"\n  description="${t("components.preview.appearanceDescription")}"\n  leading={<Icon name="gear" />}\n  level={2}${requiredProp}\n  size="${pageHeaderSize}"\n  title="${t("components.preview.appearance")}"\n/>`;
    }
    if (component.name === "SearchField") {
      const searchStateProps = previewState === "disabled" ? " disabled" : previewState === "invalid" ? " invalid" : previewState === "read-only" ? " readOnly" : "";
      return `import { useState } from "react";\nimport { Icon, KeyHint, SearchField } from "@openbitfun/ui";\n\nfunction Example() {\n  const [query, setQuery] = useState(${JSON.stringify(previewState === "default" ? "" : "OpenBitFun")});\n  return (\n    <SearchField\n      clearLabel="${t("components.preview.searchClear")}"\n      onClear={() => setQuery("")}\n      onValueChange={setQuery}\n      value={query}\n      aria-label="${t("components.preview.searchLabel")}"\n      leadingIcon={<Icon name="search" />}\n      placeholder="${t("components.preview.searchPlaceholder")}"\n      shortcut={<KeyHint icon={<Icon name="command-mac" />}>K</KeyHint>}${searchStateProps}\n    />\n  );\n}`;
    }
    if (component.name === "Combobox") {
      return `import { Combobox } from "@openbitfun/ui";\n\n<Combobox\n  aria-label="Mode"\n  onValueChange={setMode}\n  options={[\n    { label: "Ask", value: "ask" },\n    { label: "Plan", value: "plan" },\n    { disabled: true, label: "Agent", value: "agent" },\n  ]}\n  value={mode}\n/>`;
    }
    if (component.name === "Spinner") {
      return `import { Spinner } from "@openbitfun/ui";\n\n<Spinner aria-label="${t("detail.loading")}" size="${size}" variant="${previewState === "bars" ? "bars" : "matrix"}" />`;
    }
    if (component.name === "MultiSelect") {
      return `import { MultiSelect } from "@openbitfun/ui";\n\n<MultiSelect\n  aria-label="Modes"\n  onValueChange={setModes}\n  options={[\n    { label: "Ask", value: "ask" },\n    { label: "Plan", value: "plan" },\n    { disabled: true, label: "Agent", value: "agent" },\n  ]}\n  value={modes}\n/>`;
    }
    if (component.name === "Listbox") {
      return `import { Listbox, ListboxOption } from "@openbitfun/ui";\n\n<Listbox aria-label="Mode">\n  <ListboxOption selected value="ask">Ask</ListboxOption>\n  <ListboxOption value="plan">Plan</ListboxOption>\n  <ListboxOption disabled value="agent">Agent</ListboxOption>\n</Listbox>`;
    }
    if (component.name === "Select") {
      return `import { Icon, Select } from "@openbitfun/ui";\n\n<Select\n  aria-label="Mode"\n  leading={<Icon name="unselected" />}\n  onValueChange={setMode}\n  options={[\n    { label: "Ask", value: "ask" },\n    { label: "Plan", value: "plan" },\n    { disabled: true, label: "Agent", value: "agent" },\n  ]}\n  value="${selectValue}"\n/>`;
    }
    if (component.name === "SegmentedControl") {
      const defaultMode = previewState === "unselected" ? "agent" : "chat";
      return `import { Icon, SegmentedControl } from "@openbitfun/ui";\n\n<SegmentedControl\n  size="md"\n  aria-label="${t("components.preview.segmentedLabel")}"\n  defaultValue="${defaultMode}"\n  onValueChange={setMode}\n  options={[\n    { icon: <Icon name="session" />, label: "${t("components.preview.segmentedChat")}", value: "chat" },\n    { label: "${t("components.preview.segmentedAgent")}", value: "agent" },\n  ]}\n/>`;
    }
    if (component.name === "StatusPill") {
      return `import { Icon, StatusPill } from "@openbitfun/ui";\n\n<StatusPill emphasis leading={<Icon name="unselected" />} tone="${previewState}">\n  Ask\n</StatusPill>`;
    }
    if (component.name === "Disclosure") {
      const stateProps = previewState === "open" ? " defaultOpen" : previewState === "disabled" ? " disabled" : "";
      return `import { Disclosure } from "@openbitfun/ui";\n\n<Disclosure summary="${t("components.preview.appearance")}"${stateProps}>\n  ${t("components.preview.appearanceDescription")}\n</Disclosure>`;
    }
    if (component.name === "NavigationPanel") {
      return `import { Icon, IconButton, NavigationPanel, NavigationPanelBody, NavigationPanelContent, NavigationPanelFooter, NavigationPanelHeader, NavigationPanelItem, NavigationPanelSection, NavigationPanelSeparator, SearchField } from "@openbitfun/ui";\n\n<NavigationPanel aria-label="${t("components.preview.navigationPanelLabel")}">\n  <NavigationPanelHeader>\n    <SearchField aria-label="${t("components.preview.searchLabel")}" leadingIcon={<Icon name="search" />} />\n  </NavigationPanelHeader>\n  <NavigationPanelBody scrollbarVisibility="${navigationPanelShowScrollbar ? "auto" : "hidden"}">\n    <NavigationPanelContent>\n      <NavigationPanelSection title="${t("components.preview.navigationPanelSectionTitle")}">\n        <NavigationPanelItem selected>${t("components.preview.menuItemOne")}</NavigationPanelItem>\n        <NavigationPanelItem>${t("components.preview.menuItemTwo")}</NavigationPanelItem>\n      </NavigationPanelSection>\n      <NavigationPanelSeparator />\n      <NavigationPanelSection title="${t("components.preview.navigationPanelMoreSection")}">\n        <NavigationPanelItem>${t("components.preview.navigationPanelMoreItem")}</NavigationPanelItem>\n      </NavigationPanelSection>\n    </NavigationPanelContent>\n  </NavigationPanelBody>\n  <NavigationPanelFooter>\n    <NavigationPanelItem leading={<Icon name="device-mac" />}>${t("components.preview.navigationPanelDevice")}</NavigationPanelItem>\n    <IconButton aria-label="${t("components.preview.settings")}" icon={<Icon name="gear" />} />\n  </NavigationPanelFooter>\n</NavigationPanel>`;
    }
    if (component.name === "ScrollArea") {
      return `import { ScrollArea } from "@openbitfun/ui";\n\n<ScrollArea\n  aria-label="${t("components.preview.scrollAreaLabel")}"\n  className="activity-scroll-area"\n  orientation="${scrollAreaOrientation}"\n  scrollbarVisibility="${previewState}"\n>\n  {items.map((item) => <div key={item.id}>{item.label}</div>)}\n</ScrollArea>`;
    }
    if (component.name === "TabGroup") {
      const defaultTab = previewState === "unselected" ? "settings" : "welcome";
      return `import { Icon, TabGroup } from "@openbitfun/ui";\n\nconst items = [\n  { icon: <Icon name="session" />, label: "${t("components.preview.welcome")}", value: "welcome" },\n  { icon: <Icon name="session" />, label: "${t("components.preview.settings")}", value: "settings" },\n];\n\n<TabGroup\n  aria-label="${t("components.preview.tabGroupLabel")}"\n  defaultValue="${defaultTab}"\n  items={items}\n  size="${tabGroupSize}"\n/>`;
    }
    if (component.name === "Toolbar") {
      return `import { Icon, ChangeCount, IconButton, TabGroup, Toolbar, ToolbarBadge, ToolbarGroup, ToolbarSeparator } from "@openbitfun/ui";\n\nconst items = [\n  { label: "${t("components.preview.welcome")}", value: "welcome" },\n  { label: "${t("components.preview.settings")}", value: "settings" },\n];\n\n<Toolbar\n  aria-label="${t("components.preview.tabGroupLabel")}"\n  center={<ToolbarGroup>\n    <ToolbarBadge>18</ToolbarBadge>\n    <strong>${t("components.preview.session")}</strong>\n  </ToolbarGroup>}\n  leading={<TabGroup defaultValue="welcome" items={items} size="sm" />}\n  size="${toolbarSize}"\n  trailing={<ToolbarGroup>\n    <ChangeCount additions={6} deletions={0} />\n    <ToolbarSeparator />\n    <IconButton aria-label="${t("components.preview.searchLabel")}" icon={<Icon name="search" />} size="xs" />\n    <IconButton aria-label="${t("components.preview.more")}" icon={<Icon name="more" />} size="xs" />\n  </ToolbarGroup>}\n/>`;
    }
    if (component.name !== "Switch") return `// ${t("detail.previewUnavailable")}: ${component.name}`;
    const stateProps = previewState === "on"
      ? " defaultChecked"
      : previewState === "disabled"
        ? " disabled"
        : "";
    return `import { Switch } from "@openbitfun/ui";\n\n<Switch\n  aria-label="${t("components.preview.notifications")}"${stateProps}\n/>`;
  }, [
    actionItemShowMetadata,
    activityItemAppearance,
    activityShowDetail,
    component.name,
    composerShowContext,
    composerShowToolbar,
    fieldOrientation,
    fieldShowControlLeading,
    fieldShowControlTrailing,
    fieldShowLabelAction,
    flowChatPreview,
    iconButtonVariant,
    iconButtonSize,
    iconButtonShape,
    iconName,
    iconSize,
    iconTone,
    numberBadgeValue,
    inspectorDisabled,
    inspectorLoading,
    menuShowScrollbar,
    navigationPanelShowScrollbar,
    pageHeaderAlign,
    pageHeaderRequired,
    pageHeaderSize,
    previewIcon,
    previewIconPosition,
    previewState,
    scrollAreaOrientation,
    selectValue,
    size,
    tabGroupSize,
    t,
    toolbarSize,
    variant,
  ]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(codeSample);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1400);
    } catch {
      setCopyStatus("unavailable");
    }
  }

  function renderDialogConfigurationContent() {
    return (
      <FormSection
        aria-label={t("components.preview.modalSectionTitle")}
        className="component-dialog-example"
        headingAs="h3"
        title={t("components.preview.modalSectionTitle")}
      >
        <FieldGroup>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalProviderName")}
              labelWidth="md"
              orientation="horizontal"
              required
            >
              <Input defaultValue="OpenBitFun" />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalAuthentication")}
              labelWidth="md"
              orientation="horizontal"
              required
            >
              <Input
                defaultValue="API Key"
                readOnly
                trailing={<Icon name="chevron-down" size="lg" aria-hidden="true" />}
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalApiKey")}
              labelWidth="md"
              orientation="horizontal"
              required
            >
              <Input
                defaultValue="openbitfun-provider-api-key"
                readOnly
                trailing={<Icon name="eye" size="lg" aria-hidden="true" />}
                type="password"
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalApiUrl")}
              labelWidth="md"
              orientation="horizontal"
            >
              <Input
                defaultValue="https://api.openbitfun.com"
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalRequestFormat")}
              labelWidth="md"
              orientation="horizontal"
            >
              <Input
                defaultValue="Anthropic (messages)"
                readOnly
                trailing={<Icon name="chevron-down" size="lg" aria-hidden="true" />}
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field
              controlWidth="fill"
              horizontalGap="lg"
              label={t("components.preview.modalSelectModels")}
              labelWidth="md"
              orientation="horizontal"
              required
            >
              <Input
                defaultValue="k3-256k"
                trailing={<Icon name="plus" size="lg" aria-hidden="true" />}
              />
            </Field>
          </FieldRow>
        </FieldGroup>
        <p className="component-dialog-example__hint">{t("components.preview.modalPresetModels")}</p>
        <div className="component-dialog-example__model-card">
          <strong>k3-256k</strong>
          <span>{t("components.preview.modalModelSummary")}</span>
        </div>
      </FormSection>
    );
  }

  function renderDialogExample() {
    const closePreview = () => setOverlayOpen(false);
    return (
      <>
        <Button onClick={() => setOverlayOpen(true)} variant="fill">
          {t("components.preview.modalInteractionDemo")}
        </Button>
        <Dialog
          onOpenChange={closePreview}
          open={overlayOpen}
          size="xl"
        >
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("components.preview.modalTitle")}</DialogTitle>
            </DialogHeading>
            <DialogClose />
          </DialogHeader>
          <DialogBody>{renderDialogConfigurationContent()}</DialogBody>
          <DialogFooter appearance="floating">
            <Button onClick={closePreview} variant="fill">
              {t("components.preview.modalCancel")}
            </Button>
            <Button onClick={closePreview} variant="primary">
              {t("components.preview.modalSave")}
            </Button>
          </DialogFooter>
        </Dialog>
      </>
    );
  }

  function renderSheetExample() {
    const closePreview = () => setOverlayOpen(false);
    const placement = previewState === "left" || previewState === "bottom"
      ? previewState
      : "right";
    return (
      <>
        <Button onClick={() => setOverlayOpen(true)} variant="fill">
          {t("components.preview.modalInteractionDemo")}
        </Button>
        <Sheet
          onOpenChange={closePreview}
          open={overlayOpen}
          placement={placement}
          size="lg"
        >
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("components.preview.modalTitle")}</DialogTitle>
            </DialogHeading>
            <DialogClose />
          </DialogHeader>
          <DialogBody>{renderDialogConfigurationContent()}</DialogBody>
          <DialogFooter>
            <Button onClick={closePreview} variant="fill">
              {t("components.preview.modalCancel")}
            </Button>
            <Button onClick={closePreview} variant="primary">
              {t("components.preview.modalSave")}
            </Button>
          </DialogFooter>
        </Sheet>
      </>
    );
  }

  function renderIconButtonPreview(
    state = previewState,
    previewVariant = iconButtonVariant,
    applyInspectorControls = false,
  ) {
    return (
      <IconButton
        aria-label={t("components.preview.listView")}
        className={state === "focus-visible" ? "lab-force-focus" : undefined}
        data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
        disabled={state === "disabled" || applyInspectorControls && inspectorDisabled}
        icon={<List aria-hidden="true" />}
        loading={state === "loading" || applyInspectorControls && inspectorLoading}
        size={iconButtonSize}
        shape={iconButtonShape}
        variant={previewVariant}
      />
    );
  }

  function renderPreview(
    state = previewState,
    previewVariant = variant,
    applyInspectorControls = false,
  ) {
    if (component.name === "VoiceCallPanel") return <VoiceCallPreview key={state} state={state} />;
    if (component.name === "VoiceParticleLogo") return <VoiceParticlePreview active={state !== "paused" && state !== "reduced-motion"} />;
    if (isFlowChatComponent) {
      return (
        <FlowChatComponentPreview
          componentName={component.name}
          key={`${component.name}-${state}`}
          state={state}
        />
      );
    }

    if (component.name === "Icon") {
      return <Icon name={iconName} size={iconSize} tone={iconTone} />;
    }

    if (component.name === "MobileButton") {
      return <MobileButton data-openbitfun-preview-state={state} disabled={state === "disabled"} loading={state === "loading"}>{t("components.preview.actionCardTitle")}</MobileButton>;
    }

    if (component.name === "MobileCard") {
      const appearance = state === "plain" || state === "elevated" ? state : "surface";
      return <MobileCard appearance={appearance}><strong>{t("components.preview.cardTitle")}</strong><p>{t("components.preview.cardDescription")}</p></MobileCard>;
    }

    if (component.name === "MobileDisclosure") {
      return <MobileDisclosure disabled={state === "disabled"} onToggle={() => undefined} open={state === "open"} title={t("detail.loading")}>{t("components.preview.fieldDescription")}</MobileDisclosure>;
    }

    if (component.name === "MobileMessage") {
      const roleType = state === "user" || state === "system" ? state : "assistant";
      return <MobileMessage roleType={roleType}>{t("components.preview.cardDescription")}</MobileMessage>;
    }

    if (component.name === "MobileBadge") {
      const tone = state === "info" || state === "success" || state === "warning" || state === "danger" ? state : "neutral";
      return <MobileBadge dot tone={tone}>{t("components.preview.notifications")}</MobileBadge>;
    }

    if (component.name === "MobileBanner") {
      const tone = state === "info" || state === "warning" || state === "danger" ? state : "neutral";
      return <MobileBanner action={<MobileButton appearance="plain" size="sm">{t("components.preview.modalSave")}</MobileButton>} tone={tone}>{t("components.preview.fieldDescription")}</MobileBanner>;
    }

    if (component.name === "MobileComposer") {
      const expanded = state === "expanded";
      return (
        <MobileComposer
          aria-label={t("components.preview.composerPlaceholder")}
          endActions={<MobileIconButton appearance="plain" aria-label={t("components.preview.flowChat.askUserSubmit")} icon={<Icon name="arrow-up" aria-hidden="true" />} size="sm" />}
          expanded={expanded}
          leading={<MobileIconButton appearance="plain" aria-label={t("components.preview.add")} icon={<Icon name="plus" aria-hidden="true" />} size="sm" />}
          startActions={expanded ? <Button size="sm" variant="fill">k3-256k</Button> : undefined}
        >
          {expanded ? <textarea aria-label={t("components.preview.composerPlaceholder")} placeholder={t("components.preview.composerPlaceholder")} /> : <span>{t("components.preview.composerPlaceholder")}</span>}
        </MobileComposer>
      );
    }

    if (component.name === "MobileFloatingActions") {
      return (
        <MobileFloatingActions
          leading={<Button size="sm" variant="fill">{t("components.preview.actionCardTitle")}</Button>}
          trailing={<MobileIconButton appearance="floating" aria-label={t("components.preview.settings")} icon={<Icon name="gear" aria-hidden="true" />} />}
        />
      );
    }

    if (component.name === "MobileFileButton") {
      return <MobileFileButton disabled={state === "disabled"} leading={<Icon name="plus" aria-hidden="true" />} loading={state === "loading"}>{t("components.preview.add")}</MobileFileButton>;
    }

    if (component.name === "MobileIconButton") {
      return (
        <MobileIconButton
          appearance="floating"
          aria-label={t("components.preview.searchLabel")}
          data-openbitfun-preview-state={state === "hover" || state === "active" || state === "focus-visible" ? state : undefined}
          disabled={state === "disabled"}
          icon={<Icon name="search" aria-hidden="true" />}
          loading={state === "loading"}
          selected={state === "selected"}
        />
      );
    }

    if (component.name === "MobileLink") {
      return <MobileLink appearance={state === "surface" ? "surface" : "inline"} href="#mobile">{t("nav.docs")}</MobileLink>;
    }

    if (component.name === "MobileTextField") {
      return (
        <MobileTextField
          aria-label={t("components.preview.searchLabel")}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          leading={<Icon name="search" aria-hidden="true" />}
          placeholder={t("components.preview.searchPlaceholder")}
        />
      );
    }

    if (component.name === "MobileListRow") {
      return (
        <MobileListRow
          appearance="surface"
          data-openbitfun-preview-state={state === "hover" || state === "active" || state === "focus-visible" ? state : undefined}
          disabled={state === "disabled"}
          label={t("components.preview.session")}
          leading={<Icon name="session" aria-hidden="true" />}
          selected={state === "selected"}
          supportingText={t("components.preview.fieldDescription")}
          trailing={<Icon name="chevron-right" aria-hidden="true" />}
        />
      );
    }

    if (component.name === "MobilePageHeader") {
      return <MobilePageHeader actions={<MobileIconButton appearance="plain" aria-label={t("components.preview.more")} icon={<Icon name="more" aria-hidden="true" />} size="sm" />} centered={state === "centered"} leading={<MobileIconButton appearance="plain" aria-label={t("components.preview.close")} icon={<Icon name="chevron-left" aria-hidden="true" />} size="sm" />} subtitle={state === "with-subtitle" ? t("components.preview.fieldDescription") : undefined} title={t("components.preview.session")} />;
    }

    if (component.name === "MobileScrim") {
      return <MobileScrim aria-label={t("components.preview.close")} style={{ blockSize: 120, inlineSize: "100%", position: "relative" }} visible={state !== "hidden"} />;
    }

    if (component.name === "MobileSection") {
      return <MobileSection action={state === "with-action" ? <MobileButton appearance="plain" size="sm">{t("components.preview.more")}</MobileButton> : undefined} description={state === "content-only" ? undefined : t("components.preview.fieldDescription")} title={state === "content-only" ? undefined : t("components.preview.appearance")}><MobileCard>{t("components.preview.cardDescription")}</MobileCard></MobileSection>;
    }

    if (component.name === "MobileSegmentedControl") {
      return <MobileSegmentedControl aria-label={t("components.preview.segmentedLabel")} onChange={() => undefined} options={[{ label: t("components.preview.segmentedChat"), value: "chat" }, { disabled: state === "disabled", label: t("components.preview.segmentedAgent"), value: "agent" }]} value={state === "selected" ? "agent" : "chat"} />;
    }

    if (component.name === "MobileStatus") {
      return <MobileStatus action={state === "danger" ? <MobileButton size="sm">{t("components.preview.modalSave")}</MobileButton> : undefined} description={t("components.preview.fieldDescription")} loading={state === "loading"} title={t("components.preview.cardTitle")} tone={state === "danger" ? "danger" : state === "info" ? "info" : "neutral"} />;
    }

    if (component.name === "MobileTextarea") {
      return <MobileTextarea aria-label={t("components.preview.composerPlaceholder")} disabled={state === "disabled"} invalid={state === "invalid"} placeholder={t("components.preview.composerPlaceholder")} />;
    }

    if (component.name === "Textarea") {
      return (
        <Textarea
          className={`component-textarea-example lab-state-${state}`}
          defaultValue={t("components.preview.fieldValue")}
          disabled={state === "disabled"}
          errorMessage={t("components.preview.inputError")}
          hint={t("components.preview.fieldDescription")}
          invalid={state === "invalid"}
          key={state}
          label={t("components.preview.inputLabel")}
          maxLength={200}
          rows={3}
          showCount
        />
      );
    }

    if (component.name === "Alert") {
      const tone = state === "success" || state === "warning" || state === "error" ? state : "info";
      return (
        <Alert
          message={t("components.preview.fieldDescription")}
          role={tone === "error" || tone === "warning" ? "alert" : "status"}
          title={t("components.preview.notifications")}
          tone={tone}
        />
      );
    }
    if (component.name === "Avatar") {
      return state === "grouped"
        ? <AvatarGroup><Avatar>BF</Avatar><Avatar>UI</Avatar><Avatar>DS</Avatar></AvatarGroup>
        : <Avatar alt="OpenBitFun" key={state} src={state === "image" ? previewImage : undefined}>BF</Avatar>;
    }
    if (component.name === "Checkbox" || component.name === "Radio") {
      const Control = component.name === "Checkbox" ? Checkbox : Radio;
      return (
        <Control
          className={`component-choice-example lab-state-${state}`}
          defaultChecked={state === "checked"}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          key={state}
          label={t("components.preview.notifications")}
          {...(component.name === "Checkbox" ? { indeterminate: state === "indeterminate", appearance: checkboxAppearance } : {})}
        />
      );
    }
    if (component.name === "NumberInput") return <NumberInputPreview key={state} state={state} />;
    if (component.name === "NumberBadge") return <NumberBadge value={numberBadgeValue} />;
    if (component.name === "Empty") {
      return (
        <Empty
          actions={state === "with-actions" ? <Button>{t("components.preview.add")}</Button> : undefined}
          description={t("components.preview.cardDescription")}
          title={state === "with-title" ? t("components.preview.cardTitle") : undefined}
        />
      );
    }

    if (component.name === "Disclosure") {
      return (
        <Disclosure
          data-openbitfun-preview-state={state === "hover" || state === "focus-visible" ? state : undefined}
          defaultOpen={state === "open"}
          disabled={state === "disabled"}
          key={state}
          summary={t("components.preview.appearance")}
        >
          {t("components.preview.appearanceDescription")}
        </Disclosure>
      );
    }

    if (component.name === "ActionCard") {
      return (
        <ActionCard
          actions={[
            {
              icon: <Icon name="more" size="lg" aria-hidden="true" />,
              id: "more",
              label: t("components.preview.more"),
            },
          ]}
          className={state === "focus-visible" ? "lab-force-focus" : undefined}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          description={t("components.preview.actionCardDescription")}
          disabled={state === "disabled"}
          leading={<Icon name="session" size="lg" aria-hidden="true" />}
          selected={state === "selected"}
          size={actionCardSize}
          tabIndex={-1}
        >
          {t("components.preview.actionCardTitle")}
        </ActionCard>
      );
    }

    if (component.name === "LauncherButton") {
      return (
        <LauncherButton
          className={state === "focus-visible" ? "lab-force-focus" : undefined}
          data-openbitfun-preview-state={
            state === "hover" || state === "active" || state === "focus-visible"
              ? state
              : undefined
          }
          disabled={state === "disabled"}
          leadingIcon={<Icon name="mic" aria-hidden="true" />}
          tabIndex={-1}
        >
          Hello
        </LauncherButton>
      );
    }

    if (component.name === "StatusPill") {
      return (
        <StatusPill
          emphasis
          leading={<Icon name="unselected" />}
          tone={state as StatusPillTone}
        >
          Ask
        </StatusPill>
      );
    }

    if (component.name === "Combobox") {
      return (
        <Combobox
          defaultOpen={state === "open" || state === "searching" || state === "loading" || state === "empty"}
          clearable
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          key={state}
          loading={state === "loading"}
          onValueChange={(value) => setSelectValue(String(value))}
          options={state === "empty" || state === "loading" ? [] : [
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
            { disabled: true, label: "Agent", value: "agent" },
          ]}
          onCreateValue={state === "custom" ? value => value : undefined}
          aria-label="Mode"
          size={size}
          value={selectValue}
        />
      );
    }

    if (component.name === "MultiSelect") {
      return (
        <MultiSelect
          defaultOpen={state === "open" || state === "searching" || state === "loading" || state === "empty"}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          key={state}
          loading={state === "loading"}
          onCreateValue={state === "custom" ? value => value : undefined}
          onValueChange={setMultiSelectValues}
          options={state === "empty" || state === "loading" ? [] : [
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
            { disabled: true, label: "Agent", value: "agent" },
          ]}
          aria-label="Modes"
          showSelectAll
          size={size}
          value={multiSelectValues}
        />
      );
    }

    if (component.name === "Listbox") {
      const multiple = state === "multiple";
      return (
        <Listbox aria-label="Mode" multiple={multiple}>
          <ListboxOption
            active={state === "active-option"}
            description="Default assistant behavior"
            disabled={state === "disabled-option"}
            selected={state === "selected-option" || multiple}
            value="ask"
          >
            Ask
          </ListboxOption>
          <ListboxOption selected={multiple} value="plan">Plan</ListboxOption>
          <ListboxOption disabled value="agent">Agent</ListboxOption>
        </Listbox>
      );
    }

    if (component.name === "Select") {
      return (
        <Select
          aria-label="Mode"
          data-openbitfun-preview-state={state === "hover" || state === "focus-visible" ? state : undefined}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          leading={<Icon name="unselected" />}
          onValueChange={(value) => setSelectValue(String(value))}
          open={state === "open" ? true : undefined}
          options={[
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
            { disabled: true, label: "Agent", value: "agent" },
          ]}
          value={selectValue}
        />
      );
    }

    if (component.name === "ActionItem") {
      return (
        <ActionItem
          actions={[
            {
              icon: <Icon name="plus" size="lg" aria-hidden="true" />,
              id: "add",
              label: t("components.preview.add"),
            },
            {
              icon: <Icon name="more" size="lg" aria-hidden="true" />,
              id: "more",
              label: t("components.preview.more"),
            },
          ]}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          disabled={state === "disabled"}
          leading={<Icon name="session" size="lg" aria-hidden="true" />}
          metadata={actionItemShowMetadata ? "12" : undefined}
          shortcut={<KeyHint>K</KeyHint>}
        >
          {t("components.preview.assistant")}
        </ActionItem>
      );
    }

    if (component.name === "ActivityItem") {
      const surface = activityItemAppearance === "surface";
      return (
        <ActivityItem
          actions={surface ? [
            {
              icon: <Icon name="duplicate" size="lg" aria-hidden="true" />,
              id: "copy",
              label: t("components.preview.activityCopy"),
            },
            {
              icon: <Icon name="arrow-down" aria-hidden="true" />,
              id: "download",
              label: t("components.preview.activityDownload"),
            },
            {
              icon: <Icon name="arrow-up-right" aria-hidden="true" />,
              id: "open",
              label: t("components.preview.activityOpen"),
            },
          ] : []}
          appearance={activityItemAppearance}
          className={state === "focus-visible"
            ? "component-activity-item-example lab-force-focus"
            : "component-activity-item-example"}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          detail={surface && activityShowDetail
            ? <code>{t("components.preview.activityDetail")}</code>
            : undefined}
          disabled={state === "disabled"}
          label={surface ? t("components.preview.activityAction") : undefined}
          leading={surface
            ? <Icon name="terminal" size="lg" aria-hidden="true" />
            : <Icon name="check-line" size="lg" aria-hidden="true" />}
          metadata={surface ? <ChangeCount additions={6} deletions={0} /> : undefined}
          onActivate={surface ? () => undefined : undefined}
        >
          {surface
            ? t("components.preview.activityDescription")
            : t("components.preview.activityStatus")}
        </ActivityItem>
      );
    }

    if (component.name === "Button") {
      const inspectorIcon = applyInspectorControls && previewIcon === "chevron"
        ? <Icon name="chevron-right" size="sm" aria-hidden="true" />
        : undefined;
      const leadingIcon = applyInspectorControls
        ? previewIconPosition === "left" ? inspectorIcon : undefined
        : <Icon name="session" size="sm" aria-hidden="true" />;
      const trailingIcon = applyInspectorControls
        ? previewIconPosition === "right" ? inspectorIcon : undefined
        : <Icon name="chevron-down" size="xs" aria-hidden="true" />;
      return (
        <Button
          className={state === "focus-visible" ? "lab-force-focus" : undefined}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          disabled={state === "disabled" || applyInspectorControls && inspectorDisabled}
          leadingIcon={leadingIcon}
          loading={state === "loading" || applyInspectorControls && inspectorLoading}
          size={size}
          trailingIcon={trailingIcon}
          variant={previewVariant}
        >
          {t("components.preview.session")}
        </Button>
      );
    }

    if (component.name === "Input") {
      const previewClassName = state === "hover"
        ? "lab-force-hover"
        : state === "focus-visible"
          ? "lab-force-focus"
          : undefined;
      return (
        <Input
          aria-label={t("components.preview.inputLabel")}
          className={previewClassName}
          defaultValue={state === "default" ? undefined : "OpenBitFun"}
          key={state}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          placeholder={t("components.preview.inputPlaceholder")}
          readOnly={state === "read-only"}
          trailing={<Icon name="eye" />}
        />
      );
    }

    if (component.name === "Field") {
      return (
        <Field
          className="component-field-example"
          controlLeading={fieldShowControlLeading ? (
            <Switch aria-label={t("components.preview.notifications")} />
          ) : undefined}
          controlTrailing={fieldShowControlTrailing ? (
            <IconButton
              aria-label={t("components.preview.more")}
              icon={<Icon name="more" size="lg" aria-hidden="true" />}
              size="xs"
            />
          ) : undefined}
          description={t("components.preview.fieldDescription")}
          label={t("components.preview.appearance")}
          labelAction={fieldShowLabelAction ? (
            <IconButton
              aria-label={t("components.preview.fieldHelp")}
              icon={<Icon name="info" size="lg" aria-hidden="true" />}
              size="xs"
            />
          ) : undefined}
          orientation={fieldOrientation}
          required
        >
          <Input
            aria-label={t("components.preview.appearance")}
            defaultValue={t("components.preview.fieldValue")}
            trailing={<Icon name="chevron-down" size="lg" aria-hidden="true" />}
          />
        </Field>
      );
    }

    if (component.name === "KeyHint") {
      return <KeyHint icon={<Icon name="command-mac" size="lg" aria-hidden="true" />}>K</KeyHint>;
    }

    if (component.name === "FieldGroup") {
      const plain = state === "plain";
      return (
        <FormSection
          className="component-field-group-example"
          description={t("components.preview.fieldDescription")}
          headingAs="h3"
          leading={<Icon name="gear" size="lg" aria-hidden="true" />}
          title={t("components.preview.modalSectionTitle")}
        >
          <FieldGroup appearance={plain ? "plain" : "subtle"} dividers={state === "divided"}>
            <FieldRow>
              <Field
                controlWidth="fill"
                label={t("components.preview.modalProviderName")}
                labelWidth="md"
                orientation="horizontal"
                required
              >
                <Input defaultValue="OpenBitFun" />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field
                controlWidth="fill"
                label={t("components.preview.modalApiUrl")}
                labelWidth="md"
                orientation="horizontal"
              >
                <Input defaultValue="https://api.openbitfun.com" />
              </Field>
            </FieldRow>
          </FieldGroup>
        </FormSection>
      );
    }

    if (component.name === "Card") {
      if (state === "media") {
        return (
          <Card
            appearance="neutral"
            className="component-card-example component-card-example--media"
            clip
            radius="md"
          >
            <CardMedia>
              <div className="component-card-media-visual">
                <Icon name="device-mac" size="lg" aria-hidden="true" />
              </div>
            </CardMedia>
            <CardBody align={cardContentAlign} padding="sm">
              <CardHeader
                contentAlign={cardContentAlign}
                description={t("components.preview.cardMediaDescription")}
                title={t("components.preview.cardMediaTitle")}
              />
            </CardBody>
          </Card>
        );
      }

      if (state === "subtle") {
        return (
          <Card
            appearance="subtle"
            className="component-card-example component-card-example--compact"
            gap="sm"
            padding="sm"
            radius="sm"
          >
            <CardHeader
              actions={(
                <IconButton
                  aria-label={t("components.preview.more")}
                  icon={<Icon name="more" size="lg" aria-hidden="true" />}
                  size="xs"
                />
              )}
              align="center"
              contentAlign={cardContentAlign}
              description={t("components.preview.activityDescription")}
              leading={<Icon name="terminal" size="lg" aria-hidden="true" />}
              title={t("components.preview.session")}
            />
          </Card>
        );
      }

      return (
        <Card
          appearance="raised"
          className="component-card-example"
          gap="md"
          padding="md"
          radius="lg"
        >
          <CardHeader
            contentAlign={cardContentAlign}
            description={t("components.preview.cardDescription")}
            title={t("components.preview.cardTitle")}
          />
          <CardBody>
            <div className="component-card-command-grid">
              {["components.preview.menuItemOne", "components.preview.menuItemTwo", "components.preview.settings"].map((key) => (
                <Card appearance="subtle" key={key} padding="sm" radius="sm">
                  <CardHeader
                    align="center"
                    leading={<Icon name="command-mac" size="lg" aria-hidden="true" />}
                    title={t(key as MessageKey)}
                  />
                </Card>
              ))}
            </div>
          </CardBody>
          <CardFooter align="end">
            <Button size="sm">{t("components.preview.settings")}</Button>
          </CardFooter>
        </Card>
      );
    }

    if (component.name === "Tooltip") {
      return (
        <Tooltip
          content={t("components.preview.tooltipContent")}
          delay={0}
          placement={state as "top" | "bottom" | "left" | "right"}
        >
          <Button size="sm" variant="fill">
            {t("components.preview.tooltipTrigger")}
          </Button>
        </Tooltip>
      );
    }

    if (component.name === "Menu") {
      const itemCount = state === "scrolling" ? 12 : 3;
      return (
        <Menu
          aria-label={t("components.preview.menuLabel")}
          scrollbarVisibility={menuShowScrollbar ? "auto" : "hidden"}
        >
          <MenuSection
            actions={[{
              icon: <Icon name="plus" size="lg" aria-hidden="true" />,
              id: "add",
              label: t("components.preview.add"),
            }]}
            title={t("components.preview.menuSectionTitle")}
          >
            {Array.from({ length: itemCount }, (_, index) => (
              <MenuItem
                checked={state === "checked-item" && index === 0}
                className={state === "focus-within" && index === 0 ? "lab-force-focus" : undefined}
                disabled={state === "disabled-item" && index === 1}
                key={index}
                leading={<Icon name="session" size="lg" aria-hidden="true" />}
                role={state === "checked-item" && index === 0 ? "menuitemcheckbox" : "menuitem"}
              >
                {index === 0
                  ? t("components.preview.menuItemOne")
                  : index === 1
                    ? t("components.preview.menuItemTwo")
                    : t("components.preview.menuItem", { index: index + 1 })}
              </MenuItem>
            ))}
          </MenuSection>
          <MenuSeparator />
          <MenuSection aria-label={t("components.preview.menuMoreSection")}>
            <MenuItem>{t("components.preview.menuMoreItem")}</MenuItem>
          </MenuSection>
        </Menu>
      );
    }

    if (component.name === "Composer") {
      const showContext = composerShowContext || state === "with-context";
      return (
        <Composer
          aria-label={t("components.preview.composerLabel")}
          className={state === "focus-within" ? "component-composer-example lab-force-focus" : "component-composer-example"}
          contextBar={showContext ? (
            <ComposerContextBar
              leading={(
                <>
                  <span className="component-composer-context-label">
                    <Icon name="device-mac" size="lg" aria-hidden="true" />
                    {t("components.preview.composerDevice")}
                    <Icon name="chevron-down" size="lg" aria-hidden="true" />
                  </span>
                  <ComposerDivider />
                  <span className="component-composer-context-label">
                    {t("components.preview.composerWorkspace")}
                    <Icon name="chevron-down" size="lg" aria-hidden="true" />
                  </span>
                </>
              )}
              trailing={(
                <span className="component-composer-mode">
                  {t("components.preview.composerMode")}
                </span>
              )}
            />
          ) : undefined}
          disabled={state === "disabled"}
          invalid={state === "invalid"}
          toolbar={composerShowToolbar ? (
            <ComposerToolbar
              leading={(
                <>
                  <IconButton
                    aria-label={t("components.preview.composerAdd")}
                    icon={<Icon name="plus" size="lg" aria-hidden="true" />}
                    shape="circle"
                    size="sm"
                    variant="fill"
                  />
                  <Button size="sm" variant="text">
                    {t("components.preview.composerStandard")}
                  </Button>
                </>
              )}
              trailing={(
                <>
                  <Button
                    size="sm"
                    trailingIcon={<Icon name="chevron-down" size="lg" aria-hidden="true" />}
                    variant="text"
                  >
                    {t("components.preview.composerModel")}
                  </Button>
                  <IconButton
                    aria-label={t("components.preview.composerVoice")}
                    icon={<Icon name="mic" size="lg" aria-hidden="true" />}
                    shape="circle"
                    size="sm"
                    variant="quiet"
                  />
                  <IconButton
                    aria-label={t("components.preview.composerSend")}
                    icon={<Icon name="arrow-up" size="lg" aria-hidden="true" />}
                    shape="circle"
                    size="sm"
                    variant="primary"
                  />
                </>
              )}
            />
          ) : undefined}
        >
          <textarea
            aria-label={t("components.preview.composerEditorLabel")}
            disabled={state === "disabled"}
            placeholder={t("components.preview.composerPlaceholder")}
            readOnly
          />
        </Composer>
      );
    }

    if (component.name === "LoadingState") {
      return <LoadingState>{state === "with-label" ? t("detail.loading") : null}</LoadingState>;
    }

    if (component.name === "Spinner") {
      return (
        <Spinner
          aria-label={t("detail.loading")}
          size={size}
          variant={state === "bars" ? "bars" : "matrix"}
        />
      );
    }

    if (component.name === "ConfirmDialog") {
      const confirmType = state === "pending" ? "warning" : state as ConfirmDialogType;
      return (
        <>
          <Button onClick={() => setOverlayOpen(true)} variant="fill">
            {t("components.preview.modalInteractionDemo")}
          </Button>
          <ConfirmDialog
            cancelText={t("components.preview.modalCancel")}
            confirmDanger={confirmType === "error"}
            confirmText={confirmType === "error"
              ? t("components.preview.confirmDelete")
              : t("components.preview.modalSave")}
            message={t("components.preview.confirmMessage")}
            onConfirm={() => undefined}
            onOpenChange={() => setOverlayOpen(false)}
            open={overlayOpen}
            pendingAction={state === "pending" ? "confirm" : null}
            preview="/workspace/project"
            title={t("components.preview.confirmTitle")}
            type={confirmType}
          />
        </>
      );
    }

    if (component.name === "Dialog") return renderDialogExample();
    if (component.name === "Sheet") return renderSheetExample();
    if (component.name === "MobileActionSheet") {
      return (
        <>
          <Button onClick={() => setOverlayOpen(true)} variant="fill">{t("components.preview.modalInteractionDemo")}</Button>
          <MobileActionSheet
            actions={[
              { id: "rename", label: t("components.preview.modalSave") },
              { id: "delete", label: t("components.preview.confirmDelete"), tone: "danger" },
            ]}
            cancelLabel={t("components.preview.modalCancel")}
            onAction={() => setOverlayOpen(false)}
            onOpenChange={() => setOverlayOpen(false)}
            open={overlayOpen}
            title={t("components.preview.session")}
          />
        </>
      );
    }

    if (component.name === "MobileConfirmSheet") {
      return (
        <>
          <Button onClick={() => setOverlayOpen(true)} variant="fill">{t("components.preview.modalInteractionDemo")}</Button>
          <MobileConfirmSheet
            cancelLabel={t("components.preview.modalCancel")}
            confirmLabel={t("components.preview.confirmDelete")}
            confirmTone="danger"
            onConfirm={() => setOverlayOpen(false)}
            onOpenChange={() => setOverlayOpen(false)}
            open={overlayOpen}
            pending={state === "pending"}
            title={t("components.preview.confirmTitle")}
          />
        </>
      );
    }

    if (component.name === "MobileSheet") {
      return (
        <>
          <Button onClick={() => setOverlayOpen(true)} variant="fill">{t("components.preview.modalInteractionDemo")}</Button>
          <MobileSheet
            footer={<Button onClick={() => setOverlayOpen(false)} variant="fill">{t("components.preview.modalCancel")}</Button>}
            onOpenChange={() => setOverlayOpen(false)}
            open={overlayOpen}
            title={t("components.preview.modalTitle")}
          >
            {renderDialogConfigurationContent()}
          </MobileSheet>
        </>
      );
    }

    if (component.name === "MobileChoiceSheet") {
      return (
        <>
          <Button onClick={() => setOverlayOpen(true)} variant="fill">{t("components.preview.modalInteractionDemo")}</Button>
          <MobileChoiceSheet
            cancelLabel={t("components.preview.modalCancel")}
            onOpenChange={() => setOverlayOpen(false)}
            onSelect={(value) => {
              setMobileChoiceValue(value);
              setOverlayOpen(false);
            }}
            open={overlayOpen}
            options={[
              { label: t("components.preview.modeMinimal"), value: "minimal" },
              { disabled: state === "disabled", label: t("components.preview.modeStandard"), value: "standard" },
              { label: t("components.preview.modeUltimate"), value: "ultimate" },
            ]}
            selectedValue={mobileChoiceValue}
            title={t("components.preview.selectExecutionMode")}
          />
        </>
      );
    }

    if (component.name === "PageHeader") {
      return (
        <PageHeader
          action={(
            <IconButton
              aria-label={t("components.preview.close")}
              icon={<Icon name="xmark" size="lg" aria-hidden="true" />}
            />
          )}
          align={pageHeaderAlign}
          description={t("components.preview.appearanceDescription")}
          leading={<Icon name="gear" size="lg" aria-hidden="true" />}
          level={2}
          required={pageHeaderRequired}
          size={pageHeaderSize}
          title={t("components.preview.appearance")}
        />
      );
    }

    if (component.name === "SearchField") {
      return <SearchFieldStatePreview key={state} state={state} />;
    }

    if (component.name === "NavigationPanel") {
      const itemCount = state === "scrolling" ? 14 : 5;
      return (
        <NavigationPanel
          aria-label={t("components.preview.navigationPanelLabel")}
          className="component-navigation-panel-example"
        >
          <NavigationPanelHeader>
            <SearchField
              aria-label={t("components.preview.searchLabel")}
              leadingIcon={<Icon name="search" size="lg" aria-hidden="true" />}
              placeholder={t("components.preview.searchPlaceholder")}
            />
          </NavigationPanelHeader>
          <NavigationPanelBody scrollbarVisibility={navigationPanelShowScrollbar ? "auto" : "hidden"}>
            <NavigationPanelContent>
              <NavigationPanelSection title={t("components.preview.navigationPanelSectionTitle")}>
                {Array.from({ length: itemCount }, (_, index) => (
                  <NavigationPanelItem
                    disabled={state === "disabled-item" && index === 1}
                    key={index}
                    leading={index % 3 === 0 ? <Icon name="session" size="lg" aria-hidden="true" /> : undefined}
                    reserveLeadingSpace
                    selected={state === "selected-item" && index === 0}
                  >
                    {index === 0
                      ? t("components.preview.menuItemOne")
                      : index === 1
                        ? t("components.preview.menuItemTwo")
                        : t("components.preview.menuItem", { index: index + 1 })}
                  </NavigationPanelItem>
                ))}
              </NavigationPanelSection>
              <NavigationPanelSeparator />
              <NavigationPanelSection title={t("components.preview.navigationPanelMoreSection")}>
                <NavigationPanelItem reserveLeadingSpace>
                  {t("components.preview.navigationPanelMoreItem")}
                </NavigationPanelItem>
                <NavigationPanelItem labelBehavior="static" style={{ maxInlineSize: 180, whiteSpace: "normal" }}>
                  {t("components.preview.cardDescription")}
                </NavigationPanelItem>
              </NavigationPanelSection>
            </NavigationPanelContent>
          </NavigationPanelBody>
          <NavigationPanelFooter>
            <>
              <NavigationPanelItem
                className="component-navigation-panel-example__device"
                leading={<Icon name="device-mac" size="lg" aria-hidden="true" />}
              >
                {t("components.preview.navigationPanelDevice")}
              </NavigationPanelItem>
              <IconButton
                aria-label={t("components.preview.settings")}
                icon={<Icon name="gear" size="lg" aria-hidden="true" />}
                size="sm"
                variant="quiet"
              />
            </>
          </NavigationPanelFooter>
        </NavigationPanel>
      );
    }

    if (component.name === "ScrollArea") {
      return (
        <ScrollArea
          aria-label={t("components.preview.scrollAreaLabel")}
          className="component-scroll-area-example"
          orientation={scrollAreaOrientation}
          scrollbarVisibility={state as ScrollbarVisibility}
        >
          <div className="component-scroll-area-example__content">
            {Array.from({ length: 7 }, (_, index) => (
              <span className="component-scroll-area-example__item" key={index}>
                {t("components.preview.scrollAreaItem", { index: index + 1 })}
              </span>
            ))}
          </div>
        </ScrollArea>
      );
    }

    if (component.name === "SegmentedControl") {
      const defaultMode = state === "unselected" ? "agent" : "chat";
      return (
        <SegmentedControl
          size="md"
          aria-label={t("components.preview.segmentedLabel")}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          defaultValue={defaultMode}
          disabled={state === "disabled"}
          key={state}
          options={[
            {
              icon: <Icon name="session" size="xs" aria-hidden="true" />,
              label: t("components.preview.segmentedChat"),
              value: "chat",
            },
            {
              label: t("components.preview.segmentedAgent"),
              value: "agent",
            },
          ]}
        />
      );
    }

    if (component.name === "RollingText") {
      return <RollingTextPreview interactive={state === "replacing"} />;
    }

    if (component.name === "TabGroup") {
      const defaultTab = state === "unselected" ? "settings" : "welcome";
      return (
        <TabGroup
          aria-label={t("components.preview.tabGroupLabel")}
          data-openbitfun-preview-state={state === "hover" || state === "active" ? state : undefined}
          defaultValue={defaultTab}
          items={[
            {
              icon: <Icon name="session" size="sm" aria-hidden="true" />,
              label: t("components.preview.welcome"),
              value: "welcome",
            },
            {
              disabled: state === "disabled",
              icon: <Icon name="session" size="sm" aria-hidden="true" />,
              label: t("components.preview.settings"),
              value: "settings",
            },
          ]}
          key={state}
          size={tabGroupSize}
        />
      );
    }

    if (component.name === "Toolbar") {
      const tabItems = Array.from({ length: state === "overflow" ? 9 : 2 }, (_, index) => ({
        icon: <Icon name="session" size="sm" aria-hidden="true" />,
        label: index === 0
          ? t("components.preview.welcome")
          : index === 1
            ? t("components.preview.settings")
            : t("components.preview.menuItem", { index: index + 1 }),
        value: `tab-${index + 1}`,
      }));

      return (
        <Toolbar
          aria-label={t("components.preview.tabGroupLabel")}
          center={state === "with-center" ? (
            <ToolbarGroup>
              <ToolbarBadge>18</ToolbarBadge>
              <strong>{t("components.preview.session")}</strong>
            </ToolbarGroup>
          ) : undefined}
          className="component-toolbar-example"
          leading={state === "with-center" ? (
            <ToolbarGroup>
              <Button size="xs" trailingIcon={<Icon name="chevron-down" size="lg" aria-hidden="true" />} variant="text">
                {t("components.preview.welcome")}
              </Button>
              <ChangeCount additions={6} deletions={0} />
            </ToolbarGroup>
          ) : (
            <TabGroup
              aria-label={t("components.preview.tabGroupLabel")}
              defaultValue="tab-1"
              items={tabItems}
              size="sm"
            />
          )}
          leadingOverflow={state === "overflow" ? "scroll" : "visible"}
          size={toolbarSize}
          trailing={(
            <ToolbarGroup>
              {state !== "with-center" && <ChangeCount additions={6} deletions={2} />}
              <ToolbarSeparator />
              <IconButton
                aria-label={t("components.preview.searchLabel")}
                icon={<Icon name="search" size="lg" aria-hidden="true" />}
                size="xs"
              />
              <IconButton
                aria-label={t("components.preview.more")}
                icon={<Icon name="more" size="lg" aria-hidden="true" />}
                size="xs"
              />
            </ToolbarGroup>
          )}
        />
      );
    }

    if (component.name !== "Switch") return <p role="status">{t("detail.previewUnavailable")}: {component.name}</p>;
    return (
      <Switch
        aria-label={t("components.preview.notifications")}
        className={state === "focus-visible" ? "lab-force-focus" : undefined}
        defaultChecked={state === "on"}
        disabled={state === "disabled"}
        key={state}
      />
    );
  }

  const copyLabel = copyStatus === "copied"
    ? t("detail.copied")
    : copyStatus === "unavailable"
      ? t("detail.copyUnavailable")
      : t("detail.copy");
  const schemeLabel = colorScheme === "dark" ? t("settings.dark") : t("settings.light");
  const contrastLabel = contrast === "high" ? t("settings.highContrast") : t("settings.standard");
  const densityLabel = density === "compact"
    ? t("settings.compact")
    : density === "touch"
      ? t("settings.touch")
      : t("settings.comfortable");

  return (
    <main className="lab-page lab-page--component-detail">
      <nav className="component-breadcrumb" aria-label={t("detail.breadcrumbLabel")}>
        <button onClick={onBack} type="button">
          {t(isFlowChatComponent ? "detail.backFlowChat" : "detail.back")}
        </button>
        <Icon name="chevron-right" size="lg" aria-hidden="true" style={{ width: 13, height: 13 }} />
        <span aria-current="page">{component.name}</span>
      </nav>

      <div className="component-preview-layout">
        <div className="component-preview-main">
          <header className="component-detail-heading">
            <div>
              <h1>{component.name}</h1>
              <p>{getComponentDescription(component.name, component.description, t)}</p>
            </div>
          </header>

          <section className="component-preview-panel" id="component-workbench">
            <header className="component-panel-heading">
              <h2>{t("detail.preview")}</h2>
            </header>

            <ThemeRoot
              className="component-preview-canvas"
              colorScheme={colorScheme}
              contrast={contrast}
              density={density}
              tokenOverrides={tokenOverrides}
              tabIndex={0}
              role="region"
              aria-label={t("detail.preview")}
            >
              {component.name === "ConfirmDialog" || component.name === "Dialog" || component.name === "Sheet" ? (
                <div className="component-dialog-preview-stage">
                  <span className="component-dialog-preview-stage__label">
                    {stateLabel(previewState)}
                  </span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "Card" ? (
                <div className="component-card-preview-stage">
                  <span className="component-card-preview-stage__label">
                    {stateLabel(previewState)}
                  </span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "ActivityItem" ? (
                <div className="component-activity-item-preview-stage">
                  <span className="component-activity-item-preview-stage__label">
                    {stateLabel(activityItemAppearance)} · {stateLabel(previewState)}
                  </span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "Composer" ? (
                <div className="component-composer-preview-stage">
                  <span className="component-composer-preview-stage__label">
                    {stateLabel(previewState)}
                  </span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "Toolbar" ? (
                <div className="component-toolbar-preview-stage">
                  <span className="component-toolbar-preview-stage__label">
                    {stateLabel(previewState)}
                  </span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "Combobox" || component.name === "MultiSelect" ? (
                <div className="component-combobox-preview" data-component="combobox">
                  <span>{stateLabel(previewState)}</span>
                  {renderPreview(previewState)}
                </div>
              ) : component.name === "Menu" || component.name === "NavigationPanel" || component.name === "FieldGroup" ? (
                <div className="component-surface-state-list" data-component={component.name}>
                  {states.map((state) => (
                    <section className="component-surface-state-list__item" key={state}>
                      <header className="flow-chat-state-list__heading">
                        <strong>{stateLabel(state)}</strong>
                        <code>{state}</code>
                      </header>
                      <div className="component-surface-state-list__preview">{renderPreview(state)}</div>
                    </section>
                  ))}
                </div>
              ) : isFlowChatComponent ? (
                <div
                  className="flow-chat-state-list"
                  data-component="flow-chat-tool-card"
                >
                  {states.map((state) => (
                    <section
                      className="flow-chat-state-list__item"
                      data-active={state === previewState || undefined}
                      key={state}
                    >
                      <header className="flow-chat-state-list__heading">
                        <strong>{stateLabel(state)}</strong>
                        <code>{state}</code>
                      </header>
                      <div
                        className="flow-chat-state-list__preview"
                        data-component-name={component.name}
                      >
                        {renderPreview(state)}
                      </div>
                    </section>
                  ))}
                </div>
              ) : component.name === "Button" ? (
                (["plain", "subtle"] as const).map((surface) => (
                  <section className="button-state-surface" data-surface={surface} key={surface}>
                    <h3>{t(surface === "plain" ? "detail.option.plain" : "detail.option.subtle")}</h3>
                    <div
                      className="component-preview-matrix"
                      data-component="button"
                      data-state-count={states.length}
                    >
                      <span className="component-preview-matrix__corner" />
                      {states.map((state, index) => (
                        <span
                          className="component-preview-matrix__column-label"
                          data-last={index === states.length - 1 || undefined}
                          key={state}
                        >
                          {stateLabel(state)}
                        </span>
                      ))}
                      {buttonVariants.map((matrixVariant) => (
                        <Fragment key={matrixVariant}>
                          <span className="component-preview-matrix__row-label">
                            {stateLabel(matrixVariant)}
                          </span>
                          {states.map((state) => (
                            <div
                              className="component-preview-matrix__cell"
                              data-active={matrixVariant === variant && state === previewState || undefined}
                              key={`${matrixVariant}-${state}`}
                            >
                              {renderPreview(state, matrixVariant)}
                            </div>
                          ))}
                        </Fragment>
                      ))}
                    </div>
                    <div className="component-preview-row">
                      <code>labelBehavior="static"</code>
                      <Button labelBehavior="static" size="sm" variant="text"
                        style={{ maxInlineSize: 220, blockSize: "auto", whiteSpace: "normal" }}>
                        {t("components.preview.cardDescription")}
                      </Button>
                    </div>
                  </section>
                ))
              ) : component.name === "Icon" ? (
                <>
                  <IconCompositionPreview />
                  <div className="component-icon-catalog">
                    {canonicalIconNames.map((name) => (
                      <div className="component-icon-catalog__item" key={name}>
                        <Icon name={name} size="lg" />
                        <code>{name}</code>
                      </div>
                    ))}
                  </div>
                </>
              ) : component.name === "IconButton" ? (
                <div
                  className="component-preview-matrix"
                  data-component="icon-button"
                  data-state-count={states.length}
                >
                  <span className="component-preview-matrix__corner" />
                  {states.map((state, index) => (
                    <span
                      className="component-preview-matrix__column-label"
                      data-last={index === states.length - 1 || undefined}
                      key={state}
                    >
                      {stateLabel(state)}
                    </span>
                  ))}
                  {iconButtonVariants.map((matrixVariant) => (
                    <Fragment key={matrixVariant}>
                      <span className="component-preview-matrix__row-label">
                        {stateLabel(matrixVariant)}
                      </span>
                      {states.map((state) => (
                        <div
                          className="component-preview-matrix__cell"
                          data-active={matrixVariant === iconButtonVariant && state === previewState || undefined}
                          key={`${matrixVariant}-${state}`}
                        >
                          {renderIconButtonPreview(state, matrixVariant)}
                        </div>
                      ))}
                    </Fragment>
                  ))}
                </div>
              ) : component.category === "mobile" ? (
                <div
                  className="component-preview-matrix"
                  data-component={component.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}
                  data-state-count={states.length}
                >
                  <span className="component-preview-matrix__corner" />
                  {states.map((state, index) => (
                    <span
                      className="component-preview-matrix__column-label"
                      data-last={index === states.length - 1 || undefined}
                      key={state}
                    >
                      {stateLabel(state)}
                    </span>
                  ))}
                  <span className="component-preview-matrix__row-label">{component.name}</span>
                  {states.map((state) => (
                    <div
                      className="component-preview-matrix__cell"
                      data-active={state === previewState || undefined}
                      key={state}
                    >
                      {renderPreview(state)}
                    </div>
                  ))}
                </div>
              ) : component.name === "ActionCard" || component.name === "ActionItem" || component.name === "Combobox" || component.name === "Field" || component.name === "FieldGroup" || component.name === "Input" || component.name === "KeyHint" || component.name === "Listbox" || component.name === "Menu" || component.name === "NavigationPanel" || component.name === "PageHeader" || component.name === "ScrollArea" || component.name === "SearchField" || component.name === "SegmentedControl" || component.name === "Select" || component.name === "StatusPill" || component.name === "Tooltip" ? (
                <div
                  className="component-preview-matrix"
                  data-component={component.name === "ActionCard"
                    ? "action-card"
                    : component.name === "ActionItem"
                      ? "action-item"
                    : component.name === "Combobox"
                      ? "combobox"
                    : component.name === "Field"
                      ? "field"
                    : component.name === "StatusPill"
                      ? "status-pill"
                    : component.name === "SegmentedControl"
                      ? "segmented-control"
                    : component.name === "Select"
                      ? "select"
                    : component.name === "FieldGroup"
                      ? "field-group"
                    : component.name === "Input"
                      ? "input"
                    : component.name === "KeyHint"
                      ? "key-hint"
                    : component.name === "Listbox"
                      ? "listbox"
                      : component.name === "PageHeader"
                        ? "page-header"
                      : component.name === "Menu"
                        ? "menu"
                      : component.name === "NavigationPanel"
                        ? "navigation-panel"
                      : component.name === "ScrollArea"
                        ? "scroll-area"
                      : component.name === "Tooltip"
                        ? "tooltip"
                      : "search-field"}
                  data-state-count={states.length}
                >
                  <span className="component-preview-matrix__corner" />
                  {states.map((state, index) => (
                    <span
                      className="component-preview-matrix__column-label"
                      data-last={index === states.length - 1 || undefined}
                      key={state}
                    >
                      {stateLabel(state)}
                    </span>
                  ))}
                  <span className="component-preview-matrix__row-label">{component.name}</span>
                  {states.map((state) => (
                    <div
                      className="component-preview-matrix__cell"
                      data-active={state === previewState || undefined}
                      key={state}
                    >
                      {renderPreview(state)}
                    </div>
                  ))}
                </div>
              ) : component.name === "TabGroup" ? (
                <div
                  className="component-preview-matrix"
                  data-component="tab-group"
                  data-state-count={states.length}
                >
                  <span className="component-preview-matrix__corner" />
                  {states.map((state, index) => (
                    <span
                      className="component-preview-matrix__column-label"
                      data-last={index === states.length - 1 || undefined}
                      key={state}
                    >
                      {stateLabel(state)}
                    </span>
                  ))}
                  <span className="component-preview-matrix__row-label">TabGroup</span>
                  {states.map((state) => (
                    <div
                      className="component-preview-matrix__cell"
                      data-active={state === previewState || undefined}
                      key={state}
                    >
                      {renderPreview(state)}
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="component-preview-matrix"
                  data-component={component.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}
                  data-state-count={states.length}
                >
                  <span className="component-preview-matrix__corner" />
                  {states.map((state, index) => (
                    <span
                      className="component-preview-matrix__column-label"
                      data-last={index === states.length - 1 || undefined}
                      key={state}
                    >
                      {stateLabel(state)}
                    </span>
                  ))}
                  <span className="component-preview-matrix__row-label">{component.name}</span>
                  {states.map((state) => (
                    <div
                      className="component-preview-matrix__cell"
                      data-active={state === previewState || undefined}
                      key={state}
                    >
                      {renderPreview(state)}
                    </div>
                  ))}
                </div>
              )}
              {component.name === "Menu" && <div className="component-menu-interaction"><NestedMenuPattern /></div>}
              {component.name === "Disclosure" && (
                <div className="component-preview-row">
                  <code>presentation="native"</code>
                  <Disclosure presentation="native" summary={t("components.preview.appearance")}>
                    {t("components.preview.appearanceDescription")}
                  </Disclosure>
                </div>
              )}
            </ThemeRoot>
          </section>

          <section className="component-code-panel component-code-panel--standalone">
            <header className="component-panel-heading component-code-heading">
              <h2>{t("detail.code")}</h2>
              <div>
                <span>React · TypeScript</span>
                <button onClick={copyCode} type="button">
                  <Clipboard aria-hidden="true" size={14} />
                  {copyLabel}
                </button>
              </div>
            </header>
            <pre><code>{codeSample}</code></pre>
          </section>
        </div>

        <aside className="component-inspector">
          <div className="component-inspector-tabs" role="tablist" aria-label={t("detail.inspector.label")}>
            {(["properties", "styles", "tokens"] as const).map((tab) => (
              <button
                aria-selected={inspectorTab === tab}
                key={tab}
                onClick={() => setInspectorTab(tab)}
                role="tab"
                type="button"
              >
                {t(`detail.inspector.${tab}` as MessageKey)}
              </button>
            ))}
          </div>

          {inspectorTab === "properties" && (
            <div className="component-inspector-content" role="tabpanel">
              <section>
                <h2>{t("detail.inspector.basicProperties")}</h2>
                <div className="component-inspector-controls">
                  {component.name === "Button" && (
                    <InspectorSelect
                      label={t("detail.variant")}
                      onChange={(value) => setVariant(value as (typeof buttonVariants)[number])}
                      options={buttonVariants}
                      value={variant}
                    />
                  )}
                  {component.name === "IconButton" && (
                    <InspectorSelect
                      label={t("detail.variant")}
                      onChange={(value) => setIconButtonVariant(value as (typeof iconButtonVariants)[number])}
                      options={iconButtonVariants}
                      value={iconButtonVariant}
                    />
                  )}
                  {component.name === "IconButton" && (
                    <>
                      <InspectorSelect label={t("detail.size")} options={iconButtonSizes} value={iconButtonSize} onChange={(value) => setIconButtonSize(value as (typeof iconButtonSizes)[number])} translateOptions={false} />
                      <InspectorSelect label="shape" options={["square", "circle"]} value={iconButtonShape} onChange={(value) => setIconButtonShape(value as "square" | "circle")} translateOptions={false} />
                    </>
                  )}
                  {component.name === "Field" && (
                    <InspectorSelect
                      label={t("detail.orientation")}
                      onChange={(value) => setFieldOrientation(value as FieldOrientation)}
                      options={fieldOrientations}
                      value={fieldOrientation}
                    />
                  )}
                  {component.name === "Checkbox" && (
                    <InspectorSelect label="appearance" options={["custom", "native"]}
                      value={checkboxAppearance} onChange={(value) => setCheckboxAppearance(value as "custom" | "native")}
                      translateOptions={false} />
                  )}
                  {component.name === "PageHeader" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setPageHeaderSize(value as PageHeaderSize)}
                      options={pageHeaderSizes}
                      value={pageHeaderSize}
                    />
                  )}
                  {component.name === "PageHeader" && (
                    <InspectorSelect
                      label={t("detail.alignment")}
                      onChange={(value) => setPageHeaderAlign(value as PageHeaderAlign)}
                      options={pageHeaderAlignments}
                      value={pageHeaderAlign}
                    />
                  )}
                  {component.name === "Icon" && (
                    <InspectorSelect
                      label={t("detail.name")}
                      onChange={(value) => setIconName(value as IconName)}
                      options={canonicalIconNames}
                      translateOptions={false}
                      value={iconName}
                    />
                  )}
                  {component.name === "NumberBadge" && (
                    <Field label="value">
                      <Input value={numberBadgeValue} onChange={(event) => setNumberBadgeValue(event.target.value)} />
                    </Field>
                  )}
                  {component.name === "Icon" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setIconSize(value as IconSize)}
                      options={iconSizes}
                      translateOptions={false}
                      value={iconSize}
                    />
                  )}
                  {component.name === "Icon" && (
                    <InspectorSelect
                      label={t("detail.variant")}
                      onChange={(value) => setIconTone(value as IconTone)}
                      options={iconTones}
                      translateOptions={false}
                      value={iconTone}
                    />
                  )}
                  {component.name === "Card" && (
                    <InspectorSelect
                      label={t("detail.alignment")}
                      onChange={(value) => setCardContentAlign(value as CardContentAlignment)}
                      options={cardContentAlignments}
                      value={cardContentAlign}
                    />
                  )}
                  {component.name === "Field" && (
                    <InspectorToggle
                      checked={fieldShowLabelAction}
                      label={t("detail.showLabelAction")}
                      onCheckedChange={setFieldShowLabelAction}
                    />
                  )}
                  {component.name === "Field" && (
                    <InspectorToggle
                      checked={fieldShowControlLeading}
                      label={t("detail.showLeadingControl")}
                      onCheckedChange={setFieldShowControlLeading}
                    />
                  )}
                  {component.name === "Field" && (
                    <InspectorToggle
                      checked={fieldShowControlTrailing}
                      label={t("detail.showTrailingAction")}
                      onCheckedChange={setFieldShowControlTrailing}
                    />
                  )}
                  {component.name === "ScrollArea" && (
                    <InspectorSelect
                      label={t("detail.orientation")}
                      onChange={(value) => setScrollAreaOrientation(value as ScrollAreaOrientation)}
                      options={scrollAreaOrientations}
                      value={scrollAreaOrientation}
                    />
                  )}
                  {component.name === "Button" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setSize(value as PreviewSize)}
                      options={["sm", "md", "lg"]}
                      value={size}
                    />
                  )}
                  <InspectorSelect
                    label={t("detail.state")}
                    onChange={setPreviewState}
                    options={inspectorStates}
                    translateOptions={component.name !== "StatusPill"}
                    value={previewState}
                  />
                  {component.name === "ActivityItem" && (
                    <InspectorSelect
                      label={t("detail.variant")}
                      onChange={(value) => setActivityItemAppearance(value as ActivityItemAppearance)}
                      options={activityItemAppearances}
                      value={activityItemAppearance}
                    />
                  )}
                  {component.name === "ActivityItem" && (
                    <InspectorToggle
                      checked={activityShowDetail}
                      label={t("detail.showDetailArea")}
                      onCheckedChange={setActivityShowDetail}
                    />
                  )}
                  {component.name === "PageHeader" && (
                    <InspectorToggle
                      checked={pageHeaderRequired}
                      label={t("detail.showAsterisk")}
                      onCheckedChange={setPageHeaderRequired}
                    />
                  )}
                  {component.name === "ActionItem" && (
                    <InspectorToggle
                      checked={actionItemShowMetadata}
                      label={t("detail.showMetadata")}
                      onCheckedChange={setActionItemShowMetadata}
                    />
                  )}
                  {component.name === "ActionCard" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setActionCardSize(value as ActionCardSize)}
                      options={actionCardSizes}
                      value={actionCardSize}
                    />
                  )}
                  {component.name === "Toolbar" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setToolbarSize(value as ToolbarSize)}
                      options={["sm", "md"]}
                      value={toolbarSize}
                    />
                  )}
                  {component.name === "TabGroup" && (
                    <InspectorSelect
                      label={t("detail.size")}
                      onChange={(value) => setTabGroupSize(value as TabGroupSize)}
                      options={["sm", "md"]}
                      value={tabGroupSize}
                    />
                  )}
                  {component.name === "Composer" && (
                    <InspectorToggle
                      checked={composerShowContext}
                      label={t("detail.showContextBar")}
                      onCheckedChange={setComposerShowContext}
                    />
                  )}
                  {component.name === "Composer" && (
                    <InspectorToggle
                      checked={composerShowToolbar}
                      label={t("detail.showToolbar")}
                      onCheckedChange={setComposerShowToolbar}
                    />
                  )}
                  {component.name === "Menu" && (
                    <InspectorToggle
                      checked={menuShowScrollbar}
                      label={t("detail.showScrollbar")}
                      onCheckedChange={setMenuShowScrollbar}
                    />
                  )}
                  {component.name === "NavigationPanel" && (
                    <InspectorToggle
                      checked={navigationPanelShowScrollbar}
                      label={t("detail.showScrollbar")}
                      onCheckedChange={setNavigationPanelShowScrollbar}
                    />
                  )}
                  {(component.name === "Button" || component.name === "IconButton") && (
                    <InspectorToggle
                      checked={inspectorDisabled}
                      label={t("detail.disabled")}
                      onCheckedChange={setInspectorDisabled}
                    />
                  )}
                  {(component.name === "Button" || component.name === "IconButton") && (
                    <InspectorToggle
                      checked={inspectorLoading}
                      label={t("detail.loading")}
                      onCheckedChange={setInspectorLoading}
                    />
                  )}
                  {component.name === "Button" && (
                    <InspectorSelect
                      label={t("detail.icon")}
                      onChange={(value) => setPreviewIcon(value as PreviewIcon)}
                      options={["none", "chevron"]}
                      value={previewIcon}
                    />
                  )}
                  {component.name === "Button" && (
                    <InspectorSelect
                      label={t("detail.iconPosition")}
                      onChange={(value) => setPreviewIconPosition(value as PreviewIconPosition)}
                      options={["left", "right"]}
                      value={previewIconPosition}
                    />
                  )}
                </div>
              </section>

              <section>
                <h2>{t("detail.inspector.selectedPreview")}</h2>
                <ThemeRoot
                  className="component-inspector-preview"
                  colorScheme={colorScheme}
                  contrast={contrast}
                  density={density}
                  tokenOverrides={tokenOverrides}
                >
                  {component.name === "IconButton"
                    ? renderIconButtonPreview(previewState, iconButtonVariant, true)
                    : renderPreview(previewState, variant, true)}
                </ThemeRoot>
              </section>

              <section>
                <h2>{t("detail.inspector.publicApi")}</h2>
                <div className="component-inspector-props">
                  {component.props.map((prop) => (
                    <div key={prop.name}>
                      <code>{prop.name}</code>
                      <span>{prop.type}</span>
                      <small>{prop.defaultValue ?? "—"}</small>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {inspectorTab === "styles" && (
            <div className="component-inspector-content" role="tabpanel">
              <section>
                <h2>{t("detail.inspector.themeContext")}</h2>
                <dl className="component-inspector-facts">
                  <div><dt>{t("settings.scheme")}</dt><dd>{schemeLabel}</dd></div>
                  <div><dt>{t("settings.contrast")}</dt><dd>{contrastLabel}</dd></div>
                  <div><dt>{t("settings.density")}</dt><dd>{densityLabel}</dd></div>
                  <div><dt>{t("detail.inspector.category")}</dt><dd>{getComponentCategoryLabel(component.category, t)}</dd></div>
                </dl>
              </section>
              <section>
                <h2>{t("detail.inspector.supportedStates")}</h2>
                <div className="component-inspector-chip-list">
                  {component.states.map((state) => <span key={state}>{state}</span>)}
                </div>
              </section>
            </div>
          )}

          {inspectorTab === "tokens" && (
            <div className="component-inspector-content" role="tabpanel">
              <section>
                <h2>{t("detail.ownedTokens")}</h2>
                <div className="component-inspector-token-list">
                  {component.tokens.map((token) => <code key={token}>{token}</code>)}
                </div>
                <button className="component-inspector-action" onClick={() => onInspectTokens(component.name)} type="button">
                  {t("detail.openWorkbench")}
                </button>
              </section>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
