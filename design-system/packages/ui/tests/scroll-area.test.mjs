import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScrollArea } from "../dist/index.js";

test("ScrollArea defaults to a native vertical viewport with automatic visibility", () => {
  const markup = renderToStaticMarkup(
    createElement(ScrollArea, { "aria-label": "Activity" }, "Content"),
  );

  assert.match(markup, /data-openbitfun-component="scroll-area"/);
  assert.match(markup, /data-openbitfun-part="viewport"/);
  assert.match(markup, /data-openbitfun-orientation="vertical"/);
  assert.match(markup, /data-openbitfun-overscroll-behavior-y="contain"/);
  assert.match(markup, /data-openbitfun-scrollbar-visibility="auto"/);
  assert.match(markup, /aria-label="Activity"/);
});

test("ScrollArea exposes orientation, scroll chaining, and scrollbar visibility contracts", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ScrollArea,
      { orientation: "both", overscrollBehaviorY: "auto", scrollbarVisibility: "always" },
      "Content",
    ),
  );

  assert.match(markup, /data-openbitfun-orientation="both"/);
  assert.match(markup, /data-openbitfun-overscroll-behavior-y="auto"/);
  assert.match(markup, /data-openbitfun-scrollbar-visibility="always"/);
});

test("ScrollArea preserves feature-owned appearance contracts", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ScrollArea,
      { "data-openbitfun-component": "model-settings", "data-openbitfun-part": "root" },
      "Content",
    ),
  );

  assert.match(markup, /data-openbitfun-component="model-settings"/);
  assert.match(markup, /data-openbitfun-part="root"/);
});

test("ScrollArea styling uses public scrollbar tokens and preserves native scrolling", async () => {
  const styles = await readFile(
    new URL("../src/components/ScrollArea/ScrollArea.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /overflow-y: auto/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /overflow: scroll/);
  assert.match(styles, /\[data-openbitfun-overscroll-behavior-y="auto"\]\s*\{\s*overscroll-behavior-y:\s*auto/);
  assert.doesNotMatch(styles, /scrollbar-color:|::-webkit-scrollbar/);

  // The published stylesheet must carry the shared policy for both ordinary
  // native scroll containers and ScrollArea, including standalone consumers.
  const publishedStyles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  assert.match(publishedStyles, /--openbitfun-scrollbar-width/);
  assert.match(publishedStyles, /--openbitfun-scrollbar-radius/);
  assert.match(publishedStyles, /--openbitfun-color-scrollbar-thumb/);
  assert.match(publishedStyles, /--openbitfun-color-scrollbar-thumb-hover/);
  assert.match(publishedStyles, /\[data-openbitfun-scrollbar-visibility\]/);
  assert.match(publishedStyles, /scrollbar-width:\s*none/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});
