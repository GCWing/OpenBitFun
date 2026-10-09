import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignSystemProvider, Tooltip } from "../dist/index.js";

test("Tooltip renders only the trigger until it is shown", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Tooltip,
      { content: "Open settings" },
      createElement("button", { type: "button" }, "Settings"),
    ),
  );

  assert.match(markup, /<button type="button"[^>]*>Settings<\/button>/);
  assert.doesNotMatch(markup, /role="tooltip"/);
});

test("DesignSystemProvider owns shared tooltip delay and portal configuration", () => {
  const markup = renderToStaticMarkup(
    createElement(
      DesignSystemProvider,
      { tooltipDelay: 0, portalHost: null },
      createElement(
        Tooltip,
        { content: "Rename", placement: "right" },
        createElement("button", { type: "button" }, "Rename"),
      ),
    ),
  );

  assert.match(markup, /<button type="button"[^>]*>Rename<\/button>/);
});

test("Tooltip owns delayed opening, viewport flipping, and interactive persistence", async () => {
  const source = await readFile(
    new URL("../src/components/Tooltip/Tooltip.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /DEFAULT_TOOLTIP_DELAY_MS = 450/);
  assert.match(source, /WARM_WINDOW_MS/);
  assert.match(source, /determineBestPlacement/);
  assert.match(source, /applyBoundaryConstraints/);
  assert.match(source, /INTERACTIVE_HIDE_DELAY_MS/);
  assert.match(source, /followCursor/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /data-motion="presence"/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /useDesignSystem/);
  assert.match(source, /<Portal/);
});

test("Tooltip styling uses only public surface, geometry, and elevation tokens", async () => {
  const styles = await readFile(
    new URL("../src/components/Tooltip/Tooltip.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-overlay-tooltip-max-inline-size/);
  assert.match(styles, /--openbitfun-overlay-tooltip-arrow-size/);
  assert.match(styles, /--openbitfun-color-surface-raised/);
  assert.match(styles, /--openbitfun-color-border-subtle/);
  assert.match(styles, /--openbitfun-shadow-sm/);
  assert.match(styles, /--openbitfun-layer-tooltip/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});
