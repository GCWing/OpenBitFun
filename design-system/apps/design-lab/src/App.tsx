import { FoundationsPage } from "./pages/FoundationsPage";
import { LabNavigation, LabSectionNavigation } from "./components/LabNavigation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SystemTokenMode } from "@openbitfun/design-tokens";
import type { ThemeDataName } from "@openbitfun/theme-openbitfun";
import { AppWindow, Blocks, BookOpen, Bot, Braces, FileText, House, Languages, Menu, MessageSquare, Moon, MousePointerClick, PanelTop, PanelsTopLeft, Smartphone, SquareTerminal, Sun, ToggleLeft, type LucideIcon } from "lucide-react";
import { Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogHeader, DialogHeading, DialogTitle, IconButton, KeyHint, Listbox, ListboxEmpty, ListboxOption, SearchField, Select, Sheet, Icon as CatalogIcon,
  DesignSystemProvider,
  ThemeRoot,
  type ColorScheme,
  type ContrastMode,
  type DensityMode,
  type IconName,
} from "@openbitfun/ui";
import { OpenBitFunMark } from "@openbitfun/ui/brand";
import { BrandPage } from "./pages/BrandPage";
import { componentRegistry } from "@openbitfun/ui/registry";
import {
  useI18n,
  type DesignLabLocale,
} from "./i18n";
import {
  getComponentCategoryLabel,
  getComponentDescription,
} from "./i18n/componentMetadata";
import { OverviewPage } from "./pages/OverviewPage";
import { ComponentsPage } from "./pages/ComponentsPage";
import { GettingStartedPage } from "./pages/GettingStartedPage";
import { ResourcesPage } from "./pages/ResourcesPage";
import { PatternsPage } from "./pages/PatternsPage";
import { FlowChatMockPage } from "./pages/FlowChatMockPage";
import { ColorsPage } from "./pages/ColorsPage";
import { SubagentIpPage } from "./pages/SubagentIpPage";
import { SUBAGENT_AVATAR_CATALOG } from "./assets/subagentAvatars";
import {
  colorTokenCatalog,
  nonColorTokenCatalog,
  type EditableToken,
} from "./token-editor/catalog";
import {
  buildActiveTokenOverrides,
  getActiveTokenMode,
  getTokenDraftKey,
  loadTokenDrafts,
  persistTokenDrafts,
  type TokenDrafts,
  type TokenEditorContext,
} from "./token-editor/model";
import { TokenWorkbench } from "./token-editor/TokenWorkbench";
import { TokenEffectPreview } from "./token-editor/TokenEffectPreview";

type LabRoute =
  | { page: "overview" }
  | { page: "foundations" }
  | { page: "getting-started" }
  | { page: "components" }
  | { page: "mobile" }
  | { page: "brand" }
  | { page: "patterns" }
  | { page: "flow-chat" }
  | { page: "flow-chat-mock" }
  | { page: "colors" }
  | { page: "subagent-ip" }
  | { page: "resources" }
  | { page: "tokens" }
  | { componentName: string; page: "component" };

interface SearchDestination {
  detail: string;
  icon: LucideIcon | IconName;
  keywords: string;
  label: string;
  route: LabRoute;
}

const componentIcons: Record<string, LucideIcon> = {
  AmbientToolCard: SquareTerminal,
  Button: MousePointerClick,
  Dialog: AppWindow,
  Sheet: AppWindow,
  ProminentToolCard: SquareTerminal,
  Switch: ToggleLeft,
  TabGroup: PanelTop,
};

const flowChatComponents = componentRegistry.filter(
  (component) => component.category === "flow-chat",
);
const mobileComponents = componentRegistry.filter(
  (component) => component.category === "mobile",
);
function getThemeDataName(
  colorScheme: ColorScheme,
  contrast: ContrastMode,
): ThemeDataName {
  if (contrast === "high") {
    return colorScheme === "dark" ? "highContrastDark" : "highContrastLight";
  }
  return colorScheme;
}

function parseRoute(hash: string): LabRoute {
  const route = hash.replace(/^#/, "").toLowerCase();
  if (!route || route === "overview") {
    return { page: "overview" };
  }
  if (route === "foundations" || route.startsWith("foundations/")) return { page: "foundations" };
  if (route === "tokens") {
    return { page: "tokens" };
  }
  if (route === "colors") {
    return { page: "colors" };
  }
  if (route === "getting-started") {
    return { page: "getting-started" };
  }
  if (route === "components") {
    return { page: "components" };
  }
  if (route === "brand" || route.startsWith("brand/")) return { page: "brand" };
  if (route === "mobile") {
    return { page: "mobile" };
  }
  if (route === "patterns") {
    return { page: "patterns" };
  }
  if (route === "flow-chat") {
    return { page: "flow-chat" };
  }
  if (route === "flow-chat-mock") {
    return { page: "flow-chat-mock" };
  }
  if (route === "resources") {
    return { page: "resources" };
  }
  if (route === "subagent-ip") {
    return { page: "subagent-ip" };
  }

  const componentSlug = route.startsWith("component/")
    ? route.slice("component/".length)
    : route;
  const component = componentRegistry.find(
    (candidate) => candidate.name.toLowerCase() === componentSlug,
  );
  return component
    ? { componentName: component.name, page: "component" }
    : { page: "overview" };
}

function routeHash(route: LabRoute): string {
  return route.page === "component"
    ? `#component/${route.componentName.toLowerCase()}`
    : `#${route.page}`;
}

export function App() {
  const { locale, setLocale, t } = useI18n();
  const [colorScheme, setColorScheme] = useState<ColorScheme>("light");
  const [contrast, setContrast] = useState<ContrastMode>("standard");
  const [density, setDensity] = useState<DensityMode>("compact");
  const [route, setRoute] = useState<LabRoute>(() => parseRoute(window.location.hash));
  const [componentScope, setComponentScope] = useState("all");
  const [drafts, setDrafts] = useState<TokenDrafts>(loadTokenDrafts);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const searchShortcut = /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘ K" : "Ctrl K";

  const themeName = getThemeDataName(colorScheme, contrast);
  // Document-level portals live outside the page ThemeRoot. Give them the same
  // token scope before paint, including subsequent theme and density changes.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const attributes = {
      "data-openbitfun-design-system-root": "",
      "data-color-scheme": colorScheme,
      "data-contrast": contrast,
      "data-density": density,
    };
    const previous = Object.keys(attributes).map(name => [name, root.getAttribute(name)] as const);
    Object.entries(attributes).forEach(([name, value]) => root.setAttribute(name, value));
    return () => {
      previous.forEach(([name, value]) => {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      });
    };
  }, [colorScheme, contrast, density]);

  const editorContext = useMemo<TokenEditorContext>(() => ({
    density: density as SystemTokenMode,
    theme: themeName,
  }), [density, themeName]);
  const tokenOverrides = useMemo(
    () => buildActiveTokenOverrides(editorContext, drafts),
    [drafts, editorContext],
  );

  const searchDestinations = useMemo<SearchDestination[]>(() => [
    { detail: t("design.foundationsIntro"), icon: "palette", keywords: "foundations typography spacing motion 规范 排版 间距", label: t("design.foundations"), route: { page: "foundations" } },
    {
      detail: t("search.overviewDetail"),
      icon: House,
      keywords: `home start overview ${t("nav.overview")}`,
      label: t("nav.overview"),
      route: { page: "overview" },
    },
    {
      detail: t("search.gettingStartedDetail"),
      icon: BookOpen,
      keywords: `install packages quick start ${t("nav.gettingStarted")}`,
      label: t("nav.gettingStarted"),
      route: { page: "getting-started" },
    },
    {
      detail: t("search.tokensDetail", { count: nonColorTokenCatalog.length }),
      icon: Braces,
      keywords: `design tokens spacing typography radius motion theme ${t("nav.designTokens")}`,
      label: t("nav.designTokens"),
      route: { page: "tokens" },
    },
    {
      detail: t("search.colorsDetail", { count: colorTokenCatalog.length }),
      icon: "palette",
      keywords: `colors semantic palette scale reference theme ${t("nav.colors")}`,
      label: t("nav.colors"),
      route: { page: "colors" },
    },
    {
      detail: t("search.componentsDetail", { count: componentRegistry.length }),
      icon: Blocks,
      keywords: `component library catalog ${t("nav.components")}`,
      label: t("nav.components"),
      route: { page: "components" },
    },
    {
      detail: t("brand.description"),
      icon: "spark",
      keywords: `OpenBitFun brand logo motion ${t("nav.brand")}`,
      label: t("design.brand"),
      route: { page: "brand" },
    },
    {
      detail: t("search.mobileDetail", { count: mobileComponents.length }),
      icon: Smartphone,
      keywords: `mobile touch phone foldable ${t("nav.mobile")}`,
      label: t("nav.mobile"),
      route: { page: "mobile" },
    },
    {
      detail: t("search.patternsDetail"),
      icon: PanelsTopLeft,
      keywords: `patterns recipes settings navigation search device ${t("nav.patterns")}`,
      label: t("nav.patterns"),
      route: { page: "patterns" },
    },
    {
      detail: t("search.flowChatDetail", { count: flowChatComponents.length }),
      icon: SquareTerminal,
      keywords: `FlowChat tool cards ambient prominent ${t("nav.flowChat")}`,
      label: t("nav.flowChat"),
      route: { page: "flow-chat" },
    },
    {
      detail: t("search.flowChatMockDetail"),
      icon: MessageSquare,
      keywords: `FlowChat conversation thinking exploration replay ${t("nav.flowChatMock")}`,
      label: t("design.conversation"),
      route: { page: "flow-chat-mock" },
    },
    {
      detail: t("search.subagentIpDetail", { count: SUBAGENT_AVATAR_CATALOG.length }),
      icon: Bot,
      keywords: `subagent avatar robot joystick character SVG IP ${t("subagentIp.kicker")}`,
      label: t("nav.subagentIp"),
      route: { page: "subagent-ip" },
    },
    {
      detail: t("search.resourcesDetail"),
      icon: FileText,
      keywords: `readme release policy package documentation ${t("nav.resources")}`,
      label: t("nav.resources"),
      route: { page: "resources" },
    },
    ...componentRegistry.map((component) => {
      const category = getComponentCategoryLabel(component.category, t);
      const description = getComponentDescription(component.name, component.description, t);
      return {
        detail: t("search.componentDetail", { category }),
        icon: componentIcons[component.name] ?? Blocks,
        keywords: `${component.name} ${component.category} ${component.description} ${category} ${description}`,
        label: component.name,
        route: { componentName: component.name, page: "component" } as const,
      };
    }),
  ], [t]);

  const visibleSearchDestinations = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) {
      return searchDestinations;
    }
    return searchDestinations.filter((destination) =>
      `${destination.label} ${destination.detail} ${destination.keywords}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [searchDestinations, searchQuery]);

  useEffect(() => {
    persistTokenDrafts(drafts);
  }, [drafts]);

  useEffect(() => {
    function syncRoute() {
      const nextRoute = parseRoute(window.location.hash);
      setRoute(nextRoute);
      setSidebarOpen(false);
      // Foundations handles its own chapter focus, deep links and scroll position.
      const anchor = window.location.hash.match(/^#brand\/(\w+)$/);
      if (anchor) requestAnimationFrame(() => document.getElementById(`brand-${anchor[1]}`)?.scrollIntoView());
      else if (nextRoute.page !== "foundations") window.scrollTo({ top: 0 });
    }
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setSidebarOpen(false);
        setSearchOpen(current => !current);
      }
    }
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, []);

  function navigate(nextRoute: LabRoute) {
    const nextHash = routeHash(nextRoute);
    setSearchOpen(false);
    setSearchQuery("");
    setSidebarOpen(false);
    if (window.location.hash === nextHash) {
      setRoute(nextRoute);
      window.scrollTo({ top: 0 });
      return;
    }
    window.location.hash = nextHash;
  }

  function changeToken(token: EditableToken, value: string) {
    const mode = getActiveTokenMode(token, editorContext);
    const key = getTokenDraftKey(token.collection, mode, token.name);
    setDrafts((current) => {
      if (value === token.values[mode]) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: value };
    });
  }

  function resetToken(token: EditableToken) {
    const mode = getActiveTokenMode(token, editorContext);
    const key = getTokenDraftKey(token.collection, mode, token.name);
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function openTokenPage(scope = "all") {
    setComponentScope(scope);
    navigate({ page: "tokens" });
  }

  function changeThemeMode(nextMode: ThemeDataName) {
    switch (nextMode) {
      case "dark":
        setColorScheme("dark");
        setContrast("standard");
        break;
      case "highContrastDark":
        setColorScheme("dark");
        setContrast("high");
        break;
      case "highContrastLight":
        setColorScheme("light");
        setContrast("high");
        break;
      case "light":
        setColorScheme("light");
        setContrast("standard");
        break;
    }
  }

  const activeComponent = route.page === "component"
    ? componentRegistry.find((component) => component.name === route.componentName)
    : undefined;

  return (
    <DesignSystemProvider colorScheme={colorScheme} contrast={contrast} density={density} locale={locale} nativeTooltipPolicy="application">
    <ThemeRoot
      className="lab-shell"
      data-page={route.page}
      data-component-library={["components", "component", "mobile", "flow-chat"].includes(route.page) || undefined}
      data-sidebar-open={sidebarOpen || undefined}
      colorScheme={colorScheme}
      contrast={contrast}
      density={density}
    >
      <div className="lab-workspace">
        <header className="lab-topbar">
          <IconButton
            aria-label={t("app.openNavigation")}
            className="lab-navigation-trigger"
            icon={<CatalogIcon glyph={Menu} />}
            onClick={() => setSidebarOpen(true)}
          />
          <a className="design-wordmark-link" href="#overview" onClick={event => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate({ page: "overview" });
          }}>
            <OpenBitFunMark size={28} /><span>OpenBitFun<span className="design-wordmark-suffix"> Design</span></span>
          </a>
          <LabNavigation page={route.page} componentName={activeComponent?.name}
            onNavigate={page => page === "tokens" ? openTokenPage() : navigate({ page })} />
          <div className="lab-topbar-actions">
            <Button className="lab-search-trigger" size="sm" variant="fill"
              aria-label={t("search.label")} aria-haspopup="dialog"
              leadingIcon={<CatalogIcon name="search" />}
              onClick={() => setSearchOpen(true)}>
              <span className="lab-search-trigger-label">{t("search.placeholder")}</span>
              <KeyHint className="lab-search-shortcut">{searchShortcut}</KeyHint>
            </Button>
            <IconButton
              aria-label={colorScheme === "light" ? t("theme.switchToDark") : t("theme.switchToLight")}
              icon={<CatalogIcon glyph={colorScheme === "light" ? Sun : Moon} />}
              onClick={() => setColorScheme(current => current === "light" ? "dark" : "light")}
            />
            <IconButton aria-label={t("settings.label")} aria-haspopup="dialog"
              icon={<CatalogIcon name="settings" />} onClick={() => setSettingsOpen(true)} />
          </div>
        </header>

        <Dialog open={searchOpen} onOpenChange={setSearchOpen} initialFocusRef={searchInputRef} size="md">
          <DialogHeader>
            <DialogTitle>{t("search.label")}</DialogTitle>
            <DialogClose aria-label={t("settings.close")} />
          </DialogHeader>
          <DialogBody className="lab-search-dialog">
            <SearchField aria-label={t("search.label")} placeholder={t("search.placeholder")}
              ref={searchInputRef} value={searchQuery} onChange={event => setSearchQuery(event.target.value)}
              leadingIcon={<CatalogIcon name="search" />} clearLabel={t("design.clear")} onClear={() => setSearchQuery("")}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  searchResultsRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
                } else if (event.key === "Enter" && visibleSearchDestinations[0]) {
                  event.preventDefault();
                  navigate(visibleSearchDestinations[0].route);
                }
              }} />
            <Listbox className="lab-search-options" ref={searchResultsRef} aria-label={t("search.label")}>
              {visibleSearchDestinations.map(destination => (
                <ListboxOption key={routeHash(destination.route)} value={routeHash(destination.route)}
                  selected={routeHash(destination.route) === routeHash(route)}
                  description={destination.detail}
                  leading={typeof destination.icon === "string"
                    ? <CatalogIcon name={destination.icon} /> : <CatalogIcon glyph={destination.icon} />}
                  onClick={() => navigate(destination.route)}>
                  {destination.label}
                </ListboxOption>
              ))}
              {visibleSearchDestinations.length === 0 && <ListboxEmpty>{t("search.noResults", { query: searchQuery })}</ListboxEmpty>}
            </Listbox>
          </DialogBody>
        </Dialog>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen} size="sm">
          <DialogHeader>
            <DialogHeading>
              <DialogTitle>{t("settings.title")}</DialogTitle>
              <DialogDescription>{t("settings.subtitle")}</DialogDescription>
            </DialogHeading>
            <DialogClose aria-label={t("settings.close")} />
          </DialogHeader>
          <DialogBody className="lab-settings-form">
            <label className="lab-settings-field">
              <span>{t("language.label")}</span>
              <Select aria-label={t("language.label")} value={locale}
                leading={<CatalogIcon glyph={Languages} />}
                onValueChange={value => setLocale(value as DesignLabLocale)}
                options={[{ value: "zh-CN", label: "简体中文" }, { value: "en-US", label: "English" }, { value: "zh-TW", label: "繁體中文" }]} />
            </label>
            <label className="lab-settings-field">
              <span>{t("settings.scheme")}</span>
              <Select aria-label={t("settings.scheme")} value={colorScheme}
                onValueChange={value => setColorScheme(value as ColorScheme)}
                options={[{ value: "light", label: t("settings.light") }, { value: "dark", label: t("settings.dark") }]} />
            </label>
            <label className="lab-settings-field">
              <span>{t("settings.contrast")}</span>
              <Select aria-label={t("settings.contrast")} value={contrast}
                onValueChange={value => setContrast(value as ContrastMode)}
                options={[{ value: "standard", label: t("settings.standard") }, { value: "high", label: t("settings.highContrast") }]} />
            </label>
            <label className="lab-settings-field">
              <span>{t("settings.density")}</span>
              <Select aria-label={t("settings.density")} value={density}
                onValueChange={value => setDensity(value as DensityMode)}
                options={["compact", "comfortable", "touch"].map(value => ({ value, label: t(`settings.${value as DensityMode}`) }))} />
            </label>
            <Button disabled={Object.keys(drafts).length === 0} onClick={() => setDrafts({})} variant="fill">
              {t("settings.resetTokenDrafts")} · {Object.keys(drafts).length}
            </Button>
          </DialogBody>
        </Dialog>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen} placement="left" size="sm">
          <DialogHeader>
            <DialogTitle>OpenBitFun Design</DialogTitle>
            <DialogClose aria-label={t("app.closeNavigation")} />
          </DialogHeader>
          <DialogBody className="lab-mobile-navigation">
            <LabNavigation page={route.page} onNavigate={page => page === "tokens" ? openTokenPage() : navigate({ page })} />
            <LabSectionNavigation page={route.page} onNavigate={page => page === "tokens" ? openTokenPage() : navigate({ page })} />
          </DialogBody>
        </Sheet>

        <LabSectionNavigation page={route.page} onNavigate={page => page === "tokens" ? openTokenPage() : navigate({ page })} />
        <div className="lab-content">
          {route.page === "overview" && (
            <OverviewPage onNavigate={(target) => navigate({ page: target })} />
          )}

          {route.page === "foundations" && <FoundationsPage
            density={density}
            mode={themeName}
            onDensityChange={setDensity}
            onModeChange={changeThemeMode}
            onNavigate={page => page === "tokens" ? openTokenPage() : navigate({ page })}
          />}

          {route.page === "getting-started" && (
            <GettingStartedPage
              onNavigate={(target) => navigate({ page: target })}
            />
          )}

          {(["components", "component", "mobile", "flow-chat"].includes(route.page)) && (
            <ComponentsPage
              category={route.page === "mobile" ? "mobile" : route.page === "flow-chat" ? "flow-chat" : undefined}
              colorScheme={colorScheme}
              component={activeComponent}
              contrast={contrast}
              density={density}
              onInspectTokens={openTokenPage}
              onOpenComponent={(name) => navigate({ componentName: name, page: "component" })}
              tokenOverrides={tokenOverrides}
            />
          )}

          {route.page === "brand" && <BrandPage onOpenComponent={(name) => navigate({ componentName: name, page: "component" })} />}

          {route.page === "patterns" && (
            <PatternsPage
              colorScheme={colorScheme}
              contrast={contrast}
              density={density}
              tokenOverrides={tokenOverrides}
            />
          )}

          {route.page === "flow-chat-mock" && <FlowChatMockPage />}

          {route.page === "tokens" && (
            <TokenWorkbench
              componentScope={componentScope}
              context={editorContext}
              drafts={drafts}
              onComponentScopeChange={setComponentScope}
              onResetAll={() => setDrafts({})}
              onResetToken={resetToken}
              onTokenChange={changeToken}
              preview={(
                <ThemeRoot
                  className="token-preview-theme-host"
                  colorScheme={colorScheme}
                  contrast={contrast}
                  density={density}
                  tokenOverrides={tokenOverrides}
                >
                  <TokenEffectPreview componentName={componentScope} />
                </ThemeRoot>
              )}
            />
          )}

          {route.page === "colors" && (
            <ColorsPage
              density={density}
              mode={themeName}
              onDensityChange={setDensity}
              onModeChange={changeThemeMode}
            />
          )}

          {route.page === "subagent-ip" && <SubagentIpPage />}

          {route.page === "resources" && <ResourcesPage />}
        </div>
      </div>
    </ThemeRoot>
    </DesignSystemProvider>
  );
}
