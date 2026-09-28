import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as brand from "../dist/brand.js";
import * as ui from "../dist/index.js";
import { componentRegistry } from "../dist/registry.js";

test("brand exports expose the real artwork while preserving the existing voice entry", () => {
  for (const name of ["OpenBitFunSolidMark", "OpenBitFunAppIcon", "OpenBitFunMark", "OpenBitFunBrandMotion", "SubagentHatch", "VoiceParticleLogo"]) {
    assert.equal(typeof brand[name], "function");
    assert.equal(componentRegistry.find(component => component.name === name)?.category, "brand");
  }
  assert.equal(ui.VoiceParticleLogo, brand.VoiceParticleLogo);
  assert.equal(ui.OpenBitFunMark, undefined, "new brand APIs belong to the opt-in entry");
});

test("brand marks are decorative by default and expose supplied accessible names", () => {
  for (const name of ["OpenBitFunMark", "OpenBitFunBrandMotion"]) {
    const decorative = renderToStaticMarkup(createElement(brand[name], { active: false }));
    assert.match(decorative, /aria-hidden="true"/);
    assert.doesNotMatch(decorative, /role="img"/);
    const named = renderToStaticMarkup(createElement(brand[name], { label: "OpenBitFun", active: false }));
    assert.match(named, /role="img"/);
    assert.match(named, /aria-label="OpenBitFun"/);
    assert.doesNotMatch(named, /aria-hidden="true"/);
  }
  for (const name of ["OpenBitFunSolidMark", "OpenBitFunAppIcon"]) {
    assert.match(renderToStaticMarkup(createElement(brand[name])), /alt=""/);
    const named = renderToStaticMarkup(createElement(brand[name], { label: "OpenBitFun", size: 16 }));
    assert.match(named, /alt="OpenBitFun"/);
    assert.match(named, /width:16px/);
    assert.match(named, /src="data:image\/png;base64,/);
    if (name === "OpenBitFunAppIcon") {
      assert.match(named, /srcSet=/);
      assert.match(named, /sizes="16px"/);
    }
  }
});

test("published artwork embeds the same bytes as the application icon generator", async () => {
  const source = new URL("../src/brand/assets/", import.meta.url);
  const solid = renderToStaticMarkup(createElement(brand.OpenBitFunSolidMark));
  assert.ok(solid.includes((await readFile(new URL("openbitfun-app-mark.png", source))).toString("base64")));
  const app = renderToStaticMarkup(createElement(brand.OpenBitFunAppIcon));
  for (const size of [16, 32, 128, 256, 512]) {
    assert.ok(app.includes((await readFile(new URL(`openbitfun-app-icon-${size}.png`, source))).toString("base64")));
  }
});

const playbackSource = await readFile(new URL("../src/brand/brandPlayback.ts", import.meta.url), "utf8");
const playbackModule = ts.transpileModule(playbackSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { startBrandPlayback } = await import(`data:text/javascript;base64,${Buffer.from(playbackModule).toString("base64")}`);

test("brand playback cancels for reduced motion, pauses when hidden and cleans up", () => {
  const motion = Object.assign(new EventTarget(), { matches: true });
  const document = Object.assign(new EventTarget(), { hidden: false, defaultView: { matchMedia: () => motion } });
  const calls = [];
  const animation = { cancel: () => calls.push("cancel"), pause: () => calls.push("pause"), play: () => calls.push("play") };
  const stop = startBrandPlayback({ ownerDocument: document, animate() {} }, () => {
    calls.push("create");
    return [animation];
  });
  assert.deepEqual(calls, [], "reduced motion must not start decorative animation");
  motion.matches = false;
  motion.dispatchEvent(new Event("change"));
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  motion.matches = true;
  motion.dispatchEvent(new Event("change"));
  motion.matches = false;
  motion.dispatchEvent(new Event("change"));
  stop();
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(calls, ["create", "pause", "play", "cancel", "create", "cancel"]);
});
