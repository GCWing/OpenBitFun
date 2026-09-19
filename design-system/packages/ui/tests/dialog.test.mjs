import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DialogFooter, DialogHeader } from "../dist/index.js";

test("Dialog and Sheet compose the shared overlay kernel and compound anatomy", async () => {
  const source = await readFile(
    new URL("../src/components/Dialog/Dialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /<Portal target=\{resolvedPortalHost\} open=\{open\} modal/);
  assert.match(source, /useDismissibleLayer/);
  assert.match(source, /useFocusScope/);
  assert.match(source, /preventScroll=\{preventScroll\}/);
  assert.match(source, /usePresence/);
  assert.match(source, /kind="dialog"/);
  assert.match(source, /kind="sheet"/);
  for (const part of [
    "overlay",
    "surface",
    "header",
    "heading",
    "title",
    "description",
    "header-actions",
    "close",
    "body",
    "footer",
  ]) {
    assert.match(source, new RegExp(`data-openbitfun-part=\\"${part}\\"`));
  }
  assert.match(source, /aria-describedby=\{ariaDescribedBy \?\? \(hasDescription \? descriptionId : undefined\)\}/);
  assert.match(source, /aria-labelledby=\{ariaLabelledBy \?\? \(!ariaLabel && hasTitle \? titleId : undefined\)\}/);
});

test("Dialog public API has canonical axes and no legacy escape hatches", async () => {
  const source = await readFile(
    new URL("../src/components/Dialog/Dialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /export type DialogSize = "sm" \| "md" \| "lg" \| "xl" \| "2xl"/);
  assert.match(source, /export type SheetPlacement = "left" \| "right" \| "bottom"/);
  assert.match(source, /onOpenChange: \(open: false, reason: DialogCloseReason\) => void/);
  assert.doesNotMatch(source, /contentClassName|overlayClassName|portalContainer|portalled|resizable|draggable/);
});

test("Dialog geometry and typography use public design tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  for (const token of [
    "--openbitfun-overlay-dialog-viewport-gutter",
    "--openbitfun-overlay-dialog-backdrop-blur",
    "--openbitfun-overlay-dialog-surface-radius",
    "--openbitfun-overlay-dialog-header-padding-inline",
    "--openbitfun-overlay-dialog-footer-padding-inline",
    "--openbitfun-overlay-dialog-max-inline-size-xxlarge",
    "--openbitfun-type-heading-dialog-font-size",
    "--openbitfun-type-heading-dialog-font-weight",
    "--openbitfun-color-overlay-scrim",
    "--openbitfun-color-surface-raised",
    "--openbitfun-shadow-overlay",
  ]) {
    assert.match(styles, new RegExp(token));
  }
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("DialogFooter exposes a centered frosted floating action layer", async () => {
  const markup = renderToStaticMarkup(
    createElement(
      DialogFooter,
      { appearance: "floating" },
      createElement("button", null, "Cancel"),
      createElement("button", null, "Save"),
    ),
  );
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(markup, /data-appearance="floating"/);
  assert.match(styles, /\[data-appearance=floating\]\{[^}]*position:absolute/);
  assert.match(styles, /\[data-appearance=floating\]\{[^}]*justify-content:center/);
  assert.match(styles, /\[data-appearance=floating\]:before\{[^}]*background:linear-gradient/);
  assert.match(styles, /\[data-appearance=floating\]:before\{[^}]*backdrop-filter:var\(--openbitfun-overlay-dialog-footer-blur\)/);
  assert.match(styles, /\[data-appearance=floating\]\{[^}]*pointer-events:auto/);
  assert.match(styles, /--openbitfun-overlay-dialog-footer-action-min-width/);
});

test("dialog separators are explicit and do not leak native attributes", () => {
  for (const component of [DialogHeader, DialogFooter]) {
    assert.match(renderToStaticMarkup(createElement(component)), /data-separator="false"/);
    const markup = renderToStaticMarkup(createElement(component, { separator: true }));
    assert.match(markup, /data-separator="true"/);
    assert.doesNotMatch(markup, / separator=/);
  }
});
