import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { componentRegistry } from "@openbitfun/ui/registry";

let server;
let render;
let presentation;
let renderPage;

before(async () => {
  // Load actual Lab modules without a browser, generated inspector, or mock components.
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  const { ComponentsPage } = await server.ssrLoadModule("/src/pages/ComponentsPage.tsx");
  const { I18nContext } = await server.ssrLoadModule("/src/i18n/I18nProvider.tsx");
  const { messages } = await server.ssrLoadModule("/src/i18n/messages.ts");
  const { translateFromCatalog } = await server.ssrLoadModule("/src/i18n/core.mjs");
  presentation = await server.ssrLoadModule("/src/preview/componentPresentation.ts");
  const { ColorsPage } = await server.ssrLoadModule("/src/pages/ColorsPage.tsx");
  const { PatternsPage } = await server.ssrLoadModule("/src/pages/PatternsPage.tsx");
  renderPage = (name, locale) => renderToStaticMarkup(createElement(I18nContext.Provider, {
    value: { locale, setLocale() {}, t: (key, params) => translateFromCatalog(messages, locale, key, params) },
  }, createElement(name === "colors" ? ColorsPage : PatternsPage, {
    colorScheme: "light", contrast: "standard", density: "compact", mode: "light",
    tokenOverrides: {}, onModeChange() {}, onDensityChange() {},
  })));
  render = (name) => {
    const component = componentRegistry.find(item => item.name === name) ?? { name, states: ["default"], props: [], tokens: [], category: "form", description: "", maturity: "stable" };
    const html = renderToStaticMarkup(createElement(I18nContext.Provider, {
      value: { locale: "zh-CN", setLocale() {}, t: (key, params) => translateFromCatalog(messages, "zh-CN", key, params) },
    }, createElement(ComponentsPage, {
      component, colorScheme: "light", contrast: "standard", density: "comfortable",
      tokenOverrides: {}, onOpenComponent() {}, onInspectTokens() {},
    })));
    // Exclude inspector controls, which legitimately contain switches.
    const preview = html.split('id="component-workbench"')[1]?.split('<section class="component-code-panel')[0];
    assert.ok(preview, `Missing preview panel: ${name}`);
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, "The preview must be embedded in the library page");
    if (componentRegistry.some(item => item.name === name)) {
      assert.ok(html.includes(`href="#component/${name.toLowerCase()}" aria-current="page"`), `Missing selected navigation entry: ${name}`);
    }
    return { html, preview };
  };
});

after(async () => { await server?.close(); });

test("color and pattern directories expose one labelled panel while retaining other examples", () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW"]) {
    for (const [page, prefix, selected, count] of [
      ["colors", "colors", "semantic", 4],
      ["patterns", "pattern", "settings", 7],
    ]) {
      const html = renderPage(page, locale);
      const panels = [...html.matchAll(new RegExp(`<section[^>]+id="${prefix}-([a-z]+)"[^>]*role="tabpanel"[^>]*>`, "g"))];
      assert.equal(panels.length, count, `${page} must retain its complete directory`);
      assert.deepEqual(panels.filter(([tag]) => !/\shidden(?:=|\s|>)/.test(tag)).map(([, id]) => id), [selected]);
      for (const [tag, id] of panels) {
        assert.ok(tag.includes(`aria-labelledby="${prefix}-tab-${id}"`));
        assert.ok(html.includes(`id="${prefix}-tab-${id}"`));
      }
      assert.doesNotMatch(html, />patterns\.[^<]+<|>colors\.[^<]+</);
    }
  }
});

test("Textarea opens with its editable, validation and disabled examples visible", () => {
  const { html, preview } = render("Textarea");
  assert.equal((preview.match(/data-openbitfun-component="textarea"/g) ?? []).length, 5);
  assert.equal((preview.match(/<textarea\b/g) ?? []).length, 5);
  for (const state of ["hover", "focus-visible", "invalid", "disabled"]) assert.ok(preview.includes(`data-state="${state}"`));
  assert.match(preview, /data-openbitfun-part="count"/);
  assert.doesNotMatch(preview, /data-openbitfun-component="switch"|>Switch<|>关闭<|>开启</);
  assert.match(html, /import \{ Textarea \}/);
});

test("other components formerly using the fallback render their own state specimens", () => {
  for (const name of ["Alert", "Avatar", "Checkbox", "NumberInput", "Radio", "Empty"]) {
    const { preview, html } = render(name);
    const componentId = name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    assert.match(preview, new RegExp(`data-openbitfun-component="${componentId}"`), name);
    assert.match(preview, /class="[^"]*design-component-overview/);
    assert.doesNotMatch(preview, /<details/);
    assert.doesNotMatch(preview, /component-preview-matrix/);
    assert.doesNotMatch(preview, /data-openbitfun-component="switch"|>Switch</, name);
    assert.doesNotMatch(html, /import \{ Switch \}/, name);
  }
  assert.match(render("Alert").preview, /data-state="error"/);
  assert.match(render("Avatar").preview, /<img/);
});

test("LauncherButton exposes its interaction states with the catalog mic", () => {
  const { html, preview } = render("LauncherButton");

  assert.equal(
    (preview.match(/data-openbitfun-component="launcher-button"/g) ?? []).length,
    5,
  );
  assert.match(preview, /data-openbitfun-name="mic"/);
  for (const state of ["hover", "active", "disabled"]) assert.ok(preview.includes(`data-state="${state}"`));
  assert.match(html, /import \{ Icon, LauncherButton \}/);
});

test("FieldGroup compares complete form groups at their natural width", () => {
  const { preview } = render("FieldGroup");
  assert.equal((preview.match(/data-openbitfun-component="field-group"/g) ?? []).length, 3);
  for (const state of ["subtle", "plain", "divided"]) assert.ok(preview.includes(`data-state="${state}"`));
  assert.doesNotMatch(preview, /component-preview-matrix/);
});

test("Switch is explicit and unknown components never silently become switches", () => {
  assert.match(render("Switch").preview, /data-openbitfun-component="switch"/);
  const { preview } = render("UnregisteredExample");
  assert.match(preview, /此组件尚未实现预览/);
  assert.doesNotMatch(preview, /data-openbitfun-component="switch"/);
});

test("RollingText exposes real standalone and TabGroup replacement specimens", () => {
  const { preview, html } = render("RollingText");
  assert.match(preview, /data-openbitfun-component="rolling-text"/);
  assert.match(preview, /data-openbitfun-component="tab-group"/);
  assert.match(preview, /替换标题/);
  assert.match(html, /labelTransitionKey/);
});

test("Icon details include real mixed-icon compositions at every button size", () => {
  const { preview } = render("Icon");
  assert.match(preview, /component-icon-composition/);
  for (const size of ["xs", "sm", "md", "lg"]) {
    assert.match(preview, new RegExp(`Button / ${size}`));
    assert.match(preview, new RegExp(`aria-label="SVG / ${size}"`));
    assert.match(preview, new RegExp(`aria-label="Icon / ${size}"`));
  }
  assert.match(preview, /data-openbitfun-component="tab-group"/);
  assert.match(preview, /data-openbitfun-component="input"/);
  assert.match(preview, /design-icon-directory/);
  assert.match(preview, /aria-label="搜索图标"/);
});

test("the complete registry has an authored presentation and a renderable default", () => {
  for (const component of componentRegistry) {
    assert.ok(presentation.hasAuthoredPresentation(component), `Choose a suitable presentation for ${component.name}`);
    assert.ok(component.states.includes(presentation.getInitialPreviewState(component)), `Invalid initial state for ${component.name}`);
    const { preview } = render(component.name);
    assert.doesNotMatch(preview, /此组件尚未实现预览/, component.name);
    if (presentation.getComponentPresentation(component) === "interactive") {
      assert.doesNotMatch(preview, /component-preview-matrix|design-component-overview|role="dialog"|role="alertdialog"/, component.name);
    }
  }
});

test("important choices and semantic variants are visible without opening an inspector", () => {
  const button = render("Button").preview;
  for (const variant of ["outline", "fill", "secondary", "primary", "text"]) assert.ok(button.includes(`data-openbitfun-variant="${variant}"`));
  const iconButton = render("IconButton").preview;
  assert.ok(iconButton.includes('data-state-count="6"'));
  assert.ok(iconButton.includes('aria-busy="true"'));
  const status = render("StatusPill").preview;
  for (const tone of ["neutral", "accent", "info", "success", "warning", "danger"]) assert.ok(status.includes(`data-tone="${tone}"`));
  const field = render("Field").preview;
  assert.ok(field.includes('data-invalid="true"'));
  assert.ok(field.includes('aria-invalid="true"'));
  assert.ok(render("ActivityItem").preview.includes('data-appearance="inline"'));
});

test("navigation and mobile components open in usable compositions", () => {
  assert.match(render("TabGroup").preview, /role="tabpanel"/);
  assert.match(render("SegmentedControl").preview, /data-selected-content="chat"/);
  assert.match(render("MobileComposer").preview, /<textarea/);
  assert.match(render("MobileComposer").preview, /data-openbitfun-component="mobile-message"/);
  assert.doesNotMatch(render("Composer").preview.match(/<textarea[^>]*>/)?.[0] ?? "", /readonly/);
  assert.match(render("MobileScrim").preview, /design-scrim-example/);
});
