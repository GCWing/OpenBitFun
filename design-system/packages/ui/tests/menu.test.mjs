import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Menu,
  MenuItem,
  MenuList,
  MenuSection,
  MenuSeparator,
  ScrollArea,
} from "../dist/index.js";

test("Menu composes grouped items, heading actions, and separators with native roles", () => {
  const markup = renderToStaticMarkup(
    createElement(
      Menu,
      { "aria-label": "Sessions", scrollbarVisibility: "always" },
      createElement(
        MenuSection,
        {
          actions: [{ icon: createElement("svg"), id: "add", label: "Add session" }],
          title: "Sessions",
        },
        createElement(MenuItem, null, "First session"),
        createElement(MenuItem, { checked: true, role: "menuitemcheckbox" }, "Pinned"),
      ),
      createElement(MenuSeparator),
      createElement(MenuSection, { "aria-label": "More" },
        createElement(MenuItem, { disabled: true }, "Disabled session"),
      ),
    ),
  );

  assert.match(markup, /data-openbitfun-component="menu"/);
  assert.match(markup, /role="menu"/);
  assert.match(markup, /data-openbitfun-scrollbar-visibility="always"/);
  assert.match(markup, /aria-labelledby="[^"]+"[^>]+role="group"/);
  assert.match(markup, /data-openbitfun-part="heading-actions"/);
  assert.match(markup, /aria-label="Add session"/);
  assert.equal((markup.match(/role="menuitem"/g) ?? []).length, 3);
  assert.match(markup, /aria-checked="true"[^>]+role="menuitemcheckbox"/);
  assert.match(markup, /role="separator"/);
});

test("Menu owns roving focus and standard single-level navigation keys", async () => {
  const source = await readFile(
    new URL("../src/components/Menu/Menu.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /querySelectorAll<HTMLButtonElement>\("\[data-openbitfun-menu-item\]"\)/);
  assert.match(source, /case "ArrowDown"/);
  assert.match(source, /case "ArrowUp"/);
  assert.match(source, /case "Home"/);
  assert.match(source, /case "End"/);
  assert.match(source, /label\.startsWith\(query\)/);
  assert.match(source, /autoFocusFirstItem/);
});

test("Menu keeps roving focus scoped to items owned by the current menu", async () => {
  const source = await readFile(
    new URL("../src/components/Menu/Menu.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /item\.closest\('\[role="menu"\]'\) === root/);
});

test("Menu styling uses only public surface, geometry, action, and scrollbar tokens", async () => {
  const styles = await readFile(
    new URL("../src/components/Menu/Menu.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-overlay-menu-inline-size/);
  assert.match(styles, /--openbitfun-overlay-menu-item-height/);
  assert.match(styles, /\.items\s*\{[^}]*gap: var\(--openbitfun-overlay-menu-row-gap\)/);
  assert.doesNotMatch(styles, /\.list\s*\{[^}]*\bgap:/);
  assert.match(styles, /\.separator\s*\{[^}]*margin-block: var\(--openbitfun-overlay-menu-section-gap\)/);
  assert.match(styles, /--openbitfun-color-surface-panel/);
  assert.match(styles, /--openbitfun-shadow-menu/);
  assert.match(styles, /--openbitfun-overlay-menu-scrollbar-gap/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("flat, grouped, and custom scrolling menus share the same row-spacing owner", () => {
  const markup = renderToStaticMarkup(
    createElement(Menu, null,
      createElement(MenuItem, null, "Open project"),
      createElement(MenuItem, null, "Add assistant"),
      createElement(MenuSeparator),
      createElement(MenuSection, { title: "Recent projects" },
        createElement(ScrollArea, { style: { maxHeight: 240 } },
          createElement(MenuList, { "data-openbitfun-part": "recent-projects" },
            createElement(MenuItem, { checked: true, role: "menuitemradio" }, "Selected"),
            createElement(MenuItem, null, "Next"),
          ),
        ),
      ),
    ),
  );
  const lists = Array.from(markup.matchAll(/<div[^>]*class="([^"]+)"[^>]*data-openbitfun-menu-list=""[^>]*>/g));
  assert.equal(lists.length, 3, "root, section and nested scroll content must each own a row stack");
  const sharedClass = lists[2][1];
  assert.ok(lists.every(([, classes]) => classes.split(" ").includes(sharedClass)));
  assert.match(lists[0][0], /data-openbitfun-part="list"/);
  assert.match(lists[1][0], /data-openbitfun-part="section-items"/);
  assert.match(lists[2][0], /data-openbitfun-part="recent-projects"/);
  assert.equal((markup.match(/role="menu"/g) ?? []).length, 1, "a row stack must not introduce a nested menu");
});

test("section and separator spacing includes the row gap without doubling it", async () => {
  const styles = await readFile(new URL("../src/components/Menu/Menu.module.css", import.meta.url), "utf8");
  for (const selector of [".section + .section", ".items > .separator:not(:first-child)", ".items > .separator:not(:last-child)"]) {
    const block = styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
    assert.match(block, /margin-block-(?:start|end): max\(0px, calc\(var\(--openbitfun-overlay-menu-section-gap\) - var\(--openbitfun-overlay-menu-row-gap\)\)\)/);
  }
  assert.match(styles, /\.separator\s*\{[^}]*margin-block: var\(--openbitfun-overlay-menu-section-gap\)/);
});

test("Menu keeps focus rings inside items without adding a permanent gutter", async () => {
  const styles = await readFile(new URL("../src/components/Menu/Menu.module.css", import.meta.url), "utf8");
  const scrollStyles = await readFile(new URL("../src/components/ScrollArea/ScrollArea.module.css", import.meta.url), "utf8");
  const itemStyles = await readFile(new URL("../src/components/ActionItem/ActionItem.module.css", import.meta.url), "utf8");
  assert.match(styles, /\.list\s*\{[^}]*padding:\s*0/);
  assert.match(itemStyles, /\.root:has\(\.trigger:focus-visible\)\s*\{[^}]*box-shadow:\s*0 0 0 var\(--openbitfun-focus-width\)/);
  assert.match(styles, /\.item:has\(> \[data-openbitfun-part="trigger"\]:focus-visible\)\s*\{[^}]*box-shadow:\s*inset 0 0 0 var\(--openbitfun-focus-width\)/);
  // Keep clipping and scrolling; the item owns its focus indicator.
  assert.match(scrollStyles, /data-openbitfun-orientation="vertical"\]\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(styles, /overflow[^:]*:\s*visible/);
});

test("Menu keeps equal item insets while its scrollbar stays on the surface edge", async () => {
  const styles = await readFile(new URL("../src/components/Menu/Menu.module.css", import.meta.url), "utf8");

  assert.match(styles, /\.root\s*\{[^}]*padding-inline:\s*var\(--openbitfun-overlay-menu-surface-padding\) 0/);
  assert.match(styles, /\.viewport\s*\{[^}]*padding-inline-end:\s*var\(--openbitfun-overlay-menu-scrollbar-gap\);[^}]*scrollbar-gutter:\s*auto/);
  assert.match(
    styles,
    /\.list\s*\{[^}]*padding-inline-end:\s*calc\(\s*var\(--openbitfun-overlay-menu-surface-padding\)\s*- var\(--openbitfun-overlay-menu-scrollbar-gap\)\s*\)/,
  );
  assert.doesNotMatch(styles, /scrollbar-gutter:\s*stable/);
});
