import { useMemo, useState, type ReactNode } from "react";
import {
  ActionCard,
  ActivityItem,
  Button,
  Card,
  CardBody,
  CardHeader,
  Disclosure,
  Field,
  FieldGroup,
  FieldRow,
  FormSection,
  Icon,
  IconButton,
  KeyHint,
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelFooter,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
  PageHeader,
  SearchField,
  ScrollArea,
  TabGroup,
  SegmentedControl,
  Select,
  StatusPill,
  Switch,
  ThemeRoot,
  type ColorScheme,
  type ContrastMode,
  type DensityMode,
  type IconName,
  type TokenOverrides,
} from "@openbitfun/ui";
import { useI18n, type MessageKey } from "../i18n";
import { FileActivityPattern, IndicatorsPattern, FormTypographyPattern, NestedMenuPattern, ProviderConfigurationPattern, SceneToolbarPattern, WorkspaceConfigurationPattern } from "./ReferencePatterns";

interface PatternsPageProps {
  colorScheme: ColorScheme;
  contrast: ContrastMode;
  density: DensityMode;
  tokenOverrides: TokenOverrides;
}

const quickActions: readonly {
  description: MessageKey;
  icon: IconName;
  title: MessageKey;
}[] = [
  { description: "patterns.actions.newProjectDescription", icon: "plus", title: "patterns.actions.newProject" },
  { description: "patterns.actions.openFilesDescription", icon: "files", title: "patterns.actions.openFiles" },
  { description: "patterns.actions.openBrowserDescription", icon: "browser", title: "patterns.actions.openBrowser" },
  { description: "patterns.actions.openTerminalDescription", icon: "terminal", title: "patterns.actions.openTerminal" },
];

export function PatternsPage({ colorScheme, contrast, density, tokenOverrides }: PatternsPageProps) {
  const { t } = useI18n();
  const [pattern, setPattern] = useState("settings");
  const [appearance, setAppearance] = useState("system");
  const [fontSize, setFontSize] = useState("medium");
  const [language, setLanguage] = useState("zh-CN");
  const [pointerGlow, setPointerGlow] = useState(true);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const visibleActions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return quickActions;
    return quickActions.filter((action) => (
      `${t(action.title)} ${t(action.description)}`.toLowerCase().includes(normalized)
    ));
  }, [query, t]);

  return (
    <ThemeRoot className="patterns-theme-host" colorScheme={colorScheme} contrast={contrast} density={density} tokenOverrides={tokenOverrides}>
      <main className="lab-page lab-page--patterns" id="patterns">
        <header className="page-heading">
          <h1>{t("patterns.title")}</h1>
        </header>

        <TabGroup className="pattern-navigation" aria-label={t("patterns.title")} value={pattern} onValueChange={setPattern}
          items={(["settings", "navigation", "search", "device", "provider", "toolbar", "menu"] as const).map(value => ({
            value, label: t(`patterns.${value}.title`), id: `pattern-tab-${value}`, panelId: `pattern-${value}`,
          }))} />

        <PatternSection description={t("patterns.settings.description")} id="settings" active={pattern === "settings"} title={t("patterns.settings.title")}>
          <Card appearance="raised" className="pattern-settings" data-openbitfun-pattern="settings-form" padding="md" radius="md">
            <PageHeader description={t("components.preview.appearanceDescription")} level={3} size="md" title={t("components.preview.appearance")} />
            <CardBody>
              <FormSection description={t("patterns.settings.description")} headingAs="h4" title={t("components.preview.appearance")}>
                <FieldGroup appearance="subtle" dividers>
                  <FieldRow>
                    <Field controlWidth="fill" description={t("patterns.settings.languageDescription")} label={t("patterns.settings.language")} labelWidth="md" orientation="horizontal">
                      <Select onValueChange={(value) => setLanguage(String(value))} options={[{ label: "简体中文", value: "zh-CN" }, { label: "English", value: "en-US" }, { label: "繁體中文", value: "zh-TW" }]} value={language} />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field controlWidth="fill" description={t("patterns.settings.themeDescription")} label={t("patterns.settings.theme")} labelWidth="md" orientation="horizontal">
                      <SegmentedControl size="md" onValueChange={setAppearance} options={[{ label: t("patterns.settings.system"), value: "system" }, { label: t("settings.light"), value: "light" }, { label: t("settings.dark"), value: "dark" }]} value={appearance} />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field description={t("patterns.settings.pointerDescription")} label={t("patterns.settings.pointer")} labelWidth="md" orientation="horizontal">
                      <Switch aria-label={t("patterns.settings.pointer")} checked={pointerGlow} onCheckedChange={setPointerGlow} />
                    </Field>
                  </FieldRow>
                </FieldGroup>
              </FormSection>
              <FormSection title={t("patterns.settings.fontSize")}>
                <FieldGroup appearance="subtle">
                  <FieldRow>
                    <Field controlWidth="fill" description={t("patterns.settings.fontSizeDescription")} label={t("patterns.settings.fontSize")} labelWidth="md" orientation="horizontal">
                      <SegmentedControl size="md" onValueChange={setFontSize} options={[{ label: t("settings.compact"), value: "small" }, { label: t("settings.comfortable"), value: "medium" }, { label: t("settings.touch"), value: "large" }]} value={fontSize} />
                    </Field>
                  </FieldRow>
                </FieldGroup>
              </FormSection>
            </CardBody>
          </Card>
        <Disclosure summary={t("design.type")}> <FormTypographyPattern /> </Disclosure>
        </PatternSection>


        <PatternSection description={t("patterns.navigation.description")} id="navigation" active={pattern === "navigation"} title={t("patterns.navigation.title")}>
          <div className="pattern-navigation-stage" data-openbitfun-pattern="navigation-panel">
            <NavigationPanel
              aria-label={t("patterns.navigation.title")}
            >
              <NavigationPanelHeader>
                <SearchField aria-label={t("patterns.navigation.search")} leadingIcon={<Icon name="search" />} placeholder={t("patterns.navigation.search")} />
              </NavigationPanelHeader>
              <NavigationPanelBody>
                <NavigationPanelContent>
                  <NavigationPanelSection title={t("patterns.navigation.workspace")}>
                    <NavigationPanelItem leading={<Icon name="folder" />} selected>Open-OpenBitFun</NavigationPanelItem>
                    <NavigationPanelItem leading={<Icon name="star" />}>OpenBitFun UI</NavigationPanelItem>
                  </NavigationPanelSection>
                  <Disclosure defaultOpen leading={<Icon name="extension" />} summary={t("patterns.navigation.tools")}>
                    <NavigationPanelItem leading={<Icon name="browser" />}>{t("patterns.actions.openBrowser")}</NavigationPanelItem>
                    <NavigationPanelItem leading={<Icon name="terminal" />}>{t("patterns.actions.openTerminal")}</NavigationPanelItem>
                  </Disclosure>
                  <NavigationPanelSection title={t("patterns.navigation.projects")}>
                    <NavigationPanelItem leading={<Icon name="files" />}>design-system</NavigationPanelItem>
                    <NavigationPanelItem leading={<Icon name="git" />}>fmy/ui-sys</NavigationPanelItem>
                  </NavigationPanelSection>
                </NavigationPanelContent>
              </NavigationPanelBody>
              <NavigationPanelFooter>
                <div className="pattern-navigation-footer"><StatusPill leading={<Icon name="circle" />} tone="success">{t("patterns.device.online")}</StatusPill><IconButton aria-label={t("patterns.device.refresh")} icon={<Icon name="refresh" />} size="xs" variant="quiet" /></div>
              </NavigationPanelFooter>
            </NavigationPanel>
            <div className="pattern-navigation-copy">
              <PageHeader description={t("patterns.navigation.description")} level={3} size="display" title={t("patterns.navigation.workspace")} />
              <p>{t("patterns.navigation.status")}</p>
            </div>
          </div>
        </PatternSection>

        <PatternSection description={t("patterns.search.description")} id="search" active={pattern === "search"} title={t("patterns.search.title")}>
          <Card appearance="raised" className="pattern-command" data-openbitfun-pattern="search-command-surface" gap="lg" padding="md" radius="lg">
            <div className="pattern-command-header">
              <div className="pattern-command-query"><SearchField size="sm" aria-label={t("patterns.search.searchPlaceholder")} clearLabel={t("components.preview.close")} leadingIcon={<Icon name="search" />} onClear={() => setQuery("")} onValueChange={setQuery} placeholder={t("patterns.search.searchPlaceholder")} shortcut={<KeyHint>Ctrl K</KeyHint>} value={query} /></div>
              <TabGroup size="sm" onValueChange={setScope} items={[{ label: t("patterns.search.all"), value: "all" }, { label: t("patterns.search.files"), value: "files" }, { label: t("patterns.search.commands"), value: "commands" }]} value={scope} />
            </div>
            <ScrollArea className="pattern-command-results">
              <div className="pattern-action-grid">
                {scope !== "files" && visibleActions.map((action) => <ActionCard description={t(action.description)} key={action.title} leading={<Icon name={action.icon} />} size="md">{t(action.title)}</ActionCard>)}
              </div>
              {scope !== "commands" && <div className="pattern-recent-list">
                <strong>{t("patterns.search.recent")}</strong>
                <ActivityItem actions={[{ icon: <Icon name="arrow-up-right" />, id: "open-readme", label: t("patterns.actions.openFiles") }]} appearance="surface" label="README.md" leading={<Icon name="files" />}>design-system/README.md</ActivityItem>
                <ActivityItem actions={[{ icon: <Icon name="arrow-up-right" />, id: "open-package", label: t("patterns.actions.openFiles") }]} appearance="surface" label="package.json" leading={<Icon name="files" />}>design-system/packages/ui/package.json</ActivityItem>
              </div>}
            </ScrollArea>
          </Card>
        <FileActivityPattern />
        </PatternSection>

        <PatternSection description={t("patterns.device.description")} id="device" active={pattern === "device"} title={t("patterns.device.title")}>
          <Card appearance="subtle" className="pattern-device-card" data-openbitfun-pattern="device-card" gap="md" padding="md" radius="md">
            <CardHeader actions={<IconButton aria-label={t("patterns.device.refresh")} icon={<Icon name="refresh" />} size="sm" variant="quiet" />} description="macOS · 127.0.0.1" leading={<span className="pattern-device-icon"><Icon name="device-mac" size="lg" /></span>} title="MacBook Pro" />
            <CardBody><StatusPill leading={<Icon name="unselected" />} tone="success">{t("patterns.device.online")}</StatusPill></CardBody>
            <Button leadingIcon={<Icon name="link" />} size="sm" variant="primary">{t("patterns.device.connect")}</Button>
          </Card>
        </PatternSection>
        <PatternSection description={t("patterns.provider.description")} id="provider" active={pattern === "provider"} title={t("patterns.provider.title")}>
          <ProviderConfigurationPattern />
          <WorkspaceConfigurationPattern />
        </PatternSection>
        <PatternSection description={t("patterns.toolbar.description")} id="toolbar" active={pattern === "toolbar"} title={t("patterns.toolbar.title")}>
          <IndicatorsPattern />
          <SceneToolbarPattern />
        </PatternSection>
        <PatternSection description={t("patterns.menu.description")} id="menu" active={pattern === "menu"} title={t("patterns.menu.title")}>
          <NestedMenuPattern />
        </PatternSection>
      </main>
    </ThemeRoot>
  );
}

function PatternSection({ children, description, id, active, title }: { children: ReactNode; description: string; id: string; active: boolean; title: string }) {
  return (
    <section className="pattern-section" id={`pattern-${id}`} role="tabpanel" aria-labelledby={`pattern-tab-${id}`} hidden={!active} tabIndex={0}>
      <div className="pattern-section__heading"><div><h2>{title}</h2><p>{description}</p></div></div>
      {children}
    </section>
  );
}
