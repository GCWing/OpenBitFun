import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MobileActionSheet,
  MobileBadge,
  MobileBanner,
  MobileButton,
  MobileCard,
  MobileChoiceSheet,
  MobileConfirmSheet,
  MobileComposer,
  MobileDisclosure,
  MobileFileButton,
  MobileFloatingActions,
  MobileIconButton,
  MobileLink,
  MobileListRow,
  MobileMessage,
  MobilePageHeader,
  MobileScrim,
  MobileSection,
  MobileSegmentedControl,
  MobileSheet,
  MobileStatus,
  MobileTextField,
  MobileTextarea,
} from "../dist/mobile.js";

test("mobile entry exposes touch controls without product state", () => {
  const iconButton = renderToStaticMarkup(createElement(MobileIconButton, {
    "aria-label": "Refresh",
    appearance: "floating",
    icon: createElement("svg"),
    loading: true,
  }));
  const textField = renderToStaticMarkup(createElement(MobileTextField, {
    "aria-label": "Search",
    leading: createElement("svg"),
    placeholder: "Search sessions",
  }));
  const row = renderToStaticMarkup(createElement(MobileListRow, {
    appearance: "surface",
    label: "Workspace",
    selected: true,
    supportingText: "/workspace",
    trailing: createElement("svg"),
  }));

  assert.match(iconButton, /data-openbitfun-component="mobile-icon-button"/);
  assert.match(iconButton, /data-appearance="floating"/);
  assert.match(iconButton, /aria-busy="true"/);
  assert.match(iconButton, /disabled=""/);
  assert.match(textField, /data-openbitfun-component="mobile-text-field"/);
  assert.match(textField, /<input[^>]*aria-label="Search"/);
  assert.match(row, /data-openbitfun-component="mobile-list-row"/);
  assert.match(row, /data-selected="true"/);
  assert.match(row, /aria-current="true"/);
});

test("mobile entry exposes reusable composer and floating action anatomy", () => {
  const composer = renderToStaticMarkup(createElement(MobileComposer, {
    "aria-label": "Open composer",
    endActions: createElement("button", null, "Send"),
    leading: createElement("button", null, "+"),
    onActivate: () => undefined,
  }, "Message"));
  const actions = renderToStaticMarkup(createElement(MobileFloatingActions, {
    leading: createElement("button", null, "New"),
    trailing: createElement("button", null, "Settings"),
  }));

  assert.match(composer, /data-openbitfun-component="mobile-composer"/);
  assert.match(composer, /data-expanded="false"/);
  assert.match(composer, /data-openbitfun-part="editor"[^>]*role="button"/);
  assert.match(actions, /data-openbitfun-component="mobile-floating-actions"/);
  assert.match(actions, /data-openbitfun-part="trailing"/);
});

test("mobile disclosure exposes stable parts without changing toggle semantics", () => {
  for (const open of [false, true]) {
    const markup = renderToStaticMarkup(createElement(MobileDisclosure, {
      onToggle: () => undefined, open, title: "Advanced options",
    }, "Server"));
    assert.match(markup, new RegExp(`aria-expanded="${open}"`));
    assert.match(markup, /<button[^>]*data-openbitfun-part="trigger"[^>]*type="button"/);
    assert.match(markup, /data-openbitfun-part="title"/);
    assert.match(markup, /data-openbitfun-part="chevron"/);
    assert.equal(markup.includes('data-openbitfun-part="body"'), open);
  }
});

test("mobile entry exposes the complete reusable mobile surface set", () => {
  const examples = [
    createElement(MobileActionSheet, { actions: [{ id: "rename", label: "Rename" }], onAction: () => undefined, onOpenChange: () => undefined, open: true, title: "Actions" }),
    createElement(MobileBadge, { tone: "success" }, "Online"),
    createElement(MobileBanner, { tone: "warning" }, "Reconnect"),
    createElement(MobileButton, { appearance: "primary" }, "Continue"),
    createElement(MobileCard, { appearance: "elevated" }, "Card"),
    createElement(MobileChoiceSheet, { onOpenChange: () => undefined, onSelect: () => undefined, open: false, options: [{ label: "Standard", value: "standard" }], title: "Mode" }),
    createElement(MobileConfirmSheet, { cancelLabel: "Cancel", confirmLabel: "Delete", onConfirm: () => undefined, onOpenChange: () => undefined, open: true, title: "Delete session" }),
    createElement(MobileDisclosure, { onToggle: () => undefined, open: true, title: "Thinking" }, "Details"),
    createElement(MobileFileButton, null, "Choose file"),
    createElement(MobileLink, { href: "https://example.com" }, "Open documentation"),
    createElement(MobileMessage, { roleType: "user" }, "Hello"),
    createElement(MobilePageHeader, { title: "Sessions" }),
    createElement(MobileScrim, { "aria-label": "Close" }),
    createElement(MobileSection, { title: "Recent" }, "Content"),
    createElement(MobileSegmentedControl, { "aria-label": "Mode", onChange: () => undefined, options: [{ label: "Chat", value: "chat" }], value: "chat" }),
    createElement(MobileStatus, { loading: true, title: "Loading" }),
    createElement(MobileTextarea, { "aria-label": "Message" }),
  ].map(example => renderToStaticMarkup(example));

  for (const name of ["badge", "banner", "button", "card", "disclosure", "file-button", "link", "message", "page-header", "scrim", "section", "segmented-control", "status", "textarea"]) {
    assert.ok(examples.some(markup => markup.includes(`data-openbitfun-component="mobile-${name}"`)), `missing mobile-${name}`);
  }
  assert.equal(typeof MobileActionSheet, "function");
  assert.equal(typeof MobileConfirmSheet, "function");
});

test("mobile choice sheet keeps its closed server-rendering contract", () => {
  const choiceSheet = renderToStaticMarkup(createElement(MobileChoiceSheet, {
    cancelLabel: "Cancel",
    onOpenChange: () => undefined,
    onSelect: () => undefined,
    open: false,
    options: [{ label: "Standard", value: "standard" }],
    title: "Choose mode",
  }));

  assert.equal(choiceSheet, "");
});

test("mobile sheet keeps its closed server-rendering contract", () => {
  const sheet = renderToStaticMarkup(createElement(MobileSheet, {
    onOpenChange: () => undefined,
    open: false,
    title: "Actions",
  }, createElement("button", null, "Rename")));

  assert.equal(sheet, "");
});

test("mobile sheet header keeps the title on the sheet centerline beside header actions", async () => {
  const styles = await readFile(
    new URL("../src/mobile/MobileSheet/MobileSheet.module.css", import.meta.url),
    "utf8",
  );
  const headerRule = styles.match(/\.header\s*\{[^}]*display:[^}]+\}/)?.[0];
  const headingRule = styles.match(/\.heading\s*\{[^}]+\}/)?.[0];
  const headerActionRule = styles.match(/\.headerAction\s*\{[^}]+\}/)?.[0];

  assert.ok(headerRule, "missing MobileSheet header display rule");
  assert.match(headerRule, /display:\s*grid/);
  assert.match(
    headerRule,
    /grid-template-columns:\s*minmax\([^,]+,\s*1fr\)\s+minmax\(0,\s*auto\)\s+minmax\([^,]+,\s*1fr\)/,
  );
  assert.match(headingRule ?? "", /grid-column:\s*2/);
  assert.match(headerActionRule ?? "", /grid-column:\s*3/);
  assert.match(headerActionRule ?? "", /justify-self:\s*end/);
});

test("mobile confirmation sheets present custom icons without a decorative tile", async () => {
  const styles = await readFile(
    new URL("../src/mobile/MobileConfirmSheet/MobileConfirmSheet.module.css", import.meta.url),
    "utf8",
  );
  const iconRule = styles.match(/\.icon\s*\{[^}]+\}/)?.[0];

  assert.ok(iconRule, "missing MobileConfirmSheet icon rule");
  assert.doesNotMatch(iconRule, /(?:background|border-radius)\s*:/);
});

test("mobile stylesheet is isolated and uses semantic tokens", async () => {
  const styles = await readFile(new URL("../dist/mobile.css", import.meta.url), "utf8");

  assert.match(styles, /data-appearance=floating/);
  assert.match(styles, /data-invalid=true/);
  assert.match(styles, /data-selected=true/);
  assert.match(styles, /data-expanded=true/);
  assert.match(styles, /pointer-events:none/);
  assert.match(styles, /mobile-sheet/);
  assert.match(styles, /--openbitfun-color-surface-panel/);
  assert.match(styles, /--openbitfun-shadow-base/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i);
});
