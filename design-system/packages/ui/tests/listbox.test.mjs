import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Listbox,
  ListboxEmpty,
  ListboxGroup,
  ListboxOption,
} from "../dist/index.js";

test("Listbox exposes grouped single- and multi-select option semantics", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Listbox,
      { "aria-label": "Models", multiple: true },
      createElement(ListboxOption, { selected: true, value: "primary" }, "Primary"),
      createElement(
        ListboxGroup,
        { label: "External" },
        createElement(
          ListboxOption,
          { description: "Remote model", disabled: true, value: "remote" },
          "Remote",
        ),
      ),
      createElement(ListboxEmpty, null, "No matches"),
    ),
  );

  assert.match(markup, /data-openbitfun-component="listbox"/);
  assert.match(markup, /role="listbox"/);
  assert.match(markup, /aria-multiselectable="true"/);
  assert.match(markup, /aria-selected="true"[^>]+role="option"/);
  assert.match(markup, /aria-labelledby="[^"]+"[^>]+role="group"/);
  assert.match(markup, /aria-disabled="true"/);
});

test("Listbox styling uses public menu, action, content, and focus tokens", async () => {
  const styles = await readFile(
    new URL("../src/components/Listbox/Listbox.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-overlay-menu-item-height/);
  assert.match(styles, /\.list,\s*\.groupOptions\s*\{[^}]*gap: var\(--openbitfun-overlay-menu-row-gap\)/);
  assert.match(styles, /--openbitfun-color-action-neutral-surface/);
  assert.match(styles, /--openbitfun-color-content-muted/);
  assert.match(styles, /--openbitfun-color-focus-ring/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("selection popovers inherit row spacing from Listbox instead of patching its private lists", async () => {
  for (const component of ["Select", "Combobox"]) {
    const styles = await readFile(new URL(`../src/components/${component}/${component}.module.css`, import.meta.url), "utf8");
    assert.doesNotMatch(styles, /\[data-openbitfun-part="(?:list|group-options|group)"\][^{]*\{[^}]*\bgap:/);
  }
});

test("Listbox owns direct-option roving focus and standard navigation keys", async () => {
  const source = await readFile(
    new URL("../src/components/Listbox/Listbox.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /querySelectorAll<HTMLButtonElement>\("\[data-openbitfun-listbox-option\]"\)/);
  assert.match(source, /option\.closest\('\[role="listbox"\]'\) === root/);
  assert.match(source, /case "ArrowDown"/);
  assert.match(source, /case "ArrowUp"/);
  assert.match(source, /case "Home"/);
  assert.match(source, /case "End"/);
  assert.match(source, /focusMode === "virtual"/);
  assert.match(source, /autoFocusOption/);
});
