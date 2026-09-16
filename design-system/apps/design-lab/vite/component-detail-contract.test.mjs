import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  const styles = await readFile(stylesSource, "utf8");
  assert.doesNotMatch(source, /<(MessageCircle|MoreHorizontal|SearchIcon|Check|Copy|Download|Terminal|Settings|ChevronDown)(?:\s|\/>)/);
  assert.match(styles, /\.colors-select-field > :is\(svg, \[data-openbitfun-component="icon"\]\)/);
  assert.match(styles, /\.colors-expand-button :is\(svg, \[data-openbitfun-component="icon"\]\)\[data-expanded\]/);
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

  assert.match(detail, /if \(flowChatPreview\) \{\s*return component\.states;/);
  assert.match(detail, /className="flow-chat-state-list"/);
  assert.match(detail, /className="flow-chat-state-list__item"/);
  assert.match(detail, /data-component-name=\{component\.name\}/);
  assert.doesNotMatch(detail, /component-preview-matrix[^]*data-component="flow-chat-tool-card"/);
  assert.match(catalog, /definition\.section === "framework"/);
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

test("FlowChat gallery renders only the real migrated tool-card components", async () => {
  const [app, catalog, gallery, preview] = await Promise.all([
    readFile(appSource, "utf8"),
    readFile(catalogSource, "utf8"),
    readFile(flowChatGallerySource, "utf8"),
    readFile(flowChatPreviewSource, "utf8"),
  ]);
  const specimenNames = [...preview.matchAll(/\{ tool: "([^"]+)" \}/g)]
    .map((match) => match[1]);
  const productOwnedDeclaration = /const productOwnedToolExamples = \[([^\]]+)\] as const;/.exec(gallery);
  const productOwnedNames = productOwnedDeclaration
    ? [...productOwnedDeclaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    : [];
  const migratedToolNames = [
    "AgentSpawn",
    "AgentSendInput",
    "Task",
    "LaunchReviewAgent",
    "AgentWait",
    "AskUserQuestion",
    "Bash",
    "ExecCommand",
    "WriteStdin",
    "ExecControl",
    "ContextCompression",
    "ControlHub",
    "FinalizeMiniApp",
    "PublishMiniApp",
    "PublishAppearance",
    "UnregisteredTool",
    "LS",
    "GetFileDiff",
    "Write",
    "Edit",
    "Delete",
    "GetToolSpec",
    "Git",
    "Glob",
    "Grep",
    "PageDeploy",
    "PagePublish",
    "Read",
    "ReviewSessionSummary",
    "RunCode",
    "SessionControl",
    "SessionMessage",
    "Skill",
    "TerminalControl",
    "TodoWrite",
    "view_image",
    "WebFetch",
    "WebSearch",
  ];
  const productOwnedToolNames = [
    "CreatePlan",
    "submit_code_review",
    "MCP",
    "InitMiniApp",
    "GenerativeUI",
    "ComputerUse",
    "CreateCanvas",
    "ReadCanvas",
    "UpdateCanvas",
    "PatchCanvas",
  ];

  assert.match(app, /const flowChatComponents = componentRegistry\.filter/);
  assert.match(app, /route === "flow-chat"/);
  assert.match(app, /<ComponentsPage\s+category="flow-chat"/);
  assert.match(catalog, /category === "flow-chat"/);
  assert.match(catalog, /<FlowChatToolGallery onOpenComponent=\{onOpenComponent\} \/>/);
  assert.match(gallery, /<FlowChatComponentPreview/);
  assert.match(gallery, /definition\.section === "tool-card"/);
  assert.deepEqual(specimenNames, migratedToolNames);
  assert.deepEqual(productOwnedNames, productOwnedToolNames);
  assert.equal(new Set(specimenNames).size, specimenNames.length);
  assert.equal(new Set(productOwnedNames).size, productOwnedNames.length);
  assert.equal(
    specimenNames.some((toolName) => productOwnedNames.includes(toolName)),
    false,
  );
  assert.match(gallery, /const productOwnedToolExamples/);
});

test("CommandToolCard previews follow the runtime command-state presentation", async () => {
  const preview = await readFile(flowChatPreviewSource, "utf8");
  const commandPreview =
    /function CommandPreview[\s\S]*?\r?\n}\r?\n\r?\nfunction resolveFileOperation/.exec(preview)?.[0];

  assert.ok(commandPreview);
  assert.match(
    commandPreview,
    /state === "expanded" \|\| state === "loading"/,
  );
  assert.match(commandPreview, /outputDensity=\{loading \? "compact" : "expanded"}/);
  assert.match(
    commandPreview,
    /statusLabel=\{state === "error"[\s\S]*?: undefined}/,
  );
  assert.match(commandPreview, /action=\{t\(sample\.actionKey\)\}/);
  assert.match(commandPreview, /<Timer aria-hidden="true" \/>/);
  assert.doesNotMatch(
    commandPreview,
    /statusLabel=\{[\s\S]*?components\.preview\.flowChat\.completed/,
  );
  assert.match(commandPreview, /const footerItems = completed \?/);
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

  assert.match(catalog, /case "Card"/);
  assert.match(detail, /case "Card":\s*return \["raised", "subtle", "media"\] as const/);
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

test("Button matrix is limited to the four reference interaction states", async () => {
  const source = await readFile(detailSource, "utf8");
  const declaration = /case "Button":\s*case "IconButton":\s*return \[([^\]]+)\] as const;/.exec(source);

  assert.ok(declaration);
  assert.deepEqual(
    [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["default", "hover", "active", "disabled"],
  );
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
    ["quiet", "outline", "fill", "primary"],
  );
  assert.match(source, /data-component="icon-button"/);
  assert.match(source, /aria-label=\{t\("components\.preview\.listView"\)\}/);
  assert.match(source, /icon=\{<List aria-hidden="true" \/>\}/);
  assert.match(source, /size=\{iconButtonSize\}/);
  assert.match(source, /shape=\{iconButtonShape\}/);
});

test("Icon preview exposes the complete named catalog and semantic controls", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(catalog, /case "Icon"/);
  assert.match(detail, /canonicalIconNames\.map\(\(name\)/);
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

  assert.match(catalog, /case "StatusPill"/);
  assert.match(detail, /case "StatusPill":\s*return \["neutral", "info", "success", "warning", "danger"\] as const/);
  assert.match(detail, /<StatusPill/);
  assert.match(detail, /leading=\{<Icon name="unselected" \/>\}/);
  assert.match(detail, /tone=\{state as StatusPillTone\}/);
});

test("Select preview exposes the unified open surface and independent states", async () => {
  const [catalog, detail] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
  ]);

  assert.match(catalog, /case "Select"/);
  assert.match(detail, /case "Select":\s*return \["default", "hover", "focus-visible", "open", "invalid", "disabled"\] as const/);
  assert.match(detail, /onValueChange=\{\(value\) => setSelectValue\(String\(value\)\)\}/);
  assert.match(detail, /leading=\{<Icon name="unselected" \/>\}/);
  assert.match(detail, /disabled=\{state === "disabled"\}/);
  assert.match(detail, /invalid=\{state === "invalid"\}/);
  assert.match(detail, /open=\{state === "open" \? true : undefined\}/);
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

  assert.match(catalog, /case "ActivityItem"/);
  assert.match(detail, /const activityItemAppearances = \["inline", "surface"\] as const/);
  assert.match(detail, /case "ActivityItem":\s*return \["default", "hover", "active", "focus-visible", "disabled"\] as const/);
  assert.match(detail, /appearance=\{activityItemAppearance\}/);
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

  assert.match(catalog, /case "Dialog":\s*case "Sheet":/);
  assert.match(detail, /component\.name === "Dialog"/);
  assert.match(detail, /component\.name === "Sheet"/);
  assert.match(detail, /renderDialogExample\(\)/);
  assert.match(detail, /renderSheetExample\(\)/);
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

  assert.match(catalog, /case "ConfirmDialog"/);
  assert.match(detail, /case "ConfirmDialog":\s*return \["info", "warning", "error", "success", "pending"\] as const/);
  assert.match(detail, /<ConfirmDialog/);
  assert.match(detail, /confirmDanger=\{confirmType === "error"\}/);
  assert.match(detail, /pendingAction=\{state === "pending" \? "confirm" : null\}/);
  assert.match(detail, /preview="\/workspace\/project"/);
  assert.match(detail, /open=\{overlayOpen\}/);
  assert.match(detail, /onOpenChange=\{\(\) => setOverlayOpen\(false\)\}/);
  assert.doesNotMatch(detail, /portalled=|preventScroll=|overlayClassName=|dialogClassName=/);
  assert.match(styles, /\.component-dialog-preview-stage\s*\{/);
});

test("Input, KeyHint, and SearchField previews expose composable slot and state contracts", async () => {
  const source = await readFile(detailSource, "utf8");

  assert.match(source, /case "Input":\s*case "SearchField":\s*return \["default", "filled", "hover", "focus-visible", "read-only", "invalid", "disabled"\] as const/);
  assert.match(source, /case "Select":\s*return \["default", "hover", "focus-visible", "open", "invalid", "disabled"\] as const/);
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

  assert.match(catalog, /case "ScrollArea"/);
  assert.match(detail, /const scrollAreaOrientations = \["vertical", "horizontal", "both"\] as const/);
  assert.match(detail, /case "ScrollArea":\s*return \["auto", "always", "hidden"\] as const/);
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

  assert.match(catalog, /case "Menu"/);
  assert.match(detail, /MenuSection/);
  assert.match(detail, /MenuSeparator/);
  assert.match(detail, /"scrolling", "focus-within", "disabled-item", "checked-item"/);
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

  assert.match(catalog, /case "NavigationPanel"/);
  assert.match(detail, /NavigationPanelSection/);
  assert.match(detail, /NavigationPanelSeparator/);
  assert.match(detail, /"default", "selected-item", "disabled-item", "scrolling"/);
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

  assert.match(catalog, /case "Composer"/);
  assert.match(detail, /ComposerContextBar/);
  assert.match(detail, /ComposerDivider/);
  assert.match(detail, /ComposerToolbar/);
  assert.match(detail, /"default", "focus-within", "with-context", "invalid", "disabled"/);
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
  assert.match(source, /orientation=\{fieldOrientation\}/);
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

  assert.match(source, /case "FieldGroup":\s*return \["subtle", "plain", "divided"\] as const/);
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

test("TabGroup preview carries the selected and outline reference composition", async () => {
  const source = await readFile(detailSource, "utf8");
  const declaration = /case "TabGroup":\s*return \[([^\]]+)\] as const;/.exec(source);

  assert.ok(declaration);
  assert.deepEqual(
    [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["selected", "unselected", "hover", "disabled"],
  );
  assert.match(source, /name="session"/);
  assert.match(source, /components\.preview\.welcome/);
  assert.match(source, /components\.preview\.settings/);
  assert.match(source, /data-component="tab-group"/);
  assert.match(source, /<TabGroup/);
  assert.match(source, /setTabGroupSize/);
  assert.match(source, /size=\{tabGroupSize\}/);
});

test("Toolbar preview keeps leading, centered, trailing, and overflow compositions independent", async () => {
  const [catalog, detail, styles] = await Promise.all([
    readFile(catalogSource, "utf8"),
    readFile(detailSource, "utf8"),
    readFile(stylesSource, "utf8"),
  ]);

  assert.match(catalog, /case "Toolbar"/);
  assert.match(detail, /ToolbarBadge/);
  assert.match(detail, /ToolbarGroup/);
  assert.match(detail, /ToolbarSeparator/);
  assert.match(detail, /case "Toolbar":\s*return \["default", "with-center", "overflow"\] as const/);
  assert.match(detail, /leadingOverflow=\{state === "overflow" \? "scroll" : "visible"\}/);
  assert.match(detail, /center=\{state === "with-center"/);
  assert.match(detail, /items=\{tabItems\}\s+size="sm"/);
  assert.match(detail, /setToolbarSize/);
  assert.match(styles, /\.component-toolbar-example\s*\{[^}]*max-inline-size:\s*760px/s);
});

test("Combobox details render their own live state and menus include nested interaction", async () => {
  const detail = await readFile(detailSource, "utf8");
  assert.match(detail, /data-component="combobox"/);
  assert.match(detail, /defaultOpen=\{state === "open" \|\| state === "searching" \|\| state === "loading" \|\| state === "empty"\}/);
  assert.match(detail, /onCreateValue=\{state === "custom"/);
  assert.match(detail, /component\.name === "MultiSelect"/);
  assert.match(detail, /onValueChange=\{setMultiSelectValues\}/);
  assert.match(detail, /value=\{multiSelectValues\}/);
  assert.match(detail, /<NestedMenuPattern/);
});

test("wide surfaces stack independently and compact pickers do not reserve empty canvas", async () => {
  const [detail, styles] = await Promise.all([readFile(detailSource, "utf8"), readFile(stylesSource, "utf8")]);
  assert.match(detail, /component.name === "Menu" \|\| component.name === "NavigationPanel" \|\| component.name === "FieldGroup" \? \(/);
  assert.match(detail, /className="component-surface-state-list__preview"/);
  assert.match(styles, /\.component-surface-state-list\s*\{[^}]*display: grid/);
  assert.match(styles, /\.component-surface-state-list__preview\s*\{[^}]*overflow: auto/);
  const picker = styles.match(/\.component-combobox-preview\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(picker, /padding:/);
  assert.doesNotMatch(picker, /min-block-size: 280px/);
  assert.match(styles, /\.component-inspector-preview\s*\{[^}]*overflow: auto/);
});

test("form previews preserve specimen width and their simulated field states", async () => {
  const styles = await readFile(stylesSource, "utf8");
  assert.match(styles, /\.component-field-group-example\s*\{[^}]*min-inline-size:\s*440px/);
  assert.match(styles, /\.component-textarea-example\s*\{[^}]*inline-size:\s*280px/);
  assert.match(styles, /\.component-textarea-example\.lab-state-hover textarea[^{}]*\{[^}]*--openbitfun-color-field-border-hover/);
  assert.match(styles, /\.component-textarea-example\.lab-state-focus-visible textarea[^{}]*\{[^}]*--openbitfun-color-focus-ring/);
  assert.match(styles, /\.component-preview-matrix\[data-state-count="7"\]\s*\{[^}]*repeat\(7,/);
});
