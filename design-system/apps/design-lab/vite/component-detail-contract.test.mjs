import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { componentRegistry } from "@openbitfun/ui/registry";

const detailSource = new URL("../src/pages/ComponentDetailPage.tsx", import.meta.url);
const catalogSource = new URL("../src/pages/ComponentsPage.tsx", import.meta.url);
const appSource = new URL("../src/App.tsx", import.meta.url);
const flowChatPreviewSource = new URL("../src/preview/FlowChatPreviewRegistry.tsx", import.meta.url);
const flowChatGallerySource = new URL("../src/preview/FlowChatToolGallery.tsx", import.meta.url);
const stylesSource = new URL("../src/styles.css", import.meta.url);

test("NumberBadge inspector updates both the preview value and copyable example", async () => {
  const source = await readFile(detailSource, "utf8");
  assert.match(source, /const \[numberBadgeValue, setNumberBadgeValue\] = useState\("18"\)/);
  assert.match(source, /<NumberBadge value=\{numberBadgeValue\} \/>/);
  assert.match(source, /onChange=\{\(event\) => setNumberBadgeValue\(event.target.value\)\}/);
  assert.match(source, /JSON.stringify\(numberBadgeValue\)/);
  assert.match(source, /iconTone,\s*numberBadgeValue,/);
});

test("copyable examples and color-page controls use the same catalog as previews", async () => {
  const source = await readFile(detailSource, "utf8");
  const colors = await readFile(new URL("../src/pages/ColorsPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<(MessageCircle|MoreHorizontal|SearchIcon|Check|Copy|Download|Terminal|Settings|ChevronDown)(?:\s|\/>)/);
  assert.match(colors, /<Select\b/);
  assert.match(colors, /<SearchField\b/);
  assert.match(colors, /trailingIcon=\{<Icon name=\{expanded \? "chevron-up" : "chevron-down"\}/);
  assert.doesNotMatch(colors, /<(?:select|input|button)\b/);
});

test("every preview matrix declares its state-column count", async () => {
  const source = await readFile(detailSource, "utf8");
  const matrices = source.match(/className="component-preview-matrix"/g) ?? [];
  const stateCounts = source.match(/data-state-count=\{states\.length\}/g) ?? [];

  assert.ok(matrices.length > 0);
  assert.equal(stateCounts.length, matrices.length);
});

test("preview matrices define horizontal columns for every registered state count", async () => {
  const source = await readFile(stylesSource, "utf8");

  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="1"\]\s*\{[^}]*grid-template-columns:\s*96px\s+minmax\(240px, 1fr\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="2"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(2, minmax\(280px, max-content\)\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="3"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(3, minmax\(280px, max-content\)\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="4"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(4, minmax\(280px, max-content\)\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="5"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(5, minmax\(280px, max-content\)\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-state-count="6"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(6, minmax\(280px, max-content\)\)/s,
  );
});

test("FlowChat component details are registry-driven and stack every state vertically", async () => {
  const [detail, catalog, preview, styles] = await Promise.all([
    readFile(detailSource, "utf8"),
    readFile(catalogSource, "utf8"),
    readFile(flowChatPreviewSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /const states = component\.states/);
  assert.match(detail, /className="flow-chat-state-list"/);
  assert.match(detail, /className="flow-chat-state-list__item"/);
  assert.match(detail, /data-component-name=\{component\.name\}/);
  assert.doesNotMatch(detail, /component-preview-matrix[^]*data-component="flow-chat-tool-card"/);
  assert.match(catalog, /const catalogComponents = componentRegistry\.filter/);
  assert.doesNotMatch(catalog, /definition\.section === "framework"/);
  assert.match(preview, /flowChatPreviewDefinitions/);
  assert.match(preview, /AmbientToolCard/);
  assert.match(preview, /ProminentToolCard/);
  assert.match(preview, /CommandToolCard/);
  assert.match(preview, /ContextCompressionToolCard/);
  assert.match(preview, /FileOperationToolCard/);
  assert.match(preview, /ReadFileToolCard/);
  assert.match(preview, /ToolCardActions/);
  assert.match(styles, /\.flow-chat-state-list\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.flow-chat-state-list__item\s*\{[^}]*border-bottom:/s);
  assert.match(
    styles,
    /\.flow-chat-state-list__preview\[data-component-name="AskUser"\]\s*\{[^}]*width:\s*min\(100%,\s*680px\)/s,
  );
  assert.doesNotMatch(styles, /\.component-preview-matrix\[data-component="flow-chat-tool-card"\]/);
});

test("FlowChat gallery consumes the production inventory and shared lifecycle presenter", async () => {
  const [app, catalog, gallery, preview, scenarios] = await Promise.all([
    readFile(appSource, "utf8"),
    readFile(catalogSource, "utf8"),
    readFile(flowChatGallerySource, "utf8"),
    readFile(flowChatPreviewSource, "utf8"),
    readFile(new URL("../src/preview/FlowChatScenarios.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /const flowChatComponents = componentRegistry\.filter/);
  assert.match(app, /route === "flow-chat"/);
  assert.match(app, /\["components", "component", "mobile", "flow-chat"\]\.includes\(route\.page\)/);
  assert.match(app, /route\.page === "flow-chat" \? "flow-chat" : undefined/);
  assert.match(catalog, /category === "flow-chat"/);
  assert.match(catalog, /<FlowChatToolGallery onOpenComponent=\{onOpenComponent\} \/>/);
  assert.match(gallery, /<FlowChatComponentPreview/);
  assert.match(gallery, /definition\.section === "tool-card"/);
  assert.match(gallery, /productOwnedToolNames/);
  assert.match(gallery, /<FlowChatScenarios/);
  assert.match(preview, /toolsForComponent/);
  assert.match(preview, /toolsForComponent\("CronToolCard"\)/);
  assert.doesNotMatch(preview, /COMMAND_SAMPLES|tool: "Bash"|tool: "Task"|tool: "TerminalControl"|tool: "Cron"/);
  assert.match(preview, /<ScenarioCommand/);
  assert.match(scenarios, /<ExecProcessPresentation/);
  assert.match(scenarios, /<LazyTerminalOutputRenderer/);
  assert.match(scenarios, /useThinkingDisclosure/);
  assert.match(scenarios, /<ExploreGroup/);
  assert.match(scenarios, /<FlowChatRuntimeStatus/);
  // Inventory equivalence and every public state are exercised by the shared package's catalog tests.
});

test("Button preview exposes the public presentation variants", async () => {
  const source = await readFile(detailSource, "utf8");
  const declaration = /const buttonVariants = \[([^\]]+)\] as const;/.exec(source);

  assert.ok(declaration);
  assert.deepEqual(
    [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["outline", "fill", "secondary", "primary", "text"],
  );
});

test("Button preview opens on the filled variant used by the reference inspector", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(
    source,
    /useState<\(typeof buttonVariants\)\[number\]>\("fill"\)/,
  );
});

test("Card preview exposes generic surface and slot composition contracts", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /CardHeader/);
  assert.match(detail, /CardBody/);
  assert.match(detail, /CardFooter/);
  assert.match(detail, /CardMedia/);
  assert.match(detail, /appearance="raised"/);
  assert.match(detail, /appearance="subtle"/);
  assert.match(detail, /appearance="neutral"/);
  assert.match(styles, /\.component-card-example\s*\{[^}]*max-inline-size:\s*760px/s);
  assert.match(styles, /\.component-card-command-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
});

test("Button and IconButton previews preserve all public interaction states", async () => {
  const source = await readFile(detailSource, "utf8");
  assert.match(source, /const states = component\.states/);
  assert.deepEqual(componentRegistry.find(item => item.name === "Button").states, ["default", "hover", "active", "disabled"]);
  assert.deepEqual(componentRegistry.find(item => item.name === "IconButton").states, ["default", "hover", "active", "focus-visible", "disabled", "loading"]);
});

test("Button matrix uses the Session icon composition from the reference", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /name="session"/);
  assert.match(source, /chevron-down/);
  assert.match(source, /components\.preview\.session/);
  assert.match(source, /state === "hover" \|\| state === "active"/);
});

test("Button inspector wires the real disabled, loading, and icon controls", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /setInspectorDisabled/);
  assert.match(source, /setInspectorLoading/);
  assert.match(source, /setPreviewIcon/);
  assert.match(source, /setPreviewIconPosition/);
  assert.match(source, /renderPreview\(previewState, variant, true\)/);
});

test("IconButton preview exposes its icon-only presentation contract", async () => {
  const source = await readFile(detailSource, "utf8");
  const declaration = /const iconButtonVariants = \[([^\]]+)\] as const;/.exec(source);

  assert.ok(declaration);
  assert.deepEqual(
    [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["annotation", "quiet", "outline", "fill", "primary"],
  );
  assert.match(source, /data-component="icon-button"/);
  assert.match(source, /aria-label=\{t\(annotation \? "components\.preview\.fieldHelp" : "components\.preview\.listView"\)\}/);
  assert.match(source, /icon=\{annotation \? <Icon name="info" \/> : <Icon glyph=\{List\} \/>\}/);
  assert.match(source, /size=\{iconButtonSize\}/);
  assert.match(source, /shape=\{iconButtonShape\}/);
});

test("Icon preview exposes the complete named catalog and semantic controls", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  const overview = await readFile(new URL("../src/preview/ComponentOverview.tsx", import.meta.url), "utf8");
  assert.match(overview, /canonicalIconNames\.filter/);
  assert.match(overview, /onSelectIcon\(name\)/);
  assert.match(detail, /setIconName/);
  assert.match(detail, /setIconSize/);
  assert.match(detail, /setIconTone/);
  assert.match(detail, /translateOptions=\{false\}/);
  assert.match(styles, /\.component-icon-catalog\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(132px, 1fr\)\)/s);
});

test("StatusPill preview exposes compact indicator anatomy and semantic tones", async () => {
  const [catalog, detail] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
  ]);

  assert.match(detail, /<StatusPill/);
  assert.match(detail, /leading=\{<Icon name="unselected" \/>\}/);
  assert.match(detail, /tone=\{state as StatusPillTone\}/);
});

test("Select preview exposes the unified open surface and independent states", async () => {
  const [catalog, detail] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
  ]);

  assert.match(detail, /onValueChange=\{\(value\) => setSelectValue\(String\(value\)\)\}/);
  assert.match(detail, /leading=\{<Icon name="unselected" \/>\}/);
  assert.match(detail, /disabled=\{state === "disabled"\}/);
  assert.match(detail, /invalid=\{state === "invalid"\}/);
  assert.match(detail, /defaultOpen=\{state === "open"\}/);
});

test("ActionItem preview keeps its trigger and end actions as separate contracts", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /component\.name === "ActionItem"/);
  assert.match(source, /leading=\{<Icon name="session" size="lg" aria-hidden="true" \/>\}/);
  assert.match(source, /shortcut=\{<KeyHint>K<\/KeyHint>\}/);
  assert.match(source, /id: "add"/);
  assert.match(source, /id: "more"/);
});

test("ActivityItem preview exposes inline and surfaced anatomy without product behavior", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /const activityItemAppearances = \["inline", "surface"\] as const/);
  assert.match(detail, /appearance=\{appearance\}/);
  assert.match(detail, /label=\{surface \? t\("components\.preview\.activityAction"\) : undefined\}/);
  assert.match(detail, /metadata=\{surface \? <ChangeCount additions=\{6\} deletions=\{0\} \/> : undefined\}/);
  assert.match(detail, /actions=\{surface \? \[/);
  assert.match(detail, /setActivityItemAppearance/);
  assert.match(styles, /\.component-activity-item-example\s*\{[^}]*max-inline-size:\s*680px/s);
  assert.match(styles, /\[data-openbitfun-component="activity-item"\]\.lab-force-focus/);
});

test("ActionItem preview reserves a full-width column for its complete anatomy", async () => {
  const source = await readFile(stylesSource, "utf8");

  assert.match(
    source,
    /\.component-preview-matrix\[data-component="action-item"\]\s*\{[^}]*grid-template-columns:\s*96px\s+repeat\(4, minmax\(280px, 1fr\)\)/s,
  );
  assert.match(
    source,
    /\.component-preview-matrix\[data-component="action-item"\]\s+\[data-openbitfun-component="action-item"\]\s*\{[^}]*inline-size:\s*100%/s,
  );
});

test("Dialog and Sheet previews exercise provider-owned overlays and compound anatomy", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /component\.name === "Dialog"/);
  assert.match(detail, /component\.name === "Sheet"/);
  assert.match(detail, /renderDialogExample\(state\)/);
  assert.match(detail, /renderSheetExample\(state\)/);
  assert.match(detail, /<DialogHeader>/);
  assert.match(detail, /<DialogBody>/);
  assert.match(detail, /<DialogFooter>/);
  assert.match(detail, /size="xl"/);
  assert.match(detail, /<DialogFooter appearance="floating">/);
  assert.match(detail, /placement=\{placement\}/);
  assert.doesNotMatch(detail, /portalled=|portalContainer=|contentPadding=|overlayClassName=|dialogClassName=/);
  assert.match(styles, /\.component-dialog-preview-stage\s*\{/);
});

test("ConfirmDialog preview exposes semantic, destructive, preview, and pending contracts", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /<ConfirmDialog/);
  assert.match(detail, /confirmDanger=\{confirmType === "error"\}/);
  assert.match(detail, /pendingAction=\{state === "pending" && previewPending \? "confirm" : null\}/);
  assert.match(detail, /setTimeout\(\(\) => setPreviewPending\(false\)/);
  assert.match(detail, /preview="\/workspace\/project"/);
  assert.match(detail, /open=\{overlayOpen\}/);
  assert.match(detail, /onOpenChange=\{\(\) => setOverlayOpen\(false\)\}/);
  assert.doesNotMatch(detail, /portalled=|preventScroll=|overlayClassName=|dialogClassName=/);
  assert.match(styles, /\.component-dialog-preview-stage\s*\{/);
});

test("Input, KeyHint, and SearchField previews expose composable slot and state contracts", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /component\.name === "Input"/);
  assert.match(source, /component\.name === "KeyHint"/);
  assert.match(source, /component\.name === "SearchField"/);
  assert.match(source, /trailing=\{<Icon name="eye" \/>\}/);
  assert.match(source, /leadingIcon=\{<Icon name="search" \/>\}/);
  assert.match(source, /shortcut=\{<KeyHint icon=\{<Icon name="command-mac" \/>\}>K<\/KeyHint>\}/);
  assert.match(source, /onClear=\{\(\) => setValue\(""\)\}/);
  assert.match(source, /readOnly=\{state === "read-only"\}/);

  const styles = await readFile(stylesSource, "utf8");
  const fieldFocus = styles.match(/\[data-openbitfun-component="input"\]\.lab-force-focus\s*\{([^}]+)\}/)?.[1];
  assert.ok(fieldFocus, "Input must retain its border-based preview focus treatment");
  assert.match(fieldFocus, /border-color: var\(--openbitfun-color-field-border-active\)/);
  assert.match(fieldFocus, /box-shadow: none/);
  assert.doesNotMatch(fieldFocus, /border-width:|outline:|--openbitfun-focus-width/);
  assert.doesNotMatch(styles, /input\.lab-force-focus\s*\{/);
  assert.match(styles, /\[data-openbitfun-component="search-field"\]\[data-variant="default"\]:is\(\.lab-force-hover, \.lab-force-focus\)[^{]+\{\s*outline-color: var\(--openbitfun-color-border-default\)/);
});

test("ScrollArea preview exposes direction and native scrollbar visibility contracts", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /const scrollAreaOrientations = \["vertical", "horizontal", "both"\] as const/);
  assert.match(detail, /orientation=\{scrollAreaOrientation\}/);
  assert.match(detail, /scrollbarVisibility=\{state as ScrollbarVisibility\}/);
  assert.match(styles, /\.component-scroll-area-example\s*\{[^}]*block-size:\s*160px/s);
});

test("Menu preview exposes grouped anatomy, item states, and scrollbar control", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /MenuSection/);
  assert.match(detail, /MenuSeparator/);
  assert.match(detail, /scrollbarVisibility=\{menuShowScrollbar \? "auto" : "hidden"\}/);
  assert.match(detail, /role=\{state === "checked-item"/);
  assert.match(styles, /\[data-openbitfun-component="action-item"\]\.lab-force-focus/);
});

test("NavigationPanel preview exposes header, grouped navigation, selected items, scrolling, and footer", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /NavigationPanelSection/);
  assert.match(detail, /NavigationPanelSeparator/);
  assert.match(detail, /<NavigationPanelFooter>/);
  assert.match(detail, /<NavigationPanelHeader>/);
  assert.match(detail, /selected=\{state === "selected-item"/);
  assert.match(detail, /scrollbarVisibility=\{navigationPanelShowScrollbar \? "auto" : "hidden"\}/);
  assert.match(styles, /\.component-navigation-panel-example\s*\{[^}]*block-size:\s*520px/s);
});

test("Composer preview exposes context, editor, and action regions independently", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /ComposerContextBar/);
  assert.match(detail, /ComposerDivider/);
  assert.match(detail, /ComposerToolbar/);
  assert.match(detail, /contextBar=\{showContext \? \(/);
  assert.match(detail, /toolbar=\{composerShowToolbar \? \(/);
  assert.match(detail, /<textarea/);
  assert.match(detail, /setComposerShowContext/);
  assert.match(detail, /setComposerShowToolbar/);
  assert.match(styles, /\.component-composer-example\s*\{[^}]*max-inline-size:\s*680px/s);
  assert.match(styles, /\[data-openbitfun-component="composer"\]\.lab-force-focus/);
});

test("Field preview exposes label and control composition independently from layout orientation", async () => {
  const [source, styles] = await Promise.all([
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(source, /const fieldOrientations = \["vertical", "horizontal"\] as const/);
  assert.match(source, /description=\{t\("components\.preview\.fieldDescription"\)\}/);
  assert.match(source, /orientation=\{applyInspectorControls \? fieldOrientation : "vertical"\}/);
  assert.match(source, /component\.name === "Field"/);
  assert.match(source, /labelAction=\{fieldShowLabelAction \? \(/);
  assert.match(source, /controlLeading=\{fieldShowControlLeading \? \(/);
  assert.match(source, /controlTrailing=\{fieldShowControlTrailing \? \(/);
  assert.match(source, /setFieldShowLabelAction/);
  assert.match(source, /setFieldShowControlLeading/);
  assert.match(source, /setFieldShowControlTrailing/);
  assert.match(styles, /\.component-field-example\[data-orientation="horizontal"\] \[data-openbitfun-part="control"\]\s*\{[^}]*inline-size:\s*150px/s);
});

test("FieldGroup preview exposes section, surface, row, and field composition contracts", async () => {
  const [source, styles] = await Promise.all([
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(source, /component\.name === "FieldGroup"/);
  assert.match(source, /<FormSection/);
  assert.match(source, /leading=\{<Icon name="gear" size="lg" aria-hidden="true" \/>\}/);
  assert.match(source, /<FieldGroup appearance=\{plain \? "plain" : "subtle"\} dividers=\{state === "divided"\}/);
  assert.match(source, /<FieldRow>/);
  assert.match(source, /controlWidth="fill"/);
  assert.match(source, /labelWidth="md"/);
  assert.match(styles, /\.component-field-group-example\s*\{[^}]*max-inline-size:\s*760px/s);
});

test("PageHeader preview decouples semantic level from visual size and alignment", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /const pageHeaderAlignments = \["start", "center"\] as const/);
  assert.match(source, /const pageHeaderSizes = \["sm", "md", "lg", "display"\] as const/);
  assert.match(source, /level=\{2\}/);
  assert.match(source, /size=\{pageHeaderSize\}/);
  assert.match(source, /align=\{pageHeaderAlign\}/);
  assert.match(source, /action=\{\(/);
  assert.match(source, /leading=\{<Icon name="gear" size="lg" aria-hidden="true" \/>\}/);
});

test("TabGroup preview connects selection to its content panels", async () => {
  const [source, live] = await Promise.all([
    readFile(detailSource, "utf8"),
    readFile(new URL("../src/preview/LiveComponentExamples.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<NavigationExample name=\{component.name\}/);
  assert.match(live, /onValueChange=\{setValue\}/);
  assert.match(live, /hidden=\{value !== option.value\}/);
  assert.match(live, /"tabpanel"/);
  assert.match(source, /size=\{tabGroupSize\}/);
});

test("Toolbar preview keeps leading, centered, trailing, and overflow compositions independent", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(detail, /ToolbarBadge/);
  assert.match(detail, /ToolbarGroup/);
  assert.match(detail, /ToolbarSeparator/);
  assert.match(detail, /leadingOverflow=\{state === "overflow" \? "scroll" : "visible"\}/);
  assert.match(detail, /center=\{state === "with-center"/);
  assert.match(detail, /items=\{tabItems\}\s+size="sm"/);
  assert.match(detail, /setToolbarSize/);
  assert.match(styles, /\.component-toolbar-example\s*\{[^}]*max-inline-size:\s*760px/s);
});

test("Combobox details render their own live state and menus include nested interaction", async () => {
  const detail = await readFile(detailSource, "utf8");
  assert.match(detail, /<Combobox/);
  assert.match(detail, /defaultOpen=\{state === "open" \|\| state === "searching" \|\| state === "loading" \|\| state === "empty"\}/);
  assert.match(detail, /onCreateValue=\{state === "custom"/);
  assert.match(detail, /component\.name === "MultiSelect"/);
  assert.match(detail, /onValueChange=\{setMultiSelectValues\}/);
  assert.match(detail, /value=\{multiSelectValues\}/);
  assert.match(detail, /<NestedMenuPattern/);
});

test("wide surfaces stack independently and compact pickers do not reserve empty canvas", async () => {
  const styles = await readFile(new URL("../src/preview/ComponentShowcase.css", import.meta.url), "utf8");
  assert.match(styles, /data-presentation="stack"[^}]+grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /data-component-name="Combobox"[^}]+max-width: 360px/);
  assert.match(styles, /component-field-group-example[^}]+min-inline-size: 0/);
});

test("form previews preserve specimen width and their simulated field states", async () => {
  const styles = await readFile(stylesSource, "utf8");
  assert.match(styles, /\.component-field-group-example\s*\{[^}]*min-inline-size:\s*440px/);
  assert.match(styles, /\.component-textarea-example\s*\{[^}]*inline-size:\s*280px/);
  assert.match(styles, /\.component-textarea-example\.lab-state-hover textarea[^{}]*\{[^}]*--openbitfun-color-field-border-hover/);
  assert.match(styles, /\.component-textarea-example\.lab-state-focus-visible textarea[^{}]*\{[^}]*--openbitfun-color-focus-ring/);
  assert.match(styles, /\.component-preview-matrix\[data-state-count="7"\]\s*\{[^}]*repeat\(7,/);
});
