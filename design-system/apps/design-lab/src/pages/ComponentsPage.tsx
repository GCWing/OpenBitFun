import { useEffect, useRef, useState } from "react";
import { ComponentDetailPage } from "./ComponentDetailPage";
import { BrandPreview } from "../preview/BrandPreview";
import { AppWindow, Heading, Keyboard, List, Rows3, MousePointerClick, PanelTop, ToggleLeft } from "lucide-react";
import { VoiceCallPreview, VoiceParticlePreview } from "../components/VoiceCallPreview";
import {
  ActionCard,
  ActionItem,
  ActivityItem,
  Alert,
  Avatar,
  AvatarGroup,
  Button,
  OverflowText,
  Card,
  CardHeader,
  ChangeCount,
  Checkbox,
  Combobox,
  Composer,
  ComposerToolbar,
  Disclosure,
  Empty,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon as CatalogIcon,
  IconButton,
  Input,
  KeyHint,
  LauncherButton,
  Listbox,
  ListboxOption,
  LoadingState,
  Menu,
  MenuItem,
  MenuSection,
  MultiSelect,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelFooter,
  NavigationPanelItem,
  NavigationPanelSection,
  NumberInput,
  NumberBadge,
  PageHeader,
  Radio,
  ScrollArea,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
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
  type ContrastMode,
  type DensityMode,
  type TokenOverrides,
} from "@openbitfun/ui";
import {
  MobileBadge,
  MobileBanner,
  MobileButton,
  MobileCard,
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
  MobileStatus,
  MobileTextField,
  MobileTextarea,
} from "@openbitfun/ui/mobile";
import { componentRegistry, type ComponentMeta } from "@openbitfun/ui/registry";
import { useI18n } from "../i18n";
import {
  getComponentCategoryLabel,
  getComponentDescription,
} from "../i18n/componentMetadata";
import {
  FlowChatComponentPreview,
  getFlowChatPreviewDefinition,
} from "../preview/FlowChatPreviewRegistry";
import { FlowChatToolGallery } from "../preview/FlowChatToolGallery";
import { RollingTextPreview } from "../preview/RollingTextPreview";

interface ComponentsPageProps {
  category?: ComponentMeta["category"];
  colorScheme: ColorScheme;
  component?: ComponentMeta;
  contrast: ContrastMode;
  density: DensityMode;
  onInspectTokens: (name?: string) => void;
  onOpenComponent: (name: string) => void;
  tokenOverrides: TokenOverrides;
}

const componentIcons = {
  ActionCard: <MousePointerClick aria-hidden="true" size={19} />,
  ActionItem: <List aria-hidden="true" size={19} />,
  ActivityItem: <CatalogIcon name="terminal" style={{ width: 19, height: 19 }} />,
  Button: <MousePointerClick aria-hidden="true" size={19} />,
  Card: <Rows3 aria-hidden="true" size={19} />,
  Combobox: <CatalogIcon name="search" style={{ width: 19, height: 19 }} />,
  Composer: <CatalogIcon name="arrow-up" style={{ width: 19, height: 19 }} />,
  Field: <Rows3 aria-hidden="true" size={19} />,
  Icon: <CatalogIcon name="search" style={{ width: 19, height: 19 }} />,
  IconButton: <List aria-hidden="true" size={19} />,
  Input: <CatalogIcon name="eye" style={{ width: 19, height: 19 }} />,
  KeyHint: <Keyboard aria-hidden="true" size={19} />,
  LauncherButton: <CatalogIcon name="mic" style={{ width: 19, height: 19 }} />,
  Listbox: <List aria-hidden="true" size={19} />,
  LoadingState: <AppWindow aria-hidden="true" size={19} />,
  Menu: <List aria-hidden="true" size={19} />,
  MobileActionSheet: <List aria-hidden="true" size={19} />,
  MobileBadge: <CatalogIcon name="check-line" style={{ width: 19, height: 19 }} />,
  MobileBanner: <AppWindow aria-hidden="true" size={19} />,
  MobileButton: <MousePointerClick aria-hidden="true" size={19} />,
  MobileCard: <Rows3 aria-hidden="true" size={19} />,
  MobileChoiceSheet: <List aria-hidden="true" size={19} />,
  MobileConfirmSheet: <AppWindow aria-hidden="true" size={19} />,
  MobileComposer: <CatalogIcon name="arrow-up" style={{ width: 19, height: 19 }} />,
  MobileDisclosure: <CatalogIcon name="chevron-right" style={{ width: 19, height: 19 }} />,
  MobileFileButton: <CatalogIcon name="plus" style={{ width: 19, height: 19 }} />,
  MobileFloatingActions: <PanelTop aria-hidden="true" size={19} />,
  MobileIconButton: <MousePointerClick aria-hidden="true" size={19} />,
  MobileLink: <CatalogIcon name="link" style={{ width: 19, height: 19 }} />,
  MobileListRow: <Rows3 aria-hidden="true" size={19} />,
  MobileMessage: <CatalogIcon name="session" style={{ width: 19, height: 19 }} />,
  MobilePageHeader: <Heading aria-hidden="true" size={19} />,
  MobileScrim: <AppWindow aria-hidden="true" size={19} />,
  MobileSection: <Rows3 aria-hidden="true" size={19} />,
  MobileSegmentedControl: <ToggleLeft aria-hidden="true" size={19} />,
  MobileSheet: <AppWindow aria-hidden="true" size={19} />,
  MobileStatus: <AppWindow aria-hidden="true" size={19} />,
  MobileTextField: <CatalogIcon name="search" style={{ width: 19, height: 19 }} />,
  MobileTextarea: <CatalogIcon name="arrow-up" style={{ width: 19, height: 19 }} />,
  Dialog: <AppWindow aria-hidden="true" size={19} />,
  Sheet: <AppWindow aria-hidden="true" size={19} />,
  MultiSelect: <List aria-hidden="true" size={19} />,
  NavigationPanel: <CatalogIcon name="sidebar-left" style={{ width: 19, height: 19 }} />,
  PageHeader: <Heading aria-hidden="true" size={19} />,
  ScrollArea: <Rows3 aria-hidden="true" size={19} />,
  SearchField: <CatalogIcon name="search" style={{ width: 19, height: 19 }} />,
  SegmentedControl: <ToggleLeft aria-hidden="true" size={19} />,
  Select: <List aria-hidden="true" size={19} />,
  Spinner: <AppWindow aria-hidden="true" size={19} />,
  StatusPill: <CatalogIcon name="check-line" style={{ width: 19, height: 19 }} />,
  Switch: <ToggleLeft aria-hidden="true" size={19} />,
  Disclosure: <CatalogIcon name="chevron-right" style={{ width: 19, height: 19 }} />,
  TabGroup: <PanelTop aria-hidden="true" size={19} />,
  Toolbar: <PanelTop aria-hidden="true" size={19} />,
  Tooltip: <CatalogIcon name="session" style={{ width: 19, height: 19 }} />,
} as const;

export function ComponentCardPreview({ component }: { component: ComponentMeta }) {
  const { t } = useI18n();
  if (component.category === "brand") return <BrandPreview name={component.name} active={false} />;
  if (component.name === "VoiceCallPanel") return <VoiceCallPreview compact />;
  if (component.name === "VoiceParticleLogo") return <VoiceParticlePreview />;
  if (component.name === "Combobox") return <Combobox label={t("components.preview.modalProviderName")} defaultValue="openbitfun" options={[{ value: "openbitfun", label: "OpenBitFun" }, { value: "custom", label: t("components.preview.add") }]} />;
  const flowChatPreview = getFlowChatPreviewDefinition(component.name);

  if (flowChatPreview) {
    return (
      <FlowChatComponentPreview
        componentName={component.name}
        interactive={false}
      />
    );
  }

  switch (component.name) {
    case "ActionCard":
      return (
        <ActionCard
          className="component-action-card-card-preview"
          description={t("components.preview.actionCardDescription")}
          leading={<CatalogIcon name="session" aria-hidden="true" />}
          tabIndex={-1}
        >
          {t("components.preview.actionCardTitle")}
        </ActionCard>
      );
    case "ActionItem":
      return (
        <ActionItem
          leading={<CatalogIcon name="session" aria-hidden="true" />}
          shortcut={<KeyHint>K</KeyHint>}
        >
          {t("components.preview.assistant")}
        </ActionItem>
      );
    case "ActivityItem":
      return (
        <ActivityItem
          appearance="surface"
          className="component-activity-item-card-preview"
          label={t("components.preview.activityAction")}
          leading={<CatalogIcon name="terminal" aria-hidden="true" />}
          metadata={<ChangeCount additions={6} deletions={0} />}
        >
          {t("components.preview.activityDescription")}
        </ActivityItem>
      );
    case "Button":
      return (
        <Stack align="center" direction="horizontal" gap="2" wrap>
          <Button variant="primary">{t("components.preview.primary")}</Button>
          <Button>{t("components.preview.button")}</Button>
        </Stack>
      );
    case "Card":
      return (
        <Card
          appearance="subtle"
          className="component-card-card-preview"
          gap="sm"
          padding="sm"
          radius="sm"
        >
          <CardHeader
            align="center"
            description={t("components.preview.cardDescription")}
            leading={<CatalogIcon name="command-mac" size="lg" aria-hidden="true" />}
            title={t("components.preview.cardTitle")}
          />
        </Card>
      );
    case "Field":
      return (
        <Field
          description={t("components.preview.fieldDescription")}
          label={t("components.preview.notifications")}
          orientation="horizontal"
        >
          <Switch tabIndex={-1} />
        </Field>
      );
    case "NumberBadge":
      return <NumberBadge value={18} />;
    case "Icon":
      return (
        <Stack align="center" direction="horizontal" gap="3">
          <CatalogIcon name="search" tone="primary" />
          <CatalogIcon name="folder" tone="secondary" />
          <CatalogIcon name="check-circle" tone="success" />
        </Stack>
      );
    case "IconButton":
      return (
        <Stack align="center" direction="horizontal" gap="2">
          <IconButton
            aria-label={t("components.preview.listView")}
            icon={<List aria-hidden="true" />}
            tabIndex={-1}
          />
          <IconButton
            aria-label={t("components.preview.listView")}
            icon={<List aria-hidden="true" />}
            tabIndex={-1}
            variant="fill"
          />
        </Stack>
      );
    case "MobileIconButton":
      return (
        <MobileIconButton
          appearance="floating"
          aria-label={t("components.preview.searchLabel")}
          icon={<CatalogIcon name="search" aria-hidden="true" />}
          tabIndex={-1}
        />
      );
    case "MobileLink":
      return <MobileLink href="#mobile" tabIndex={-1}>{t("nav.docs")}</MobileLink>;
    case "MobileButton":
      return <MobileButton size="sm" tabIndex={-1}>{t("components.preview.actionCardTitle")}</MobileButton>;
    case "MobileCard":
      return <MobileCard appearance="elevated">{t("components.preview.cardDescription")}</MobileCard>;
    case "MobileBadge":
      return <MobileBadge dot tone="success">{t("components.preview.notifications")}</MobileBadge>;
    case "MobileBanner":
      return <MobileBanner tone="info">{t("components.preview.fieldDescription")}</MobileBanner>;
    case "MobileComposer":
      return (
        <MobileComposer
          aria-label={t("components.preview.composerPlaceholder")}
          endActions={<MobileIconButton appearance="plain" aria-label={t("components.preview.flowChat.askUserSubmit")} icon={<CatalogIcon name="arrow-up" aria-hidden="true" />} size="sm" tabIndex={-1} />}
          leading={<MobileIconButton appearance="plain" aria-label={t("components.preview.add")} icon={<CatalogIcon name="plus" aria-hidden="true" />} size="sm" tabIndex={-1} />}
        >
          <span>{t("components.preview.composerPlaceholder")}</span>
        </MobileComposer>
      );
    case "MobileDisclosure":
      return <MobileDisclosure onToggle={() => undefined} open title={t("detail.loading")}>{t("components.preview.fieldDescription")}</MobileDisclosure>;
    case "MobileFileButton":
      return <MobileFileButton leading={<CatalogIcon name="plus" aria-hidden="true" />} tabIndex={-1}>{t("components.preview.add")}</MobileFileButton>;
    case "MobileFloatingActions":
      return (
        <MobileFloatingActions
          leading={<MobileIconButton appearance="floating" aria-label={t("components.preview.add")} icon={<CatalogIcon name="plus" aria-hidden="true" />} tabIndex={-1} />}
          trailing={<MobileIconButton appearance="floating" aria-label={t("components.preview.settings")} icon={<CatalogIcon name="gear" aria-hidden="true" />} tabIndex={-1} />}
        />
      );
    case "MobileTextField":
      return (
        <MobileTextField
          aria-label={t("components.preview.searchLabel")}
          leading={<CatalogIcon name="search" aria-hidden="true" />}
          placeholder={t("components.preview.searchPlaceholder")}
          tabIndex={-1}
        />
      );
    case "MobileListRow":
      return (
        <MobileListRow
          appearance="surface"
          label={t("components.preview.session")}
          leading={<CatalogIcon name="session" aria-hidden="true" />}
          supportingText={t("components.preview.fieldDescription")}
          tabIndex={-1}
          trailing={<CatalogIcon name="chevron-right" aria-hidden="true" />}
        />
      );
    case "MobileMessage":
      return <MobileMessage roleType="user">{t("components.preview.cardDescription")}</MobileMessage>;
    case "MobilePageHeader":
      return <MobilePageHeader centered title={t("components.preview.session")} />;
    case "MobileScrim":
      return <MobileScrim aria-label={t("components.preview.close")} style={{ blockSize: 64, inlineSize: "100%", position: "relative" }} tabIndex={-1} />;
    case "MobileSection":
      return <MobileSection title={t("components.preview.appearance")}>{t("components.preview.fieldDescription")}</MobileSection>;
    case "MobileSegmentedControl":
      return <MobileSegmentedControl aria-label={t("components.preview.segmentedLabel")} onChange={() => undefined} options={[{ label: t("components.preview.segmentedChat"), value: "chat" }, { label: t("components.preview.segmentedAgent"), value: "agent" }]} value="chat" />;
    case "MobileStatus":
      return <MobileStatus description={t("components.preview.fieldDescription")} title={t("components.preview.cardTitle")} />;
    case "MobileTextarea":
      return <MobileTextarea aria-label={t("components.preview.composerPlaceholder")} placeholder={t("components.preview.composerPlaceholder")} readOnly />;
    case "Input":
      return (
        <Input
          aria-label={t("components.preview.inputLabel")}
          placeholder={t("components.preview.inputPlaceholder")}
          trailing={<CatalogIcon name="eye" aria-hidden="true" />}
        />
      );
    case "KeyHint":
      return <KeyHint icon={<CatalogIcon name="command-mac" size="lg" aria-hidden="true" />}>K</KeyHint>;
    case "LauncherButton":
      return (
        <LauncherButton
          leadingIcon={<CatalogIcon name="mic" aria-hidden="true" />}
          tabIndex={-1}
        >
          Hello
        </LauncherButton>
      );
    case "Listbox":
      return (
        <Listbox aria-label={t("components.preview.appearance")}>
          <ListboxOption selected value="ask">Ask</ListboxOption>
          <ListboxOption value="plan">Plan</ListboxOption>
        </Listbox>
      );
    case "Menu":
      return (
        <Menu aria-label={t("components.preview.menuLabel")} scrollbarVisibility="hidden">
          <MenuSection title={t("components.preview.menuSectionTitle")}>
            <MenuItem leading={<CatalogIcon name="session" aria-hidden="true" />} tabIndex={-1}>
              {t("components.preview.menuItemOne")}
            </MenuItem>
            <MenuItem leading={<CatalogIcon name="session" aria-hidden="true" />} tabIndex={-1}>
              {t("components.preview.menuItemTwo")}
            </MenuItem>
          </MenuSection>
        </Menu>
      );
    case "FieldGroup":
      return (
        <FormSection
          headingAs="h3"
          leading={<CatalogIcon name="gear" size="lg" aria-hidden="true" />}
          title={t("components.preview.modalSectionTitle")}
        >
          <FieldGroup>
            <FieldRow>
              <Field controlWidth="fill" label={t("components.preview.modalProviderName")} labelWidth="sm" orientation="horizontal">
                <Input defaultValue="OpenBitFun" readOnly />
              </Field>
            </FieldRow>
          </FieldGroup>
        </FormSection>
      );
    case "ConfirmDialog":
      return (
        <Button leadingIcon={<AppWindow aria-hidden="true" />} size="sm" variant="fill">
          {t("components.preview.confirmDelete")}
        </Button>
      );
    case "Alert":
      return (
        <Alert
          message={t("components.preview.fieldDescription")}
          title={t("components.preview.notifications")}
          tone="info"
        />
      );
    case "Avatar":
      return (
        <AvatarGroup maxCount={3}>
          <Avatar>BF</Avatar>
          <Avatar>UI</Avatar>
          <Avatar>DS</Avatar>
          <Avatar>+1</Avatar>
        </AvatarGroup>
      );
    case "Checkbox":
      return (
        <Checkbox
          defaultChecked
          description={t("components.preview.fieldDescription")}
          label={t("components.preview.notifications")}
          tabIndex={-1}
        />
      );
    case "Combobox":
      return (
        <Combobox
          options={[
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
          ]}
          aria-label={t("components.preview.appearance")}
          value="ask"
        />
      );
    case "MultiSelect":
      return (
        <MultiSelect
          aria-label={t("components.preview.appearance")}
          options={[
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
          ]}
          value={["ask", "plan"]}
        />
      );
    case "NumberInput":
      return <NumberInput onValueChange={() => undefined} value={8} />;
    case "Radio":
      return (
        <Radio
          defaultChecked
          description={t("components.preview.fieldDescription")}
          label={t("components.preview.fieldValue")}
          name="component-preview-radio"
          tabIndex={-1}
        />
      );
    case "Textarea":
      return (
        <Textarea
          aria-label={t("components.preview.inputLabel")}
          defaultValue={t("components.preview.fieldValue")}
          showCount
        />
      );
    case "Disclosure":
      return (
        <Disclosure defaultOpen summary={t("components.preview.appearance")}>
          <span>{t("components.preview.appearanceDescription")}</span>
        </Disclosure>
      );
    case "Empty":
      return (
        <Empty
          description={t("components.preview.cardDescription")}
          title={t("components.preview.cardTitle")}
        />
      );
    case "Composer":
      return (
        <Composer
          aria-label={t("components.preview.composerLabel")}
          className="component-composer-card-preview"
          toolbar={(
            <ComposerToolbar
              leading={(
                <IconButton
                  aria-label={t("components.preview.composerAdd")}
                  icon={<CatalogIcon name="plus" size="lg" aria-hidden="true" />}
                  size="sm"
                  tabIndex={-1}
                  variant="fill"
                />
              )}
              trailing={(
                <IconButton
                  aria-label={t("components.preview.composerSend")}
                  icon={<CatalogIcon name="arrow-up" aria-hidden="true" />}
                  size="sm"
                  tabIndex={-1}
                  variant="primary"
                />
              )}
            />
          )}
        >
          <span className="component-composer-placeholder">
            {t("components.preview.composerPlaceholder")}
          </span>
        </Composer>
      );
    case "MobileActionSheet":
    case "MobileChoiceSheet":
    case "MobileConfirmSheet":
    case "MobileSheet":
    case "Dialog":
    case "Sheet":
      return (
        <Button
          leadingIcon={<AppWindow aria-hidden="true" />}
          size="sm"
          tabIndex={-1}
        >
          {t("components.preview.openDialog")}
        </Button>
      );
    case "LoadingState":
      return <LoadingState>{t("detail.loading")}</LoadingState>;
    case "Spinner":
      return <Spinner aria-label={t("detail.loading")} size="sm" />;
    case "PageHeader":
      return (
        <PageHeader
          description={t("components.preview.appearanceDescription")}
          leading={<Heading aria-hidden="true" />}
          level={2}
          size="sm"
          title={t("components.preview.appearance")}
        />
      );
    case "NavigationPanel":
      return (
        <NavigationPanel
          aria-label={t("components.preview.navigationPanelLabel")}
          className="component-navigation-panel-card-preview"
        >
          <NavigationPanelBody scrollbarVisibility="hidden">
            <NavigationPanelContent>
              <NavigationPanelSection title={t("components.preview.navigationPanelSectionTitle")}>
                <NavigationPanelItem leading={<CatalogIcon name="session" aria-hidden="true" />} selected tabIndex={-1}>
                  {t("components.preview.menuItemOne")}
                </NavigationPanelItem>
                <NavigationPanelItem reserveLeadingSpace tabIndex={-1}>
                  {t("components.preview.menuItemTwo")}
                </NavigationPanelItem>
              </NavigationPanelSection>
            </NavigationPanelContent>
          </NavigationPanelBody>
          <NavigationPanelFooter>
            <span>{t("components.preview.navigationPanelDevice")}</span>
          </NavigationPanelFooter>
        </NavigationPanel>
      );
    case "ScrollArea":
      return (
        <ScrollArea
          aria-label={t("components.preview.scrollAreaLabel")}
          className="component-scroll-area-card-preview"
          edgeFade="vertical"
        >
          <div className="component-scroll-area-example__content">
            {Array.from({ length: 5 }, (_, index) => (
              <span className="component-scroll-area-example__item" key={index}>
                {t("components.preview.scrollAreaItem", { index: index + 1 })}
              </span>
            ))}
          </div>
        </ScrollArea>
      );
    case "SearchField":
      return (
        <SearchField
          aria-label={t("components.preview.searchLabel")}
          leadingIcon={<CatalogIcon name="search" aria-hidden="true" />}
          placeholder={t("components.preview.searchPlaceholder")}
          shortcut={<KeyHint icon={<CatalogIcon name="command-mac" size="lg" aria-hidden="true" />}>K</KeyHint>}
        />
      );
    case "StatusPill":
      return (
        <StatusPill leading={<CatalogIcon name="unselected" />}>
          Ask
        </StatusPill>
      );
    case "Select":
      return (
        <Select
          aria-label={t("components.preview.appearance")}
          options={[
            { label: "Ask", value: "ask" },
            { label: "Plan", value: "plan" },
          ]}
          value="ask"
        />
      );
    case "SegmentedControl":
      return (
        <SegmentedControl
          aria-label={t("components.preview.segmentedLabel")}
          defaultValue="chat"
          options={[
            {
              icon: <CatalogIcon name="session" aria-hidden="true" />,
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
    case "Switch":
      return (
        <Stack align="center" direction="horizontal" gap="3">
          <Switch
            aria-label={t("components.preview.notifications")}
            tabIndex={-1}
          />
          <Switch
            aria-label={t("components.preview.notifications")}
            defaultChecked
            tabIndex={-1}
          />
        </Stack>
      );
    case "RollingText":
      return <RollingTextPreview />;
    case "TabGroup":
      return (
        <TabGroup
          aria-label={t("components.preview.tabGroupLabel")}
          defaultValue="welcome"
          items={[
            {
              icon: <CatalogIcon name="session" aria-hidden="true" />,
              label: t("components.preview.welcome"),
              value: "welcome",
            },
            {
              icon: <CatalogIcon name="session" aria-hidden="true" />,
              label: t("components.preview.settings"),
              value: "settings",
            },
          ]}
        />
      );
    case "Toolbar":
      return (
        <Toolbar
          aria-label={t("components.preview.tabGroupLabel")}
          center={(
            <ToolbarGroup>
              <ToolbarBadge>18</ToolbarBadge>
              <strong>{t("components.preview.session")}</strong>
            </ToolbarGroup>
          )}
          className="component-toolbar-card-preview"
          leading={(
            <Button size="xs" tabIndex={-1} trailingIcon={<CatalogIcon name="arrow-right" size="lg" aria-hidden="true" />} variant="text">
              {t("components.preview.welcome")}
            </Button>
          )}
          trailing={(
            <ToolbarGroup>
              <ToolbarSeparator />
              <IconButton
                aria-label={t("components.preview.searchLabel")}
                icon={<CatalogIcon name="search" aria-hidden="true" />}
                size="xs"
                tabIndex={-1}
              />
            </ToolbarGroup>
          )}
        />
      );
    case "Tooltip":
      return (
        <Tooltip content={t("components.preview.tooltipContent")} delay={0}>
          <Button size="sm" tabIndex={-1} variant="fill">
            {t("components.preview.tooltipTrigger")}
          </Button>
        </Tooltip>
      );
    default:
      return null;
  }
}

export function ComponentsPage({
  category,
  colorScheme,
  component,
  contrast,
  density,
  onInspectTokens,
  onOpenComponent,
  tokenOverrides,
}: ComponentsPageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [toolReferenceOpen, setToolReferenceOpen] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const activeLinkRef = useRef<HTMLAnchorElement>(null);
  const selectedComponent = component
    ?? componentRegistry.find(item => category ? item.category === category : item.name === "Button")
    ?? componentRegistry[0];
  const categories = Array.from(new Set(componentRegistry.map(component => component.category)));
  const normalizedQuery = query.trim().toLowerCase();
  const catalogComponents = componentRegistry.filter(component =>
    `${component.name} ${component.category} ${component.description} ${getComponentDescription(component.name, component.description, t)} ${getComponentCategoryLabel(component.category, t)}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    const list = listRef.current;
    const activeLink = activeLinkRef.current;
    if (!list) return;
    if (!activeLink) {
      list.scrollTop = 0;
      return;
    }
    // Keep selection visible inside the directory without scrolling the preview.
    const listBounds = list.getBoundingClientRect();
    const linkBounds = activeLink.getBoundingClientRect();
    if (linkBounds.top < listBounds.top) list.scrollTop += linkBounds.top - listBounds.top;
    else if (linkBounds.bottom > listBounds.bottom) list.scrollTop += linkBounds.bottom - listBounds.bottom;
  }, [selectedComponent?.name, normalizedQuery, catalogOpen]);

  return (
    <main className="lab-page design-component-library" id="components">
      <aside className="design-library-sidebar" aria-labelledby="component-library-title" data-open={catalogOpen || undefined}>
        <div className="design-library-heading">
          <h2 id="component-library-title">{t("design.components")}</h2>
          <span className="design-library-count" role="status">{t("design.results", { count: catalogComponents.length })}</span>
          <IconButton className="design-library-toggle" aria-controls="component-library-index" aria-expanded={catalogOpen}
            aria-label={t("design.browseComponents")} onClick={() => setCatalogOpen(open => !open)}
            icon={<CatalogIcon name={catalogOpen ? "chevron-up" : "chevron-down"} />} />
        </div>
        <div className="design-library-index" id="component-library-index">
          <SearchField aria-label={t("design.search")} placeholder={t("design.search")} value={query}
            onChange={event => setQuery(event.target.value)} clearLabel={t("design.clear")} onClear={() => setQuery("")}
            leadingIcon={<CatalogIcon name="search" />} />
          <nav className="design-library-list" aria-label={t("design.all")} ref={listRef}>
            {categories.map(group => {
              const items = catalogComponents.filter(item => item.category === group).sort((a, b) => a.name.localeCompare(b.name));
              if (!items.length) return null;
              return (
                <section className="design-library-group" key={group} aria-labelledby={`component-group-${group}`}>
                  <h3 id={`component-group-${group}`}>{getComponentCategoryLabel(group, t)}</h3>
                  <ul>
                    {items.map(item => (
                      <li key={item.name}>
                        <a data-overflow-trigger className="design-library-link" href={`#component/${item.name.toLowerCase()}`}
                          aria-current={selectedComponent?.name === item.name ? "page" : undefined}
                          ref={selectedComponent?.name === item.name ? activeLinkRef : undefined}
                          title={`${item.name} · ${getComponentDescription(item.name, item.description, t)}`}
                          onClick={event => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                            event.preventDefault();
                            setCatalogOpen(false);
                            onOpenComponent(item.name);
                          }}>
                          <OverflowText>{item.name}</OverflowText>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {catalogComponents.length === 0 && <div className="design-library-empty"><p>{t("design.noResults")}</p><Button size="sm" variant="text" onClick={() => setQuery("")}>{t("design.clear")}</Button></div>}
          </nav>
          <footer className="design-library-footer">
            <a href="#patterns">{t("design.contexts")}<CatalogIcon name="arrow-right" size="sm" /></a>
            <a href="#flow-chat-mock">{t("design.conversation")}<CatalogIcon name="arrow-right" size="sm" /></a>
          </footer>
        </div>
      </aside>
      {selectedComponent && (
        <div className="design-library-content">
          <ComponentDetailPage key={selectedComponent.name} embedded component={selectedComponent}
            colorScheme={colorScheme} contrast={contrast} density={density}
            onInspectTokens={onInspectTokens} tokenOverrides={tokenOverrides} />
          {selectedComponent.category === "flow-chat" && (
            <details className="design-tool-reference" onToggle={event => setToolReferenceOpen(event.currentTarget.open)}>
              <summary>{t("components.flowChat.templatesTitle")}</summary>
              {toolReferenceOpen && <ThemeRoot colorScheme={colorScheme} contrast={contrast} density={density} tokenOverrides={tokenOverrides}>
                <FlowChatToolGallery onOpenComponent={onOpenComponent} />
              </ThemeRoot>}
            </details>
          )}
          <div className="design-directory-footer">
            <Button onClick={() => onInspectTokens(selectedComponent.name)} trailingIcon={<CatalogIcon name="arrow-right" size="sm" />}>{t("design.tokens")}</Button>
          </div>
        </div>
      )}
    </main>
  );
}
