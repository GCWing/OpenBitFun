import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Icon, Select } from "../dist/index.js";

const options = [
  { label: "Ask", testAttributes: { "data-mode": "ask" }, testId: "ask-option", value: "ask" },
  { disabled: true, label: "Plan", value: "plan" },
  { group: "Advanced", label: "Agent", value: 3 },
];

test("Select exposes a select-only combobox and preserves native form semantics", () => {
  const markup = renderToStaticMarkup(createElement(Select, {
    "aria-label": "Mode",
    options,
    value: "ask",
  }));

  assert.match(markup, /data-openbitfun-component="select"/);
  assert.match(markup, /<select/);
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /aria-label="Mode"/);
  assert.match(markup, /<option[^>]*value="ask"[^>]*selected="">Ask<\/option>/);
  assert.match(markup, /data-testid="ask-option"/);
  assert.match(markup, /data-mode="ask"/);
  assert.match(markup, /<option disabled="" value="plan">Plan<\/option>/);
  assert.match(markup, /<optgroup label="Advanced">/);
  assert.match(markup, /value="3">Agent<\/option>/);
  assert.match(markup, /<button[^>]*aria-expanded="false"[^>]*role="combobox"/);
  assert.match(markup, /data-openbitfun-part="value"[^>]*data-overflow-behavior="marquee"[^>]*><span[^>]*>Ask<\/span><\/span>/);
});

test("Select exposes size, invalid, disabled, and leading regions independently", () => {
  const markup = renderToStaticMarkup(createElement(Select, {
    "aria-label": "Mode",
    disabled: true,
    invalid: true,
    leading: createElement(Icon, { name: "circle" }),
    options,
    size: "lg",
  }));

  assert.match(markup, /data-size="lg"/);
  assert.match(markup, /data-disabled="true"/);
  assert.match(markup, /data-invalid="true"/);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /data-openbitfun-part="leading"/);
  assert.match(markup, /data-openbitfun-part="indicator"/);
});

test("Select styling owns one token-driven surface for the expanded header and listbox", async () => {
  const source = await readFile(
    new URL("../src/components/Select/Select.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../src/components/Select/Select.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-control-select-padding-inline/);
  assert.match(styles, /--openbitfun-control-select-indicator-size/);
  assert.match(styles, /--openbitfun-color-field-border-focus/);
  assert.match(styles, /\.popover\s*\{[^}]*border-radius:\s*var\(--openbitfun-control-select-radius\)/s);
  assert.match(styles, /--openbitfun-color-selection-surface/);
  assert.match(styles, /--openbitfun-color-control-highlight-background/);
  assert.match(styles, /--openbitfun-shadow-menu/);
  assert.match(styles, /--openbitfun-color-status-danger-border/);
  assert.match(styles, /\.popover\s*\{[^}]*flex-direction:\s*column[^}]*padding:\s*0[^}]*border:/s);
  assert.match(styles, /\.root\s*\{[^}]*block-size:\s*var\(--_select-height\)/s);
  assert.match(styles, /\.root\s*\{[^}]*display:\s*grid;/s);
  assert.match(
    styles,
    /\.popoverHeader\s*\{[^}]*block-size:\s*calc\([\s\S]*?--_select-height[\s\S]*?--openbitfun-border-width-default/,
  );
  assert.match(styles, /\.divider\s*\{[^}]*--openbitfun-border-width-default/s);
  assert.match(styles, /\.options\s*\{[^}]*--openbitfun-overlay-menu-surface-padding/s);
  assert.doesNotMatch(styles, /border-block-(?:start|end):\s*0/);
  assert.doesNotMatch(styles, /scale\(/);
  assert.match(source, /<Listbox/);
  assert.match(source, /<ListboxGroup/);
  assert.match(source, /useDismissibleLayer/);
  assert.match(source, /useAnchoredLayer\(\{/);
  assert.match(source, /overlapAnchor:\s*true/);
  assert.match(source, /data-openbitfun-part="header"/);
  assert.match(source, /data-openbitfun-part="divider"/);
  assert.match(source, /data-openbitfun-part="options"/);
  assert.ok(
    source.indexOf('data-openbitfun-part="header"')
      < source.indexOf('data-openbitfun-part="options"'),
  );
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});
