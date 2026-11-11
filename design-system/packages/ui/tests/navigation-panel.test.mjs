import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NavigationPanel,
  NavigationPanelBody,
  NavigationPanelContent,
  NavigationPanelFooter,
  NavigationPanelHeader,
  NavigationPanelItem,
  NavigationPanelSection,
  NavigationPanelSeparator,
} from "../dist/index.js";

test("NavigationPanelItem forwards static labels and keeps native navigation semantics", () => {
  const markup = renderToStaticMarkup(createElement(NavigationPanelItem, {
    selected: true, labelBehavior: "static", className: "horizontal-navigation",
    title: "My submissions", "data-active": true,
  }, "My submitted Mini Apps"));
  assert.match(markup, /<span[^>]+class="[^"]+ horizontal-navigation"/);
  assert.match(markup, /<button[^>]+aria-current="page"/);
  assert.match(markup, /data-active="true"/);
  assert.match(markup, /type="button"/);
  assert.match(markup, /data-openbitfun-part="label">My submitted Mini Apps<\/span>/);
  assert.doesNotMatch(markup, /data-overflow-behavior|data-overflow-content|labelBehavior/);
  const defaultMarkup = renderToStaticMarkup(createElement(NavigationPanelItem, null, "Navigation"));
  assert.match(defaultMarkup, /data-overflow-behavior="marquee"/);
});

test("NavigationPanel composes independent header, grouped body, and footer regions", () => {
  const markup = renderToStaticMarkup(
    createElement(
      NavigationPanel,
      {
        "aria-label": "Application navigation",
      },
      createElement(NavigationPanelHeader, null, createElement("button", null, "Search")),
      createElement(
        NavigationPanelBody,
        { scrollbarVisibility: "always" },
        createElement(
          NavigationPanelContent,
          null,
          createElement(
            NavigationPanelSection,
            {
              actions: [{ icon: createElement("svg"), id: "add", label: "Add" }],
              title: "Sessions",
            },
            createElement(NavigationPanelItem, { selected: true }, "Welcome"),
            createElement(NavigationPanelItem, { disabled: true }, "Unavailable"),
          ),
          createElement(NavigationPanelSeparator),
        ),
      ),
      createElement(NavigationPanelFooter, null, createElement("button", null, "Device")),
    ),
  );

  assert.match(markup, /<nav[^>]+aria-label="Application navigation"/);
  assert.match(markup, /data-openbitfun-component="navigation-panel"/);
  assert.match(markup, /data-openbitfun-part="header"/);
  assert.match(markup, /data-openbitfun-part="content"/);
  assert.match(markup, /data-openbitfun-part="footer"/);
  assert.match(markup, /data-openbitfun-scrollbar-visibility="always"/);
  assert.match(markup, /aria-labelledby="[^"]+"/);
  assert.match(markup, /aria-current="page"/);
  assert.match(markup, /disabled=""/);
  assert.match(markup, /role="separator"/);
  assert.match(markup, /aria-label="Add"/);
});

test("NavigationPanel styling reuses shared action and scrollbar contracts", async () => {
  const styles = await readFile(
    new URL("../src/components/NavigationPanel/NavigationPanel.module.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /--openbitfun-layout-navigation-panel-inline-size/);
  assert.match(styles, /--openbitfun-layout-navigation-panel-footer-height/);
  assert.match(styles, /\.items\s*\{[^}]*gap: calc\(var\(--openbitfun-space-1\) \/ 2\)/);
  assert.match(styles, /--openbitfun-color-surface-chrome/);
  assert.match(styles, /--openbitfun-color-selection-surface/);
  assert.match(styles, /aria-current/);
  assert.match(styles, /scrollbar-gutter: stable/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}/i);
});

test("NavigationPanel separates group captions, destinations, and the selected destination", async () => {
  const styles = await readFile(
    new URL("../src/components/NavigationPanel/NavigationPanel.module.css", import.meta.url),
    "utf8",
  );
  const actionStyles = await readFile(
    new URL("../src/components/ActionItem/ActionItem.module.css", import.meta.url),
    "utf8",
  );
  const heading = styles.match(/\.headingLabel\s*\{([^}]+)\}/)?.[1];
  assert.ok(heading);
  assert.match(heading, /color: var\(--openbitfun-color-content-caption\)/);
  assert.match(heading, /font-family: var\(--openbitfun-type-label-xs-font-family\)/);
  assert.match(heading, /font-size: var\(--openbitfun-type-label-xs-font-size\)/);
  assert.match(heading, /font-weight: var\(--openbitfun-type-label-xs-font-weight\)/);
  assert.match(heading, /line-height: var\(--openbitfun-type-label-xs-line-height\)/);
  assert.match(styles, /\.item\[data-openbitfun-tone="neutral"\]:not\(\[data-disabled="true"\]\)\s*\{\s*color: var\(--openbitfun-color-content-primary\)/);
  assert.match(actionStyles, /\.label\s*\{[^}]*font-size: var\(--openbitfun-type-label-md-font-size\)/);
  assert.match(actionStyles, /\.label\s*\{[^}]*font-weight: var\(--openbitfun-type-label-md-font-weight\)/);
  assert.match(styles, /\.item > \[data-openbitfun-part="trigger"\]\[aria-current\] > \[data-openbitfun-part="label"\]\s*\{\s*font-weight: var\(--openbitfun-type-label-selected-font-weight\)/);
  assert.match(styles, /@media \(prefers-contrast: more\)[\s\S]*?color: var\(--openbitfun-color-content-muted\)/);
  assert.match(styles, /:global\(\[data-contrast="high"\]\) \.headingLabel\s*\{\s*color: var\(--openbitfun-color-content-muted\)/);
  assert.match(styles, /@media \(forced-colors: active\)[\s\S]*?color: CanvasText/);
});
