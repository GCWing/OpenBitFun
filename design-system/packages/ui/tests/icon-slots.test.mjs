import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Icon, IconButton, SessionIcon, TabGroup } from "../dist/index.js";
import { Network } from "lucide-react";

const slots = [
  ["Button", "icon", "inline-size", "100%"],
  ["LauncherButton", "icon", "inline-size", "100%"],
  ["IconButton", "icon", "inline-size", "100%"],
  ["TabGroup", "icon", "inline-size", "100%"],
  ["ActionCard", "leading", "inline-size", "var(--openbitfun-control-action-card-icon-size)"],
  ["ActionItem", "leading", "inline-size", "100%"],
  ["ActivityItem", "leading", "inline-size", "100%"],
  ["SegmentedControl", "icon", "inline-size", "100%"],
  ["KeyHint", "icon", "inline-size", "1em"],
  ["Input", "leading", "inline-size", "var(--_field-icon-size)"],
  ["Input", "trailing", "inline-size", "var(--_field-icon-size)"],
  ["SearchField", "icon", "inline-size", "100%"],
  ["Select", "leading", "inline-size", "100%"],
  ["Select", "indicator", "inline-size", "100%"],
  ["StatusPill", "leading", "inline-size", "100%"],
  ["Avatar", "content", "inline-size", "55%"],
  ["Empty", "media", "inline-size", "var(--_empty-icon-size)"],
  ["ConfirmDialog", "icon", "inline-size", "var(--openbitfun-layout-confirm-dialog-icon-glyph-size)"],
  ["Listbox", "leading", "inline-size", "100%"],
  ["Listbox", "indicator", "inline-size", "100%"],
];

const markedSlotSources = [
  ["ActionCard/ActionCard.tsx", 1],
  ["ActionItem/ActionItem.tsx", 1],
  ["ActivityItem/ActivityItem.tsx", 1],
  ["Avatar/Avatar.tsx", 1],
  ["Button/Button.tsx", 2],
  ["Combobox/Combobox.tsx", 2],
  ["ConfirmDialog/ConfirmDialog.tsx", 1],
  ["Empty/Empty.tsx", 1],
  ["IconButton/IconButton.tsx", 1],
  ["Input/Input.tsx", 2],
  ["KeyHint/KeyHint.tsx", 1],
  ["LauncherButton/LauncherButton.tsx", 1],
  ["Listbox/Listbox.tsx", 2],
  ["Menu/MenuPopover.tsx", 1],
  ["SearchField/SearchField.tsx", 1],
  ["SegmentedControl/SegmentedControl.tsx", 1],
  ["Select/Select.tsx", 2],
  ["StatusPill/StatusPill.tsx", 1],
  ["TabGroup/TabGroup.tsx", 1],
];

test("sized slots apply the same geometry to SVG and catalog icons, regardless of stylesheet order", async () => {
  for (const [component, slot, property, value] of slots) {
    const css = await readFile(new URL(`../src/components/${component}/${component}.module.css`, import.meta.url), "utf8");
    // Class + attribute specificity beats Icon's class-only dimensions, even if
    // the Icon stylesheet loads later during source HMR or a production build.
    const selector = `.${slot} > [data-openbitfun-component="icon"]`;
    const rule = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].find(([, selectors]) => selectors.includes(selector));
    assert.ok(rule, `${component}.${slot} must directly size catalog icons`);
    assert.match(rule[1], /svg/, `${component}.${slot} must retain SVG support`);
    assert.ok(rule[2].includes(`${property}: ${value}`), `${component}.${slot}: ${property}`);
    assert.ok(rule[2].includes(`${property.replace("inline", "block")}: ${value}`), `${component}.${slot}: block size`);
  }
});

test("buttons route native and default-size catalog icons through identical slots at every size", () => {
  for (const size of ["xs", "sm", "md", "lg"]) {
    const catalog = createElement(Icon, { name: "settings" });
    const svg = createElement("svg", { width: 24, height: 24 });
    for (const [Component, props] of [
      [Button, { children: "Settings", leadingIcon: catalog, trailingIcon: svg }],
      [IconButton, { "aria-label": "Settings", icon: catalog }],
    ]) {
      const markup = renderToStaticMarkup(createElement(Component, { ...props, size }));
      assert.match(markup, new RegExp(`data-size="${size}"`));
      assert.match(markup, /<span[^>]*class="[^"]*_icon_[^"]*"[^>]*><span[^>]*data-openbitfun-component="icon"/);
      assert.match(markup, /data-openbitfun-name="settings"[^>]*data-size="lg"/);
    }
  }
});

test("buttons constrain normalized line fallbacks through the same icon slot", () => {
  const lineIcon = createElement(Icon, { glyph: Network });
  for (const [Component, props] of [
    [Button, { children: "Network", leadingIcon: lineIcon }],
    [IconButton, { "aria-label": "Network", icon: lineIcon }],
  ]) {
    const markup = renderToStaticMarkup(createElement(Component, props));
    assert.match(markup, /data-openbitfun-component="icon"/);
    assert.match(markup, /data-openbitfun-source="line"/);
    assert.match(markup, /<svg[^>]*stroke-width="1.6"/);
  }
});

test("public icon slots normalize default Lucide weight without changing custom artwork", async () => {
  const layers = await readFile(new URL("../src/styles/layers.css", import.meta.url), "utf8");
  const rule = [...layers.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
    .find(([, selectors]) => selectors.includes('[data-openbitfun-icon-slot="true"]'));

  assert.ok(rule, "shared icon-slot normalization rule must exist");
  assert.match(rule[1], /svg\.lucide\[stroke-width="2"\]/);
  assert.match(rule[2], /color:\s*inherit/);
  assert.match(rule[2], /stroke-width:\s*1\.6/);

  for (const [Component, props] of [
    [Button, { children: "Network", leadingIcon: createElement(Network) }],
    [IconButton, { "aria-label": "Network", icon: createElement(Network) }],
  ]) {
    const markup = renderToStaticMarkup(createElement(Component, props));
    const svg = markup.match(/<svg[^>]*>/)?.[0] ?? "";
    assert.match(markup, /data-openbitfun-icon-slot="true"/);
    assert.match(svg, /class="lucide lucide-network"/);
    assert.match(svg, /stroke-width="2"/);
  }

  const customMarkup = renderToStaticMarkup(createElement(IconButton, {
    "aria-label": "Filled network",
    icon: createElement(Network, { fill: "currentColor", strokeWidth: 0 }),
  }));
  assert.match(customMarkup, /<svg[^>]*stroke-width="0"/);
});

test("every public sized icon wrapper opts into the shared slot contract", async () => {
  for (const [file, expectedCount] of markedSlotSources) {
    const source = await readFile(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    const count = source.match(/data-openbitfun-icon-slot="true"/g)?.length ?? 0;
    assert.equal(count, expectedCount, file);
  }
});

test("tabs keep native session icons and catalog scene icons in the same sized region", () => {
  const markup = renderToStaticMarkup(createElement(TabGroup, {
    "aria-label": "Scenes",
    defaultValue: "session",
    items: [
      { value: "session", label: "Session", icon: createElement(SessionIcon) },
      { value: "settings", label: "Settings", icon: createElement(Icon, { name: "settings" }) },
      { value: "assistant", label: "Assistant", icon: createElement(Icon, { name: "user" }) },
    ],
  }));
  assert.equal((markup.match(/data-openbitfun-part="icon"/g) ?? []).length, 3);
  assert.match(markup, /data-openbitfun-part="icon"[^>]*><svg/);
  assert.match(markup, /data-openbitfun-part="icon"[^>]*><span[^>]*data-openbitfun-component="icon"/);
});

test("standalone catalog sizes are retained instead of globally shrinking every icon", () => {
  for (const size of ["2xs", "xs", "sm", "md", "lg"]) {
    const markup = renderToStaticMarkup(createElement(Icon, { name: "settings", size }));
    assert.match(markup, new RegExp(`data-size="${size}"`));
  }
});
