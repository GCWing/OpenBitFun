import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Input } from "../dist/index.js";

test("Input keeps IME-owned Enter and Escape away from submit and cancel handlers", async () => {
  const source = await readFile(
    new URL("../src/components/Input/Input.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /isImeOwnedKeyboardEvent/);
  assert.match(source, /event\.key === "Enter" \|\| event\.key === "Escape"/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(source, /onCompositionStart/);
  assert.match(source, /onCompositionEnd/);
});

test("Input keeps native input semantics and independent content slots", () => {
  const markup = renderToStaticMarkup(
    createElement(Input, {
      "aria-label": "Project name",
      leading: createElement("svg", { "data-icon": "project" }),
      placeholder: "Name",
      trailing: createElement("button", { type: "button" }, "Clear"),
    }),
  );

  assert.match(markup, /data-openbitfun-component="input"/);
  assert.match(markup, /data-openbitfun-part="leading"/);
  assert.match(markup, /data-openbitfun-part="trailing"/);
  assert.match(markup, /aria-label="Project name"/);
  assert.match(markup, /placeholder="Name"/);
  assert.match(markup, /type="text"/);
  assert.match(markup, /data-icon="project"/);
  assert.match(markup, /<button type="button">Clear<\/button>/);
});

test("Input exposes invalid, disabled, and size independently", () => {
  const markup = renderToStaticMarkup(
    createElement(Input, { disabled: true, invalid: true, size: "lg" }),
  );

  assert.match(markup, /data-disabled="true"/);
  assert.match(markup, /data-invalid="true"/);
  assert.match(markup, /data-size="lg"/);
  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /disabled=""/);
});

test("Input supports compact capsule editing without leaking shape or size to the native input", async () => {
  const markup = renderToStaticMarkup(
    createElement(Input, { size: "xs", shape: "pill", "aria-label": "Tag", defaultValue: "Planning" }),
  );
  assert.match(markup, /data-size="xs"/);
  assert.match(markup, /data-shape="pill"/);
  assert.match(markup, /<input[^>]*aria-label="Tag"/);
  assert.doesNotMatch(markup, /<input[^>]*\s(?:shape|size)=/);
  const styles = await readFile(new URL("../src/components/Input/Input.module.css", import.meta.url), "utf8");
  assert.match(styles, /\[data-size="xs"\][\s\S]*?--_field-height: var\(--openbitfun-control-button-xs-height\)/);
  assert.match(styles, /\[data-shape="pill"\][\s\S]*?border-radius: var\(--openbitfun-radius-pill\)/);
});

test("Input styles consume semantic field and status tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-color-field-background/);
  assert.match(styles, /--openbitfun-color-field-border-active/);
  assert.match(styles, /--openbitfun-color-content-muted/);
  assert.match(styles, /--openbitfun-color-status-danger-border/);
  assert.match(styles, /--openbitfun-control-height-sm/);
  assert.match(styles, /caret-color:var\(--openbitfun-color-accent-default\)/);
  assert.doesNotMatch(
    styles,
    /\.field\[data-disabled=(?:"true"|true)\]\{[^}]*opacity:/,
  );
});
