import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { componentRegistry } from "@openbitfun/ui/registry";

test("brand resources use original artwork, localized names and real downloads", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { BrandPage, brandResources } = await server.ssrLoadModule("/src/pages/BrandPage.tsx");
    const { I18nContext } = await server.ssrLoadModule("/src/i18n/I18nProvider.tsx");
    const { messages } = await server.ssrLoadModule("/src/i18n/messages.ts");
    const { translateFromCatalog } = await server.ssrLoadModule("/src/i18n/core.mjs");
    for (const locale of ["en-US", "zh-CN", "zh-TW"]) {
      const html = renderToStaticMarkup(createElement(I18nContext.Provider, {
        value: { locale, setLocale() {}, t: (key, params) => translateFromCatalog(messages, locale, key, params) },
      }, createElement(BrandPage, { onOpenComponent() {} })));
      const entries = componentRegistry.filter(component => component.category === "brand" && component.name !== "SubagentHatch");
      assert.deepEqual(new Set(brandResources.filter(item => item.name !== "wordmark").map(item => item.name)), new Set(entries.map(item => item.name)));
      assert.match(html, /data-openbitfun-component="openbitfun-solid-mark"/);
      assert.match(html, /id="brand-resource-title"/);
      assert.match(html, /download="openbitfun-silver-mark.png"/);
      assert.match(html, /href="#subagent-ip"/);
      assert.match(html, /aria-pressed="true"/);
      assert.doesNotMatch(html, /<h2>OpenBitFunSolidMark<|>brand\.|>design\./);
      assert.ok(brandResources.find(item => item.name === "OpenBitFunAppIcon").downloads.some(item => item.filename.endsWith(".ico")));
      assert.ok(brandResources.find(item => item.name === "OpenBitFunAppIcon").downloads.some(item => item.filename.endsWith(".icns")));

    }
  } finally {
    await server.close();
  }
});
