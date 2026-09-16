import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IconButton, SearchField, Tooltip } from "../dist/index.js";

test("SearchField composes search semantics with icon and shortcut slots", () => {
  const markup = renderToStaticMarkup(
    createElement(SearchField, {
      "aria-label": "Search",
      leadingIcon: createElement("svg", { "data-icon": "search" }),
      placeholder: "Search",
      shortcut: "Ctrl K",
    }),
  );

  assert.match(markup, /data-openbitfun-component="search-field"/);
  assert.match(markup, /type="search"/);
  assert.match(markup, /data-icon="search"/);
  assert.match(markup, /Ctrl K/);
  assert.equal((markup.match(/aria-hidden="true"/g) ?? []).length, 2);
});

test("SearchField source preserves consumer key handling before Enter submission", async () => {
  const source = await readFile(
    new URL("../src/components/SearchField/SearchField.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /onKeyDown\?\.\(event\)/);
  assert.match(source, /!event\.defaultPrevented && event\.key === "Enter"/);
  assert.match(source, /onSearch\?\.\(event\.currentTarget\.value\)/);
});

test("SearchField supports embedded composition without leaking its variant onto the input", async () => {
  const markup = renderToStaticMarkup(createElement(SearchField, {
    "aria-label": "Search modes",
    size: "sm",
    variant: "embedded",
  }));
  assert.match(markup, /data-openbitfun-component="search-field" data-variant="embedded"/);
  assert.doesNotMatch(markup, /<input[^>]*variant=/);
  assert.match(markup, /type="search"/);

  const styles = await readFile(new URL("../src/components/SearchField/SearchField.module.css", import.meta.url), "utf8");
  const embedded = styles.match(/\.root\[data-variant="embedded"\][^{]+\{([^}]+)\}/)?.[1] ?? "";
  assert.match(embedded, /block-size:\s*100%/);
  assert.match(embedded, /padding:\s*0/);
  assert.match(embedded, /border:\s*0/);
  assert.match(embedded, /background:\s*transparent/);
  assert.match(embedded, /box-shadow:\s*none/);
});

test("SearchField renders custom trailing content before the clear action", () => {
  const markup = renderToStaticMarkup(
    createElement(SearchField, {
      "aria-label": "Search",
      clearLabel: "Clear search",
      onClear: () => {},
      trailing: createElement("span", { "data-part": "matches" }, "1 / 5"),
      value: "query",
    }),
  );

  const trailingIndex = markup.indexOf('data-part="matches"');
  const clearIndex = markup.indexOf('aria-label="Clear search"');
  assert.ok(trailingIndex >= 0);
  assert.ok(clearIndex >= 0);
  assert.ok(trailingIndex < clearIndex);
});

test("SearchField only exposes its footer in the panel variant and preserves input semantics", () => {
  const props = {
    "aria-label": "Search messages",
    footer: createElement("span", { role: "status" }, "1 / 7 results"),
    value: "device",
  };
  const panel = renderToStaticMarkup(createElement(SearchField, { ...props, variant: "panel" }));
  assert.match(panel, /data-openbitfun-component="search-field" data-variant="panel"/);
  assert.match(panel, /<input[^>]*aria-label="Search messages"[^>]*type="search"[^>]*value="device"/);
  assert.match(panel, /data-openbitfun-part="footer"><span role="status">1 \/ 7 results<\/span>/);
  assert.doesNotMatch(panel, /<input[^>]*(?:footer|variant)=/);

  for (const variant of ["default", "embedded"]) {
    const markup = renderToStaticMarkup(createElement(SearchField, { ...props, variant }));
    assert.doesNotMatch(markup, /data-openbitfun-part="footer"|1 \/ 7 results/);
  }
});

test("SearchField sizes both row and panel while retaining tooltip-wrapped terminal actions", () => {
  for (const size of ["sm", "md", "lg"]) {
    for (const variant of ["default", "panel", "embedded"]) {
      const markup = renderToStaticMarkup(createElement(SearchField, {
        "aria-label": "Search", size, variant,
        trailing: createElement("span", null, "Matches"),
        shortcut: "Ctrl K",
        trailingAction: createElement(Tooltip, { content: "Close" },
          createElement(IconButton, { "aria-label": "Close", icon: "X", size: "xs", shape: "square" })),
        clearLabel: "Clear", onClear() {},
      }));
      assert.match(markup, new RegExp(`data-openbitfun-component="search-field" data-variant="${variant}" data-size="${size}"`));
      assert.match(markup, new RegExp(`data-openbitfun-component="input"[^>]*data-size="${size}"`));
      assert.ok(markup.indexOf("Matches") < markup.indexOf("Ctrl K"));
      assert.ok(markup.indexOf("Ctrl K") < markup.indexOf('aria-label="Close"'));
      assert.ok(markup.indexOf('aria-label="Close"') < markup.indexOf('aria-label="Clear"'));
      assert.doesNotMatch(markup, /<input[^>]*(?:trailingAction|variant|footer)=/);
    }
  }
});

test("SearchField panel uses canonical frosted tokens with an opaque reduced-transparency fallback", async () => {
  const styles = await readFile(
    new URL("../src/components/SearchField/SearchField.module.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /border-radius: var\(--openbitfun-radius-lg\)/);
  assert.match(styles, /@supports[^}]+background: color-mix\(in srgb, var\(--openbitfun-color-surface-raised\) 80%, transparent\)/s);
  assert.match(styles, /backdrop-filter: var\(--openbitfun-effect-blur-medium\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency: reduce\)[^}]+background: var\(--openbitfun-color-surface-raised\)[^}]+backdrop-filter: none/s);
});

test("SearchField exposes a labeled clear action without hiding it from assistive technology", () => {
  const markup = renderToStaticMarkup(
    createElement(SearchField, {
      "aria-label": "Search",
      clearLabel: "Clear search",
      onClear: () => {},
      value: "query",
    }),
  );

  assert.match(markup, /aria-label="Clear search"/);
  assert.match(markup, /data-openbitfun-component="icon-button"/);
  assert.match(markup, /data-openbitfun-shape="square"/);
  assert.match(markup, /data-size="xs"/);
});

test("SearchField keeps its clear action quiet and focus-preserving", async () => {
  const source = await readFile(
    new URL("../src/components/SearchField/SearchField.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  for (const state of [{}, { disabled: true }, { readOnly: true }]) {
    const markup = renderToStaticMarkup(createElement(SearchField, {
      "aria-label": "Search", clearLabel: "Clear", onClear() {}, ...state,
    }));
    assert.match(markup, /data-openbitfun-variant="quiet"/);
    assert.equal(/<button[^>]*disabled=""/.test(markup), Boolean(state.disabled || state.readOnly));
  }
});

test("SearchField owns pill composition while reusing Input behavior", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /border-radius:var\(--openbitfun-radius-pill\)/);
  assert.match(styles, /--openbitfun-type-label-md-font-size/);
  assert.match(styles, /--openbitfun-type-meta-font-size/);
});

test("SearchField owns a quiet single-border focus without changing Input's focus contract", async () => {
  const [styles, inputStyles] = await Promise.all([
    readFile(new URL("../src/components/SearchField/SearchField.module.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Input/Input.module.css", import.meta.url), "utf8"),
  ]);
  const focusRule = inputStyles.match(
    /\.field:focus-within\s*\{([^}]+)\}/,
  )?.[1];

  const searchFocusRule = styles.match(
    /\.root\[data-variant="default"\] \.field:where\(:not\(\[data-invalid="true"\], \[data-disabled="true"\]\)\):is\(:hover, :focus-within\)\s*\{([^}]+)\}/,
  )?.[1];
  const panelFocusRule = styles.match(
    /\.root\[data-variant="panel"\]:focus-within\s*\{([^}]+)\}/,
  )?.[1];

  assert.ok(searchFocusRule);
  assert.match(searchFocusRule, /outline-color: var\(--openbitfun-color-border-default\)/);
  assert.doesNotMatch(searchFocusRule, /box-shadow|border-width|outline-width|outline-offset/);
  assert.ok(panelFocusRule);
  assert.match(panelFocusRule, /outline-color: var\(--openbitfun-color-border-default\)/);
  assert.ok(focusRule);
  assert.match(focusRule, /border-color: var\(--openbitfun-color-field-border-active\)/);
  assert.doesNotMatch(inputStyles, /--openbitfun-color-field-border-focus|\.field[^{}]*:focus-visible/);
  assert.match(focusRule, /box-shadow: none/);
  assert.doesNotMatch(focusRule, /border-width|outline/);
});
