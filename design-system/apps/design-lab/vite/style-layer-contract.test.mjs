import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { tokenCatalog } from "@openbitfun/design-tokens";
import { themeTokenCatalog } from "@openbitfun/theme-openbitfun";

const stylesSource = new URL("../src/styles.css", import.meta.url);

function findLayerRange(source, name) {
  const marker = `@layer ${name}`;
  const markerIndex = source.indexOf(marker);

  assert.notEqual(markerIndex, -1, `Missing ${marker}`);

  const openingBraceIndex = source.indexOf("{", markerIndex + marker.length);

  assert.notEqual(openingBraceIndex, -1, `Missing opening brace for ${marker}`);

  let depth = 0;

  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return { start: markerIndex, end: index + 1 };
      }
    }
  }

  assert.fail(`Missing closing brace for ${marker}`);
}

test("Design Lab form resets stay below component styles in openbitfun.reset", async () => {
  const source = await readFile(stylesSource, "utf8");
  const resetLayer = findLayerRange(source, "openbitfun.reset");
  const resetContracts = [
    /button,\s*input,\s*select\s*\{\s*font:\s*inherit;\s*\}/g,
    /button,\s*a,\s*select\s*\{\s*-webkit-tap-highlight-color:\s*transparent;\s*\}/g,
    /button\s*\{\s*color:\s*inherit;\s*\}/g,
  ];

  for (const contract of resetContracts) {
    const matches = [...source.matchAll(contract)];

    assert.equal(matches.length, 1);
    assert.ok(matches[0].index > resetLayer.start);
    assert.ok(matches[0].index < resetLayer.end);
  }
});

test("every Lab stylesheet consumes published tokens and has no empty selectors", async () => {
  const root = new URL("../src/", import.meta.url);
  const tokens = new Set([...tokenCatalog, ...themeTokenCatalog].map(token => token.cssVariable));
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".css"));
  for (const file of files) {
    const source = await readFile(new URL(file.replaceAll("\\", "/"), root), "utf8");
    assert.doesNotMatch(source, /^\s*\{/m, `${file} contains a rule without a selector`);
    for (const [, variable] of source.matchAll(/var\((--openbitfun-[a-z0-9-]+)/g)) {
      assert.ok(tokens.has(variable), `${file} references unpublished token ${variable}`);
    }
  }
});

test("site controls use public components without a second native-control skin", async () => {
  const root = new URL("../src/", import.meta.url);
  const app = await readFile(new URL("App.tsx", root), "utf8");
  for (const component of ["Dialog", "Sheet", "Select", "SearchField", "Listbox", "IconButton"]) {
    assert.ok(app.includes(`<${component}`), `Site shell must consume ${component}`);
  }
  for (const file of ["App.tsx", "pages/ColorsPage.tsx", "pages/FoundationsPage.tsx", "pages/GettingStartedPage.tsx"]) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /<(?:button|input|select)\b/, `${file} reimplements a public control`);
  }
  const styles = await readFile(stylesSource, "utf8");
  assert.doesNotMatch(styles, /\.lab-(?:shell|topbar|sidebar|search|settings)\b/);
  assert.doesNotMatch(styles, /\.token-tools select|\.token-action-row button|\.component-code-heading button|\.component-inspector-select select/);
});
