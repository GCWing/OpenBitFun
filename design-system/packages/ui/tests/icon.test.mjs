import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
import { Icon, iconNames, canonicalIconNames, iconAliases } from "../dist/index.js";
import { Network } from "lucide-react";

test("Icon exposes the complete named catalog without duplicate names", () => {
  assert.equal(iconNames.length, 98);
  assert.equal(canonicalIconNames.length, 95);
  assert.deepEqual(Object.keys(iconAliases).sort(), ["circle", "download"]);
  for (const name of ["thinking", "git", "duplicate", "chevron-left", "selected", "delete", "waitlist-message", "creative", "ultimate", "standard", "minimal", "arrow-down", "unselected"]) {
    assert.ok(canonicalIconNames.includes(name), name);
  }
  assert.equal(new Set(iconNames).size, iconNames.length);
  assert.ok(iconNames.includes("search"));
  assert.ok(canonicalIconNames.includes("list-todo"));
  assert.match(renderToStaticMarkup(createElement(Icon, { name: "list-todo" })), /lucide-list-todo/);
  assert.ok(iconNames.includes("book-open"));
  assert.ok(iconNames.includes("circle-arrow-right"));
  assert.match(renderToStaticMarkup(createElement(Icon, { name: "circle-arrow-right" })), /lucide-circle-arrow-right/);
  assert.match(renderToStaticMarkup(createElement(Icon, { name: "book-open" })), /lucide-book-open/);
  assert.ok(iconNames.includes("book-search"));
  assert.ok(iconNames.includes("file-up"));
  assert.ok(iconNames.includes("file-search-corner"));
  assert.ok(iconNames.includes("folder-search"));
  const bookSearch = renderToStaticMarkup(createElement(Icon, { name: "book-search" }));
  assert.match(bookSearch, /lucide-book-search/);
  assert.match(bookSearch, /stroke-width="var\(--openbitfun-control-icon-stroke-width\)"/);
  assert.ok(iconNames.includes("commit"));
  assert.ok(iconNames.includes("sidebar-right"));
  assert.ok(iconNames.includes("chevron-up"));
  assert.ok(iconNames.includes("refresh"));
  assert.ok(iconNames.includes("layers-plus"));
  for (const name of ["target", "users", "history", "git-pull-request"]) {
    assert.ok(canonicalIconNames.includes(name));
    assert.match(renderToStaticMarkup(createElement(Icon, { name })), new RegExp(`lucide-${name}`));
  }
});

test("Icon is decorative by default and renders the named Lucide glyph", () => {
  const markup = renderToStaticMarkup(createElement(Icon, { name: "search" }));

  assert.match(markup, /data-openbitfun-component="icon"/);
  assert.match(markup, /data-openbitfun-name="search"/);
  assert.match(markup, /data-size="lg"/);
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /lucide-search/);
  assert.match(markup, /stroke-width="var\(--openbitfun-control-icon-stroke-width\)"/);
  assert.doesNotMatch(markup, /mask-image/);
});

test("Icon exposes semantic size, tone, and accessible label independently", () => {
  const markup = renderToStaticMarkup(createElement(Icon, {
    label: "Successful",
    name: "check-circle",
    size: "sm",
    tone: "success",
  }));

  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Successful"/);
  assert.doesNotMatch(markup.match(/^<span[^>]*>/)?.[0] ?? "", /aria-hidden/);
  assert.match(markup, /data-size="sm"/);
  assert.match(markup, /data-openbitfun-tone="success"/);
});

test("Icon normalizes Lucide fallbacks without exposing product-owned line weight", () => {
  const markup = renderToStaticMarkup(createElement(Icon, {
    glyph: Network,
    label: "Network",
    size: "sm",
    tone: "secondary",
  }));

  assert.match(markup, /data-openbitfun-component="icon"/);
  assert.match(markup, /data-openbitfun-source="line"/);
  assert.match(markup, /data-size="sm"/);
  assert.match(markup, /data-openbitfun-tone="secondary"/);
  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Network"/);
  assert.match(markup, /<svg[^>]*stroke-width="var\(--openbitfun-control-icon-stroke-width\)"/);
  assert.match(markup, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(markup, /mask-image/);
});

test("Icon styles consume only public geometry and semantic color tokens", async () => {
  const styles = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");

  assert.match(styles, /--openbitfun-control-icon-size2xs/);
  assert.match(styles, /--openbitfun-control-icon-size-lg/);
  assert.match(styles, /--openbitfun-color-content-primary/);
  assert.match(styles, /--openbitfun-color-status-success-content/);
  assert.match(styles, /mask-size:contain/);
  assert.match(styles, /data-openbitfun-source=line/);
});

test("Icon mask assets are color-agnostic", async () => {
  const assetDirectory = new URL("../src/components/Icon/assets/", import.meta.url);
  const assetNames = (await readdir(assetDirectory)).filter((name) => name.endsWith(".svg"));

  assert.deepEqual(assetNames.sort(), [
    "creative.svg", "git.svg", "minimal.svg",
    "reasoning-auto.svg", "standard.svg", "thinking.svg", "ultimate.svg",
  ]);
  for (const assetName of assetNames) {
    const source = await readFile(new URL(assetName, assetDirectory), "utf8");
    assert.match(source, /(?:fill|stroke)="currentColor"/i, `${assetName} must use currentColor`);
    assert.doesNotMatch(
      source,
      /\b(?:fill|stroke)="(?:black|white|#[0-9a-f]{3,8}|rgba?\()/i,
      `${assetName} must not own a color`,
    );
  }
});

test("Icon preserves all reviewed asset geometry and opacity", async () => {
  const assets = new URL("../src/components/Icon/assets/", import.meta.url);
  const fingerprints = JSON.parse(await readFile(new URL("fixtures/icon-assets.json", import.meta.url), "utf8"));
  assert.equal(fingerprints.length, 7);
  assert.equal(new Set(fingerprints.map(entry => entry.node)).size, 7);
  assert.deepEqual((await readdir(assets)).filter(name => name.endsWith(".svg")).sort(), fingerprints.map(entry => entry.asset).sort());
  for (const entry of fingerprints) {
    const source = (await readFile(new URL(entry.asset, assets), "utf8")).replaceAll("\r\n", "\n").trim();
    assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256, `${entry.name}: review geometry, viewBox and opacity before updating its fingerprint`);
    assert.ok(iconNames.includes(entry.name), `${entry.name} is not registered`);
  }
});

test("compatibility aliases share canonical Lucide geometry", () => {
  for (const [alias, canonical] of [["download", "arrow-down"], ["circle", "unselected"]]) {
    const renderGlyph = name => renderToStaticMarkup(createElement(Icon, { name })).match(/<svg[\s\S]*?<\/svg>/)?.[0];
    assert.ok(renderGlyph(alias));
    assert.equal(renderGlyph(alias), renderGlyph(canonical));
    assert.ok(!canonicalIconNames.includes(alias));
  }
  assert.ok(!canonicalIconNames.includes("turn"));
});

test("every general-purpose named icon renders Lucide and only the reviewed exceptions use masks", () => {
  const preserved = new Set([
    "minimal", "standard", "ultimate", "creative", "git", "thinking",
    "reasoning-auto",
  ]);
  for (const name of iconNames) {
    const markup = renderToStaticMarkup(createElement(Icon, { name }));
    if (preserved.has(name)) {
      assert.match(markup, /mask-image:url/, name);
      assert.doesNotMatch(markup, /<svg/, name);
    } else {
      assert.match(markup, /class="lucide lucide-/, name);
      assert.match(markup, /stroke-width="var\(--openbitfun-control-icon-stroke-width\)"/, name);
      assert.doesNotMatch(markup, /mask-image/, name);
    }
  }
});

test("published Icon masks contain the current asset attributes for every catalog entry", async () => {
  const assets = new URL("../src/components/Icon/assets/", import.meta.url);
  const catalog = JSON.parse(await readFile(new URL("fixtures/icon-assets.json", import.meta.url), "utf8"));
  const attributes = svg => [...svg.matchAll(/\b([\w:-]+)=["']([^"']*)["']/g)]
    .map(match => [match[1], match[2].trim().replace(/\s+/g, " ")]);

  for (const entry of catalog) {
    const markup = renderToStaticMarkup(createElement(Icon, { name: entry.name }));
    const mask = markup.match(/mask-image:url\(&quot;(.*?)&quot;\)/)?.[1];
    assert.ok(mask, `${entry.name} must render an asset mask`);
    assert.match(mask, /^data:image\/svg\+xml,/, `${entry.name} must include its published asset`);
    const svg = decodeURIComponent(mask.slice(mask.indexOf(",") + 1))
      .replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
    const source = await readFile(new URL(entry.asset, assets), "utf8");
    assert.deepEqual(attributes(svg), attributes(source), `${entry.name} must not ship stale or miswired geometry`);
  }
});

test("Combobox constrains catalog glyphs in both value and indicator slots", async () => {
  const source = await readFile(new URL("../src/components/Combobox/Combobox.module.css", import.meta.url), "utf8");
  for (const slot of ["valueLeading", "indicator"]) {
    assert.match(source, new RegExp(`\\.${slot} > \\[data-openbitfun-component="icon"\\]\\s*\\{\\s*inline-size: 100%;\\s*block-size: 100%;`));
  }
});
