import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DesignSystemProvider,
  useDismissibleLayer,
  useHasOverlayLayers,
  useOverlayLayerActions,
  usePresence,
} from "../dist/index.js";

test("the overlay kernel hooks are exported from the public package entry", () => {
  assert.equal(typeof useDismissibleLayer, "function");
  assert.equal(typeof useHasOverlayLayers, "function");
  assert.equal(typeof useOverlayLayerActions, "function");
  assert.equal(typeof usePresence, "function");
});

test("DesignSystemProvider is the single locale, theme, portal and layer-stack host", () => {
  const markup = renderToStaticMarkup(
    createElement(
      DesignSystemProvider,
      {
        colorScheme: "dark",
        contrast: "high",
        density: "compact",
        locale: "zh-CN",
        messages: { dialogClose: "关闭" },
      },
      createElement("span", null, "content"),
    ),
  );
  assert.equal(markup, "<span>content</span>");
});

test("the overlay kernel centralizes portal, stack, dismissal, focus, scroll lock and presence", async () => {
  const files = await Promise.all([
    "../src/overlay/Portal.tsx",
    "../src/overlay/OverlayCoordinator.ts",
    "../src/overlay/useDismissibleLayer.ts",
    "../src/overlay/useFocusScope.ts",
    "../src/overlay/useScrollLock.ts",
    "../src/overlay/usePresence.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

  assert.match(files[0], /createPortal/);
  assert.match(files[1], /class OverlayLayerStack/);
  assert.match(files[1], /pointerdown/);
  assert.match(files[1], /Escape/);
  assert.match(files[2], /stack.register/);
  assert.match(files[1], /FOCUSABLE_SELECTOR/);
  assert.match(files[3], /registerFocusScope/);
  assert.match(files[4], /Symbol.for\("openbitfun.overlay-scroll-lock.v1"\)/);
  assert.match(files[1], /Symbol.for\("openbitfun.overlay-coordinator.v1"\)/);
  assert.match(files[5], /PresenceState/);
});

test("overlay components consume the shared kernel instead of owning document dismissal", async () => {
  const [dialog, combobox, menu, tooltip] = await Promise.all([
    readFile(new URL("../src/components/Dialog/Dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Combobox/Combobox.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Menu/MenuPopover.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Tooltip/Tooltip.tsx", import.meta.url), "utf8"),
  ]);

  for (const source of [dialog, combobox, menu]) {
    assert.match(source, /useDismissibleLayer/);
    assert.doesNotMatch(source, /addEventListener\("mousedown"/);
  }
  assert.match(dialog, /useFocusScope/);
  assert.match(dialog, /preventScroll=\{preventScroll\}/);
  assert.match(dialog, /usePresence/);
  assert.match(tooltip, /<Portal/);
});
