import type { ComponentMeta } from "@openbitfun/ui/registry";

export type ComponentPresentation =
  | "matrix" | "compact" | "fields" | "cards" | "stack" | "icons"
  | "interactive" | "composition" | "conversation" | "motion" | "brand";

// These are website presentation choices. The public registry still owns the
// component inventory, properties and supported states.
const presentations: Record<string, ComponentPresentation> = {
  Button: "matrix", IconButton: "matrix",
  Avatar: "compact", Checkbox: "compact", Radio: "compact", Switch: "compact",
  StatusPill: "compact", Spinner: "compact", LoadingState: "compact",
  LauncherButton: "compact", NumberBadge: "compact", KeyHint: "compact",
  Input: "fields", SearchField: "fields", Textarea: "fields", NumberInput: "fields", Field: "fields",
  Card: "cards", ActionCard: "cards", Empty: "cards",
  Alert: "stack", ActivityItem: "stack", ActionItem: "stack", FieldGroup: "stack", Toolbar: "stack",
  Dialog: "interactive", ConfirmDialog: "interactive", Sheet: "interactive",
  Combobox: "interactive", MultiSelect: "interactive", Select: "interactive", Tooltip: "interactive",
  Disclosure: "composition", Composer: "composition", Listbox: "composition", Menu: "composition",
  NavigationPanel: "composition", PageHeader: "composition", ScrollArea: "composition", SplitView: "composition",
  SegmentedControl: "composition", TabGroup: "composition",
  Icon: "icons", RollingText: "motion", ShimmerText: "motion", VoiceCallPanel: "motion",
  ThinkingIndicator: "motion",
  MobileBadge: "compact", MobileButton: "compact", MobileIconButton: "compact",
  MobileFileButton: "compact", MobileLink: "compact",
  MobileTextField: "fields", MobileTextarea: "fields",
  MobileCard: "cards", MobileStatus: "cards",
  MobileBanner: "stack", MobilePageHeader: "stack", MobileSection: "stack", MobileListRow: "stack",
  MobileActionSheet: "interactive", MobileChoiceSheet: "interactive",
  MobileConfirmSheet: "interactive", MobileSheet: "interactive",
  MobileDisclosure: "composition", MobileComposer: "composition", MobileFloatingActions: "composition",
  MobileMessage: "composition", MobileScrim: "composition", MobileSegmentedControl: "composition",
};

const initialStates: Record<string, string> = {
  Card: "raised", Disclosure: "open", Composer: "with-context", Switch: "off",
  StatusPill: "success", Toolbar: "with-center", TabGroup: "selected", SegmentedControl: "selected",
  Listbox: "selected-option", NavigationPanel: "selected-item", ScrollArea: "auto",
  RollingText: "replacing", VoiceCallPanel: "live", MobileDisclosure: "open",
  MobileComposer: "expanded", MobileMessage: "assistant", MobilePageHeader: "with-subtitle",
};

export function getComponentPresentation(component: Pick<ComponentMeta, "name" | "category">): ComponentPresentation {
  if (component.category === "flow-chat") return "conversation";
  if (component.category === "brand") return "brand";
  return presentations[component.name] ?? "composition";
}

export function hasComponentOverview(presentation: ComponentPresentation) {
  return ["matrix", "compact", "fields", "cards", "stack", "icons"].includes(presentation);
}

export function getInitialPreviewState(component: ComponentMeta) {
  const preferred = initialStates[component.name];
  return preferred && component.states.includes(preferred) ? preferred : component.states[0] ?? "default";
}

export function hasAuthoredPresentation(component: ComponentMeta) {
  return component.category === "flow-chat" || component.category === "brand" || component.name in presentations;
}

export function getOverviewStates(component: ComponentMeta) {
  // These mobile controls expose real pointer/focus interactions, without a
  // forced preview-state API. Compare distinct properties; try pointer states
  // on the live instance instead of showing identical specimens with new labels.
  const liveInteractionOnly = ["MobileButton", "MobileFileButton", "MobileLink", "MobileTextField", "MobileTextarea", "MobilePageHeader", "MobileSection"];
  return liveInteractionOnly.includes(component.name)
    ? component.states.filter(state => !["hover", "active", "focus-visible", "focus-within"].includes(state))
    : component.states;
}
