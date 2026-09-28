import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Lab navigation, theme resources and export actions consume the shared icon catalog", async () => {
  const source = relative => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");
  const app = await source("App.tsx");
  assert.match(app, /<LabNavigation/);
  assert.match(app, /name="settings"/);
  assert.match(app, /icon: "palette"/);
  assert.doesNotMatch(app, /\b(?:Palette|Settings2)\b/);
  for (const page of ["ResourcesPage", "GettingStartedPage"]) {
    const markup = await source(`pages/${page}.tsx`);
    assert.match(markup, /icon: "palette"/);
    assert.match(markup, /<CatalogIcon name=\{Icon\}/);
    assert.doesNotMatch(markup, /\bPalette\b/);
  }
  const workbench = await source("token-editor/TokenWorkbench.tsx");
  assert.match(workbench, /<Icon name="arrow-down" size="sm"/);
  assert.doesNotMatch(workbench, /\bDownload\b/);
});

test("the website has three primary destinations and a unified public catalog", async () => {
  const source = relative => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");
  const [app, navigation, catalog] = await Promise.all([source("App.tsx"), source("components/LabNavigation.tsx"), source("pages/ComponentsPage.tsx")]);
  assert.match(navigation, /\["components", "foundations", "brand"\]/);
  assert.match(app, /category=\{route.page === "mobile" \? "mobile" : route.page === "flow-chat" \? "flow-chat" : undefined\}/);
  assert.match(catalog, /const catalogComponents = componentRegistry\.filter/);
  assert.match(catalog, /<nav className="design-library-list"/);
  assert.match(catalog, /<ComponentDetailPage key=\{selectedComponent.name\} embedded/);
  assert.doesNotMatch(app, /expandedComponentGroups|lab-standard-component-links/);
});

test("every published mobile component has catalog and detail previews", async () => {
  const source = relative => readFile(new URL(`../src/${relative}`, import.meta.url), "utf8");
  const [mobileEntry, catalog, detail, metadata] = await Promise.all([
    readFile(new URL("../../../packages/ui/src/mobile.ts", import.meta.url), "utf8"),
    source("pages/ComponentsPage.tsx"),
    source("pages/ComponentDetailPage.tsx"),
    source("i18n/componentMetadata.ts"),
  ]);
  const componentNames = [
    ...mobileEntry.matchAll(/^\s*(Mobile[A-Za-z]+),$/gm),
  ].map(match => match[1]);

  assert.ok(componentNames.length > 0);
  for (const componentName of componentNames) {
    assert.match(catalog, new RegExp(`case "${componentName}"`), `${componentName} lacks a catalog preview`);
    assert.match(detail, new RegExp(`component\\.name === "${componentName}"`), `${componentName} lacks a detail preview`);
    assert.match(metadata, new RegExp(`\\b${componentName}:`), `${componentName} lacks localized metadata`);
  }
});
