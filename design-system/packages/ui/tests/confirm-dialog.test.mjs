import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/components/ConfirmDialog/ConfirmDialog.tsx", import.meta.url);
const stylesUrl = new URL("../src/components/ConfirmDialog/ConfirmDialog.module.css", import.meta.url);

test("ConfirmDialog composes semantic content and actions on Dialog", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /<Dialog/);
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /<DialogHeader>/);
  assert.match(source, /<DialogTitle lines=\{anchored \? ANCHORED_TITLE_LINES : undefined\}>\{title\}<\/DialogTitle>/);
  assert.match(source, /<DialogBody>/);
  assert.match(source, /<DialogFooter>/);
  assert.match(source, /data-openbitfun-component="confirm-dialog" data-openbitfun-part="content"/);
  assert.match(source, /data-openbitfun-part="messageRow"/);
  assert.match(source, /data-openbitfun-part="preview"/);
  assert.match(source, /data-openbitfun-status=\{type === "error" \? "danger" : type\}/);
  assert.match(source, /tone=\{confirmDanger \|\| type === "error" \? "danger" : "neutral"\}/);
});

test("ConfirmDialog uses the canonical controlled API without geometry or portal escape hatches", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /open: boolean/);
  assert.match(source, /onOpenChange: \(open: false, reason: ConfirmDialogCloseReason\) => void/);
  assert.match(source, /closeOnPointerOutside/);
  assert.doesNotMatch(source, /\bisOpen\b|\bonClose\b|previewMaxHeight|dialogClassName|overlayClassName|portalContainer|portalled|preventScroll/);
});

test("ConfirmDialog owns async pending and dismissal guards", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /pendingAction/);
  assert.match(source, /typeof result\.then === "function"/);
  assert.match(source, /loading=\{pendingAction === "confirm"\}/);
  assert.match(source, /loading=\{pendingAction === "secondary"\}/);
  assert.match(source, /closeOnEscape=\{!busy && closeOnEscape\}/);
  assert.match(source, /closeOnPointerOutside=\{!busy && closeOnPointerOutside\}/);
  assert.match(source, /onActionError\?\.\(error, actionName\)/);
  assert.match(source, /onOpenChange\(false, reason\)/);
  assert.match(source, /designSystem\.messages\.confirmCancel/);
  assert.match(source, /designSystem\.messages\.confirmAction/);
});

test("ConfirmDialog presents semantic icons as bare glyphs", async () => {
  const styles = await readFile(stylesUrl, "utf8");
  const iconRule = styles.match(/\.icon\s*\{[^}]+\}/)?.[0];

  assert.ok(iconRule, "missing ConfirmDialog icon rule");
  assert.match(iconRule, /flex:\s*0 0 var\(--openbitfun-layout-confirm-dialog-icon-glyph-size\)/);
  assert.match(iconRule, /block-size:\s*1lh/);
  assert.doesNotMatch(
    styles,
    /\.icon(?:\[[^\]]+\])?\s*\{[^}]*(?:background|border-radius)\s*:/,
  );
});

test("ConfirmDialog styles use public status, layout, and typography tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-layout-confirm-dialog-content-gap/);
  assert.match(styles, /--openbitfun-layout-confirm-dialog-icon-glyph-size/);
  assert.match(styles, /--openbitfun-layout-confirm-dialog-preview-max-block-size/);
  assert.match(styles, /--openbitfun-layout-confirm-dialog-preview-padding-inline/);
  assert.match(styles, /--openbitfun-color-status-warning-emphasis/);
  assert.match(styles, /--openbitfun-color-status-danger-emphasis/);
  assert.match(styles, /--openbitfun-type-code-sm-font-family/);
});
