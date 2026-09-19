import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Combobox, DesignSystemProvider, MultiSelect } from "../dist/index.js";

test("Combobox consumes host localization and canonical invalid state", () => {
  const markup = renderToStaticMarkup(createElement(
    DesignSystemProvider,
    { messages: { selectPlaceholder: "Choose model" } },
    createElement(Combobox, {
      disabled: true,
      invalid: true,
      errorMessage: "Required",
      options: [],
      required: true,
    }),
  ));

  assert.match(markup, /Choose model/);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /aria-required="true"/);
  assert.match(markup, /aria-describedby="[^\"]+-error"/);
  assert.match(markup, /Required/);
});

test("MultiSelect exposes an explicit multi-value trigger contract", () => {
  const markup = renderToStaticMarkup(createElement(MultiSelect, {
    defaultValue: ["one"],
    options: [
      { label: "One", value: "one" },
      { description: "Unavailable", disabled: true, label: "Two", value: "two" },
    ],
    showSelectAll: true,
    "aria-label": "Models",
  }));

  assert.match(markup, /data-openbitfun-component="multi-select"/);
  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-label="Models"/);
  assert.match(markup, />One</);
});

test("Combobox owns keyboard selection, IME safety, filtering, and custom values", async () => {
  const source = await readFile(
    new URL("../src/components/Combobox/Combobox.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /case|event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
  assert.match(source, /nativeEvent\.isComposing/);
  assert.match(source, /filterOption\(option, query\)/);
  assert.match(source, /submitCreateValue/);
  assert.match(source, /onCreateValue/);
  assert.match(source, /useDismissibleLayer/);
  assert.doesNotMatch(source, /onMouseEnter=.*setActive/);
});

test("Combobox styling uses public field, overlay, action, and motion tokens", async () => {
  const source = await readFile(
    new URL("../src/components/Combobox/Combobox.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/components/Combobox/Combobox.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-color-field-background/);
  assert.match(styles, /--openbitfun-overlay-menu-surface-radius/);
  assert.match(styles, /--openbitfun-color-surface-tertiary/);
  assert.match(styles, /--openbitfun-shadow-menu/);
  assert.match(styles, /position:\s*fixed/);
  assert.match(styles, /z-index:\s*var\(--openbitfun-layer-popover\)/);
  assert.match(source, /className=\{styles\.searchField\}/);
  assert.match(styles, /\.searchField\s*\{[^}]*inline-size:\s*100%/);
  assert.doesNotMatch(styles, /data-popover-mode/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("Combobox embeds search and scrollable options in one token-driven surface", async () => {
  const source = await readFile(
    new URL("../src/components/Combobox/Combobox.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/components/Combobox/Combobox.module.css", import.meta.url),
    "utf8",
  );

  assert.match(source, /clearLabel=\{query \? designSystem\.messages\.clearSelection : undefined\}/);
  assert.match(source, /leadingIcon=\{<Icon name="search" size="sm" \/>\}/);
  assert.match(source, /variant="embedded"/);
  assert.match(source, /overlapAnchor: true/);
  assert.match(source, /data-openbitfun-part="divider"/);
  assert.match(source, /data-openbitfun-part="options"/);
  assert.match(styles, /\.popover\s*\{[^}]*min-inline-size:\s*0[^}]*padding:\s*0/s);
  assert.match(
    styles,
    /\.popover\[data-placement="top"\]\s*\{[^}]*flex-direction:\s*column-reverse/s,
  );
  assert.match(styles, /\.search\s*\{[^}]*--_combobox-height[^}]*--openbitfun-border-width-default/s);
  assert.match(styles, /\.options\s*\{[^}]*min-block-size:\s*0[^}]*--openbitfun-overlay-menu-surface-padding/s);
  assert.match(styles, /\.root\[data-open="true"\] \.control\s*\{[^}]*visibility:\s*hidden/s);
  assert.doesNotMatch(styles, /scale\(/);
});

test("Combobox and MultiSelect keep the field height independent of text, tags, and clear actions", async () => {
  const styles = await readFile(
    new URL("../src/components/Combobox/Combobox.module.css", import.meta.url),
    "utf8",
  );
  const control = styles.match(/\.control\s*\{([^}]+)\}/)?.[1] ?? "";
  const trigger = styles.match(/\.trigger\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(control, /block-size:\s*var\(--_combobox-height\)/);
  assert.match(control, /grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.match(trigger, /block-size:\s*100%/);
  assert.match(trigger, /min-block-size:\s*0/);
  assert.match(trigger, /padding-block:\s*0/);
  for (const size of ["sm", "md", "lg"]) {
    assert.ok(styles.includes(`var(--openbitfun-control-height-${size})`));
  }
});
