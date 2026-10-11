import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabGroup } from "../dist/index.js";

const items = [
  {
    icon: createElement("svg", { "data-icon": "welcome" }),
    label: "Welcome",
    panelId: "welcome-panel",
    value: "welcome",
  },
  {
    icon: createElement("svg", { "data-icon": "settings" }),
    label: "Settings",
    panelId: "settings-panel",
    value: "settings",
  },
];

test("TabGroup exposes a single selected tab with native button behavior", () => {
  const markup = renderToStaticMarkup(
    createElement(TabGroup, {
      "aria-label": "Workspace views",
      defaultValue: "welcome",
      items,
    }),
  );

  assert.match(markup, /data-openbitfun-component="tab-group"/);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /aria-orientation="horizontal"/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 2);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(markup, /aria-controls="welcome-panel"/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /tabindex="-1"/);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-overflow-behavior="marquee"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-overflow-trigger="true"/g) ?? []).length, 2);
});

test("tab presentation props reach the button without replacing its owned semantics", () => {
  const markup = renderToStaticMarkup(createElement(TabGroup, {
    items: [{ ...items[0], id: "product-tab", tabProps: {
      className: "product-tab", "data-openbitfun-product-component": "product",
      "data-openbitfun-product-part": "tab", title: "Full title",
      "aria-describedby": "help", style: { opacity: 0.8 },
      // Untyped callers must not override component-owned interaction/identity.
      role: "button", type: "submit", tabIndex: 8, id: "wrong-id",
      "aria-selected": false, "aria-controls": "wrong-panel", "data-openbitfun-part": "wrong-part",
    } }],
  }));
  const button = markup.match(/<button\b[^>]*>/)?.[0] ?? "";
  assert.match(button, /class="[^" ]+ product-tab"/);
  assert.match(button, /data-openbitfun-product-component="product"/);
  assert.match(button, /data-openbitfun-product-part="tab"/);
  assert.match(button, /aria-describedby="help"/);
  assert.match(button, /style="opacity:0.8"/);
  assert.match(button, /title="Full title"/);
  assert.match(button, /id="product-tab"/);
  assert.match(button, /role="tab"/);
  assert.match(button, /type="button"/);
  assert.match(button, /tabindex="0"/);
  assert.match(button, /aria-selected="true"/);
  assert.match(button, /aria-controls="welcome-panel"/);
  assert.match(button, /data-openbitfun-part="tab"/);
});

test("controlled value and disabled items preserve selection and focus contracts", () => {
  const markup = renderToStaticMarkup(
    createElement(TabGroup, {
      "aria-label": "Workspace views",
      items: [items[0], { ...items[1], disabled: true }],
      value: "welcome",
    }),
  );

  assert.match(markup, /Welcome<\/span><\/span><\/button>/);
  assert.match(markup, /aria-disabled="true"/);
  assert.match(markup, /disabled=""/);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
});

test("product wrappers preserve the standard tablist, selection and end-action anatomy", () => {
  const markup = renderToStaticMarkup(createElement(TabGroup, {
    items: [items[0], {
      ...items[1],
      endAction: createElement("button", { type: "button", "aria-label": "Close Settings" }, "Close"),
    }],
    value: "settings",
    renderItem: (item, node, index) => createElement("div", {
      "data-document": item.value,
      "data-index": index,
      draggable: true,
    }, node),
  }));

  assert.equal((markup.match(/role="tablist"/g) ?? []).length, 1);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 2);
  assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(markup, /data-document="settings" data-index="1" draggable="true"/);
  assert.match(markup, /<\/button><span[^>]+data-openbitfun-part="endAction"[^>]*><button/);
});

test("label metadata remains inside the accessible tab and outside rolling text", () => {
  const markup = renderToStaticMarkup(createElement(TabGroup, {
    items: [{ value: "session", label: "New Session", labelTransitionKey: "session-2", labelSuffix: "02" }],
  }));
  assert.match(markup, /data-openbitfun-component="rolling-text"/);
  assert.match(markup, /<span[^>]*data-openbitfun-part="labelSuffix">02<\/span><\/button>/);
  assert.equal((markup.match(/role="tab"/g) ?? []).length, 1);
});

test("TabGroup exposes compact and standard geometry without changing selection behavior", () => {
  const standardMarkup = renderToStaticMarkup(
    createElement(TabGroup, { "aria-label": "Standard tabs", items }),
  );
  const compactMarkup = renderToStaticMarkup(
    createElement(TabGroup, { "aria-label": "Compact tabs", items, size: "sm" }),
  );

  assert.match(standardMarkup, /data-size="md"/);
  assert.match(compactMarkup, /data-size="sm"/);
  assert.equal((compactMarkup.match(/aria-selected="true"/g) ?? []).length, 1);
});

test("icons are decorative and labels remain accessible", () => {
  const markup = renderToStaticMarkup(
    createElement(TabGroup, { "aria-label": "Workspace views", items }),
  );

  assert.equal((markup.match(/aria-hidden="true"/g) ?? []).length, 2);
  assert.match(markup, /data-icon="welcome"/);
  assert.match(markup, />Welcome<\/span>/);
  assert.match(markup, />Settings<\/span>/);
});

test("end actions are rendered beside tabs instead of nesting interactive controls", () => {
  const markup = renderToStaticMarkup(
    createElement(TabGroup, {
      "aria-label": "Workspace views",
      items: [
        items[0],
        {
          label: "Settings",
          panelId: "settings-panel",
          value: "settings",
          endAction: createElement(
            "button",
            { "aria-label": "Close Settings", type: "button" },
            "Close",
          ),
        },
      ],
    }),
  );

  assert.equal((markup.match(/data-openbitfun-part="item"/g) ?? []).length, 2);
  assert.equal((markup.match(/data-has-end-action="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/data-has-icon="true"/g) ?? []).length, 1);
  assert.equal((markup.match(/data-has-icon="false"/g) ?? []).length, 1);
  assert.match(markup, /data-openbitfun-part="endAction"/);
  assert.match(markup, /<\/button><span[^>]+data-openbitfun-part="endAction"[^>]*><button/);
  assert.equal((markup.match(/type="button"/g) ?? []).length, 3);
});

test("end actions float over the label without reserving or clipping text", async () => {
  const styles = await readFile(new URL("../src/components/TabGroup/TabGroup.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /action-reserve|clip-path|mask-image/);
  assert.doesNotMatch(styles, /data-has-end-action[^}]*padding-inline/s);
});

test("TabGroup styling uses its geometry contract and Button semantic colors", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-control-tab-group-gap/);
  assert.match(styles, /--openbitfun-control-tab-group-item-gap/);
  assert.match(styles, /--openbitfun-control-tab-group-item-height/);
  assert.match(styles, /--openbitfun-control-tab-group-item-height-sm/);
  assert.match(styles, /--openbitfun-control-tab-group-item-icon-size/);
  assert.match(styles, /--openbitfun-control-tab-group-item-padding-inline/);
  assert.match(styles, /--openbitfun-control-tab-group-item-padding-block-sm/);
  assert.match(styles, /--openbitfun-control-tab-group-item-padding-inline-sm/);
  assert.match(styles, /--openbitfun-control-tab-group-item-action-size/);
  assert.match(styles, /--openbitfun-control-tab-group-item-radius/);
  assert.match(styles, /--openbitfun-color-action-neutral-border/);
  assert.match(styles, /--openbitfun-color-action-neutral-content/);
  assert.match(styles, /--openbitfun-color-content-primary/);
  assert.match(styles, /--openbitfun-color-action-neutral-surface/);
  assert.match(styles, /--openbitfun-type-label-md-font-weight/);
  assert.match(styles, /--openbitfun-type-label-selected-font-weight/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("tab labels and icons keep primary content across selection states", async () => {
  const styles = await readFile(
    new URL("../src/components/TabGroup/TabGroup.module.css", import.meta.url),
    "utf8",
  );

  assert.match(
    styles,
    /\.tab\s*\{[^}]*--_tab-content:\s*var\(--openbitfun-color-content-primary\);/s,
  );
  assert.doesNotMatch(
    styles,
    /\.tab\[aria-selected="true"\]\s*\{[^}]*--_tab-content:/s,
  );
  assert.match(
    styles,
    /\.label\s*\{[^}]*line-height:\s*var\(--openbitfun-type-label-md-line-height\);/s,
  );
});

test("TabGroup implements wrapped arrow, Home, and End navigation", async () => {
  const source = await readFile(
    new URL("../src/components/TabGroup/TabGroup.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /ArrowRight/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /enabledItems\.length/);
  assert.match(source, /onValueChange\?\.\(item\.value\)/);
});
